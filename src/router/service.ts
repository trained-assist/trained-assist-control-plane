/**
 * RouteService: host-owned оркестрация fast path (P16 policy + P17 recipe).
 *
 * Последовательность: подготовка снимка → решение политики → host-валидация →
 * исполнение ровно одного обработчика → ответ/эскалация → bounded termination.
 *
 * Что здесь принципиально:
 *  - решение принимает чистая функция `decideRoute`, а сервис только исполняет
 *    и проверяет; поэтому решение воспроизводимо и не зависит от состояния
 *    worker'а (нужно для eval §11.7.5);
 *  - ни один технический исход (отказ модели, таймаут, отказ провайдера,
 *    невалидный/обрезанный JSON, нулевой бюджет) не включает агента:
 *    `escalationAttempt` остаётся false, а исход пишется как
 *    technical_error/blocked/insufficient_context (§11.3);
 *  - capability исполняется не более одного раза на решение, repair схемы — не
 *    более одного вызова (§11.2 шаг 7);
 *  - продолжение запрашивается, но НЕ выдаётся: ровно один владелец
 *    продолжения — Output (`src/output/continuation.ts`), и роутер не создаёт
 *    ни job, ни run.
 */
import { logStructured } from '../logging/structured-log';
import { agentWorkOrder, deterministicAnswer, templateAnswer, type AgentWorkOrder } from './handlers';
import { ROUTING_BLOCKED_EVENT, ROUTING_ESCALATED_EVENT, ROUTING_TECHNICAL_ERROR_EVENT, routingLogFields } from './events';
import { decideRoute, MAX_DECISION_ATTEMPTS } from './policy';
import { validateCatalog } from './catalog';
import { RECIPE_ID } from './recipe/decision-contract';
import type { HostCapabilityHandler, PreparedCapabilityData } from './recipe/host-data';
import { hostConstraintsOf, hostRequiresExternalAction, partialResultRefOf } from './recipe/host-data';
import type { RecipeResult, ReplyOrRouteRunner } from './recipe/recipe';
import { buildScopedBrief, logBrief, type BriefBuildResult, type BriefServiceDeps } from './brief/service';
import { discoveryCapabilityIds } from './brief/compiler';
import type { CatalogBrief } from './brief/brief-types';
import { type CapabilityEntry, type RouteMode, type RoutingDecision, type RoutingInput, TERMINAL_EXECUTOR } from './router-types';
import type { FastPathContinuationRequest } from '../output/continuation';

export interface RouteServiceDeps {
  /** Рецепт P17: один вызов модели без инструментов → одно решение. */
  replyOrRoute?: ReplyOrRouteRunner;
  /** Идентификатор модели для журнала (без инструментов). */
  modelId?: string;
  /** Host-owned обработчик данных: модель capability не вызывает. */
  handler?: HostCapabilityHandler;
  /** Источник решений для eval-стенда P18. */
  source?: string;
  /** Brief builder (P20): scoped cache и бюджет размера проекции каталога. */
  brief?: BriefServiceDeps;
  now?: () => number;
}

export interface RouteResult {
  decision: RoutingDecision;
  decisionId: string;
  /** Пользовательский ответ, если он разрешён решением. */
  reply: { text: string; evidenceRefs: string[]; mode: RouteMode } | null;
  /** Вопрос пользователю (clarify/required_input). */
  askUser: { question: string; missingFields: string[] } | null;
  /** Заявка исполнителю; сам запуск — вне модуля. */
  workOrder: AgentWorkOrder | null;
  /**
   * Запрос продолжения. Выдаёт его только Output — единственный владелец
   * продолжения (P17); здесь он только собирается.
   */
  continuation: FastPathContinuationRequest | null;
  /** Что реально выполнено: счётчики для доказательства «агент не запускался». */
  execution: {
    capabilityExecutions: number;
    agentDispatchAttempts: number;
    recipeCalls: number;
    modelCalls: number | null;
  };
  /** Brief каталога (P20): проекция, которую получил рецепт, и его метрики. */
  brief: BriefBuildResult;
}

