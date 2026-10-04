/**
 * Bounded reply-or-route recipe (P17, AC-128).
 *
 * Проверяются исходы, которые обязаны быть корректными ВСЕГДА:
 *  - schema invalid (в том числе после одного ремонта) — технический исход, а
 *    не ответ и не исполнитель;
 *  - model timeout и provider failure — технический исход с явной причиной;
 *  - budget denied — до платного вызова, модель не зовётся вовсе;
 *  - awaiting input — типизированное ожидание по известному хосту полю;
 *  - insufficient context — ответ не публикуется и не эскалируется;
 *  - модель не получает инструментов и не назначает исполнителя;
 *  - продолжение запрашивается, но не выдаётся роутером.
 */
import { describe, expect, it } from 'vitest';
import { deriveAuthorization } from '../src/router/authorization';
import { sandboxCapabilityCatalog } from '../src/router/catalog';
import { routeRequest } from '../src/router/service';
import { createReplyOrRouteRunner } from '../src/router/recipe/recipe';
import { sandboxHostCapabilityHandler } from '../src/router/recipe/host-data';
import {
  scriptedAgentDecision,
  scriptedCapabilityDecision,
  scriptedClarify,
  scriptedFixedModel,
  scriptedReply,
} from '../src/router/recipe/fixed-model';
import type { HostFacts, PreparedInput, RoutingEnvelope, RoutingInput } from '../src/router/router-types';

const catalog = sandboxCapabilityCatalog();

const baseFacts = (overrides: Partial<HostFacts> = {}): HostFacts => ({
  clockMs: Date.parse('2026-09-30T23:10:00+03:00'),
  connections: { 'google-drive': true, 'web-search': true },
  profileFields: { email: null },
  activeTasks: [{ id: 'T-1042', state: 'running', title: 'сравнить тарифы' }],
  tasksYesterday: [{ id: 'T-1041', title: 'сравнить тарифы' }],
  ...overrides,
});

const basePrepared = (text: string, overrides: Partial<PreparedInput> = {}): PreparedInput => ({
  text,
  context: { pendingProposal: null, lastAssistantText: null, sessionEmpty: true, relevantTurns: 0 },
  attachments: [],
  typedSignal: null,
  contextVersion: 'ctx-1',
  readinessSnapshotPresent: true,
  ...overrides,
});

const baseEnvelope = (overrides: Partial<RoutingEnvelope> = {}): RoutingEnvelope => ({
  principalId: 'sandbox-p17',
  profileId: 'profile-p17',
  userTaskId: 'ut-1',
  conversationId: 'conv-1',
  catalogVersion: catalog.version,
  policyVersion: catalog.version,
  budgets: { llmCallsRemaining: 2, agentAllowed: true },
  runId: null,
  requestId: 'req-1',
  ...overrides,
});

const grantsAll = {
  principalId: 'sandbox-p17',
  profileId: 'profile-p17',
  scopes: ['tasks:intake', 'tasks:read'],
  grantedCapabilityIds: catalog.capabilities.map((c) => c.id),
  grantedIntegrationIds: ['google-drive', 'web-search'],
};

async function inputFor(
  text: string,
  opts: { envelope?: Partial<RoutingEnvelope>; prepared?: Partial<PreparedInput>; facts?: Partial<HostFacts> } = {},
): Promise<RoutingInput> {
  return {
    envelope: baseEnvelope(opts.envelope),
    prepared: basePrepared(text, opts.prepared),
    catalog,
    authorization: await deriveAuthorization(grantsAll, catalog),
    hostFacts: baseFacts(opts.facts),
  };
}

/**
 * Текст, который политика P16 отдаёт рецепту: работа с уже данным текстом
 * (маршрут `llm`, режим `llm-recipe-job`). Намеренно без намерений «живых
 * данных»/«внешнего действия»/«адаптивных инструментов» — иначе политика
 * эскалирует ДО вызова модели, и проверялся бы не рецепт.
 */
const TEXT_WORK = 'перепиши короче: мы долго спорили о сроках и в итоге решили не торопиться';
/** Тот же быстрый путь, но с явным запретом на внешнее действие в исходном тексте. */
const TEXT_WORK_NO_PUBLISH = 'перепиши короче это письмо и не публикуй его';

