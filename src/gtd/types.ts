/**
 * Лексика GTD (P23: «GTD opt-in и bounded control», #62, этап I07).
 *
 * Источник границ — PLAYBOOKS-VS-GETTING-THINGS-DONE-BOUNDARIES:
 *  § «Решение владельца: GTD только там, где нужен следующий контроль»,
 *  §5a «gtdId — запись контроля, даже без playbook», §9 «Запрос input:
 *  durable пауза вместо живого окна агента», §11 «Минимальные новые
 *  идентификаторы».
 *
 * Второй набор терминов не заводится: gtdId — тот же идентификатор, что уже
 * живёт в schedule_occurrences.gtd_id (P22) и в user_value задачи; ожидание —
 * уже существующая строка awaiting_inputs; попытка — executions; задача —
 * durable_tasks. Новые имена только те, что перечислены в §11: gtdId,
 * continuationOwner, next trigger/check, caps.
 */

/** Состояние записи контроля (§5a: active/paused/awaiting_user/completed/cancelled). */
export const GTD_STATES = [
  'active',
  'awaiting_user',
  'waiting_condition',
  'completed',
  'cancelled',
  'stopped',
] as const;
export type GtdState = (typeof GTD_STATES)[number];

/** Состояния, из которых запись ещё может двигаться (тик их проверяет). */
export const GTD_OPEN_STATES = ['active', 'awaiting_user', 'waiting_condition'] as const;
export type GtdOpenState = (typeof GTD_OPEN_STATES)[number];

/** Исход одного шага управляемой работы (структурированный, не текст). */
export const GTD_STEP_OUTCOMES = ['succeeded', 'failed', 'awaiting_user', 'awaiting_condition'] as const;
export type GtdStepOutcome = (typeof GTD_STEP_OUTCOMES)[number];

/**
 * Что запускает следующую проверку (§12a: «Wait различает Awaiting user input,
 * external condition и timer/observation»).
 *  - `timer`     — ближайшая плановая проверка (next_check_at);
 *  - `condition` — внешнее условие (CI/гейт), ссылка в gtd_conditions;
 *  - `input`     — ответ человека, адрес в awaiting_inputs.
 */
export const GTD_TRIGGER_KINDS = ['timer', 'condition', 'input'] as const;
export type GtdTriggerKind = (typeof GTD_TRIGGER_KINDS)[number];

/** Решение GTD по одному исходу/проверке. */
export const GTD_DECISIONS = ['continue', 'wait', 'complete', 'stop', 'reject'] as const;
export type GtdDecision = (typeof GTD_DECISIONS)[number];

/** Критерий завершения: проверяемое утверждение, а не текст. */
export interface GtdCriterion {
  id: string;
  description: string;
  required: boolean;
}

/**
 * Контекст управляемой работы, который план получает от хоста (P23). Один
 * владелец продолжения — GTD; план только исполняет шаг и отчитывается.
 */
export interface ManagedGtdContext {
  gtdId: string;
  /** Стабильный идентификатор шага (§11): сохраняется между попытками. */
  stepId: string;
  attempt: number;
  /** Синтетический провайдер песочницы I07: что выдаст следующий шаг. */
  stepOutcome: GtdStepOutcome;
}


/** Один шаг сценария synthetic provider'а (песочница I07). */
export interface SyntheticStep {
  stepOutcome: GtdStepOutcome;
  criteria?: Record<string, unknown> | null;
  conditionRef?: string | null;
}

/** Сырой ввод регистрации на контроль (явный opt-in). */
export interface RegisterGtdInput {
  /** Ключ идемпотентности регистрации; scope = (profileId, requestId). */
  requestId: string;
  profileId: string;
  userTaskId: string;
  /** Зачем взята на контроль: «доведи до конца и проверь», «дождись CI и проверь интеграцию». */
  reason: string;
  criteria: GtdCriterion[];
  /** Дедлайн контроля (ms epoch). Исчерпание — bounded stop, не новый контроль. */
  deadlineAt: number;
  maxAttempts?: number;
  /** Ближайшая плановая проверка (next trigger/check). */
  nextCheckAt?: number;
  /** Кто контролирует эту запись. Не поддерживается: самоконтроль запрещён. */
  supervisedByGtdId?: string | null;
  /**
   * Сценарий synthetic provider'а песочницы I07: по одной записи на каждое
   * продолжение. В проде исход шага приходит от Runner'а (M1.3) — сценарий
   * остаётся пустым и не используется.
   */
  syntheticSteps?: SyntheticStep[] | null;
}

