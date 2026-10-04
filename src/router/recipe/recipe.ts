/**
 * Bounded reply-or-route recipe (P17; §2, §11.2 шаги 3–7).
 *
 * Один полезный вызов: модель без инструментов получает подготовленные данные и
 * возвращает ровно одно решение — reply, clarify или needs_executor. Дальше
 * оркестрация ограничена явно:
 *
 *  - бюджет проверяется ДО платного вызова: нулевой остаток — это
 *    `budget_denied` без единого вызова модели (§11.2, FR-063);
 *  - ремонт схемы — максимум один вызов, и только для формы (не для таймаута,
 *    отказа провайдера и обрезки: повтор там не помогает);
 *  - семантически невалидное решение не исполняется: неизвестная capability,
 *    несовпадающая версия, неразрешённый режим и ответ при
 *    `contextSufficient=false` дают отдельные исходы, а не «ответ примерно»;
 *  - ни один технический исход не включает исполнителя: `escalationAttempt`
 *    остаётся false, продолжение не запрашивается (§11.3).
 *
 * Модель не вызывает capability и не выбирает исполнителя: данные приносит
 * host-owned обработчик, исполнителя назначает хост.
 */
import type { Coverage, RoutingDecision, RoutingInput } from '../router-types';
import {
  DECISION_SCHEMA_VERSION,
  RECIPE_ID,
  parseRecipeDecision,
  validateRecipeDecisionAgainst,
  type AgentReasonCode,
  type DecisionSemanticError,
  type DecisionSemanticResult,
  type RecipeDecision,
} from './decision-contract';
import type { PreparedCapabilityData } from './host-data';
import { MAX_RECIPE_CALLS, RECIPE_SYSTEM_PROMPT, type FixedModelPort, type FixedModelRequest, type FixedModelResponse } from './fixed-model';

export type RecipeResult =
  | { kind: 'reply'; text: string; evidenceRefs: string[]; modelCalls: number; assessment: RecipeDecision['assessment'] }
  | { kind: 'clarify'; question: string; missingFields: string[]; modelCalls: number }
  | { kind: 'awaiting_input'; question: string; missingFields: string[]; modelCalls: number }
  | {
      kind: 'needs_executor';
      reasonCode: AgentReasonCode;
      nextGoal: string;
      preservedConstraints: string[];
      requiredCapabilities: string[];
      partialResultRef: string | null;
      modelCalls: number;
      origin: 'model' | 'host_handler';
      assessment: RecipeDecision['assessment'];
    }
  | {
      kind: 'needs_capability';
      capabilityId: string;
      capabilityVersion: number;
      arguments: Record<string, unknown>;
      reasonCode: AgentReasonCode;
      modelCalls: number;
      assessment: RecipeDecision['assessment'];
    }
  | { kind: 'insufficient_context'; missingRefs: string[]; modelCalls: number }
  | { kind: 'blocked'; reasonCode: string; detail: string | null; modelCalls: number }
  | { kind: 'schema_invalid'; detail: string | null; modelCalls: number; repairAttempts: number }
  | { kind: 'timeout'; modelCalls: number }
  | { kind: 'provider_failure'; code: string; modelCalls: number }
  | { kind: 'budget_denied'; modelCalls: number }
  | { kind: 'refused'; modelCalls: number }
  | { kind: 'truncated'; modelCalls: number };

export interface RecipeRunParams {
  input: RoutingInput;
  decision: RoutingDecision;
  /** Данные от host-обработчика: модель их не добывает и не выбирает. */
  preparedData: PreparedCapabilityData | null;
  /** Поля профиля, известные хосту: clarify по ним = required_input. */
  knownProfileFields: string[];
  /** Внешнее действие в исходном запросе: подтверждение не теряется. */
  requiresExternalAction: boolean;
  /** Покрытие входа на момент решения: видно модели и в журнале. */
  coverage: Coverage;
  deadlineMs: number;
  maxOutputTokens?: number;
}

export interface RecipeDeps {
  model: FixedModelPort;
  /** Остаток платных вызовов модели: проверяется до вызова. */
  llmCallsRemaining: number;
}

/** Порт рецепта для RouteService: один вызов, один исход. */
export type ReplyOrRouteRunner = (params: {
  input: RoutingInput;
  decision: RoutingDecision;
  preparedData: PreparedCapabilityData | null;
}) => Promise<RecipeResult>;

