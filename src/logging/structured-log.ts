/**
 * Структурный лог control plane (C12: eventId, источник, профиль, корреляция
 * task/run, причина). В лог НЕ пишутся текст входа, содержимое артефактов и
 * credentials — только идентификаторы, хэши и причины.
 */
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

export function logStructured(fields: StructuredLogFields): void {
  const line = {
    ts: new Date().toISOString(),
    service: 'trained-assist-control-plane',
    environment: 'sandbox',
    ...fields,
  };
  console.log(JSON.stringify(line));
}