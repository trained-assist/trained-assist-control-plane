/**
 * Replay корпуса быстрых ответов через route policy (P18 corpus → P16 policy).
 *
 * Задача модуля — сделать eval честным: он НЕ подсказывает политике ответ.
 * Диалог превращается в тот же вход, который даёт живой `/route`: текст,
 * контекст диалога, вложения, снимок подключений, часы и бюджет. Признаки и
 * решение считает `decideRoute`.
 *
 * Отличия живого входа, которые здесь зафиксированы явно (иначе eval врал бы):
 *  - `context.connected` корпуса → снимок `HostFacts.connections`;
 *  - `context.budget_left` → `BudgetSnapshot.llmCallsRemaining`;
 *  - `context.fault` → управляемый сбой recipe (`model_returns_refusal_text`);
 *  - `context.user_email`/`tasks_yesterday_ref`/`prev_assistant_proposal` →
 *    факты профиля и контекст диалога.
 *
 * Каталог и снимок прав — те же, что в песочнице (`sandboxCapabilityCatalog`,
 * `deriveAuthorization`): eval не имеет права быть настроен «под ответ».
 */
import { sandboxCapabilityCatalog } from './catalog';
import { deriveAuthorization, type IdentitySnapshotSource } from './authorization';
import { decideRoute } from './policy';
import type {
  AttachmentFeature,
  CapabilityCatalog,
  HostFacts,
  PreparedInput,
  RoutingDecision,
  RoutingEnvelope,
} from './router-types';

/** Диалог корпуса (только поля, нужные для маршрута; тексты остаются в файле корпуса). */
export interface CorpusDialog {
  id: string;
  class: string;
  route: string;
  split: string;
  story: string[];
  context: {
    connected?: string[];
    available_not_connected?: string[];
    clock?: string;
    active_task?: { id: string; state: string; title?: string } | null;
    last_task?: { id: string; state: string } | null;
    user_email?: string | null;
    session_empty?: boolean;
    prev_assistant_proposal?: string | null;
    tasks_yesterday_ref?: string | null;
    budget_left?: number | null;
    fault?: string | null;
  };
  turns: Array<{ role: string; text?: string; attachment?: { type: string; state?: string; chars?: number; ref?: string } }>;
  expect: { must?: string[]; must_not?: string[]; max_latency_s?: number; max_model_calls?: number };
  notes?: string;
}

export const CORPUS_VERSION = 1;
export const CORPUS_POLICY_VERSION = 'fast-path-v1-draft-2026-10-02';
export const EVAL_SOURCE = 'p16-route-policy';

/** Интеграции, известные системе (каталог). Готовность — из снимка профиля. */
const KNOWN_INTEGRATIONS = ['google-drive', 'web-search', 'documents'];

const INTEGRATION_ALIAS: Record<string, string> = {
  'google-drive': 'google-drive',
  'гугл-диск': 'google-drive',
};

function clockOf(dialog: CorpusDialog): number {
  const iso = dialog.context.clock;
  if (!iso) return Date.parse('2026-09-30T23:10:00+03:00');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Date.parse('2026-09-30T23:10:00+03:00');
}

function attachmentsOf(dialog: CorpusDialog): AttachmentFeature[] {
  const out: AttachmentFeature[] = [];
  for (const turn of dialog.turns) {
    const att = turn.attachment;
    if (!att) continue;
    out.push({
      artifactRef: att.ref ?? `${dialog.id}:artifact`,
      kind: att.type,
      extracted: att.state !== 'extracting',
      chars: att.chars ?? null,
    });
  }
  return out;
}

function hostFactsOf(dialog: CorpusDialog): HostFacts {
  const connections: Record<string, boolean> = {};
  for (const id of KNOWN_INTEGRATIONS) connections[id] = false;
  for (const id of dialog.context.connected ?? []) connections[INTEGRATION_ALIAS[id] ?? id] = true;
  for (const id of dialog.context.available_not_connected ?? []) connections[INTEGRATION_ALIAS[id] ?? id] = false;
  const active = dialog.context.active_task ?? null;
  return {
    clockMs: clockOf(dialog),
    connections,
    profileFields: { email: dialog.context.user_email ?? null },
    activeTasks: active ? [{ id: active.id, state: active.state, title: active.title ?? null }] : [],
    tasksYesterday: dialog.context.tasks_yesterday_ref
      ? [{ id: 'T-1041', title: 'сравнить тарифы' }]
      : [],
  };
}

