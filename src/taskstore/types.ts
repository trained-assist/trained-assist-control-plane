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

/** Закрытая лексика task_events.kind (§5.2): новый kind = значение, не миграция схемы. */
export const TASK_EVENT_KINDS = [
  'task_accepted',
  'task_status_changed',
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
] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/** Модуль-источник события (§5.2). */
export const EVENT_SOURCES = ['input', 'router', 'executor', 'output', 'gateway', 'cron', 'watcher'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** Канал-источник сигнала (§5.3). */
export const SIGNAL_SOURCES = ['telegram', 'web', 'api', 'cron', 'system'] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export type AwaitingKind = 'data' | 'choice' | 'approval';
export type AwaitingStatus = 'open' | 'answered' | 'expired' | 'cancelled';

export interface TaskRow {
  id: string;
  profile_id: string;
  project_id: string | null;
  goal: string;
  status: TaskStatus;
  stage: TaskStage | null;
  conversation_id: string | null;
  audience_id: string | null;
  destination_id: string | null;
  awaiting_input_id: string | null;
  delivery_state: string;
  generation: number;
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