export function createReplyOrRouteRunner(deps: {
  model: FixedModelPort;
  llmCallsRemaining: () => number;
  deadlineMs?: number;
  maxOutputTokens?: number;
}): ReplyOrRouteRunner {
  const deadlineMs = deps.deadlineMs ?? 15_000;
  const maxOutputTokens = deps.maxOutputTokens ?? 1200;
  return async ({ input, decision, preparedData }) =>
    runReplyOrRoute(
      {
        input,
        decision,
        preparedData,
        knownProfileFields: Object.keys(input.hostFacts.profileFields),
        requiresExternalAction: decision.requiresExternalAction,
        coverage: decision.coverage,
        deadlineMs,
        maxOutputTokens,
      },
      { model: deps.model, llmCallsRemaining: deps.llmCallsRemaining() },
    );
}

/**
 * Один проход рецепта. Возвращает ТИПИЗИРОВАННЫЙ исход: ни один из них не
 * является «ответом примерно» и ни один не запускает исполнителя молча.
 */
export async function runReplyOrRoute(params: RecipeRunParams, deps: RecipeDeps): Promise<RecipeResult> {
  const { input, decision, preparedData } = params;
  const modelCalls = { count: 0 };

  // Бюджет — до платного вызова. Ноль остатка не превращается в вызов модели и
  // не превращается в агента: это честный blocked (§11.2, FR-063).
  if (deps.llmCallsRemaining <= 0) {
    return { kind: 'budget_denied', modelCalls: 0 };
  }

  const request = buildRequest(params, decision.decisionId);
  const first = await invoke(deps.model, request, modelCalls);
  const parsed = await interpret(first, params, modelCalls, deps, request);
  return parsed;
}

/** Запрос модели: фиксированная система + подготовленные данные, без инструментов. */
function buildRequest(params: RecipeRunParams, decisionId: string): FixedModelRequest {
  const { input, preparedData } = params;
  const catalog = input.catalog;
  return {
    decisionId,
    recipeId: RECIPE_ID,
    schemaVersion: DECISION_SCHEMA_VERSION,
    schema: decisionContractFor(catalog),
    systemPrompt: RECIPE_SYSTEM_PROMPT,
    payload: {
      request: input.prepared.text,
      conversation: {
        relevantTurns: input.prepared.context.relevantTurns,
        pendingProposal: input.prepared.context.pendingProposal,
        lastAssistantText: input.prepared.context.lastAssistantText,
      },
      catalogBrief: {
        version: catalog.version,
        capabilities: catalog.capabilities.map((c) => ({
          id: c.id,
          version: c.version,
          title: c.title,
          supportedModes: c.supportedModes,
          requiredInputs: c.requiredInputs,
          integrationId: c.integrationId,
          ready: c.integrationId === null || input.hostFacts.connections[c.integrationId] === true,
        })),
      },
      coverage: params.coverage,
      preparedData,
      coverageFlags: coverageFlagsOf(input),
    },
    deadlineMs: params.deadlineMs,
    maxOutputTokens: params.maxOutputTokens ?? 1200,
  };
}

/**
 * Контракт решения для провайдера: версия, рецепт, версия каталога и виды.
 * Это не подсказка «примерно так»: те же поля проверяет код, поэтому
 * провайдерская оптимизация не может ослабить проверку.
 */
function decisionContractFor(catalog: RoutingInput['catalog']): Record<string, unknown> {
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    recipeId: RECIPE_ID,
    catalogVersion: catalog.version,
    kinds: ['reply', 'clarify', 'needs_executor'],
    note: 'Исполнителя, идентификаторы задачи, права и бюджет модель не назначает.',
  };
}

function coverageFlagsOf(input: RoutingInput): string[] {
  const flags = [`coverage:${input.prepared.attachments.length > 0 ? 'with_attachments' : 'text_only'}`];
  if (input.prepared.context.relevantTurns > 0) flags.push('conversation:has_history');
  if (input.prepared.context.pendingProposal) flags.push('conversation:has_pending_proposal');
  return flags;
}

