/**
 * Контракт решения reply-or-route (P17; TASK-ROUTER-AND-MCP.md §3 и §11.3).
 *
 * Recipe возвращает РОВНО ОДИН outcome: `reply`, `clarify` или `needs_executor`.
 * Это одновременно попытка ответа и выбор следующего пути (§2), поэтому лишних
 * полей и второго формата здесь нет — «второго несовместимого API» (§11.3).
 *
 * Что контракт ЗАПРЕЩАЕТ по построению:
 *  - модель не называет исполнителя: поля `executor` нет в наборе, любое лишнее
 *    поле — `schema_invalid`, а исполнителя назначает хост (`TERMINAL_EXECUTOR`);
 *  - модель не выдаёт идентификаторы и права: `userTaskId`, `gtdId`, `waitId`,
 *    `jobRef`, `runRef`, `budget`, `authorization` — тоже запрещённые поля
 *    (§11.1: доверенная оболочка приходит от хоста);
 *  - модель не выдумывает capability: `capabilityId`/`capabilityVersion` должны
 *    существовать в ПРОВЕРЕННОМ снимке, иначе решение не исполняется;
 *  - `assessment.contextSufficient=false` вместе с `reply` не публикуется:
 *    JSON-валидность не доказывает, что контекста хватило (§11.2 шаг 4).
 *
 * Валидация двухслойная и это видно в типах исхода: сначала `parseRecipeDecision`
 * (форма: JSON, версия, набор полей, типы), затем `validateRecipeDecisionAgainst`
 * (семантика: снимок каталога, снимок прав, покрытие, длина ответа).
 */
import type { AuthorizationSnapshot, CapabilityCatalog, Coverage } from '../router-types';

/** Версия контракта решения: в лог решения идёт вместе с recipeId. */
export const DECISION_SCHEMA_VERSION = 1;

/** Идентификатор фиксированного рецепта fast path v1 (§11.2 шаг 3). */
export const RECIPE_ID = 'reply-or-route-v1';