const clarifyQuestion = 'Уточните, пожалуйста, что именно сделать: сейчас в сообщении нет задачи.';

/**
 * Один запрос → одно решение → одно исполнение. Никаких лестниц над
 * OpenCode (§ policy 30.09) и никаких скрытых повторов.
 */
export async function routeRequest(input: RoutingInput, deps: RouteServiceDeps = {}): Promise<RouteResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const decisionId = `${input.envelope.userTaskId}:${input.envelope.requestId ?? 'no-request'}:${input.envelope.catalogVersion}`;

  // Каталог — проверенный источник метаданных (P20): невалидный снимок не
  // исполняется и не передаётся модели. Проверка идёт ДО решения, поэтому
  // причина отказа называется точнее, чем общий NO_ENABLED_CANDIDATES.
  if (deps.brief) {
    const catalogCheck = validateCatalog(input.catalog);
    if (!catalogCheck.ok) {
      const brief: BriefBuildResult = { status: 'invalid', brief: null, errors: catalogCheck.errors, cache: { key: null, hit: false, stored: false } };
      const decision = decideRoute(input);
      decision.decisionId = decisionId;
      decision.outcome = 'technical_error';
      decision.reasonCode = 'BRIEF_METADATA_INVALID';
      decision.replyAllowed = false;
      decision.needsExecutor = false;
      decision.executor = null;
      decision.escalation = 'none';
      decision.escalationAttempt = false;
      decision.semanticOutcome = 'not_evaluated';
      decision.modelCalls = 0;
      logBrief(brief, {
        profileId: input.envelope.profileId,
        userTaskId: input.envelope.userTaskId,
        runId: input.envelope.runId,
        requestId: input.envelope.requestId,
        decisionId,
      });
      return {
        decision,
        decisionId,
        reply: null,
        askUser: null,
        workOrder: null,
        continuation: null,
        execution: { capabilityExecutions: 0, agentDispatchAttempts: 0, recipeCalls: 0, modelCalls: 0 },
        brief,
      };
    }
  }

  const decision = decideRoute(input);
  decision.decisionId = decisionId;

  // Brief каталога (P20): собирает хост до рецепта. Детерминированные и
  // шаблонные пути от него не зависят, поэтому сборка идёт только для путей,
  // которые brief используют. Технический исход сборки не включает исполнителя.
  const briefNeeded = decision.mode === 'llm-recipe-job' || decision.route === 'agent';
  const brief: BriefBuildResult = briefNeeded
    ? await buildScopedBrief(input, {
        cache: deps.brief?.cache,
        budget: deps.brief?.budget,
        purpose: decision.route === 'agent' ? 'agent-work-order' : 'reply-or-route',
      })
    : { status: 'ok', brief: null, errors: [], cache: { key: null, hit: false, stored: false } };
  if (briefNeeded && brief.status !== 'ok') {
    decision.outcome = 'technical_error';
    decision.reasonCode = brief.status === 'over_budget' ? 'BRIEF_BUDGET_EXCEEDED' : 'BRIEF_METADATA_INVALID';
    decision.replyAllowed = false;
    decision.needsExecutor = false;
    decision.executor = null;
    decision.escalation = 'none';
    decision.escalationAttempt = false;
    decision.semanticOutcome = 'not_evaluated';
    decision.modelCalls = 0;
    logBrief(brief, {
      profileId: input.envelope.profileId,
      userTaskId: input.envelope.userTaskId,
      runId: input.envelope.runId,
      requestId: input.envelope.requestId,
      decisionId,
    });
    return {
      decision,
      decisionId,
      reply: null,
      askUser: null,
      workOrder: null,
      continuation: null,
      execution: { capabilityExecutions: 0, agentDispatchAttempts: 0, recipeCalls: 0, modelCalls: 0 },
      brief,
    };
  }
  const briefForModel: CatalogBrief | null = brief.brief;

  const capability = decision.capabilityId
    ? input.catalog.capabilities.find((c) => c.id === decision.capabilityId && c.version === decision.capabilityVersion) ?? null
    : null;

  const execution = { capabilityExecutions: 0, agentDispatchAttempts: 0, recipeCalls: 0, modelCalls: decision.modelCalls };
  let reply: RouteResult['reply'] = null;
  let askUser: RouteResult['askUser'] = null;
  let workOrder: AgentWorkOrder | null = null;
  let continuation: FastPathContinuationRequest | null = null;

  // Невалидное решение не исполняется: JSON-валидность/совпадение алиаса не
  // доказывают ни существования capability, ни её готовности (§11.2 шаг 4).
  if (decision.capabilityId && !capability) {
    decision.semanticOutcome = 'invalid';
    decision.reasonCode = 'UNKNOWN_CAPABILITY_VERSION';
    decision.replyAllowed = false;
    decision.outcome = 'technical_error';
  }

  // Данные для рецепта готовит ХОСТ: модель их не добывает и не выбирает (§5).
  const preparedData: PreparedCapabilityData | null =
    decision.capabilityId && deps.handler ? await deps.handler({ capabilityId: decision.capabilityId, hostFacts: input.hostFacts, prepared: input.prepared }) : null;

  if (decision.outcome === 'blocked' || decision.route === null) {
    reply = null;
  } else if (decision.route === 'agent') {
    ({ workOrder, continuation } = escalate({
      input,
      decision,
      reasonCode: decision.reasonCode,
      requiresExternalAction: decision.requiresExternalAction,
      hostConstraints: hostConstraintsOf(input.prepared.text),
      partialResultRef: null,
      // Discovery-индекс исполнителя: только РАЗРЕШЁННЫЕ возможности (§12).
      discoveryIds: discoveryCapabilityIds(briefForModel, input),
    }));
    // Счётчик попыток эскалации: он остаётся 0 для любого не-агентского пути.
    execution.agentDispatchAttempts = 1;
    decision.jobRef = null;
    decision.runRef = input.envelope.runId;
  } else if (decision.outcome === 'clarify') {
    askUser = { question: clarifyQuestion, missingFields: ['goal'] };
  } else if (decision.outcome === 'required_input') {
    const missing = capability?.requiredInputs ?? [];
    askUser = { question: missingQuestion(capability, missing), missingFields: missing };
    const missingTemplate = templateAnswer(capability?.templateId ?? null, input.hostFacts, capability);
    reply = missingTemplate ? { ...missingTemplate, mode: 'template-handler' } : null;
  } else if (coverageWaits(decision.coverage)) {
    // Вложение ещё извлекается: ждём, а не отвечаем по пустому (FR-064).
    askUser = null;
    reply = null;
  } else if (decision.mode === 'deterministic-handler') {
    if (decision.reasonCode === 'AWAITING_ANSWER_CONTINUATION') {
      // Ответ на открытое ожидание: истина ответа лежит в Task Store, а не в
      // роутере. Роутер подтверждает приём и передаёт продолжение владельцу
      // задачи; новой задачи и нового исполнителя здесь не появляется.
      reply = {
        text: 'Ответ принят — продолжаю работу по этой задаче.',
        evidenceRefs: [`awaiting:${input.prepared.typedSignal?.ref ?? 'unknown'}`],
        mode: 'deterministic-handler',
      };
      decision.firstUsefulReplyMs = now() - startedAt;
    } else {
      const answer = capability ? deterministicAnswer(capability.id, input.hostFacts, input.prepared) : null;
      if (answer) {
        execution.capabilityExecutions = 1;
        decision.capabilityExecutions = 1;
        reply = { ...answer, mode: 'deterministic-handler' };
        decision.firstUsefulReplyMs = now() - startedAt;
      } else {
        // Данных нет: честное уточнение, а не ответ «примерно».
        decision.semanticOutcome = 'invalid_missing_arg';
        decision.reasonCode = 'MISSING_REQUIRED_INPUT';
        decision.outcome = 'clarify';
        askUser = { question: clarifyQuestion, missingFields: [] };
        reply = null;
      }
    }
  } else if (decision.mode === 'template-handler') {
    const answer = capability
      ? templateAnswer(capability.templateId, input.hostFacts, capability)
      : templateAnswer(null, input.hostFacts, capability);
    const policyTemplate = answer ?? templateAnswer('policy.model_facts', input.hostFacts, null);
    if (policyTemplate) {
      reply = { ...policyTemplate, mode: 'template-handler' };
      decision.firstUsefulReplyMs = now() - startedAt;
    } else {
      decision.semanticOutcome = 'invalid';
      decision.outcome = 'technical_error';
      reply = null;
    }
  } else if (decision.mode === 'llm-recipe-job') {
    const result: RecipeResult = deps.replyOrRoute
      ? await deps.replyOrRoute({ input, decision, preparedData, brief: briefForModel })
      : // Рецепт не внедрён: платный вызов невозможен, и это видно, а не
        // «ответ по умолчанию» (P16 → P17: тот же честный технический исход).
        { kind: 'timeout', modelCalls: 0 };
    execution.recipeCalls = 1;
    decision.recipeId = RECIPE_ID;
    decision.modelId = deps.modelId ?? null;
    decision.modelCalls = result.modelCalls;
    execution.modelCalls = result.modelCalls;
    decision.repairAttempts = result.kind === 'schema_invalid' ? result.repairAttempts : 0;
    await applyRecipeResult(result, {
      input,
      decision,
      capability,
      preparedData,
      handler: deps.handler ?? null,
      hostConstraints: hostConstraintsOf(input.prepared.text),
      briefForModel,
      now,
      startedAt,
      execution,
      setReply: (value) => {
        reply = value;
      },
      setAskUser: (value) => {
        askUser = value;
      },
      setEscalation: (value) => {
        workOrder = value.workOrder;
        continuation = value.continuation;
        execution.agentDispatchAttempts = 1;
      },
    });
  }

  if (execution.capabilityExecutions > MAX_DECISION_ATTEMPTS) {
    throw new Error(`bounded termination violated: capabilityExecutions=${execution.capabilityExecutions}`);
  }

  const latencyMs = now() - startedAt;
  decision.modelCalls = execution.modelCalls ?? decision.modelCalls;
  execution.modelCalls = decision.modelCalls;

  logBrief(brief, {
    profileId: input.envelope.profileId,
    userTaskId: input.envelope.userTaskId,
    runId: input.envelope.runId,
    requestId: input.envelope.requestId,
    decisionId,
  });
  logRouting(input, decision, decisionId, latencyMs, deps.source ?? 'route-service');
  if (decision.outcome === 'technical_error') {
    logStructured({
      event: ROUTING_TECHNICAL_ERROR_EVENT,
      level: 'warn',
      profileId: input.envelope.profileId,
      userTaskId: input.envelope.userTaskId,
      runId: input.envelope.runId,
      decisionId,
      reason: decision.reasonCode,
      escalationAttempt: decision.escalationAttempt,
      code: decision.reasonCode,
    });
  }
  if (decision.outcome === 'blocked') {
    logStructured({
      event: ROUTING_BLOCKED_EVENT,
      level: 'info',
      profileId: input.envelope.profileId,
      userTaskId: input.envelope.userTaskId,
      runId: input.envelope.runId,
      decisionId,
      reason: decision.reasonCode,
      capabilityId: decision.capabilityId,
      permissionSource: input.authorization.source,
      authorizationRef: input.authorization.snapshotRef,
    });
  }
  if (decision.needsExecutor) {
    logStructured({
      event: ROUTING_ESCALATED_EVENT,
      level: 'info',
      profileId: input.envelope.profileId,
      userTaskId: input.envelope.userTaskId,
      runId: input.envelope.runId,
      decisionId,
      reason: decision.reasonCode,
      executor: decision.executor,
      requiredConfirmation: decision.requiresExternalAction,
      terminalExecutor: true,
    });
  }

  return { decision, decisionId, reply, askUser, workOrder, continuation, execution, brief };
}

