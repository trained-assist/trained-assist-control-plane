/**
 * Ожидание результата попытки Runner с чтением событий по курсору и финализацией
 * артефактов (эпик #109, issue #122).
 *
 * Правила:
 *  - `connection_lost` — НЕИЗВЕСТНЫЙ исход, не `failed`: задача не меняется,
 *    авто-rerun нет (ARCHITECTURE §4.6).
 *  - События Runner читаются по курсору (`events?cursor=`) и записываются в
 *    `task_events` с оригинальными `eventId`/`sequence` в payload — клиент
 *    может воспроизвести их независимо от движка.
 *  - Финализация артефактов: каждый `outputRef` становится строкой
 *    `task_artifacts` (ссылка, не байты) И элементом `artifacts` результата,
 *    который собирает план.
 */
import type { TaskStore, TaskEventKind } from '../taskstore';
import type { RunnerApiAdapter, RunnerEvent, RunnerResult, RunnerStatusView } from './runner-api-adapter';
import { extractEngineText, type EngineText } from './engine-text';
import { runnerArtifactRef } from './runner-api-adapter';
import { RunnerArtifactManifestError } from './errors';

export interface AwaitRunnerResultOptions {
  runId: string;
  taskId: string;
  generation: number;
  answerMode?: 'runner_api' | 'stdout';
  declaredOutputPaths?: readonly string[];
  pollSec?: number;
  timeoutSec?: number;
}

/**
 * Манифест артефакта в терминах задачи: ссылка + размер + контрольная сумма.
 *
 * Раньше результат нёс только строку ссылки (`artifacts: string[]`), и по
 * нему нельзя было ни проверить целостность скачанного файла, ни отличить
 * существующий выход от потерянной ссылки. Теперь это тот же набор ссылок,
 * но с полями манифеста Runner'а.
 */
export interface TaskArtifactManifest {
  /** Ссылка на артефакт (storage key или outputRef). */
  ref: string;
  name: string | null;
  mime: string | null;
  sizeBytes: number | null;
  /** SHA-256 в hex без префикса; null, если манифест недоступен. */
  sha256: string | null;
}

export interface RunnerAnswer {
  text: string | null;
  source: 'runner_status_answer' | 'runner_log_stdout' | 'runner_result_text' | null;
  version: 'runner-answer-v1' | EngineText['version'] | null;
  answerSource: 'agent_file' | 'engine_stdout' | null;
}

export type AwaitRunnerResult =
  | { ok: true; result: RunnerResult; eventsRecorded: number; artifacts: TaskArtifactManifest[]; engineText: EngineText | null; answer?: RunnerAnswer }
  | { ok: false; reason: 'connection_lost' | 'runner_timeout' | 'runner_unavailable' | 'runner_failed' | 'worker_restart_pending' | 'export_not_persisted' | 'runner_artifact_manifest_invalid' };

/** События Runner -> лексика kind A2 §5.2 (оригинальный тип остаётся в payload). */
const RUNNER_EVENT_KIND: Record<string, TaskEventKind> = {
  claimed: 'step_claimed',
  materialized: 'step_started',
  started: 'run_started',
  log: 'progress',
  exit: 'step_done',
  finalizing: 'step_done',
  succeeded: 'result_ready',
  failed: 'step_failed',
  cancelled: 'task_cancelled',
  connection_lost: 'error',
};

export async function awaitRunnerResult(
  adapter: RunnerApiAdapter,
  store: TaskStore,
  opts: AwaitRunnerResultOptions,
): Promise<AwaitRunnerResult> {
  const pollSec = Math.max(1, opts.pollSec ?? 1);
  const deadline = Date.now() + (opts.timeoutSec ?? 120) * 1000;
  const collected = { cursor: 0, eventsRecorded: 0, seenEvents: [] as RunnerEvent[] };

  for (;;) {
    // Keep the durable task journal current while the Runner is working. This
    // exposes its lifecycle/output events through the existing Control Plane
    // /events endpoint instead of importing them only after terminal status.
    try { await collectRunnerEvents(adapter, store, opts, collected); } catch { /* Status remains authoritative; retry the event cursor next poll. */ }
    let status: RunnerStatusView;
    try {
      status = await adapter.status(opts.runId);
    } catch (e) {
      if (e instanceof Error && /unreachable|HTTP_5|HTTP_429/.test(e.message)) {
        return { ok: false, reason: 'runner_unavailable' };
      }
      throw e;
    }

    // Потеря связи с Runner'ом — отдельное состояние, не failed.
    if (status.connectionLost) {
      if ((await store.getRun(opts.runId))?.status !== 'unknown') {
        await store.markConnectionLost(opts.runId, 'runner connection_lost');
      }
      return { ok: false, reason: 'connection_lost' };
    }

    if (['succeeded', 'failed', 'cancelled'].includes(status.state)) {
      return finalize(adapter, store, opts, status, collected);
    }

    if (Date.now() >= deadline) return { ok: false, reason: 'runner_timeout' };
    await new Promise((resolve) => setTimeout(resolve, pollSec * 1000));
  }
}