/** Виды решения. Ровно три — как в §3. */
export const DECISION_KINDS = ['reply', 'clarify', 'needs_executor'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** Типы работы, которые модель может ПРЕДЛОЖИТЬ. Решает хост по supportedModes. */
export const PROPOSED_JOB_TYPES = ['deterministic-job', 'llm-recipe-job', 'ai-agent-job'] as const;
export type ProposedJobType = (typeof PROPOSED_JOB_TYPES)[number];

/**
 * Причины эскалации, которые модель может назвать. Узкий allowlist: свободный
 * текст в reasonCode превратил бы метрики §11.9 в мусор.
 */
export const AGENT_REASON_CODES = [
  'ADAPTIVE_TOOL_LOOP',
  'CONTEXT_NOT_COVERED',
  'ARTIFACT_WORKSPACE_REQUIRED',
  'NEEDS_CURRENT_USER_DATA',
] as const;
export type AgentReasonCode = (typeof AGENT_REASON_CODES)[number];

/** Самооценка модели — только диагностика: гейтом быстрого ответа она не является. */
export interface DecisionAssessment {
  contextSufficient: boolean;
  needsFreshData: boolean;
  needsActions: boolean;
  needsAdaptiveTools: boolean;
}

export interface RecipeReplyDecision {
  kind: 'reply';
  reply: { text: string; evidenceRefs: string[] };
  assessment: DecisionAssessment;
  /** Debug hint. Никогда не используется как разрешение fast reply (§3, §11.3). */
  confidence?: number;
}

export interface RecipeClarifyDecision {
  kind: 'clarify';
  clarify: { question: string; missingFields: string[] };
  assessment: DecisionAssessment;
  confidence?: number;
}

/** needs_executor к объявленной capability: template/handler решает хост. */
export interface RecipeCapabilityDecision {
  kind: 'needs_executor';
  proposedJobType: 'deterministic-job' | 'llm-recipe-job';
  capabilityId: string;
  capabilityVersion: number;
  arguments: Record<string, unknown>;
  reasonCode: AgentReasonCode;
  assessment: DecisionAssessment;
  confidence?: number;
}

/** needs_executor к агенту: структурированная цель ДОПОЛНЯЕТ исходный запрос. */
export interface RecipeAgentDecision {
  kind: 'needs_executor';
  proposedJobType: 'ai-agent-job';
  nextGoal: string;
  preservedConstraints: string[];
  requiredCapabilities: string[];
  reasonCode: AgentReasonCode;
  assessment: DecisionAssessment;
  confidence?: number;
}

export type RecipeDecision =
  | RecipeReplyDecision
  | RecipeClarifyDecision
  | RecipeCapabilityDecision
  | RecipeAgentDecision;

/** Поля, которые модель не имеет права возвращать ни в каком kind (§11.1). */
export const HOST_OWNED_FIELDS = [
  'executor',
  'userTaskId',
  'gtdId',
  'waitId',
  'jobRef',
  'runRef',
  'budget',
  'budgets',
  'authorization',
  'authorizationRef',
  'principalId',
  'profileId',
  'conversationId',
  'decisionId',
  'modelCalls',
  'cost',
] as const;

const BASE_FIELDS = ['schemaVersion', 'kind', 'assessment', 'confidence'];
const CAPABILITY_FIELDS = ['capabilityId', 'capabilityVersion', 'arguments'];
const AGENT_FIELDS = ['nextGoal', 'preservedConstraints', 'requiredCapabilities'];
const FIELDS_BY_JOB_TYPE: Record<ProposedJobType, string[]> = {
  'deterministic-job': CAPABILITY_FIELDS,
  'llm-recipe-job': CAPABILITY_FIELDS,
  'ai-agent-job': AGENT_FIELDS,
};

/**
 * Схема решения для провайдера. Это КОНТРАКТ, а не подсказка: те же поля
 * проверяются кодом (`parseRecipeDecision`), поэтому провайдерская «strict»
 * оптимизация не может ослабить проверку.
 */
export const RECIPE_DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: BASE_FIELDS,
  properties: {
    schemaVersion: { const: DECISION_SCHEMA_VERSION },
    kind: { enum: [...DECISION_KINDS] },
    assessment: {
      type: 'object',
      additionalProperties: false,
      required: ['contextSufficient', 'needsFreshData', 'needsActions', 'needsAdaptiveTools'],
      properties: {
        contextSufficient: { type: 'boolean' },
        needsFreshData: { type: 'boolean' },
        needsActions: { type: 'boolean' },
        needsAdaptiveTools: { type: 'boolean' },
      },
    },
    confidence: { type: 'number' },
    reply: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'evidenceRefs'],
      properties: { text: { type: 'string', minLength: 1 }, evidenceRefs: { type: 'array', items: { type: 'string' } } },
    },
    clarify: {
      type: 'object',
      additionalProperties: false,
      required: ['question', 'missingFields'],
      properties: { question: { type: 'string', minLength: 1 }, missingFields: { type: 'array', items: { type: 'string' } } },
    },
    proposedJobType: { enum: [...PROPOSED_JOB_TYPES] },
    capabilityId: { type: 'string' },
    capabilityVersion: { type: 'integer', minimum: 1 },
    arguments: { type: 'object' },
    nextGoal: { type: 'string', minLength: 1 },
    preservedConstraints: { type: 'array', items: { type: 'string' } },
    requiredCapabilities: { type: 'array', items: { type: 'string' } },
    reasonCode: { enum: [...AGENT_REASON_CODES] },
  },
} as const;

export type DecisionParseError =
  | 'not_json'
  | 'version_mismatch'
  | 'unknown_kind'
  | 'forbidden_field'
  | 'unexpected_field'
  | 'missing_field'
  | 'bad_type'
  | 'bad_reason_code';

export type DecisionParseResult =
  | { ok: true; decision: RecipeDecision }
  | { ok: false; code: DecisionParseError; field: string | null };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Набор полей, разрешённых для конкретного решения. */
function allowedFields(decision: Record<string, unknown>): Set<string> {
  const fields = new Set(BASE_FIELDS);
  const kind = decision['kind'] as DecisionKind;
  if (kind === 'reply') fields.add('reply');
  if (kind === 'clarify') fields.add('clarify');
  if (kind === 'needs_executor') {
    fields.add('proposedJobType');
    fields.add('reasonCode');
    const jobType = decision['proposedJobType'] as ProposedJobType;
    for (const field of FIELDS_BY_JOB_TYPE[jobType] ?? []) fields.add(field);
  }
  return fields;
}

/**
 * Разбор и проверка ФОРМЫ ответа модели. Никакой семантики: только версия,
 * набор полей, типы и allowlist причин.
 */