/** Запуск маршрута с заданной скриптованной моделью (тот же порт, что в /route). */
async function routeWith(
  text: string,
  model: ReturnType<typeof scriptedFixedModel>,
  opts: { envelope?: Partial<RoutingEnvelope>; prepared?: Partial<PreparedInput>; facts?: Partial<HostFacts> } = {},
  llmCallsRemaining = 2,
) {
  const input = await inputFor(text, opts);
  return routeRequest(input, {
    replyOrRoute: createReplyOrRouteRunner({ model, llmCallsRemaining: () => llmCallsRemaining, deadlineMs: 5_000 }),
    modelId: model.modelId,
    handler: sandboxHostCapabilityHandler(),
  });
}

describe('P17 · один полезный вызов: reply / clarify / needs_executor', () => {
  it('готовый reply публикуется, исполнитель не включается', async () => {
    const model = scriptedFixedModel({ script: [scriptedReply('Короче: решили не торопиться', ['host:conversation'])] });
    const result = await routeWith(TEXT_WORK, model);
    expect(result.decision.outcome).toBe('reply');
    expect(result.decision.route).toBe('llm');
    expect(result.reply?.text).toBe('Короче: решили не торопиться');
    expect(result.decision.needsExecutor).toBe(false);
    expect(result.continuation).toBeNull();
    expect(result.execution.agentDispatchAttempts).toBe(0);
    expect(result.decision.modelCalls).toBe(1);
    expect(result.decision.recipeId).toBe('reply-or-route-v1');
    expect(result.decision.modelId).toBe('sandbox-scripted-fixed-model');
  });

  it('clarify без известного хосту поля — вопрос, а не ожидание', async () => {
    const model = scriptedFixedModel({ script: [scriptedClarify('Что именно сделать?', ['goal'])] });
    const result = await routeWith(TEXT_WORK, model);
    expect(result.decision.outcome).toBe('clarify');
    expect(result.askUser?.question).toBe('Что именно сделать?');
    expect(result.askUser?.missingFields).toEqual(['goal']);
    expect(result.reply).toBeNull();
    expect(result.continuation).toBeNull();
  });

  it('needs_executor — заявка OpenCode и ЗАПРОС продолжения, без запуска', async () => {
    const model = scriptedFixedModel({
      script: [
        scriptedAgentDecision({
          nextGoal: 'найди пять конкурентов и сравни цены',
          reasonCode: 'ADAPTIVE_TOOL_LOOP',
          requiredCapabilities: ['web-search'],
        }),
      ],
    });
    const result = await routeWith(TEXT_WORK, model);
    expect(result.decision.outcome).toBe('escalated');
    expect(result.decision.needsExecutor).toBe(true);
    expect(result.decision.executor).toBe('opencode');
    expect(result.decision.reasonCode).toBe('ADAPTIVE_TOOL_LOOP');
    expect(result.decision.replyAllowed).toBe(false);
    expect(result.reply).toBeNull();
    expect(result.workOrder?.executor).toBe('opencode');
    expect(result.continuation).not.toBeNull();
    expect(result.continuation?.userTaskId).toBe('ut-1');
    expect(result.continuation?.reasonCode).toBe('ADAPTIVE_TOOL_LOOP');
    expect(result.continuation?.preservedConstraints).toEqual([]);
    // Возможности — названные решением, а не весь каталог.
    expect(result.continuation?.requiredCapabilities).toEqual(['web-search']);
    // Роутер продолжение не выдаёт: владелец — Output.
    expect(result.decision.jobRef).toBeNull();
  });

  it('ограничение из исходного текста не теряется в запросе продолжения', async () => {
    const model = scriptedFixedModel({
      script: [
        scriptedAgentDecision({
          nextGoal: 'подготовь публикацию, но не публикуй',
          reasonCode: 'ARTIFACT_WORKSPACE_REQUIRED',
        }),
      ],
    });
    const result = await routeWith(TEXT_WORK_NO_PUBLISH, model);
    expect(result.decision.outcome).toBe('escalated');
    expect(result.continuation?.preservedConstraints).toContain('no_publish');
    // Подтверждение решает хост по запрету в тексте, а не самооценка модели.
    expect(result.continuation?.requiresConfirmation).toBe(true);
    expect(result.decision.requiresExternalAction).toBe(true);
  });
});

