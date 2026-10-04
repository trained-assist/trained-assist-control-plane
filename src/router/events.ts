/**
 * События маршрута для журнала и метрик (§11.9, SANDBOX I05).
 *
 * Ключи события совпадают с `REQUIRED_EVENT_KEYS` стенда P18
 * (`eval/fast-replies/harness.py`), поэтому решения этого роутера загружаются в
 * тот же eval без конвертера. `modelCalls: null` означает «не измерено» и не
 * смешивается с нулём: иначе песочница честно превратилась бы в выдуманный
 * бесплатный агент.
 *
 * В лог НЕ попадают: текст запроса, содержимое вложений, credentials. Только
 * идентификаторы, версии, признаки (как список имён) и причины.
 */
import type { StructuredLogFields } from '../logging/structured-log';
import type { RoutingDecision } from './router-types';

export const ROUTING_DECISION_EVENT = 'routing.decision';
export const ROUTING_TECHNICAL_ERROR_EVENT = 'routing.technical_error';
export const ROUTING_BLOCKED_EVENT = 'routing.blocked';
export const ROUTING_ESCALATED_EVENT = 'routing.escalated';

/** Строка события в форме стенда P18 (все ключи обязательны). */
export interface RoutingDecisionEvent {
  event: typeof ROUTING_DECISION_EVENT;
  decisionId: string;
  corpusCase: string | null;
  corpusVersion: string | number | null;
  source: string;
  policyVersion: string;
  route: RoutingDecision['route'];
  mode: RoutingDecision['mode'];
  reasonCode: RoutingDecision['reasonCode'];
  needsExecutor: boolean;
  schemaOutcome: RoutingDecision['schemaOutcome'];
  semanticOutcome: RoutingDecision['semanticOutcome'];
  coverage: RoutingDecision['coverage'];
  modelCalls: number | null;
  latencyMs: number | null;
  usageSource: RoutingDecision['usageSource'];
  escalationAttempt: boolean;
  firstUsefulReplyMs: number | null;
  outcome: RoutingDecision['outcome'];
  continuationRef: string | null;
  jobRef: string | null;
  runRef: string | null;
}

export function routingDecisionEvent(
  decision: RoutingDecision,
  params: {
    decisionId: string;
    source: string;
    corpusCase?: string | null;
    corpusVersion?: string | number | null;
    latencyMs?: number | null;
  },
): RoutingDecisionEvent {
  return {
    event: ROUTING_DECISION_EVENT,
    decisionId: params.decisionId,
    corpusCase: params.corpusCase ?? null,
    corpusVersion: params.corpusVersion ?? null,
    source: params.source,
    policyVersion: decision.policyVersion,
    route: decision.route,
    mode: decision.mode,
    reasonCode: decision.reasonCode,
    needsExecutor: decision.needsExecutor,
    schemaOutcome: decision.schemaOutcome,
    semanticOutcome: decision.semanticOutcome,
    coverage: decision.coverage,
    modelCalls: decision.modelCalls,
    latencyMs: params.latencyMs ?? null,
    usageSource: decision.usageSource,
    escalationAttempt: decision.escalationAttempt,
    firstUsefulReplyMs: decision.firstUsefulReplyMs,
    outcome: decision.outcome,
    continuationRef: decision.continuationRef,
    jobRef: decision.jobRef,
    runRef: decision.runRef,
  };
}

/** Дополнение для журнала control plane: доверительный контекст и признаки. */
export function routingLogFields(decision: RoutingDecision, params: {
  decisionId: string;
  profileId: string;
  userTaskId: string;
  runId: string | null;
  requestId: string | null;
  latencyMs: number | null;
}): StructuredLogFields {
  return {
    event: ROUTING_DECISION_EVENT,
    decisionId: params.decisionId,
    profileId: params.profileId,
    userTaskId: params.userTaskId,
    runId: params.runId,
    requestId: params.requestId,
    reason: decision.reasonCode,
    route: decision.route,
    mode: decision.mode,
    reasonCode: decision.reasonCode,
    needsExecutor: decision.needsExecutor,
    executor: decision.executor,
    escalation: decision.escalation,
    escalationAttempt: decision.escalationAttempt,
    capabilityId: decision.capabilityId,
    capabilityVersion: decision.capabilityVersion,
    replyAllowed: decision.replyAllowed,
    requiresFreshData: decision.requiresFreshData,
    requiresExternalAction: decision.requiresExternalAction,
    coverage: decision.coverage,
    schemaOutcome: decision.schemaOutcome,
    semanticOutcome: decision.semanticOutcome,
    modelCalls: decision.modelCalls,
    latencyMs: params.latencyMs,
    firstUsefulReplyMs: decision.firstUsefulReplyMs,
    outcome: decision.outcome,
    capabilityExecutions: decision.capabilityExecutions,
    repairAttempts: decision.repairAttempts,
    policyVersion: decision.policyVersion,
    // Признаки и снимки — по именам, без текста запроса.
    intents: decision.evidence.intents,
    matchedAlias: decision.evidence.matchedAlias,
    urlHosts: decision.evidence.urlHosts,
    urlQuoted: decision.evidence.urlQuoted,
    urlReadIntent: decision.evidence.urlReadIntent,
    embeddedInstructionIgnored: decision.evidence.embeddedInstructionIgnored,
    permissionSource: decision.evidence.permissionSource,
    authorizationRef: decision.evidence.authorizationRef,
    catalogVersion: decision.evidence.catalogVersion,
    contextVersion: decision.evidence.contextVersion,
  };
}