export function parseRecipeDecision(raw: string): DecisionParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'not_json', field: null };
  }
  if (!isPlainObject(parsed)) return { ok: false, code: 'bad_type', field: null };

  const forbidden = HOST_OWNED_FIELDS.find((field) => field in parsed);
  if (forbidden) return { ok: false, code: 'forbidden_field', field: forbidden };

  if (parsed['schemaVersion'] !== DECISION_SCHEMA_VERSION) {
    return { ok: false, code: 'version_mismatch', field: 'schemaVersion' };
  }
  const kind = parsed['kind'];
  if (typeof kind !== 'string' || !(DECISION_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, code: 'unknown_kind', field: 'kind' };
  }

  const allowed = allowedFields({ ...parsed, kind: kind as DecisionKind });
  for (const field of Object.keys(parsed)) {
    if (!allowed.has(field)) return { ok: false, code: 'unexpected_field', field };
  }

  const assessment = parsed['assessment'];
  if (!isPlainObject(assessment)) return { ok: false, code: 'bad_type', field: 'assessment' };
  for (const flag of ['contextSufficient', 'needsFreshData', 'needsActions', 'needsAdaptiveTools'] as const) {
    if (typeof assessment[flag] !== 'boolean') return { ok: false, code: 'bad_type', field: `assessment.${flag}` };
  }
  if ('confidence' in parsed && typeof parsed['confidence'] !== 'number') {
    return { ok: false, code: 'bad_type', field: 'confidence' };
  }

  if (kind === 'reply') {
    const reply = parsed['reply'];
    if (!isPlainObject(reply)) return { ok: false, code: 'missing_field', field: 'reply' };
    for (const field of Object.keys(reply)) {
      if (field !== 'text' && field !== 'evidenceRefs') return { ok: false, code: 'unexpected_field', field: `reply.${field}` };
    }
    if (typeof reply['text'] !== 'string' || reply['text'].trim().length === 0) {
      return { ok: false, code: 'bad_type', field: 'reply.text' };
    }
    if (!isStringArray(reply['evidenceRefs'])) return { ok: false, code: 'bad_type', field: 'reply.evidenceRefs' };
    const decision: RecipeReplyDecision = {
      kind: 'reply',
      reply: { text: reply['text'], evidenceRefs: reply['evidenceRefs'] },
      assessment: assessmentOf(parsed),
      ...confidenceOf(parsed),
    };
    return { ok: true, decision };
  }

  if (kind === 'clarify') {
    const clarify = parsed['clarify'];
    if (!isPlainObject(clarify)) return { ok: false, code: 'missing_field', field: 'clarify' };
    for (const field of Object.keys(clarify)) {
      if (field !== 'question' && field !== 'missingFields') {
        return { ok: false, code: 'unexpected_field', field: `clarify.${field}` };
      }
    }
    if (typeof clarify['question'] !== 'string' || clarify['question'].trim().length === 0) {
      return { ok: false, code: 'bad_type', field: 'clarify.question' };
    }
    if (!isStringArray(clarify['missingFields'])) return { ok: false, code: 'bad_type', field: 'clarify.missingFields' };
    const decision: RecipeClarifyDecision = {
      kind: 'clarify',
      clarify: { question: clarify['question'], missingFields: clarify['missingFields'] },
      assessment: assessmentOf(parsed),
      ...confidenceOf(parsed),
    };
    return { ok: true, decision };
  }

  // needs_executor: proposedJobType решает, какой набор полей обязателен.
  const jobType = parsed['proposedJobType'];
  if (typeof jobType !== 'string' || !(PROPOSED_JOB_TYPES as readonly string[]).includes(jobType)) {
    return { ok: false, code: 'bad_type', field: 'proposedJobType' };
  }
  const capabilityJobType = jobType as 'deterministic-job' | 'llm-recipe-job';
  const reasonCode = parsed['reasonCode'];
  if (typeof reasonCode !== 'string' || !(AGENT_REASON_CODES as readonly string[]).includes(reasonCode)) {
    return { ok: false, code: 'bad_reason_code', field: 'reasonCode' };
  }
  const agentReasonCode = reasonCode as AgentReasonCode;
  if (jobType === 'ai-agent-job') {
    if (typeof parsed['nextGoal'] !== 'string' || parsed['nextGoal'].trim().length === 0) {
      return { ok: false, code: 'bad_type', field: 'nextGoal' };
    }
    if (!isStringArray(parsed['preservedConstraints'])) {
      return { ok: false, code: 'bad_type', field: 'preservedConstraints' };
    }
    if (!isStringArray(parsed['requiredCapabilities'])) {
      return { ok: false, code: 'bad_type', field: 'requiredCapabilities' };
    }
    const decision: RecipeAgentDecision = {
      kind: 'needs_executor',
      proposedJobType: 'ai-agent-job',
      nextGoal: parsed['nextGoal'],
      preservedConstraints: parsed['preservedConstraints'],
      requiredCapabilities: parsed['requiredCapabilities'],
      reasonCode: agentReasonCode,
      assessment: assessmentOf(parsed),
      ...confidenceOf(parsed),
    };
    return { ok: true, decision };
  }

  if (typeof parsed['capabilityId'] !== 'string' || parsed['capabilityId'].trim().length === 0) {
    return { ok: false, code: 'bad_type', field: 'capabilityId' };
  }
  if (!Number.isInteger(parsed['capabilityVersion']) || (parsed['capabilityVersion'] as number) < 1) {
    return { ok: false, code: 'bad_type', field: 'capabilityVersion' };
  }
  if (!isPlainObject(parsed['arguments'])) return { ok: false, code: 'bad_type', field: 'arguments' };
  const decision: RecipeCapabilityDecision = {
    kind: 'needs_executor',
    proposedJobType: capabilityJobType,
    capabilityId: parsed['capabilityId'],
    capabilityVersion: parsed['capabilityVersion'] as number,
    arguments: parsed['arguments'],
    reasonCode: agentReasonCode,
    assessment: assessmentOf(parsed),
    ...confidenceOf(parsed),
  };
  return { ok: true, decision };
}

