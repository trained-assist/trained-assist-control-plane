import type { TaskStore } from '../taskstore';
import type {
  TaskRow,
  RunAttemptRow,
  DeliveryRow,
  ArtifactRow,
  AwaitingInputRow,
  TaskEventRow,
} from '../taskstore/types';

export interface TraceStep {
  step: string;
  status: string;
  timestamp: number | null;
  ageMs: number | null;
  relatedIds: string[];
  lastError: string | null;
  source: string;
}

export interface TraceResult {
  taskId: string;
  observedAt: string;
  partial: boolean;
  reason: string | null;
  steps: TraceStep[];
}

function ageMs(timestamp: number | null): number | null {
  if (!timestamp) return null;
  return Date.now() - timestamp;
}

function step(
  step: string,
  status: string,
  timestamp: number | null,
  relatedIds: string[],
  lastError: string | null,
  source: string,
): TraceStep {
  return { step, status, timestamp, ageMs: ageMs(timestamp), relatedIds, lastError, source };
}

export async function traceTask(
  store: TaskStore,
  taskId: string,
  nowMs: number = Date.now(),
): Promise<TraceResult> {
  const steps: TraceStep[] = [];
  let partial = false;
  let reason: string | null = null;

  // Admission receipt
  let receipt: unknown = null;
  try {
    receipt = await store.acceptReceipt(taskId);
  } catch (e) {
    reason = reason ?? `receipt_error:${(e as Error).message}`;
  }
  if (receipt) {
    const r = receipt as Record<string, unknown>;
    steps.push(step('admission', 'accepted', r.createdAt as number ?? null, [r.receiptId as string], null, '/receipt'));
  } else {
    steps.push(step('admission', 'not_found', null, [], null, '/receipt'));
  }

  // Task row + history
  let taskRow: unknown = null;
  try {
    taskRow = await store.statusRow(taskId);
  } catch (e) {
    reason = reason ?? `task_error:${(e as Error).message}`;
    partial = true;
  }
  if (taskRow) {
    const t = taskRow as TaskRow;
    steps.push(step('task', t.status, t.updated_at, [t.id, t.profile_id], null, '/report'));
  } else {
    steps.push(step('task', 'unknown', null, [], null, '/report'));
    partial = true;
    reason = reason ?? 'task_row_missing';
  }

  // Events (last 10, most recent first)
  let events: TaskEventRow[] = [];
  try {
    const page = await store.eventsAfter(taskId, null, 10);
    events = page.events;
  } catch (e) {
    reason = reason ?? `events_error:${(e as Error).message}`;
    partial = true;
  }
  if (events.length > 0) {
    const last = events[events.length - 1]!;
    steps.push(step('events', `${events.length} events`, last.created_at, [last.event_id ?? ''], null, '/events'));
  } else {
    steps.push(step('events', 'none', null, [], null, '/events'));
  }

  // Runs
  let runs: RunAttemptRow[] = [];
  try {
    runs = await store.listRuns(taskId);
  } catch (e) {
    reason = reason ?? `runs_error:${(e as Error).message}`;
    partial = true;
  }
  if (runs.length > 0) {
    const lastRun = runs[runs.length - 1]!;
    steps.push(step('run', lastRun.status, lastRun.started_at, [lastRun.id, lastRun.session_id ?? ''], lastRun.error_class, '/status'));
  } else {
    steps.push(step('run', 'none', null, [], null, '/status'));
  }

  // Deliveries
  let deliveries: DeliveryRow[] = [];
  try {
    deliveries = await store.listDeliveries(taskId);
  } catch (e) {
    reason = reason ?? `deliveries_error:${(e as Error).message}`;
    partial = true;
  }
  if (deliveries.length > 0) {
    const lastDelivery = deliveries[deliveries.length - 1]!;
    steps.push(step('delivery', lastDelivery.status, lastDelivery.updated_at, [lastDelivery.id, lastDelivery.provider_message_id ?? ''], lastDelivery.last_error, '/status'));
  } else {
    steps.push(step('delivery', 'none', null, [], null, '/status'));
  }

  // Artifacts
  let artifacts: ArtifactRow[] = [];
  try {
    artifacts = await store.listArtifacts(taskId);
  } catch (e) {
    reason = reason ?? `artifacts_error:${(e as Error).message}`;
    partial = true;
  }
  steps.push(step('artifacts', `${artifacts.length}`, artifacts.length > 0 ? artifacts[artifacts.length - 1]!.created_at : null, artifacts.map((a) => a.artifact_id), null, '/status'));

  // Awaiting inputs
  let awaiting: AwaitingInputRow[] = [];
  try {
    awaiting = await store.listAwaiting(taskId);
  } catch (e) {
    reason = reason ?? `awaiting_error:${(e as Error).message}`;
    partial = true;
  }
  if (awaiting.length > 0) {
    const lastAwaiting = awaiting[awaiting.length - 1]!;
    steps.push(step('awaiting', lastAwaiting.status, lastAwaiting.created_at, [lastAwaiting.awaiting_input_id], null, '/status'));
  } else {
    steps.push(step('awaiting', 'none', null, [], null, '/status'));
  }

  return { taskId, observedAt: new Date(nowMs).toISOString(), partial, reason, steps };
}