describe('P17 · технические исходы не становятся ответом и не включают исполнителя', () => {
  it('schema invalid: один ремонт, затем честный технический исход', async () => {
    const model = scriptedFixedModel({ script: ['это не JSON', 'и это не JSON'] });
    const result = await routeWith(TEXT_WORK, model);
    expect(result.decision.outcome).toBe('technical_error');
    expect(result.decision.schemaOutcome).toBe('invalid');
    expect(result.decision.reasonCode).toBe('SCHEMA_INVALID');
    expect(result.decision.repairAttempts).toBe(1);
    expect(result.decision.modelCalls).toBe(2);
    expect(result.reply).toBeNull();
    expect(result.decision.needsExecutor).toBe(false);
    expect(result.continuation).toBeNull();
    expect(result.execution.agentDispatchAttempts).toBe(0);
  });

  it('schema invalid после валидного первого ответа не исполняется', async () => {
    const model = scriptedFixedModel({
      script: [
        JSON.stringify({
          schemaVersion: 1,
          kind: 'reply',
          reply: { text: 'ответ', evidenceRefs: ['куда-нибудь'] },
          assessment: { contextSufficient: true, needsFreshData: false, needsActions: false, needsAdaptiveTools: false },
        }),
      ],
    });
    const result = await routeWith(TEXT_WORK, model);
    expect(result.decision.outcome).toBe('blocked');
    expect(result.decision.semanticOutcome).toBe('invalid');
    expect(result.decision.reasonCode).toBe('SEMANTIC_INVALID');
    expect(result.reply).toBeNull();
  });

  it('модель не может назначить исполнителя: поле executor запрещено', async () => {
    const model = scriptedFixedModel({
      script: [
        JSON.stringify({
          schemaVersion: 1,
          kind: 'reply',
          reply: { text: 'ответ', evidenceRefs: [] },
          assessment: { contextSufficient: true, needsFreshData: false, needsActions: false, needsAdaptiveTools: false },
          executor: 'claude',
        }),
      ],
    });
    const result = await routeWith(TEXT_WORK, model);
    expect(result.decision.outcome).toBe('technical_error');
    expect(result.decision.reasonCode).toBe('SCHEMA_INVALID');
    expect(result.reply).toBeNull();
  });

  it('неизвестная capability не исполняется', async () => {
    const model = scriptedFixedModel({
      script: [
        scriptedCapabilityDecision({ capabilityId: 'web.page_read', capabilityVersion: 1, proposedJobType: 'deterministic-job', reasonCode: 'NEEDS_CURRENT_USER_DATA' }),
      ],
    });
    const result = await routeWith(TEXT_WORK, model);
    expect(result.decision.outcome).toBe('blocked');
    expect(result.decision.reasonCode).toBe('UNKNOWN_CAPABILITY_VERSION');
    expect(result.execution.capabilityExecutions).toBe(0);
    expect(result.continuation).toBeNull();
  });

  it('model timeout — технический исход без эскалации', async () => {
    const model = scriptedFixedModel({ fault: 'timeout' });
    const result = await routeWith(TEXT_WORK, model);
    expect(result.decision.outcome).toBe('technical_error');
    expect(result.decision.schemaOutcome).toBe('timeout');
    expect(result.decision.reasonCode).toBe('MODEL_TIMEOUT');
    expect(result.decision.needsExecutor).toBe(false);
    expect(result.continuation).toBeNull();
    expect(result.reply).toBeNull();
  });

  it('provider failure — причина и код провайдера в решении', async () => {
    const model = scriptedFixedModel({ fault: 'provider_failure' });
    const result = await routeWith(TEXT_WORK, model);
    expect(result.decision.outcome).toBe('technical_error');
    expect(result.decision.schemaOutcome).toBe('provider_failure');
    expect(result.decision.reasonCode).toBe('PROVIDER_FAILURE');
    expect(result.decision.providerCode).toBe('server_error');
    expect(result.continuation).toBeNull();
  });

  it('обрезанный ответ не чинится повтором: один вызов, честный исход', async () => {
    const model = scriptedFixedModel({ fault: 'truncated' });
    const result = await routeWith(TEXT_WORK, model);
    expect(result.decision.outcome).toBe('technical_error');
    expect(result.decision.schemaOutcome).toBe('truncated');
    expect(result.decision.reasonCode).toBe('SCHEMA_TRUNCATED');
    expect(result.decision.modelCalls).toBe(1);
    expect(result.decision.repairAttempts).toBe(0);
  });

  it('отказ модели не записывается как успех (PR-15)', async () => {
    const model = scriptedFixedModel({ fault: 'refused' });
    const result = await routeWith(TEXT_WORK, model);
    expect(result.decision.outcome).toBe('technical_error');
    expect(result.decision.schemaOutcome).toBe('refused');
    expect(result.decision.reasonCode).toBe('MODEL_REFUSED');
    expect(result.reply).toBeNull();
  });
});