/** Самооценка модели: проверена по флагам выше, поэтому здесь только сборка. */
function assessmentOf(parsed: Record<string, unknown>): DecisionAssessment {
  const assessment = parsed['assessment'] as Record<string, unknown>;
  return {
    contextSufficient: assessment['contextSufficient'] as boolean,
    needsFreshData: assessment['needsFreshData'] as boolean,
    needsActions: assessment['needsActions'] as boolean,
    needsAdaptiveTools: assessment['needsAdaptiveTools'] as boolean,
  };
}

function confidenceOf(parsed: Record<string, unknown>): { confidence?: number } {
  return typeof parsed['confidence'] === 'number' ? { confidence: parsed['confidence'] } : {};
}

/**
 * Префиксы ссылок, на которые ответ имеет право опираться. Пустой список
 * `evidenceRefs` допустим: рассуждение по тексту пользователя не требует
 * внешних цитат (§11.3), а вот ссылка «куда попало» обязана быть адресной.
 */
export const EVIDENCE_REF_PREFIXES = [
  'catalog:',
  'capabilities:',
  'policy:',
  'host:',
  'task_store:',
  'connection_state:',
  'clock:',
  'profile_fields:',
  'awaiting:',
] as const;

export type DecisionSemanticError =
  | 'reply_text_too_long'
  | 'reply_without_context'
  | 'evidence_ref_not_grounded'
  | 'clarify_question_too_long'
  | 'unknown_capability'
  | 'capability_version_mismatch'
  | 'capability_not_granted'
  | 'capability_mode_not_allowed'
  | 'capability_arguments_not_allowed'
  | 'agent_goal_too_long'
  | 'agent_context_invalid'
  | 'agent_requires_confirmation_not_declared';

export type DecisionSemanticResult =
  | { ok: true; decision: RecipeDecision; groundedRefs: string[] }
  | { ok: false; code: DecisionSemanticError; field: string | null };

/** Всё, что нужно для проверки решения против СНИМКА хоста, а не против текста. */
export interface SemanticContext {
  catalog: CapabilityCatalog;
  authorization: AuthorizationSnapshot;
  coverage: Coverage;
  /**
   * Известные хосту поля профиля (например `email` со значением null). Clarify по
   * такому полю — это required_input с типизированным ожиданием, а не
   * «просто уточните» (§11.2 шаг 1, §11.4).
   */
  knownProfileFields: string[];
  /** Внешнее действие в исходном запросе: агент обязан запросить подтверждение. */
  requiresExternalAction: boolean;
}

const MAX_REPLY_CHARS = 4000;
const MAX_QUESTION_CHARS = 600;
const MAX_GOAL_CHARS = 2000;

/**
 * Семантическая проверка решения против снимка хоста. Валидный JSON здесь ещё
 * не исполняется: capability существует, версия совпадает, режим разрешён,
 * право подтверждено снимком, ответ опирается на адресные ссылки.
 */
