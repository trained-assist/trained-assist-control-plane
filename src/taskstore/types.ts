// Типы Task Store v1.
// Источники: TASK-STORE-SCHEMA-V1.md §5–§6 (лексика статусов/событий, форма строк),
// CONVERSATIONAL-SESSION-CONTRACT.md §2.1 (что живёт в Task Store).

/** Единственная колонка состояния задачи (§5.4, CHECK в 0001_task_store_v1.sql). */
export const TASK_STATUSES = [
  'draft',
  'active',
  'paused',
  'blocked',
  'awaiting_input',
  'done',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Терминальные статусы неизменяемы — guard в TaskStore.commit (issue #90). */
export const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** Фрагмент SQL-предиката; держать в согласии с TERMINAL_STATUSES. */
export const TERMINAL_STATUS_SQL = `'${TERMINAL_STATUSES.join("','")}'`;

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Тонкая грань состояния рядом со status (§5.4). */
export const TASK_STAGES = [
  'collecting',
  'preparing',
  'queued',
  'handing_off',
  'running',
  'evaluating',
  'waiting_input',
  'waiting_followup',
  'finished',
] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

/**
 * Стадии «принято, но не начато»: задача durable, но Run ещё не стартовал.
 * Именно у них обязан быть start_deadline_at — верхняя граница ожидания
 * (arch#132 R1/R2; репро — инцидент tg-bot 2026-10-04, PR #345).
 */
export const PRE_START_STAGES = ['collecting', 'preparing', 'queued', 'handing_off'] as const;
export type PreStartStage = (typeof PRE_START_STAGES)[number];

export function isPreStartStage(stage: string | null | undefined): stage is PreStartStage {
  return !!stage && (PRE_START_STAGES as readonly string[]).includes(stage);
}

/**
 * Сколько принятый вход может ждать старта, прежде чем это дефект.
 *
 * Верхняя граница, а не «обычное время»: нарушение видно детектором (arch#132
 * R3), а не догадкой. Значение — с запасом относительно нормального пути
 * (приём → Router → движок), но заведомо меньше времени, за которое пользователь
 * успевает решить, что «бот сдох».
 */
export const DEFAULT_START_DEADLINE_MS = 10 * 60_000;

/** Закрытая лексика task_events.kind (§5.2): новый kind = значение, не миграция схемы. */
export const TASK_EVENT_KINDS = [
  'task_accepted',
  'task_status_changed',
  'progress',
  'step_claimed',
  'step_started',
  'step_parked',
  'step_woken',
  'step_done',
  'step_failed',
  'run_started',
  'run_finished',
  'awaiting_opened',
  'awaiting_answered',
  'awaiting_expired',
  'signal_received',
  'signal_rejected',
  'fenced',
  'cancel_requested',
  'task_cancelled',
  'result_ready',
  'delivery_queued',
  'delivery_sent',
  'delivery_failed',
  'error',
  /** Продолжение, выданное Output (P17): ключ идемпотентности — decisionId. */
  'continuation.created',
  'routing.selected',
] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/** Модуль-источник события (§5.2). */
export const EVENT_SOURCES = ['input', 'router', 'executor', 'output', 'gateway', 'cron', 'watcher'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export interface NativeStopEvidence {
  taskId: string;
  profileId: string;
  attemptId: string;
  runId: string;
  ownerGeneration: number;
  state: 'succeeded' | 'failed' | 'cancelled';
  exitObserved: true;
}

export interface CpStopTarget {
  requestId: string;
  userTaskId: string;
  profileId: string;
  receiptId: string;
  taskGeneration: number;
  attempts: { attemptId: string; ownerGeneration: number; runId: string | null; idempotencyKey: string }[];
}

export interface CpStopWindowRow {
  profile_id: string;
  conversation_id: string;
  window_id: string;
  snapshot_id: string;
  admission_request_ids_json: string;
  targets_json: string;
  stop_confirmed: number;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

export type CpStopTargetResolution =
  | { ok: true; targets: CpStopTarget[] }
  | { ok: false; reason: 'admission_unknown' | 'receipt_missing' | 'identity_mismatch' };

/** Канал-источник сигнала (§5.3). */
export const SIGNAL_SOURCES = ['telegram', 'web', 'api', 'cron', 'system'] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export type AwaitingKind = 'data' | 'choice' | 'approval';

/**
 * Зачем спрашиваем человека (эпик #109 шаг 5). Форма ответа остаётся kind
 * (A2 §5.4); маппинг purpose -> kind живёт в src/awaiting/purpose.ts.
 */
export type AwaitingPurpose = 'preference' | 'missing_fact' | 'credential' | 'approval';
export type AwaitingStatus = 'open' | 'answered' | 'expired' | 'cancelled';

export interface TaskRow {
  id: string;
  profile_id: string;
  project_id: string | null;
  goal: string;
  status: TaskStatus;
  stage: TaskStage | null;
  /**
   * Верхняя граница ожидания старта (NULL у started/terminal). Заполняется при
   * приёме, сбрасывается в NULL при старте Run (миграция 0008).
   */
  start_deadline_at: number | null;
  conversation_id: string | null;
  audience_id: string | null;
  destination_id: string | null;
  awaiting_input_id: string | null;
  delivery_state: string;
  generation: number;
  /** Структурированный терминальный результат задачи (аддитивная колонка §6). */
  result_json: string | null;
  created_at: number;
  updated_at: number;
  revision: number;
  playbook_id: string | null;
  playbook_version: number | null;
  user_value: string | null;
  acceptance_criteria_json: string | null;
  contract_revision: number;
  execution_policy_json: string | null;
  execution_session_id: string | null;
  request_id: string | null;
  blocker_reason: string | null;
  hooks_json: string | null;
  parent_task_id: string | null;
  parent_item_id: string | null;
  batch_item_key: string | null;
  origin_session_id: string | null;
  origin_chat_json: string | null;
}

/**
 * Строка task_events. `task_item_id` хранит имя шага воркфлоу, пока таблицы
 * task_items нет в скоупе M1.1 (колонка в схеме — TEXT без FK).
 */
export interface TaskEventRow {
  id: number;
  event_id: string | null;
  user_task_id: string;
  task_item_id: string | null;
  execution_id: string | null;
  kind: string;
  status_before: string | null;
  status_after: string | null;
  generation: number | null;
  source: string;
  payload_json: string;
  created_at: number;
}

export interface TaskSignalRow {
  id: number;
  user_task_id: string;
  step_key: string;
  idempotency_key: string;
  event_type: string;
  payload_json: string;
  generation: number | null;
  source: string;
  created_at: number;
  consumed_at: number | null;
  consumed_by_execution: string | null;
  rejected_reason: string | null;
}

export interface AwaitingInputRow {
  awaiting_input_id: string;
  user_task_id: string;
  task_item_id: string | null;
  run_id: string | null;
  kind: AwaitingKind;
  question: string;
  schema_json: string | null;
  respondent_scope: string;
  checkpoint_ref: string | null;
  status: AwaitingStatus;
  created_at: number;
  deadline_at: number;
  answered_at: number | null;
  answer_signal_id: number | null;
  answer_json: string | null;
  generation: number;
  version: number;
  /** Зачем спрашиваем; kind — форма ответа. */
  purpose: AwaitingPurpose | null;
  /** Ссылки движка (#115): корреляция, не идентичность. */
  engine_session_ref: string | null;
  engine_request_ref: string | null;
  tool_call_ref: string | null;
}

export interface ConversationRow {
  conversation_id: string;
  profile_id: string;
  project_id: string | null;
  audience_id: string | null;
  destination_id: string | null;
  title: string | null;
  active: number;
  created_at: number;
  updated_at: number;
  revision: number;
}

/** Принципал приёма: identity + профиль + выданные scope (P04/C13). */
export interface PrincipalRow {
  principalId: string;
  profileId: string;
  scopes: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Scope приёма (P04 «scope»). Только владение и изменение задач; выбор движка,
 * региона и квоты — это C04/placement policy и вне control plane.
 */
export const ADMISSION_SCOPES = ['tasks:intake', 'tasks:read', 'tasks:signal', 'tasks:control'] as const;
export type AdmissionScope = (typeof ADMISSION_SCOPES)[number];

/** Попытка исполнения (runId): строка executions (A2 §6). */
export interface RunAttemptRow {
  id: string;
  task_id: string;
  session_id: string | null;
  engine: string | null;
  model: string | null;
  /** running | unknown | success | failed | interrupted | cancelled | waiting. */
  status: string;
  generation: number;
  started_at: number;
  finished_at: number | null;
  error_class: string | null;
  error_text: string | null;
  result_json: string | null;
  last_heartbeat_at: number | null;
  lease_until: number | null;
}

export type RunOutcome = 'success' | 'failed' | 'interrupted' | 'cancelled';

/** Доставка (outbox): свой статус, отдельный от исполнения (C02, A2 §5.5). */
export interface DeliveryRow {
  id: string;
  user_task_id: string;
  event_id: number | null;
  logical_message_id: string;
  conversation_id: string | null;
  audience_id: string | null;
  destination_id: string | null;
  channel: string;
  message_json: string;
  status: string;
  attempt: number;
  next_attempt_at: number | null;
  last_error: string | null;
  provider_message_id: string | null;
  created_at: number;
  updated_at: number;
}

/** Ссылка на артефакт: байты в Artifact Storage (ARCHITECTURE §4.1). */
export interface ArtifactRow {
  artifact_id: string;
  user_task_id: string;
  kind: string;
  artifact_ref: string;
  size_bytes: number | null;
  checksum: string | null;
  run_id: string | null;
  created_at: number;
}

/**
 * Принятый вход ДО запуска (arch#132 R9, миграция 0009).
 *
 * Лёгкая запись «штука, принятая шлюзом, ещё не ставшая задачей»: НЕ пользовательская
 * задача (её lifecycle с попытками и результатом здесь не нужен), но достаточно,
 * чтобы внешний детектор видел вход, застрявший между приёмом шлюзом и admitTask.
 */
export interface PendingInputRow {
  batch_id: string;
  version: number;
  profile_id: string;
  channel: string | null;
  conversation_id: string | null;
  audience_id: string | null;
  destination_id: string | null;
  /** Время ПЕРВОГО сообщения пакета; новые сообщения его НЕ перебивают. */
  first_message_at: number;
  message_count: number;
  prep_state: 'collecting' | 'preparing' | 'ready' | 'failed' | 'admitted';
  deadline_at: number | null;
  /** Связь с задачей после admitTask; NULL пока задачи нет. */
  user_task_id: string | null;
  created_at: number;
  updated_at: number;
}

/** Состояния подготовки пакета до admitTask. */
export const PREP_STATES = ['collecting', 'preparing', 'ready', 'failed', 'admitted'] as const;
export type PrepState = (typeof PREP_STATES)[number];

/**
 * Граница ожидания для ещё не принятой задачи. Короче, чем у задачи: пока задачи
 * нет, пользователь ещё ничего не видит, и молчание тут заметнее.
 */
export const DEFAULT_PENDING_INPUT_DEADLINE_MS = 5 * 60_000;

/** Операторский алерт по инциденту «принято, но не начато» (arch#132 R4). */
export interface StuckInputAlertRow {
  incident_id: string;
  alerted_at: number;
  last_seen_at: number | null;
  /** Сколько раз планировщик видел инцидент; сам алерт отправляется один раз. */
  count: number;
}

/** Отметка работоспособности планировщика watchdog (arch#132 П3c). */
export interface WatchdogHealthRow {
  id: number;
  last_run_at: number;
  scanned: number;
  queued: number;
  delivered: number;
  skipped_stale: number;
  alerts: number;
  oldest_age_ms: number | null;
}