describe('P17 · бюджет, ожидание ввода и недостаточный контекст', () => {
  it('нулевой бюджет: модель не зовётся вовсе, исход — blocked', async () => {
    const model = scriptedFixedModel({ script: [scriptedReply('ответ не нужен')] });
    const result = await routeWith(TEXT_WORK, model, {}, 0);
    expect(result.decision.outcome).toBe('blocked');
    expect(result.decision.schemaOutcome).toBe('budget_denied');
    expect(result.decision.reasonCode).toBe('BUDGET_DENIED');
    expect(result.decision.modelCalls).toBe(0);
    expect(model.calls).toHaveLength(0);
    expect(result.continuation).toBeNull();
  });

  it('clarify по известному хосту полю — типизированное ожидание (required_input)', async () => {
    const model = scriptedFixedModel({ script: [scriptedClarify('Нужен ваш email, чтобы отправить файл.', ['email'])] });
    const result = await routeWith(TEXT_WORK, model, { facts: { profileFields: { email: null } } });
    expect(result.decision.outcome).toBe('required_input');
    expect(result.decision.reasonCode).toBe('MISSING_REQUIRED_INPUT');
    expect(result.askUser?.missingFields).toEqual(['email']);
    expect(result.reply).toBeNull();
    expect(result.continuation).toBeNull();
    expect(result.execution.agentDispatchAttempts).toBe(0);
  });

  it('reply при contextSufficient=false не публикуется и не эскалируется', async () => {
    const model = scriptedFixedModel({
      script: [
        JSON.stringify({
          schemaVersion: 1,
          kind: 'reply',
          reply: { text: 'ответ по неполному контексту', evidenceRefs: [] },
          assessment: { contextSufficient: false, needsFreshData: true, needsActions: false, needsAdaptiveTools: false },
        }),
      ],
    });
    const result = await routeWith(TEXT_WORK, model);
    expect(result.decision.outcome).toBe('insufficient_context');
    expect(result.decision.reasonCode).toBe('CONTEXT_NOT_SUFFICIENT');
    expect(result.decision.semanticOutcome).toBe('coverage_pending');
    expect(result.reply).toBeNull();
    expect(result.decision.needsExecutor).toBe(false);
    expect(result.continuation).toBeNull();
  });
});

describe('P17 · модель без инструментов и данные от хоста', () => {
  it('в запросе модели нет инструментов и нет исполнителя', async () => {
    const model = scriptedFixedModel({ script: [scriptedReply('ответ')] });
    await routeWith(TEXT_WORK, model);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.toolsPresent).toBe(false);
    expect(model.calls[0]!.repair).toBe(false);
  });

  it('needs_capability: данные приготовил хост, ответ — из снимка', async () => {
    const model = scriptedFixedModel({
      script: [
        scriptedCapabilityDecision({
          capabilityId: 'tasks.list_active',
          capabilityVersion: 1,
          proposedJobType: 'deterministic-job',
          reasonCode: 'NEEDS_CURRENT_USER_DATA',
        }),
      ],
    });
    const result = await routeWith(TEXT_WORK, model);
    expect(result.decision.outcome).toBe('reply');
    expect(result.execution.capabilityExecutions).toBe(1);
    expect(result.reply?.text).toContain('T-1042');
    expect(result.continuation).toBeNull();
  });

  it('needs_capability без обязательного входа — ожидание, а не агент', async () => {
    const model = scriptedFixedModel({
      script: [
        scriptedCapabilityDecision({
          capabilityId: 'google-drive.share_file',
          capabilityVersion: 1,
          proposedJobType: 'deterministic-job',
          reasonCode: 'NEEDS_CURRENT_USER_DATA',
        }),
      ],
    });
    const result = await routeWith(TEXT_WORK, model, { facts: { profileFields: { email: null } } });
    expect(result.decision.outcome).toBe('required_input');
    expect(result.askUser?.missingFields).toEqual(['email']);
    expect(result.continuation).toBeNull();
  });

  it('needs_agent от host-обработчика — эскалация с причиной владельца данных', async () => {
    const model = scriptedFixedModel({
      script: [
        scriptedCapabilityDecision({
          capabilityId: 'google-drive.read',
          capabilityVersion: 1,
          proposedJobType: 'deterministic-job',
          reasonCode: 'NEEDS_CURRENT_USER_DATA',
        }),
      ],
    });
    const result = await routeWith(TEXT_WORK, model, {
      facts: { connections: { 'google-drive': true, 'web-search': true } },
    });
    expect(result.decision.outcome).toBe('escalated');
    expect(result.decision.reasonCode).toBe('CONTEXT_NOT_COVERED');
    expect(result.continuation).not.toBeNull();
    expect(result.continuation?.partialResultRef).toBeNull();
    expect(result.continuation?.requiredCapabilities).toEqual(['google-drive.read']);
  });
});