function coverageWaits(coverage: RoutingDecision['coverage']): boolean {
  return coverage === 'attachment_pending' || coverage === 'middle_missing' || coverage === 'missing_snapshot' || coverage === 'stale';
}

function missingQuestion(capability: CapabilityEntry | null, missing: string[]): string {
  const what = missing.length > 0 ? missing.join(', ') : 'недостающие данные';
  return `Нужны ваши данные: ${what}.${capability ? ` Действие: ${capability.title}.` : ''} Агент не запускаю — не хватает ввода, а не возможностей.`;
}

interface EscalationParams {
  input: RoutingInput;
  decision: RoutingDecision;
  reasonCode: RoutingDecision['reasonCode'];
  requiresExternalAction: boolean;
  hostConstraints: string[];
  partialResultRef: string | null;
  /** Возможности, названные решением; null — хост не знает ни одной (policy-эскалация). */
  requiredCapabilities?: string[] | null;
  /** Discovery-индекс: разрешённые возможности из brief'а (§12). */
  discoveryIds: string[];
}

/**
 * Заявка исполнителю и ЗАПРОС продолжения. Продолжение здесь не выдаётся:
 * владелец — Output, и решение о новой работе принимает только он.
 */
function escalate(params: EscalationParams): { workOrder: AgentWorkOrder; continuation: FastPathContinuationRequest } {
  const { input, decision, reasonCode, requiresExternalAction, hostConstraints, partialResultRef } = params;
  // Нужные capability — названные решением, а не весь каталог: «нужен веб» не
  // значит «дай весь список возможностей» (§11.3). Если решение их не назвало —
  // discovery-индекс из brief'а: только разрешённые, без невыданных прав.
  const requiredCapabilities =
    params.requiredCapabilities && params.requiredCapabilities.length > 0
      ? params.requiredCapabilities
      : params.discoveryIds;
  const workOrder = agentWorkOrder({
    envelope: input.envelope,
    prepared: input.prepared,
    reasonCode,
    requiresExternalAction,
    authorizationRef: input.authorization.snapshotRef,
    catalogCapabilityIds: requiredCapabilities,
  });
  const continuation: FastPathContinuationRequest = {
    decisionId: decision.decisionId,
    userTaskId: input.envelope.userTaskId,
    profileId: input.envelope.profileId,
    conversationId: input.envelope.conversationId,
    originalRequestRef: `task:${input.envelope.userTaskId}:request:${input.envelope.requestId ?? 'none'}`,
    goal: input.prepared.text,
    // Ограничения из исходного текста не теряются при reformulation (§11.3).
    preservedConstraints: Array.from(new Set([...hostConstraints, ...workOrder.preservedConstraints])),
    requiredCapabilities,
    reasonCode: reasonCode as FastPathContinuationRequest['reasonCode'],
    partialResultRef,
    authorizationRef: input.authorization.snapshotRef,
    requiresConfirmation: requiresExternalAction,
    workOrder,
  };
  return { workOrder, continuation };
}

