/**
 * Структурный лог control plane (C12: eventId, источник, профиль, корреляция
 * task/run, причина). В лог НЕ пишутся текст входа, содержимое артефактов и
 * credentials — только идентификаторы, хэши и причины.
 */
import type { C12ErrorEvent, PublishErrorFn } from './error-publisher';

const SERVICE = 'trained-assist-control-plane';
const ENVIRONMENT = 'sandbox';

export interface StructuredLogFields {
  /** Имя события, напр. intake.accepted / intake.conflict / run.connection_lost. */
  event: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  profileId?: string | null;
  userTaskId?: string | null;
  runId?: string | null;
  /** Ключ идемпотентности приёма (C01 requestId). */
  requestId?: string | null;
  receiptId?: string | null;
  /** Ключ события журнала: task_events.id (sequence) либо event_id. */
  eventId?: number | string | null;
  /** Причина перехода или отказа — обязательна для отказов. */
  reason?: string | null;
  [key: string]: unknown;
}

/**
 * Второй аргумент опционален: переданный publisher вызывается только для
 * level === 'error' (C12 ErrorEvent в Error Watcher), оставшиеся вызовы
 * logStructured его не получают.
 */
export function logStructured(fields: StructuredLogFields, publishError?: PublishErrorFn | null): void {
  const line = {
    ts: new Date().toISOString(),
    service: SERVICE,
    environment: ENVIRONMENT,
    ...fields,
  };
  console.log(JSON.stringify(line));
  if (!publishError || fields.level !== 'error') return;
  void publishError(toErrorEvent(fields)).catch(() => undefined);
}

/** C12 ErrorEvent из полей структурного лога (маппинг C12/I2). */
function toErrorEvent(fields: StructuredLogFields): C12ErrorEvent {
  const profileId = typeof fields.profileId === 'string' && fields.profileId ? fields.profileId : null;
  const userTaskId = typeof fields.userTaskId === 'string' && fields.userTaskId ? fields.userTaskId : null;
  const runId = typeof fields.runId === 'string' && fields.runId ? fields.runId : null;
  return {
    schemaVersion: 1,
    eventId: fields.eventId != null ? String(fields.eventId) : crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    source: { service: SERVICE, release: ENVIRONMENT, environment: ENVIRONMENT },
    scope: { kind: profileId ? 'profile' : 'platform', tenantId: null, profileId },
    correlation: { userTaskId, runId, traceId: null },
    replyContext: { channel: null, destinationRef: null, status: 'not_applicable' },
    error: {
      code: fields.event,
      operation: fields.event,
      severity: 'error',
      retryable: true,
      outcome: 'failed',
      safeSummary: typeof fields.reason === 'string' && fields.reason ? fields.reason : fields.event,
      privateDetailsRef: null,
    },
    origin: { kind: 'application', incidentId: null, diagnosticDepth: 0 },
  };
}
