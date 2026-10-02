/**
 * Контракт control plane, который потребляет web-срез (M1, шаг 7).
 *
 * Это ровно тот срез HTTP-поверхности, о котором зависит web; источник истины —
 * control plane (`trained-assist-control-plane`), контракты C01/C02/C03 и PR #7
 * (поток событий с курсором). Файл намеренно НЕ импортирует внутренние модули
 * control plane: web — отдельный адаптер, и его контракт должен пережить
 * рефакторинг внутренностей (шаги 4/5 развиваются параллельно).
 *
 * Соответствие:
 *   - приём/квитанция — C01 (`POST /intake`, `GET /receipt`);
 *   - журнал и курсор — C02 (`GET /events?after=`, fallback `POST /status`);
 *   - адресат по записи в Task Store, права — C03 (`X-Principal` + scope);
 *   - терминальные состояния, попытки (runId/generation) — A2 §6.
 */

/** Версия контракта приёма, которую понимает control plane (совпадает с C01). */
export const INTAKE_CONTRACT_VERSION = 1;

/** Квитанция приёма (C01): durable acceptance — не запуск и не результат. */
export interface IntakeReceipt {
  receiptId: string;
  requestId: string | null;
  userTaskId: string;
  profileId: string;
  acceptedAt: number;
  durable: true;
  /** true — повтор с тем же ключом вернул прежнюю квитанцию. */
  duplicate: boolean;
}

/** Ранний ответ запуска: задача поставлена в очередь, результата ещё нет. */
export interface StartAck {
  taskId: string;
  instanceId: string;
  /** false — задача уже была принята (повтор submit = один запуск). */
  created: boolean;
  instanceCreated: boolean;
  generation: number;
  runId: string | null;
}

/**
 * Конверт события по C02: `eventId, userTaskId, runId?, sequence, type,
 * occurredAt, payload, artifactRefs?`. Курсор — монотонная последовательность
 * журнала (`task_events.id`).
 */
export interface ControlPlaneEvent {
  eventId: string | null;
  sequence: number;
  userTaskId: string;
  runId: string | null;
  type: string;
  occurredAt: number;
  payload: Record<string, unknown>;
  artifactRefs: string[];
  /** Исходный kind журнала (A2 §5.2) — для отладки и фолбэка по /status. */
  kind: string;
}

export interface EventPage {
  events: ControlPlaneEvent[];
  nextCursor: number | null;
  hasMore: boolean;
}

/** Способ чтения журнала: основной — C02-эндпоинт, запасной — история из /status. */
export type EventTransport = 'events-endpoint' | 'status-history';

export interface AttemptView {
  id: string;
  status: string;
  generation: number;
  started_at: number | null;
  finished_at: number | null;
  error_class: string | null;
  lease_until: number | null;
}

export interface AwaitingView {
  id: string;
  status: string;
  deadline: number | null;
  question?: string | null;
}

/** Срез статуса задачи, который видит web (только чтение, P05). */
export interface TaskStatusView {
  id: string;
  status: string;
  stage: string | null;
  generation: number;
  revision: number;
  result: unknown;
  conversation_id: string | null;
  delivery_state: string | null;
  awaiting: AwaitingView | null;
  runs: AttemptView[];
  updated_at: number | null;
}

/** Ответ на сигнал: `delivered=false` — принят, но не доставлен (или отклонён). */
export interface SignalAck {
  delivered: boolean;
  signalId: number;
  duplicate: boolean;
  reason?: string;
}

/** Явное продолжение после потери связи: новый runId, generation+1 (A3 §3.2.5). */
export interface ResumeAck {
  runId: string;
  generation: number;
}

/** Артефакт шага 4: манифест + байты по требованию web-слоя. */
export interface ArtifactManifestEntry {
  ref: string;
  sizeBytes: number | null;
  sha256: string | null;
  contentType: string | null;
}

export interface ArtifactBytes extends ArtifactManifestEntry {
  body: Uint8Array;
}

export const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'] as const;
export const UNKNOWN_ATTEMPT_STATUS = 'unknown';

export function isTerminalTaskStatus(status: string): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

/** Исход попытки неизвестен (потеря связи) — это НЕ «failed» (P06). */
export function hasUnknownOutcome(status: TaskStatusView): boolean {
  return status.runs.some((r) => r.status === UNKNOWN_ATTEMPT_STATUS) && !isTerminalTaskStatus(status.status);
}

/**
 * Транспорт, которым web читает журнал. Основной путь — курсор C02; fallback
 * нужен только для прогона против control plane, где `/events` ещё не смёржен
 * (PR #7): та же самая таблица событий, только через историю в `/status`.
 */
export interface EventStreamOptions {
  transport: 'auto' | EventTransport;
  limit: number;
}