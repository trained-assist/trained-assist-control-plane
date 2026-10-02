/**
 * Поток событий задачи по контракту C02: envelope `eventId, userTaskId, runId?,
 * sequence, type, occurredAt, payload, artifactRefs?` поверх журнала task_events.
 *
 * Источник истины один — task_events (A2 §5.2); C02-тип выводится из kind
 * события, второй журнал не заводится. Курсор — task_events.id (sequence).
 */
import type { TaskEventRow } from '../taskstore';

export interface C02EventEnvelope {
  eventId: string | null;
  sequence: number;
  userTaskId: string;
  runId: string | null;
  /** Тип события по C02: accepted, queued, started, progress, attempt_failed, waiting, stopped, result_ready, task_failed, delivery_failed. */
  type: string;
  occurredAt: number;
  payload: Record<string, unknown>;
  artifactRefs: string[];
  /** Исходный kind журнала (A2) — расширение envelope для отладки. */
  kind: string;
}

const C02_TYPE_BY_KIND: Record<string, string> = {
  task_accepted: 'accepted',
  run_started: 'started',
  run_finished: 'progress',
  awaiting_opened: 'waiting',
  awaiting_answered: 'progress',
  awaiting_expired: 'progress',
  signal_received: 'progress',
  signal_rejected: 'progress',
  step_woken: 'progress',
  step_started: 'progress',
  step_done: 'progress',
  step_failed: 'attempt_failed',
  result_ready: 'result_ready',
  task_cancelled: 'stopped',
  cancel_requested: 'progress',
  fenced: 'progress',
  error: 'progress',
};

/** task_status_changed несёт разные переходы — тип выводится из status_after. */
const C02_TYPE_BY_STATUS_AFTER: Record<string, string> = {
  done: 'result_ready',
  failed: 'task_failed',
  cancelled: 'stopped',
};

export function toC02Event(row: TaskEventRow): C02EventEnvelope {
  const payload = safeParse(row.payload_json);
  const statusAfter = row.status_after ?? null;
  const type =
    C02_TYPE_BY_KIND[row.kind] ??
    (statusAfter ? C02_TYPE_BY_STATUS_AFTER[statusAfter] : undefined) ??
    'progress';
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  const artifactRefs = Array.isArray(payload.artifactRefs) ? (payload.artifactRefs as string[]) : [];
  return {
    eventId: row.event_id,
    sequence: row.id,
    userTaskId: row.user_task_id,
    runId,
    type,
    occurredAt: row.created_at,
    payload,
    artifactRefs,
    kind: row.kind,
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}