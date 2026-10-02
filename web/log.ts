/**
 * Структурный лог web-слоя в формате C12: событие, профиль, корреляция
 * task/run, ключ события журнала и причина перехода.
 *
 * В лог НЕ пишутся: ключ доступа, текст сообщения пользователя, содержимое
 * артефактов. Идентификаторы и причины — можно и нужно.
 */

export interface WebLogFields {
  /** Имя события, напр. web.intake.accepted / web.events.transport. */
  event: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  profileId?: string | null;
  conversationId?: string | null;
  userTaskId?: string | null;
  runId?: string | null;
  /** Ключ идемпотентности (C01 requestId / signal idempotencyKey). */
  requestId?: string | null;
  receiptId?: string | null;
  /** Ключ события журнала: sequence (task_events.id) либо event_id. */
  eventId?: number | string | null;
  /** Курсор чтения журнала. */
  cursor?: number | null;
  /** Причина перехода/отказа — обязательна для отказов. */
  reason?: string | null;
  [key: string]: unknown;
}

export type WebLogSink = (line: string) => void;

const defaultSink: WebLogSink = (line) => {
  console.log(line);
};

/** Имена полей, значение которых никогда не попадает в лог. */
const REDACTED = new Set(['apiKey', 'authorization', 'x-principal-secret', 'secret', 'token', 'answer', 'text', 'payload']);

const redact = (fields: WebLogFields): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACTED.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
};

export function logWeb(fields: WebLogFields, sink: WebLogSink = defaultSink): void {
  const line = {
    ts: new Date().toISOString(),
    service: 'trained-assist-web-slice',
    environment: 'sandbox',
    ...redact(fields),
  };
  sink(JSON.stringify(line));
}