function preparedOf(dialog: CorpusDialog): PreparedInput {
  const userTurns = dialog.turns.filter((t) => t.role === 'user');
  const lastText = userTurns[userTurns.length - 1]?.text ?? '';
  const prevAssistant = [...dialog.turns].reverse().find((t) => t.role === 'assistant_prev')?.text ?? null;
  return {
    text: lastText,
    context: {
      pendingProposal: dialog.context.prev_assistant_proposal ?? null,
      lastAssistantText: prevAssistant,
      sessionEmpty: dialog.context.session_empty ?? false,
      relevantTurns: Math.max(0, userTurns.length - 1) + (prevAssistant ? 1 : 0),
    },
    attachments: attachmentsOf(dialog),
    typedSignal: null,
    contextVersion: `ctx-${dialog.id}`,
    readinessSnapshotPresent: true,
  };
}

function envelopeOf(dialog: CorpusDialog): RoutingEnvelope {
  const budgetLeft = dialog.context.budget_left === undefined ? 1 : dialog.context.budget_left;
  return {
    principalId: `principal-${dialog.id}`,
    profileId: 'profile-corpus',
    userTaskId: `ut-${dialog.id}`,
    conversationId: `conv-${dialog.id}`,
    catalogVersion: 'capabilities-v1',
    policyVersion: CORPUS_POLICY_VERSION,
    budgets: { llmCallsRemaining: budgetLeft ?? 0, agentAllowed: true },
    runId: null,
    requestId: `req-${dialog.id}`,
  };
}

async function authorizationFor(dialog: CorpusDialog, catalog: CapabilityCatalog) {
  const identity: IdentitySnapshotSource = {
    principalId: envelopeOf(dialog).principalId,
    profileId: 'profile-corpus',
    scopes: ['tasks:intake', 'tasks:read', 'tasks:signal', 'tasks:control'],
    // Права на все объявленные capability каталога: eval проверяет МАРШРУТ, а
    // не модель выдачи прав (она проверяется отдельно, инвариантом AC-126).
    grantedCapabilityIds: catalog.capabilities.map((c) => c.id),
    grantedIntegrationIds: KNOWN_INTEGRATIONS,
  };
  return deriveAuthorization(identity, catalog);
}

/** Управляемый сбой recipe из поля `context.fault` корпуса. */
export function faultOutcomeOf(dialog: CorpusDialog): 'refused' | 'timeout' | 'invalid_json' | 'truncated' | null {
  switch (dialog.context.fault) {
    case 'model_returns_refusal_text':
      return 'refused';
    case 'model_timeout':
      return 'timeout';
    case 'model_invalid_json':
      return 'invalid_json';
    case 'model_truncated_json':
      return 'truncated';
    default:
      return null;
  }
}

/** Прогнать один диалог корпуса через политику. */
export async function replayDialog(dialog: CorpusDialog, catalog: CapabilityCatalog = sandboxCapabilityCatalog()): Promise<{
  decision: RoutingDecision;
  fault: string | null;
}> {
  const fault = faultOutcomeOf(dialog);
  const decision = decideRoute({
    envelope: envelopeOf(dialog),
    prepared: preparedOf(dialog),
    catalog,
    authorization: await authorizationFor(dialog, catalog),
    hostFacts: hostFactsOf(dialog),
  });
  return { decision, fault };
}

/**
 * Строка решений в формате стенда P18. Отдельный файл решений — артефакт
 * версии: он проверяется, а не переписывается под результат.
 */
export function decisionRow(caseId: string, decision: RoutingDecision, fault: string | null): Record<string, unknown> {
  const row: Record<string, unknown> = {
    case: caseId,
    route: decision.route,
    reasonCode: decision.reasonCode,
    mode: decision.mode,
    needsExecutor: decision.needsExecutor,
    schemaOutcome: decision.schemaOutcome,
    semanticOutcome: decision.semanticOutcome,
    coverage: decision.coverage,
    modelCalls: decision.modelCalls,
    escalationAttempt: decision.escalationAttempt,
    outcome: decision.outcome,
    executor: decision.executor,
    escalation: decision.escalation,
    replyAllowed: decision.replyAllowed,
    capabilityId: decision.capabilityId,
    requiresFreshData: decision.requiresFreshData,
    requiresExternalAction: decision.requiresExternalAction,
    permissionSource: decision.evidence.permissionSource,
    authorizationRef: decision.evidence.authorizationRef,
    catalogVersion: decision.evidence.catalogVersion,
    contextVersion: decision.evidence.contextVersion,
    intents: decision.evidence.intents,
    urlHosts: decision.evidence.urlHosts,
    urlQuoted: decision.evidence.urlQuoted,
    urlReadIntent: decision.evidence.urlReadIntent,
    embeddedInstructionIgnored: decision.evidence.embeddedInstructionIgnored,
    policyVersion: decision.policyVersion,
  };
  if (fault) {
    // Технический исход recipe: маршрут решения не меняется, исход — честный
    // technical_error, эскалации нет (§11.3).
    row.route = decision.route;
    row.outcome = 'technical_error';
    row.escalationAttempt = false;
    row.needsExecutor = false;
    row.schemaOutcome = 'refused';
    row.reasonCode = 'MODEL_REFUSED';
    row.fault = fault;
  }
  return row;
}