interface RecipeApplyState {
  input: RoutingInput;
  decision: RoutingDecision;
  capability: CapabilityEntry | null;
  preparedData: PreparedCapabilityData | null;
  /** Host-owned обработчик: он и приносит данные для предложенной capability. */
  handler: HostCapabilityHandler | null;
  hostConstraints: string[];
  /** Brief каталога (P20): discovery-индекс для исполнителя. */
  briefForModel: CatalogBrief | null;
  now: () => number;
  startedAt: number;
  /** Счётчики исполнения: доказательство «агент не запускался». */
  execution: RouteResult['execution'];
  setReply: (value: RouteResult['reply']) => void;
  setAskUser: (value: RouteResult['askUser']) => void;
  setEscalation: (value: { workOrder: AgentWorkOrder; continuation: FastPathContinuationRequest }) => void;
}

/** Исход рецепта → поля решения. Ни один технический исход не эскалирует. */
async function applyRecipeResult(result: RecipeResult, state: RecipeApplyState): Promise<void> {
  const { decision } = state;
  const mark = (outcome: RoutingDecision['outcome'], reasonCode: RoutingDecision['reasonCode'], schemaOutcome: RoutingDecision['schemaOutcome'], semanticOutcome: RoutingDecision['semanticOutcome']) => {
    decision.outcome = outcome;
    decision.reasonCode = reasonCode;
    decision.schemaOutcome = schemaOutcome;
    decision.semanticOutcome = semanticOutcome;
    decision.replyAllowed = outcome === 'reply';
  };

  /**
   * Техническая деградация: НЕ тишина и НЕ «успешный быстрый ответ».
   *
   * Маршрутизация не смогла решить по технической причине. Дорогого агента молча
   * не запускаем (needsExecutor остаётся false) — но хост обязан показать видимый
   * контролируемый исход с причиной и разрешённым действием. Иначе пользователь
   * получает тот же класс дефекта, что «сообщение принято, но дальше тишина»
   * (arch#132, Приоритет 4).
   */
  const degrade = (text: string, actions: RoutingDecision['degradedNotice'] extends null ? never : NonNullable<RoutingDecision['degradedNotice']>['actions'] = ['retry', 'launch']) => {
    decision.degraded = true;
    decision.degradedNotice = { text, actions };
    // Деградация не отвечает на вопрос и не эскалирует сама.
    decision.needsExecutor = false;
    decision.escalation = 'none';
  };

  switch (result.kind) {
    case 'reply':
      mark('reply', decision.reasonCode, 'valid', 'valid');
      state.setReply({ text: result.text, evidenceRefs: result.evidenceRefs, mode: 'llm-recipe-job' });
      decision.firstUsefulReplyMs = state.now() - state.startedAt;
      return;
    case 'clarify':
      mark('clarify', 'AMBIGUOUS_WITHOUT_CONTEXT', 'valid', 'valid');
      state.setAskUser({ question: result.question, missingFields: result.missingFields });
      return;
    case 'awaiting_input':
      // Недостающее — известное хосту поле: типизированное ожидание, а не вопрос.
      mark('required_input', 'MISSING_REQUIRED_INPUT', 'valid', 'valid');
      state.setAskUser({ question: result.question, missingFields: result.missingFields });
      return;
    case 'insufficient_context':
      // Ответ не публикуется и не эскалируется: хост расширяет контекст сам.
      mark('insufficient_context', 'CONTEXT_NOT_SUFFICIENT', 'valid', 'coverage_pending');
      return;
    case 'blocked':
      mark('blocked', blockedReasonOf(result.reasonCode), 'invalid', 'invalid');
      return;
    case 'schema_invalid':
      mark('technical_error', 'SCHEMA_INVALID', 'invalid', 'not_evaluated');
      degrade('Ответ модели не распознан — повторите или запустите вручную.');
      return;
    case 'timeout':
      mark('technical_error', 'MODEL_TIMEOUT', 'timeout', 'not_evaluated');
      degrade('Маршрутизация не ответила вовремя — повторите или запустите вручную.');
      return;
    case 'provider_failure':
      decision.providerCode = result.code;
      mark('technical_error', 'PROVIDER_FAILURE', 'provider_failure', 'not_evaluated');
      degrade('Маршрутизация недоступна (провайдер). Запустите вручную или повторите.');
      return;
    case 'budget_denied':
      mark('blocked', 'BUDGET_DENIED', 'budget_denied', 'not_evaluated');
      return;
    case 'refused':
      mark('technical_error', 'MODEL_REFUSED', 'refused', 'not_evaluated');
      degrade('Модель отказалась отвечать — запустите вручную или переформулируйте.');
      return;
    case 'truncated':
      mark('technical_error', 'SCHEMA_TRUNCATED', 'truncated', 'not_evaluated');
      degrade('Ответ модели обрезан — повторите или запустите вручную.');
      return;
    case 'needs_capability':
      await executeCapability(result, state);
      return;
    case 'needs_executor': {
      decision.requiresFreshData = result.assessment.needsFreshData;
      // Подтверждение решает хост: либо модель объявила действие, либо в исходном
      // тексте есть явный запрет на внешнее действие (§11.3).
      const requiresExternalAction = result.assessment.needsActions || hostRequiresExternalAction(state.hostConstraints);
      decision.requiresExternalAction = requiresExternalAction;
      const { workOrder, continuation } = escalate({
        input: state.input,
        decision,
        reasonCode: result.reasonCode,
        requiresExternalAction,
        hostConstraints: state.hostConstraints,
        partialResultRef: result.partialResultRef,
        requiredCapabilities: result.requiredCapabilities,
        discoveryIds: discoveryCapabilityIds(state.briefForModel, state.input),
      });
      state.setEscalation({ workOrder, continuation });
      // Исполнителя назначает хост, а не модель: терминальный и только он (§11.3).
      decision.needsExecutor = true;
      decision.executor = TERMINAL_EXECUTOR;
      decision.escalation = 'agent';
      mark('escalated', result.reasonCode, 'valid', 'valid');
      return;
    }
  }
}