type CollectedRunnerEvents = { cursor: number; eventsRecorded: number; seenEvents: RunnerEvent[] };

async function collectRunnerEvents(
  adapter: RunnerApiAdapter,
  store: TaskStore,
  opts: AwaitRunnerResultOptions,
  collected: CollectedRunnerEvents,
): Promise<void> {
  for (;;) {
    const page = await adapter.events(opts.runId, collected.cursor, 500);
    for (const event of page.events) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= collected.cursor) continue;
      collected.seenEvents.push(event);
      await store.logEvent({
        taskId: opts.taskId,
        kind: RUNNER_EVENT_KIND[event.type] ?? 'progress',
        executionId: event.runId,
        source: 'executor',
        payload: {
          runId: event.runId,
          eventId: event.eventId,
          sequence: event.sequence,
          type: event.type,
          ownerGeneration: event.ownerGeneration,
          at: event.timestamp,
          ...(event.payload === undefined ? {} : { payload: event.payload }),
        },
      });
      collected.eventsRecorded += 1;
      collected.cursor = event.sequence;
    }
    if (page.resetRequired) collected.cursor = Math.max(collected.cursor, page.cursor);
    if (!page.hasMore) break;
  }
}

async function finalize(
  adapter: RunnerApiAdapter,
  store: TaskStore,
  opts: AwaitRunnerResultOptions,
  status: RunnerStatusView,
  collected: CollectedRunnerEvents,
): Promise<AwaitRunnerResult> {
  // Drain the terminal tail before building the result, retaining the same
  // cursor used for live journal updates so events are never duplicated.
  await collectRunnerEvents(adapter, store, opts, collected);

  const result = await adapter.result(opts.runId);

  const commitFailure = async (reason: string, terminalStatus: 'failed' | 'cancelled', retryWorkerRestart = false) => {
    const failureResult = { reason, runId: result.runId, ownerGeneration: result.ownerGeneration,
      outcome: result.outcome, persistence: result.persistence, exitReason: result.exitReason, failure: result.failure ?? null };
    const attempt = (await store.listRuns(opts.taskId)).find((run) => run.session_id === opts.runId && run.generation === opts.generation);
    if (attempt) await store.finishRun(attempt.id, terminalStatus, {
      errorClass: result.failure?.code ?? reason, errorText: result.failure?.safeSummary ?? result.exitReason, result: failureResult,
    });
    if (retryWorkerRestart) {
      await store.logEvent({ taskId: opts.taskId, generation: opts.generation, source: 'executor', kind: 'progress',
        executionId: attempt?.id ?? null,
        payload: { event: 'worker_restart_pending', runId: result.runId, retry: 1, maxRetries: 1 } });
      return;
    }
    await store.commit(opts.taskId, opts.generation, { status: terminalStatus, stage: 'finished',
      kind: 'task_status_changed', step: 'finalize', result: failureResult, payload: failureResult });
  };

  if (status.state !== 'succeeded' || result.outcome !== 'succeeded') {
    const workerRestart = status.state === 'failed' && result.outcome === 'failed'
      && result.failure?.code === 'WORKER_CRASH' && result.failure.retryable === true;
    const priorCrashes = workerRestart
      ? (await store.listRuns(opts.taskId)).filter(run => run.status === 'failed' && run.error_class === 'WORKER_CRASH').length : 0;
    const retryWorkerRestart = workerRestart && priorCrashes === 0;
    await commitFailure(result.failure?.code ?? result.exitReason,
      result.outcome === 'cancelled' ? 'cancelled' : 'failed', retryWorkerRestart);
    if (retryWorkerRestart) return { ok: false, reason: 'worker_restart_pending' };
    return { ok: false, reason: 'runner_failed' };
  }

  // Финализация артефактов: ссылки на сохранённые выходы Runner'а. Источников
  // два, потому что Runner отдаёт их по-разному: `result.outputRefs` — то, что движок
  // сам положил в результат, а `GET /v1/runs/{runId}/artifacts` — манифесты
  // зарегистрированных артефактов (живой прогон: регистрация вне контура, и
  // outputRefs пуст, а артефакт виден только здесь). Дедуп — на уровне ссылки.
  // Этот же набор — источник для `task_artifacts` и для `result.artifacts` плана:
  // второго источника ссылок нет.
  let byRef;
  try {
    const manifests = await adapter.artifacts(opts.runId);
    byRef = new Map(manifests.map(manifest => [runnerArtifactRef(manifest), manifest]));
    if (!Array.isArray(result.outputRefs) || result.outputRefs.some(ref => typeof ref !== 'string' || !ref.trim() || ref !== ref.trim())) {
      throw new RunnerArtifactManifestError();
    }
  } catch (error) {
    if (!(error instanceof RunnerArtifactManifestError)) throw error;
    await store.logEvent({ taskId: opts.taskId, generation: opts.generation, source: 'executor', kind: 'error',
      payload: { class: 'runner_artifact_manifest_invalid', runId: opts.runId, reconciliationRequired: true } });
    return { ok: false, reason: 'runner_artifact_manifest_invalid' };
  }
  const artifactRefs = [...new Set([...result.outputRefs, ...byRef.keys()])];
  const artifacts: TaskArtifactManifest[] = artifactRefs.map((ref) => {
    const manifest = byRef.get(ref);
    return {
      ref,
      name: manifest?.name ?? null,
      mime: manifest?.mime ?? null,
      sizeBytes: manifest?.size ?? null,
      sha256: manifest?.sha256 ?? null,
    };
  });
  for (const artifact of artifacts) {
    await store.recordArtifact({
      taskId: opts.taskId,
      kind: 'file',
      artifactRef: artifact.ref,
      sizeBytes: artifact.sizeBytes,
      checksum: artifact.sha256 ? `sha256:${artifact.sha256}` : null,
      runId: opts.runId,
      generation: opts.generation,
    });
  }

  const noExportRequired = Array.isArray(opts.declaredOutputPaths) && opts.declaredOutputPaths.length === 0
    && result.persistence === 'not_required' && artifactRefs.length === 0;
  if (result.persistence !== 'persisted' && !noExportRequired && result.persistence !== 'pending') {
    await commitFailure('export_not_persisted', 'failed');
    return { ok: false, reason: 'export_not_persisted' };
  }
  if (result.persistence === 'pending' && !noExportRequired) {
    // Экспорт не подтверждён: результат не теряется молча, но и успехом не считается.
    // Pending is a separate resumable phase. Preserve the engine result and let the
    // workflow publish its text while it reconciles persistence on the same run.
    await store.logEvent({ taskId: opts.taskId, generation: opts.generation, source: 'executor', kind: 'step_done',
      payload: { class: result.persistence === 'pending' ? 'run_persistence_pending' : 'run_persistence_failed',
        runId: opts.runId, persistence: result.persistence, persistenceReason: result.persistenceReason ?? null,
        cleanup: result.cleanup, reconciliationRequired: result.persistence === 'pending' } });
  }

  // Конечный текст движка — из потока событий, а не из поля результата: в
  // контракте Runner'а текста нет. Отсутствие текста не прячется за ok=true —
  // вызывающий видит `engineText: null` и решает сам.
  const engineText = extractEngineText(collected.seenEvents);
  // In API mode, status.answer is the normalized public result. Legacy callers
  // can still use the versioned stdout contract; this switch is a caller/API
  // contract, never a physical worker name.
  const statusAnswer = typeof status.answer === 'string' && status.answer.trim().length > 0
    ? status.answer : null;
  const resultText = typeof result.text === 'string' && result.text.trim().length > 0 ? result.text : null;
  // The Runner API status is the primary public answer. Its terminal result is
  // also durable and can contain the same captured answer; keep it as a
  // fallback in case status and result were observed across a state update.
  // Never promote arbitrary stdout in API mode: it can contain progress/tool JSON.
  const text = opts.answerMode === 'runner_api' ? statusAnswer ?? resultText : engineText?.text ?? resultText;
  const resolution = [...collected.seenEvents].sort((first, second) => second.sequence - first.sequence)
    .find((event) => event.type === 'agent_exit_resolved')?.payload as { answerSource?: unknown } | undefined;
  const answerSource = text !== null && (resolution?.answerSource === 'agent_file' || resolution?.answerSource === 'engine_stdout')
    ? resolution.answerSource : null;
  const answer: RunnerAnswer = { text, answerSource,
    source: text === null ? null : opts.answerMode === 'runner_api'
      ? statusAnswer !== null ? 'runner_status_answer' : 'runner_result_text'
      : engineText ? engineText.source : 'runner_result_text',
    version: text === null ? null : opts.answerMode === 'runner_api' ? 'runner-answer-v1' : engineText?.version ?? 'runner-answer-v1' };
  return { ok: true, result, eventsRecorded: collected.eventsRecorded, artifacts, engineText, answer };
}
