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
 *    `task_artifacts` (ссылка, не байты). Экспорт не подтверждён
 *    (`persistence != 'persisted'`) — задача не завершается успехом молча.
 */
import type { TaskStore, TaskEventKind } from '../taskstore';
import type { RunnerApiAdapter, RunnerResult, RunnerStatusView } from './runner-api-adapter';

export interface AwaitRunnerResultOptions {
  runId: string;
  taskId: string;
  generation: number;
  pollSec?: number;
  timeoutSec?: number;
}

export type AwaitRunnerResult =
  | { ok: true; result: RunnerResult; eventsRecorded: number }
  | { ok: false; reason: 'connection_lost' | 'runner_timeout' | 'runner_unavailable' };

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
      return finalize(adapter, store, opts, status.state);
    }

    if (Date.now() >= deadline) return { ok: false, reason: 'runner_timeout' };
    await new Promise((resolve) => setTimeout(resolve, pollSec * 1000));
  }
}

async function finalize(
  adapter: RunnerApiAdapter,
  store: TaskStore,
  opts: AwaitRunnerResultOptions,
  state: string,
): Promise<AwaitRunnerResult> {
  // События по курсору: читаем с нуля, записываем в журнал с курсором в payload.
  let cursor = 0;
  let eventsRecorded = 0;
  for (;;) {
    const page = await adapter.events(opts.runId, cursor, 500);
    for (const event of page.events) {
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

  // Финализация артефактов: ссылки на сохранённые выходы Runner'а.
  for (const ref of result.outputRefs) {
    await store.recordArtifact({
      taskId: opts.taskId,
      kind: 'file',
      artifactRef: ref,
      runId: opts.runId,
      generation: opts.generation,
    });
  }

  if (result.persistence !== 'persisted') {
    // Экспорт не подтверждён: результат не теряется молча, но и успехом не считается.
    await store.commit(opts.taskId, opts.generation, {
      status: 'failed',
      kind: 'task_status_changed',
      step: 'finalize',
      result: {
        reason: 'export_not_persisted',
        runId: result.runId,
        ownerGeneration: result.ownerGeneration,
        persistence: result.persistence,
        exitReason: result.exitReason,
      },
      payload: { runId: result.runId, persistence: result.persistence, exitReason: result.exitReason },
    });
    return { ok: false, reason: 'runner_timeout' };
  }

  if (state !== 'succeeded') {
    await store.commit(opts.taskId, opts.generation, {
      status: 'failed',
      kind: 'task_status_changed',
      step: 'finalize',
      result: {
        reason: result.exitReason,
        runId: result.runId,
        ownerGeneration: result.ownerGeneration,
        failure: result.failure ?? null,
      },
      payload: { runId: result.runId, exitReason: result.exitReason, failure: result.failure ?? null },
    });
    return { ok: false, reason: 'runner_timeout' };
  }

  return { ok: true, result, eventsRecorded };
}