export interface GtdRecordRow {
  gtd_id: string;
  profile_id: string;
  user_task_id: string;
  registration_reason: string;
  criteria_json: string;
  continuation_owner: string;
  state: GtdState;
  stop_reason: string | null;
  next_trigger_kind: GtdTriggerKind | null;
  next_trigger_ref: string | null;
  next_check_at: number | null;
  deadline_at: number;
  max_attempts: number;
  attempts: number;
  current_step_id: string | null;
  control_generation: number;
  synthetic_steps_json: string | null;
  supervised_by_gtd_id: string | null;
  last_outcome: string | null;
  created_at: number;
  updated_at: number;
  revision: number;
}

export interface GtdOutcomeRow {
  outcome_id: string;
  gtd_id: string;
  profile_id: string;
  user_task_id: string;
  run_id: string | null;
  step_id: string;
  outcome: GtdStepOutcome;
  detail_json: string | null;
  event_id: number | null;
  idempotency_key: string;
  state: 'pending' | 'acked' | 'rejected' | 'quarantined';
  reason: string | null;
  attempt: number | null;
  created_at: number;
  updated_at: number;
  acked_at: number | null;
}

export interface GtdProgressionRow {
  progression_id: string;
  gtd_id: string;
  user_task_id: string;
  attempt: number;
  step_id: string;
  decision: GtdDecision;
  reason: string;
  trigger_kind: GtdTriggerKind | null;
  trigger_ref: string | null;
  outcome_id: string | null;
  continuation_run_id: string | null;
  created_at: number;
}

export interface GtdConditionRow {
  condition_ref: string;
  gtd_id: string;
  user_task_id: string;
  conclusion: 'success' | 'failure' | 'neutral';
  report_ref: string | null;
  source: string | null;
  created_at: number;
}

export interface GtdView {
  record: GtdRecordRow;
  criteria: GtdCriterion[];
  progressions: GtdProgressionRow[];
  outcomes: GtdOutcomeRow[];
}

const sha = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .slice(0, 10)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/**
 * gtdId детерминирован от (profileId, userTaskId): повторная регистрация того же
 * контроля возвращает тот же ID, а не второй. Вместе с UNIQUE(user_task_id)
 * это делает «обход caps новой записью контроля» невозможным на уровне данных.
 */
export async function deriveGtdId(profileId: string, userTaskId: string): Promise<string> {
  return `gtd-${await sha(`${profileId} ${userTaskId}`)}`;
}

export function parseCriteria(row: GtdRecordRow): GtdCriterion[] {
  try {
    const parsed = JSON.parse(row.criteria_json) as unknown;
    return Array.isArray(parsed) ? (parsed as GtdCriterion[]) : [];
  } catch {
    return [];
  }
}

/**
 * Критерии завершения проверяются ДЕТЕРМИНИРОВАННО по структурированному
 * свидетельству исхода ({criterionId: boolean}). Никакого LLM-суждения:
 * «критерий выполнен» — это факт из результата шага, а не оценка контролёра.
 */
export function evaluateCriteria(
  criteria: GtdCriterion[],
  evidence: Record<string, unknown> | null | undefined,
): { met: boolean; missing: string[]; satisfied: string[] } {
  const map = evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>) : {};
  const satisfied: string[] = [];
  const missing: string[] = [];
  for (const c of criteria) {
    if (c.required !== false && map[c.id] === true) satisfied.push(c.id);
    else if (c.required !== false) missing.push(c.id);
  }
  return { met: missing.length === 0, missing, satisfied };
}
