/**
 * RouteService: host-owned оркестрация fast path (P16, §11.2 шаги 3–7).
 *
 * Последовательность: подготовка снимка → решение политики → host-валидация →
 * исполнение ровно одного обработчика → ответ/эскалация → bounded termination.
 *
 * Что здесь принципиально:
 *  - решение принимает чистая функция `decideRoute`, а сервис только исполняет
 *    и проверяет; поэтому решение воспроизводимо и не зависит от состояния
 *    worker'а (нужно для eval §11.7.5);
 *  - ни один технический исход (отказ модели, таймаут, невалидный/обрезанный
 *    JSON, нулевой бюджет) не включает агента: `escalationAttempt` остаётся
 *    false, а исход пишется как technical_error/blocked;
 *  - capability исполняется не более одного раза на решение, repair — не более
 *    одного (§11.2 шаг 7);
 *  - `agentWorkOrder` — это заявка, а не запуск: реальную отправку делает
 *    M1.3/P17 после host-проверки прав и бюджета.
 */
import { logStructured } from '../logging/structured-log';
import { agentWorkOrder, deterministicAnswer, templateAnswer, type AgentWorkOrder, type RecipeRunner } from './handlers';
import { ROUTING_BLOCKED_EVENT, ROUTING_ESCALATED_EVENT, ROUTING_TECHNICAL_ERROR_EVENT, routingLogFields } from './events';
import { decideRoute, MAX_DECISION_ATTEMPTS } from './policy';
import type { CapabilityEntry, RouteMode, RoutingDecision, RoutingInput } from './router-types';

export interface RouteServiceDeps {
  /** Recipe P17: одна модель без инструментов. В песочнице внедряется стабом. */
  recipe?: RecipeRunner;
  /** Источник решений для eval-стенда P18. */
  source?: string;
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
  /** Что реально выполнено: счётчики для доказательства «агент не запускался». */
  execution: {
    capabilityExecutions: number;
    agentDispatchAttempts: number;
    recipeCalls: number;
    modelCalls: number | null;
  };
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
  const decision = decideRoute(input);
  decision.decisionId = decisionId;

  const capability = decision.capabilityId
    ? input.catalog.capabilities.find((c) => c.id === decision.capabilityId && c.version === decision.capabilityVersion) ?? null
    : null;

  const execution = { capabilityExecutions: 0, agentDispatchAttempts: 0, recipeCalls: 0, modelCalls: decision.modelCalls };
  let reply: RouteResult['reply'] = null;
  let askUser: RouteResult['askUser'] = null;
  let workOrder: AgentWorkOrder | null = null;

  // Невалидное решение не исполняется: JSON-валидность/совпадение алиаса не
  // доказывают ни существования capability, ни её готовности (§11.2 шаг 4).
  if (decision.capabilityId && !capability) {
    decision.semanticOutcome = 'invalid';
    decision.reasonCode = 'UNKNOWN_CAPABILITY_VERSION';
    decision.replyAllowed = false;
    decision.outcome = 'technical_error';
  }

  if (decision.outcome === 'blocked' || decision.route === null) {
    reply = null;
  } else if (decision.route === 'agent') {
    workOrder = agentWorkOrder({
      envelope: input.envelope,
      prepared: input.prepared,
      reasonCode: decision.reasonCode,
      requiresExternalAction: decision.requiresExternalAction,
      authorizationRef: input.authorization.snapshotRef,
      catalogCapabilityIds: input.catalog.capabilities.map((c) => c.id),
    });
    // Счётчик попыток эскалации: он остаётся 0 для любого не-агентского пути.
    execution.agentDispatchAttempts = 1;
    decision.jobRef = `job_${input.envelope.userTaskId}`;
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
    const outcome = await runRecipe(input, decision, deps, execution);
    if (outcome.kind === 'ok') {
      reply = { text: outcome.text, evidenceRefs: ['recipe:reply-or-route'], mode: 'llm-recipe-job' };
      decision.firstUsefulReplyMs = now() - startedAt;
    } else {
      // Отказ/таймаут/мусор — технический исход, НЕ ответ и НЕ повод для агента.
      decision.schemaOutcome =
        outcome.kind === 'refused'
          ? 'refused'
          : outcome.kind === 'timeout'
            ? 'timeout'
            : outcome.kind === 'truncated'
              ? 'truncated'
              : 'invalid';
      decision.semanticOutcome = 'not_evaluated';
      decision.reasonCode =
        outcome.kind === 'refused'
          ? 'MODEL_REFUSED'
          : outcome.kind === 'timeout'
            ? 'MODEL_TIMEOUT'
            : outcome.kind === 'truncated'
              ? 'SCHEMA_TRUNCATED'
              : 'SCHEMA_INVALID';
      decision.outcome = 'technical_error';
      decision.replyAllowed = false;
      decision.modelCalls = outcome.modelCalls;
      // Ремонт схемы — максимум один (bounded termination, §11.2 шаг 7);
      // факт ремонта виден в решении, а не спрятан внутрь счётчика вызовов.
      decision.repairAttempts = outcome.kind === 'invalid_json' || outcome.kind === 'truncated' ? 1 : 0;
      reply = null;
    }
  }

  if (execution.capabilityExecutions > MAX_DECISION_ATTEMPTS) {
    throw new Error(`bounded termination violated: capabilityExecutions=${execution.capabilityExecutions}`);
  }

  const latencyMs = now() - startedAt;
  decision.modelCalls = execution.modelCalls ?? decision.modelCalls;
  execution.modelCalls = decision.modelCalls;

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

  return { decision, decisionId, reply, askUser, workOrder, execution };
}

function coverageWaits(coverage: RoutingDecision['coverage']): boolean {
  return coverage === 'attachment_pending' || coverage === 'middle_missing' || coverage === 'missing_snapshot' || coverage === 'stale';
}

function missingQuestion(capability: CapabilityEntry | null, missing: string[]): string {
  const what = missing.length > 0 ? missing.join(', ') : 'недостающие данные';
  return `Нужны ваши данные: ${what}.${capability ? ` Действие: ${capability.title}.` : ''} Агент не запускаю — не хватает ввода, а не возможностей.`;
}

async function runRecipe(
  input: RoutingInput,
  decision: RoutingDecision,
  deps: RouteServiceDeps,
  execution: RouteResult['execution'],
): Promise<Awaited<ReturnType<RecipeRunner>>> {
  const recipe = deps.recipe;
  if (!recipe) {
    // Recipe внедряется в P17; до этого платный вызов невозможен, и это видно,
    // а не «ответ по умолчанию».
    decision.reasonCode = 'MODEL_TIMEOUT';
    decision.outcome = 'technical_error';
    decision.replyAllowed = false;
    decision.modelCalls = 0;
    return { kind: 'timeout', modelCalls: 0 };
  }
  execution.recipeCalls = 1;
  const outcome = await recipe({
    decisionId: decision.decisionId,
    text: input.prepared.text,
    preparedData: null,
  });
  return outcome;
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