/** Вызов модели с учётом дедлайна: превышение — технический исход. */
async function invoke(
  model: FixedModelPort,
  request: FixedModelRequest,
  counter: { count: number },
): Promise<FixedModelResponse> {
  counter.count += 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(1, request.deadlineMs));
  });
  try {
    return await Promise.race([model.invoke(request), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Разбор ответа модели: форма, затем семантика, затем один ремонт формы. */
async function interpret(
  response: FixedModelResponse,
  params: RecipeRunParams,
  counter: { count: number },
  deps: RecipeDeps,
  request: FixedModelRequest,
): Promise<RecipeResult> {
  if (response.kind === 'timeout') return { kind: 'timeout', modelCalls: counter.count };
  if (response.kind === 'provider_failure') return { kind: 'provider_failure', code: response.code, modelCalls: counter.count };
  if (response.kind === 'budget_denied') return { kind: 'budget_denied', modelCalls: counter.count };
  if (response.finish === 'refusal' || response.finish === 'content_filter') {
    return { kind: 'refused', modelCalls: counter.count };
  }
  if (response.finish === 'length') return { kind: 'truncated', modelCalls: counter.count };

  const parsed = parseRecipeDecision(response.text);
  if (!parsed.ok) {
    // Ремонт — максимум один вызов и только для ФОРМЫ. Таймаут, отказ провайдера
    // и обрезка ремонту не поддаются: повтор там не помогает (§11.2 шаг 7).
    if (counter.count >= MAX_RECIPE_CALLS || deps.llmCallsRemaining <= counter.count) {
      return { kind: 'schema_invalid', detail: `${parsed.code}:${parsed.field ?? ''}`, modelCalls: counter.count, repairAttempts: counter.count - 1 };
    }
    const repairRequest: FixedModelRequest = {
      ...request,
      repair: { reason: parsed.code, previousText: response.text },
    };
    const second = await invoke(deps.model, repairRequest, counter);
    if (second.kind !== 'ok') {
      return interpret(second, params, counter, deps, request);
    }
    const repaired = parseRecipeDecision(second.text);
    if (!repaired.ok) {
      return { kind: 'schema_invalid', detail: `${repaired.code}:${repaired.field ?? ''}`, modelCalls: counter.count, repairAttempts: 1 };
    }
    return decide(repaired.decision, params, counter.count);
  }
  return decide(parsed.decision, params, counter.count);
}

/** Семантическая проверка решения против снимка хоста и выбор исхода. */
function decide(decision: RecipeDecision, params: RecipeRunParams, modelCalls: number): RecipeResult {
  const semantic: DecisionSemanticResult = validateRecipeDecisionAgainst(decision, {
    catalog: params.input.catalog,
    authorization: params.input.authorization,
    coverage: params.coverage,
    knownProfileFields: params.knownProfileFields,
    requiresExternalAction: params.requiresExternalAction,
  });

  if (!semantic.ok) {
    const code = semantic.code as DecisionSemanticError;
    if (code === 'reply_without_context') {
      // Ответ при недостаточном контексте не публикуется и не эскалируется:
      // это отдельный исход, по которому хост расширяет контекст сам (§11.6.3).
      return { kind: 'insufficient_context', missingRefs: ['context:coverage'], modelCalls };
    }
    return { kind: 'blocked', reasonCode: code, detail: semantic.field, modelCalls };
  }

  if (decision.kind === 'reply') {
    return { kind: 'reply', text: decision.reply.text, evidenceRefs: semantic.groundedRefs, modelCalls, assessment: decision.assessment };
  }

  if (decision.kind === 'clarify') {
    const hostFields = decision.clarify.missingFields.filter((field) => params.knownProfileFields.includes(field));
    if (hostFields.length === decision.clarify.missingFields.length && hostFields.length > 0) {
      // Недостающее — известное хосту поле профиля: это типизированное ожидание
      // (required_input), а не «уточните что-нибудь» (§11.2 шаг 1, §11.4).
      return { kind: 'awaiting_input', question: decision.clarify.question, missingFields: hostFields, modelCalls };
    }
    return { kind: 'clarify', question: decision.clarify.question, missingFields: decision.clarify.missingFields, modelCalls };
  }

  if (decision.proposedJobType === 'ai-agent-job') {
    return {
      kind: 'needs_executor',
      reasonCode: decision.reasonCode,
      nextGoal: decision.nextGoal,
      preservedConstraints: decision.preservedConstraints,
      requiredCapabilities: decision.requiredCapabilities,
      partialResultRef: null,
      modelCalls,
      origin: 'model',
      assessment: decision.assessment,
    };
  }

  return {
    kind: 'needs_capability',
    capabilityId: decision.capabilityId,
    capabilityVersion: decision.capabilityVersion,
    arguments: decision.arguments,
    reasonCode: decision.reasonCode,
    modelCalls,
    assessment: decision.assessment,
  };
}
