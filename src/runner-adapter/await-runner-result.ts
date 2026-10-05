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
 *    который собирает план. Экспорт не подтверждён
 *    (`persistence != 'persisted'`) — задача не завершается успехом молча.
 */
import type { TaskStore, TaskEventKind } from '../taskstore';
import type { RunnerApiAdapter, RunnerEvent, RunnerResult, RunnerStatusView } from './runner-api-adapter';
import { extractEngineText, type EngineText } from './engine-text';

export interface AwaitRunnerResultOptions {
  runId: string;
  taskId: string;
  generation: number;
  engineName?: string;
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
  | { ok: false; reason: 'connection_lost' | 'runner_timeout' | 'runner_unavailable' | 'runner_failed' | 'export_not_persisted' };

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

  for (;;) {
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
      await store.markConnectionLost(opts.runId, 'runner connection_lost');
      return { ok: false, reason: 'connection_lost' };
    }

    if (['succeeded', 'failed', 'cancelled'].includes(status.state)) {
      return finalize(adapter, store, opts, status);
    }

    if (Date.now() >= deadline) return { ok: false, reason: 'runner_timeout' };
    await new Promise((resolve) => setTimeout(resolve, pollSec * 1000));
  }
}

async function finalize(
  adapter: RunnerApiAdapter,
  store: TaskStore,
  opts: AwaitRunnerResultOptions,
  status: RunnerStatusView,
): Promise<AwaitRunnerResult> {
  // События по курсору: читаем с нуля, записываем в журнал с курсором в payload.
  let cursor = 0;
  let eventsRecorded = 0;
  const seenEvents: RunnerEvent[] = [];
  for (;;) {
    const page = await adapter.events(opts.runId, cursor, 500);
    for (const event of page.events) {
      seenEvents.push(event);
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
      eventsRecorded += 1;
    }
    cursor = page.cursor;
    if (!page.hasMore) break;
  }

  const result = await adapter.result(opts.runId);

  const commitFailure = async (reason: string, terminalStatus: 'failed' | 'cancelled') => {
    const failureResult = { reason, runId: result.runId, ownerGeneration: result.ownerGeneration,
      outcome: result.outcome, persistence: result.persistence, exitReason: result.exitReason, failure: result.failure ?? null };
    const attempt = (await store.listRuns(opts.taskId)).find((run) => run.session_id === opts.runId && run.generation === opts.generation);
    if (attempt) await store.finishRun(attempt.id, terminalStatus, {
      errorClass: result.failure?.code ?? reason, errorText: result.failure?.safeSummary ?? result.exitReason, result: failureResult,
    });
    await store.commit(opts.taskId, opts.generation, { status: terminalStatus, stage: 'finished',
      kind: 'task_status_changed', step: 'finalize', result: failureResult, payload: failureResult });
  };

  if (status.state !== 'succeeded' || result.outcome !== 'succeeded') {
    await commitFailure(result.failure?.code ?? result.exitReason, result.outcome === 'cancelled' ? 'cancelled' : 'failed');
    return { ok: false, reason: 'runner_failed' };
  }

  // Финализация артефактов: ссылки на сохранённые выходы Runner'а. Источников
  // два, потому что Runner отдаёт их по-разному: `result.outputRefs` — то, что движок
  // сам положил в результат, а `GET /v1/runs/{runId}/artifacts` — манифесты
  // зарегистрированных артефактов (живой прогон: регистрация вне контура, и
  // outputRefs пуст, а артефакт виден только здесь). Дедуп — на уровне ссылки.
  // Этот же набор — источник для `task_artifacts` и для `result.artifacts` плана:
  // второго источника ссылок нет.
  const manifests = await adapter.artifacts(opts.runId);
  const byRef = new Map(manifests.map((m) => [m.storageKey || m.artifactId, m]));
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

  if (result.persistence !== 'persisted') {
    // Экспорт не подтверждён: результат не теряется молча, но и успехом не считается.
    await commitFailure('export_not_persisted', 'failed');
    return { ok: false, reason: 'export_not_persisted' };
  }

  // Конечный текст движка — из потока событий, а не из поля результата: в
  // контракте Runner'а текста нет. Отсутствие текста не прячется за ok=true —
  // вызывающий видит `engineText: null` и решает сам.
  const engineText = extractEngineText(seenEvents);
  const native = opts.engineName === 'dynamic-ip-azure-agent-run';
  const text = native
    ? typeof status.answer === 'string' && status.answer.trim().length > 0 ? status.answer : null
    : engineText?.text ?? result.text ?? null;
  const resolution = [...seenEvents].sort((first, second) => second.sequence - first.sequence)
    .find((event) => event.type === 'agent_exit_resolved')?.payload as { answerSource?: unknown } | undefined;
  const answerSource = native && text !== null && (resolution?.answerSource === 'agent_file' || resolution?.answerSource === 'engine_stdout')
    ? resolution.answerSource : null;
  const answer: RunnerAnswer = { text, answerSource,
    source: text === null ? null : native ? 'runner_status_answer' : engineText ? engineText.source : 'runner_result_text',
    version: text === null ? null : native ? 'runner-answer-v1' : engineText?.version ?? 'runner-answer-v1' };
  return { ok: true, result, eventsRecorded, artifacts, engineText, answer };
}