/** Причина семантического отказа: значение, а не текст ошибки схемы. */
function blockedReasonOf(code: string): RoutingDecision['reasonCode'] {
  if (code === 'unknown_capability' || code === 'capability_version_mismatch') return 'UNKNOWN_CAPABILITY_VERSION';
  if (code === 'capability_not_granted' || code === 'capability_mode_not_allowed') return 'PERMISSION_DENIED';
  return 'SEMANTIC_INVALID';
}

/**
 * Исполнение capability, НАЗВАННОЙ моделью: ровно один вызов host-обработчика
 * (§11.2 шаг 5). Модель не выбирает backend и не вызывает capability сама — она
 * предложила только id, версию и аргументы, а данные приносит хост.
 *
 * Данные берутся для той capability, которую назвало решение: на текстовой
 * работе политика capability не выбирала, и предзагруженные данные (если были)
 * относятся к другой возможности — брать их было бы подменой проверенного.
 */
async function executeCapability(
  result: Extract<RecipeResult, { kind: 'needs_capability' }>,
  state: RecipeApplyState,
): Promise<void> {
  const { decision, input } = state;
  const entry =
    input.catalog.capabilities.find((c) => c.id === result.capabilityId && c.version === result.capabilityVersion) ?? null;
  if (!entry) {
    // Решение прошло семантическую проверку, но снимок не подтвердил: не
    // исполняем, а фиксируем расхождение (запись могла устареть между шагами).
    decision.semanticOutcome = 'invalid';
    decision.reasonCode = 'UNKNOWN_CAPABILITY_VERSION';
    decision.outcome = 'technical_error';
    decision.replyAllowed = false;
    return;
  }
  if (!state.handler) {
    decision.semanticOutcome = 'not_evaluated';
    decision.reasonCode = 'CAPABILITY_HANDLER_ERROR';
    decision.outcome = 'technical_error';
    decision.replyAllowed = false;
    return;
  }
  const data = await state.handler({ capabilityId: result.capabilityId, hostFacts: input.hostFacts, prepared: input.prepared });
  decision.capabilityExecutions = 1;
  state.execution.capabilityExecutions = 1;
  switch (data.outcome) {
    case 'completed': {
      const answer = deterministicAnswer(entry.id, input.hostFacts, input.prepared);
      if (!answer) {
        decision.semanticOutcome = 'invalid_missing_arg';
        decision.reasonCode = 'MISSING_REQUIRED_INPUT';
        decision.outcome = 'clarify';
        decision.replyAllowed = false;
        state.setAskUser({ question: clarifyQuestion, missingFields: [] });
        return;
      }
      decision.outcome = 'reply';
      decision.reasonCode = 'CAPABILITY_QUESTION';
      decision.schemaOutcome = 'valid';
      decision.semanticOutcome = 'valid';
      decision.replyAllowed = true;
      state.setReply({ ...answer, evidenceRefs: answer.evidenceRefs, mode: 'llm-recipe-job' });
      decision.firstUsefulReplyMs = state.now() - state.startedAt;
      return;
    }
    case 'missing_input':
      decision.outcome = 'required_input';
      decision.reasonCode = 'MISSING_REQUIRED_INPUT';
      decision.schemaOutcome = 'valid';
      decision.semanticOutcome = 'valid';
      decision.replyAllowed = false;
      state.setAskUser({
        question: missingQuestion(entry, data.missingInputs),
        missingFields: data.missingInputs,
      });
      return;
    case 'blocked':
      decision.outcome = 'blocked';
      decision.reasonCode = 'PERMISSION_DENIED';
      decision.schemaOutcome = 'valid';
      decision.semanticOutcome = 'invalid';
      decision.replyAllowed = false;
      return;
    case 'needs_agent': {
      // Хост решил, что нужен исполнитель: эскалация — решение владельца
      // данных, а не догадка модели (§11.4).
      const requiresExternalAction = result.assessment.needsActions || hostRequiresExternalAction(state.hostConstraints);
      const { workOrder, continuation } = escalate({
        input,
        decision,
        reasonCode: reasonCodeOf(data.needsAgentReason),
        requiresExternalAction,
        hostConstraints: state.hostConstraints,
        partialResultRef: partialResultRefOf(data),
        requiredCapabilities: [entry.id],
        discoveryIds: discoveryCapabilityIds(state.briefForModel, input),
      });
      state.setEscalation({ workOrder, continuation });
      decision.requiresFreshData = true;
      decision.requiresExternalAction = requiresExternalAction;
      decision.outcome = 'escalated';
      decision.reasonCode = reasonCodeOf(data.needsAgentReason);
      decision.schemaOutcome = 'valid';
      decision.semanticOutcome = 'valid';
      return;
    }
    case 'technical_error':
      decision.outcome = 'technical_error';
      decision.reasonCode = 'CAPABILITY_HANDLER_ERROR';
      decision.schemaOutcome = 'valid';
      decision.semanticOutcome = 'invalid';
      decision.replyAllowed = false;
      return;
  }
}

function reasonCodeOf(reason: string | null): RoutingDecision['reasonCode'] {
  if (reason === 'NO_DECLARED_CAPABILITY') return 'CONTEXT_NOT_COVERED';
  if (reason === 'INTEGRATION_NOT_CONNECTED') return 'PERMISSION_DENIED';
  if (reason === 'EXTERNAL_EFFECT_NOT_ALLOWED') return 'EXTERNAL_EFFECT_NO_CAPABILITY';
  return 'NEEDS_CURRENT_USER_DATA';
}

function logRouting(
  input: RoutingInput,
  decision: RoutingDecision,
  decisionId: string,
  latencyMs: number | null,
  source: string,
): void {
  logStructured({
    ...routingLogFields(decision, {
      decisionId,
      profileId: input.envelope.profileId,
      userTaskId: input.envelope.userTaskId,
      runId: input.envelope.runId,
      requestId: input.envelope.requestId,
      latencyMs,
    }),
    level: decision.outcome === 'technical_error' ? 'warn' : 'info',
    source,
  });
}