export function validateRecipeDecisionAgainst(
  decision: RecipeDecision,
  ctx: SemanticContext,
): DecisionSemanticResult {
  if (decision.kind === 'reply') {
    if (decision.reply.text.length > MAX_REPLY_CHARS) {
      return { ok: false, code: 'reply_text_too_long', field: 'reply.text' };
    }
    if (!decision.assessment.contextSufficient) {
      // Ответ при недостаточном контексте не публикуется: это не «уточнение» и
      // не тихая эскалация, а insufficient_context (§11.6.3).
      return { ok: false, code: 'reply_without_context', field: 'assessment.contextSufficient' };
    }
    const groundedRefs: string[] = [];
    for (const ref of decision.reply.evidenceRefs) {
      if (!EVIDENCE_REF_PREFIXES.some((prefix) => ref.startsWith(prefix)) || ref.length > 200) {
        return { ok: false, code: 'evidence_ref_not_grounded', field: 'reply.evidenceRefs' };
      }
      groundedRefs.push(ref);
    }
    return { ok: true, decision, groundedRefs };
  }

  if (decision.kind === 'clarify') {
    if (decision.clarify.question.length > MAX_QUESTION_CHARS) {
      return { ok: false, code: 'clarify_question_too_long', field: 'clarify.question' };
    }
    return { ok: true, decision, groundedRefs: [] };
  }

  if (decision.proposedJobType === 'ai-agent-job') {
    if (decision.nextGoal.length > MAX_GOAL_CHARS) {
      return { ok: false, code: 'agent_goal_too_long', field: 'nextGoal' };
    }
    if (ctx.requiresExternalAction && !decision.assessment.needsActions) {
      // Внешнее действие в исходном запросе, а решение его не декларирует:
      // подтверждение не может потеряться при reformulation (§11.3).
      return { ok: false, code: 'agent_requires_confirmation_not_declared', field: 'assessment.needsActions' };
    }
    if (
      decision.preservedConstraints.length > 8 ||
      decision.preservedConstraints.some((constraint) => constraint.trim().length === 0 || constraint.length > 160) ||
      decision.requiredCapabilities.length > 10 ||
      decision.requiredCapabilities.some((id) => id.trim().length === 0 || id.length > 80)
    ) {
      return { ok: false, code: 'agent_context_invalid', field: 'preservedConstraints|requiredCapabilities' };
    }
    for (const capabilityId of new Set(decision.requiredCapabilities)) {
      const capability = ctx.catalog.capabilities.find((entry) => entry.id === capabilityId);
      if (!capability) return { ok: false, code: 'unknown_capability', field: 'requiredCapabilities' };
      if (
        !ctx.authorization.grantedCapabilityIds.includes(capabilityId) ||
        (capability.integrationId !== null && !ctx.authorization.grantedIntegrationIds.includes(capability.integrationId))
      ) {
        return { ok: false, code: 'capability_not_granted', field: 'requiredCapabilities' };
      }
    }
    return { ok: true, decision, groundedRefs: [] };
  }

  const entry = ctx.catalog.capabilities.find((c) => c.id === decision.capabilityId);
  if (!entry) return { ok: false, code: 'unknown_capability', field: 'capabilityId' };
  if (entry.version !== decision.capabilityVersion) {
    return { ok: false, code: 'capability_version_mismatch', field: 'capabilityVersion' };
  }
  if (!ctx.authorization.grantedCapabilityIds.includes(entry.id)) {
    // Право подтверждает снимок идентичности, а не выбор модели (AC-126).
    return { ok: false, code: 'capability_not_granted', field: 'capabilityId' };
  }
  const mode = decision.proposedJobType === 'deterministic-job' ? 'deterministic' : 'llm';
  if (!entry.supportedModes.includes(mode)) {
    return { ok: false, code: 'capability_mode_not_allowed', field: 'proposedJobType' };
  }
  return { ok: true, decision, groundedRefs: [`catalog:${ctx.catalog.version}:${entry.id}`] };
}

/** Короткая причина для журнала: значение, не текст (метрики §11.9). */
export const DECISION_PARSE_ERROR_CODES: readonly DecisionParseError[] = [
  'not_json',
  'version_mismatch',
  'unknown_kind',
  'forbidden_field',
  'unexpected_field',
  'missing_field',
  'bad_type',
  'bad_reason_code',
];

export const DECISION_SEMANTIC_ERROR_CODES: readonly DecisionSemanticError[] = [
  'reply_text_too_long',
  'reply_without_context',
  'evidence_ref_not_grounded',
  'clarify_question_too_long',
  'unknown_capability',
  'capability_version_mismatch',
  'capability_not_granted',
  'capability_mode_not_allowed',
  'capability_arguments_not_allowed',
  'agent_goal_too_long',
  'agent_context_invalid',
  'agent_requires_confirmation_not_declared',
];
