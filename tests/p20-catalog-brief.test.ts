/**
 * Brief builder и retrieval (P20, AC-136; этап I06).
 *
 * Проверяются именно пункты приёмки карточки:
 *  - brief содержит ограничения по данным/задаче и ссылки на оригинал;
 *  - summary не придумывает права (доступность — факт снимка, не обещание);
 *  - кэш ключуется по profile/правам/связываниям/каталогу/политике/контексту;
 *  - размер brief измерен и укладывается в бюджет;
 *  - Tier-2 только для кандидатов, нативные имена MCP не переименовываются;
 *  - технический исход сборки не включает ни модель, ни исполнителя.
 */
import { describe, expect, it } from 'vitest';
import { deriveAuthorization } from '../src/router/authorization';
import { sandboxCapabilityCatalog, validateCatalog } from '../src/router/catalog';
import { compileCatalogBrief, compileCachedBrief, DEFAULT_BRIEF_MAX_BYTES } from '../src/router/brief/compiler';
import { ScopedBriefCache, briefCacheKey } from '../src/router/brief/cache';
import { accessClaimsOf } from '../src/router/brief/summary';
import { routeRequest } from '../src/router/service';
import { createReplyOrRouteRunner } from '../src/router/recipe/recipe';
import { sandboxHostCapabilityHandler } from '../src/router/recipe/host-data';
import { scriptedFixedModel, scriptedReply, type FixedModelPort } from '../src/router/recipe/fixed-model';
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
  principalId: 'sandbox-p20',
  profileId: 'profile-p20',
  userTaskId: 'ut-1',
  conversationId: 'conv-1',
  catalogVersion: catalog.version,
  policyVersion: 'route-policy-v1-2026-10-04',
  budgets: { llmCallsRemaining: 2, agentAllowed: true },
  runId: null,
  requestId: 'req-1',
  ...overrides,
});

const grantsAll = {
  principalId: 'sandbox-p20',
  profileId: 'profile-p20',
  scopes: ['tasks:intake', 'tasks:read'],
  grantedCapabilityIds: catalog.capabilities.map((c) => c.id),
  grantedIntegrationIds: ['google-drive', 'web-search'],
};

async function inputFor(
  text: string,
  opts: { envelope?: Partial<RoutingEnvelope>; prepared?: Partial<PreparedInput>; facts?: Partial<HostFacts>; grants?: Partial<typeof grantsAll> } = {},
): Promise<RoutingInput> {
  const grants = { ...grantsAll, ...opts.grants };
  return {
    envelope: baseEnvelope(opts.envelope),
    prepared: basePrepared(text, opts.prepared),
    catalog,
    authorization: await deriveAuthorization(grants, catalog),
    hostFacts: baseFacts(opts.facts),
  };
}

/** Модель-перехватчик: возвращает заданное решение и помнит, что пришло в запрос. */
function capturingModel(decision: string): FixedModelPort & { requests: Array<{ tools: unknown; brief: unknown }> } {
  const requests: Array<{ tools: unknown; brief: unknown }> = [];
  return {
    modelId: 'sandbox-capturing-model',
    exposesTools: false,
    requests,
    async invoke(request) {
      requests.push({ tools: (request as { tools?: unknown }).tools, brief: request.payload.catalogBrief });
      return { kind: 'ok', text: decision, finish: 'stop', usage: { inputTokens: null, outputTokens: null } };
    },
  };
}

const TEXT_WORK = 'перепиши короче: мы долго спорили о сроках и в итоге решили не торопиться';

/** Brief обязан быть собран: иначе падение с причиной, а не с undefined. */
function briefOrThrow(result: Awaited<ReturnType<typeof compileCatalogBrief>>) {
  if (result.status !== 'ok') throw new Error(`brief не собран: ${result.status}`);
  return result.brief;
}

/** Собранный brief: типизированный исход, а не «может быть null». */
async function briefOf(
  input: RoutingInput,
  opts: { purpose?: 'reply-or-route' | 'agent-work-order' | 'capability-discovery'; budget?: { maxBytes?: number } } = {},
) {
  const result = await compileCatalogBrief({ input, purpose: opts.purpose ?? 'reply-or-route', budget: opts.budget });
  if (result.status !== 'ok') throw new Error(`brief не собран: ${result.status}`);
  return result.brief!;
}

describe('P20 · Tier-1: явные имена, mode tags и факты доступности', () => {
  it('каждый entry несёт routing name, mode tags, эффект, данные и обязательные входы', async () => {
    const brief = await briefOf(await inputFor(TEXT_WORK));
    for (const entry of brief.tier1) {
      expect(entry.routingName).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
      expect(entry.modes.length).toBeGreaterThan(0);
      expect(entry.preferredMode).toBeDefined();
      expect(['read', 'write', 'none']).toContain(entry.effect);
      expect(['none', 'prepared', 'live']).toContain(entry.data);
      expect(['enabled', 'not_connected', 'not_granted', 'input_missing']).toContain(entry.availability);
      expect(entry.definitionRef).toBe(`capabilities:${catalog.version}:${entry.id}@${entry.version}`);
    }
    const share = brief!.tier1.find((entry) => entry.id === 'google-drive.share_file');
    expect(share?.required).toEqual(['email']);
    expect(share?.effect).toBe('write');
    expect(share?.data).toBe('live');
    const statusEntry = brief!.tier1.find((entry) => entry.id === 'service.status');
    expect(statusEntry?.modes).toEqual(['deterministic']);
    expect(statusEntry?.effect).toBe('none');
    expect(statusEntry?.data).toBe('prepared');
  });

  it('нативные имена MCP не переименовываются: brief только отображает отображение', async () => {
    const brief = await briefOf(await inputFor(TEXT_WORK));
    const byId = new Map(catalog.capabilities.map((entry) => [entry.id, entry]));
    for (const entry of brief.tier1) {
      const original = byId.get(entry.id);
      expect(original).toBeDefined();
      expect(entry.nativeToolName).toBe(original!.nativeToolName ?? null);
      expect(entry.routingName).not.toBe(entry.nativeToolName);
    }
    const names = brief.tier1.map((entry) => entry.routingName);
    expect(new Set(names).size).toBe(names.length);
    const native = brief.tier1.map((entry) => entry.nativeToolName).filter((name): name is string => name !== null);
    expect(new Set(native).size).toBe(native.length);
  });

  it('routing name по умолчанию — детерминированная проекция id, а не догадка', async () => {
    const input = await inputFor(TEXT_WORK);
    const stripped = {
      ...input,
      catalog: { version: catalog.version, capabilities: input.catalog.capabilities.map((c) => ({ ...c, routingName: undefined })) },
    };
    const brief = await briefOf(stripped);
    const entry = brief.tier1.find((item) => item.id === 'google-drive.read');
    expect(entry?.routingName).toBe('google_drive_read');
    expect(entry?.routingNameSource).toBe('derived_from_id');
  });
});

describe('P20 · Tier-2 только для кандидатов', () => {
  it('полные схемы получают выбранные кандидаты, а не весь каталог', async () => {
    const brief = await briefOf(await inputFor('что сейчас в работе?'));
    expect(brief.tier1.length).toBeGreaterThan(brief.tier2.length);
    expect(brief.tier2.length).toBeGreaterThan(0);
    const withSchema = brief.tier2.filter((entry) => entry.inputSchema.length + entry.outputSchema.length > 0);
    expect(withSchema.length).toBeGreaterThan(0);
    const byId = new Map(catalog.capabilities.map((c) => [c.id, c]));
    for (const entry of brief.tier2) {
      expect(brief.candidates).toContain(entry.id);
      const original = byId.get(entry.id)!;
      const data = original.dataSource === 'external_live' ? 'live' : original.dataSource === 'none' ? 'none' : 'prepared';
      expect(entry.constraints.data).toEqual([`data:${data}`, `effect:${original.effect}`]);
      expect(entry.constraints.task).toEqual(original.requiredInputs.map((field) => `required:${field}`));
      if (original.routeHint === 'template') {
        expect(entry.implementation.templateId).toBe(original.templateId);
      } else {
        expect(entry.implementation.handlerRef).toBe(`handler:${entry.id}`);
      }
    }
    const ids = brief.tier2.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('назначение без рецепта не тянет Tier-2', async () => {
    const brief = await briefOf(await inputFor(TEXT_WORK), { purpose: 'agent-work-order' });
    expect(brief.tier2).toEqual([]);
    expect(brief.tier1.length).toBeGreaterThan(0);
  });
});

describe('P20 · summary не придумывает права', () => {
  it('неподключённая интеграция — факт снимка, а не обещание', async () => {
    const brief = await briefOf(await inputFor('прочитай мою гугл-таблицу', { facts: { connections: { 'google-drive': false } } }));
    const entry = brief.tier1.find((item) => item.id === 'google-drive.read');
    expect(entry?.availability).toBe('not_connected');
    expect(entry?.executable).toBe(false);
    expect(entry?.summary).toContain('интеграция не подключена');
    expect(accessClaimsOf(entry?.summaryTitle ?? '')).toEqual([]);
  });

  it('невыданное право не попадает в Tier-1 вовсе', async () => {
    const brief = await briefOf(
      await inputFor(TEXT_WORK, { grants: { grantedCapabilityIds: catalog.capabilities.filter((c) => c.id !== 'service.help').map((c) => c.id) } }),
    );
    expect(brief.tier1.find((entry) => entry.id === 'service.help')).toBeUndefined();
    expect(brief.excludedByScope).toEqual([{ id: 'service.help', reason: 'not_granted' }]);
  });

  it('отсутствующий обязательный вход — input_missing, а не разрешение', async () => {
    const brief = await briefOf(await inputFor('расшарь файл', { facts: { profileFields: {} } }));
    const entry = brief.tier1.find((item) => item.id === 'google-drive.share_file');
    expect(entry?.availability).toBe('input_missing');
    expect(entry?.executable).toBe(false);
    expect(entry?.summary).toContain('нужны данные профиля');
  });

  it('заголовок каталога с обещанием доступа вырезается и попадает в gaps', async () => {
    const input = await inputFor(TEXT_WORK);
    const doctored = {
      ...input,
      catalog: {
        version: catalog.version,
        capabilities: input.catalog.capabilities.map((c) => (c.id === 'google-drive.read' ? { ...c, title: 'Подключено: гугл-диск, доступно всем' } : c)),
      },
    };
    const result = await compileCatalogBrief({ input: doctored, purpose: 'reply-or-route' });
    expect(result.status).toBe('ok');
    const compiled = briefOrThrow(result);
    const entry = compiled.tier1.find((item) => item.id === 'google-drive.read');
    expect(accessClaimsOf(entry?.summaryTitle ?? '')).toEqual([]);
    expect(compiled.gaps).toContain('access_claim_in_title:google-drive.read');
  });
});

describe('P20 · ссылки на оригинал и неизменность каталога', () => {
  it('brief ссылается на оригинальные определения, а каталог не меняется', async () => {
    const input = await inputFor(TEXT_WORK);
    const before = JSON.stringify(input.catalog);
    const brief = await briefOf(input);
    expect(JSON.stringify(input.catalog)).toBe(before);
    expect(brief.catalogVersion).toBe(catalog.version);
    expect(brief.catalogDigest).toMatch(/^[0-9a-f]{64}$/);
    for (const entry of brief.tier1) {
      expect(entry.definitionRef).toContain(catalog.version);
      expect(entry.definitionRef).toContain(entry.id);
    }
    for (const entry of brief.tier2) {
      expect(entry.definitionRef).toBe(`capabilities:${catalog.version}:${entry.id}@${entry.version}`);
    }
  });

  it('одинаковый каталог даёт одинаковый digest, другой — другой', async () => {
    const input = await inputFor(TEXT_WORK);
    const a = await briefOf(input);
    const b = await briefOf(input);
    expect(a.catalogDigest).toBe(b.catalogDigest);
    const changed = { ...input, catalog: { ...input.catalog, capabilities: input.catalog.capabilities.map((c) => (c.id === 'service.help' ? { ...c, title: 'Другой заголовок' } : c)) } };
    const c = await briefOf(changed);
    expect(c.catalogDigest).not.toBe(a.catalogDigest);
  });
});

describe('P20 · кэш ключуется по области, а не по тексту', () => {
  const scopeOf = (input: RoutingInput) => ({
    tenantId: input.envelope.principalId,
    profileId: input.envelope.profileId,
    authorizationRef: input.authorization.snapshotRef,
    bindingsRef: 'bindings',
    catalogVersion: input.catalog.version,
    policyVersion: input.envelope.policyVersion,
    contextVersion: input.prepared.contextVersion,
    purpose: 'reply-or-route' as const,
    schemaVersion: 'catalog-brief-v1',
  });

  it('одинаковая область даёт одинаковый ключ, другая — другой', async () => {
    const input = await inputFor(TEXT_WORK);
    const same = await briefCacheKey(scopeOf(input));
    const otherProfile = await briefCacheKey(scopeOf(await inputFor(TEXT_WORK, { envelope: { profileId: 'profile-p20-b' } })));
    const otherContext = await briefCacheKey(scopeOf(await inputFor(TEXT_WORK, { prepared: { contextVersion: 'ctx-2' } })));
    const otherCatalog = await briefCacheKey(scopeOf({ ...input, catalog: { ...input.catalog, version: 'capabilities-v2' } }));
    const otherPolicy = await briefCacheKey(scopeOf({ ...input, envelope: { ...input.envelope, policyVersion: 'route-policy-v2' } }));
    const otherPurpose = await briefCacheKey({ ...scopeOf(input), purpose: 'agent-work-order' });
    expect(same).toBe(await briefCacheKey(scopeOf(await inputFor(TEXT_WORK))));
    for (const key of [otherProfile, otherContext, otherCatalog, otherPolicy, otherPurpose]) {
      expect(key).not.toBe(same);
    }
  });

  it('смена прав и связываний меняет кэш: чужой brief не отдаётся', async () => {
    const cache = new ScopedBriefCache();
    const first = await inputFor(TEXT_WORK, { facts: { connections: { 'google-drive': true } } });
    const a = await compileCachedBrief({ input: first, purpose: 'reply-or-route', cache });
    expect(a.status).toBe('ok');
    expect(briefOrThrow(a).cache.hit).toBe(false);
    expect(briefOrThrow(a).cache.stored).toBe(true);
    const hit = await compileCachedBrief({ input: first, purpose: 'reply-or-route', cache });
    expect(briefOrThrow(hit).cache.hit).toBe(true);
    expect(briefOrThrow(hit).briefId).toBe(briefOrThrow(a).briefId);

    const otherProfile = await compileCachedBrief({
      input: await inputFor(TEXT_WORK, { envelope: { profileId: 'profile-p20-b' } }),
      purpose: 'reply-or-route',
      cache,
    });
    expect(briefOrThrow(otherProfile).cache.hit).toBe(false);
    expect(briefOrThrow(otherProfile).cache.key).not.toBe(briefOrThrow(a).cache.key);

    const otherBindings = await compileCachedBrief({
      input: await inputFor(TEXT_WORK, { facts: { connections: { 'google-drive': false } } }),
      purpose: 'reply-or-route',
      cache,
    });
    expect(briefOrThrow(otherBindings).cache.hit).toBe(false);
    const entry = briefOrThrow(otherBindings).tier1.find((item) => item.id === 'google-drive.read');
    expect(entry?.availability).toBe('not_connected');
  });

  it('в кэше и в ключе нет текста запроса и вложений', async () => {
    const cache = new ScopedBriefCache();
    const input = await inputFor('секретный текст про курс и таблицу');
    const brief = briefOrThrow(await compileCachedBrief({ input, purpose: 'reply-or-route', cache }));
    expect(brief.cache.key).not.toContain('секретный');
    expect(JSON.stringify(brief)).not.toContain('секретный');
    expect(JSON.stringify(brief)).not.toContain('курс');
  });

  it('вытеснение детерминировано: давний вход удаляется первым', async () => {
    const cache = new ScopedBriefCache({ maxEntries: 1 });
    const first = await compileCachedBrief({ input: await inputFor(TEXT_WORK), purpose: 'reply-or-route', cache });
    const second = await compileCachedBrief({ input: await inputFor(TEXT_WORK, { prepared: { contextVersion: 'ctx-2' } }), purpose: 'reply-or-route', cache });
    expect(briefOrThrow(second).cache.hit).toBe(false);
    expect(cache.stats().entries).toBe(1);
    expect(cache.stats().evictions).toBe(1);
    // Давняя запись вытеснена: повторный запрос той же области — промах, а не
    // отдача вытесненного brief'а.
    const again = await compileCachedBrief({ input: await inputFor(TEXT_WORK), purpose: 'reply-or-route', cache });
    expect(briefOrThrow(again).cache.hit).toBe(false);
    expect(briefOrThrow(again).cache.key).toBe(briefOrThrow(first).cache.key);
  });
});

describe('P20 · размер brief измерен и уложен в бюджет', () => {
  it('измерение по умолчанию: байты, вхождения и бюджет в ответе', async () => {
    const brief = await briefOf(await inputFor(TEXT_WORK));
    expect(brief.bytes).toBeGreaterThan(0);
    expect(brief.chars).toBeGreaterThan(0);
    expect(brief.budget.maxBytes).toBe(DEFAULT_BRIEF_MAX_BYTES);
    expect(brief.budget.measuredBytes).toBe(brief.bytes);
    expect(brief.budget.withinBudget).toBe(true);
    expect(brief.measurements.length).toBeGreaterThan(0);
    expect(brief.measurements[0]!.bytes).toBe(brief.bytes);
  });

  it('маленький бюджет: Tier-2 отбрасывается первым, потери видны', async () => {
    const brief = await briefOf(await inputFor(TEXT_WORK), { budget: { maxBytes: 6000 } });
    expect(brief.degraded).toBe(true);
    expect(brief.budget.withinBudget).toBe(true);
    expect(brief.omittedByBudget.length).toBeGreaterThan(0);
    expect(brief.tier2.length).toBeGreaterThan(0);
    const steps = brief.measurements.map((step) => step.step);
    expect(steps).toContain('full');
    expect(steps).toContain('tier1-only');
    expect(steps).toContain('tier1-minimal');
    expect(steps[steps.length - 1]!.startsWith('tier1-minimal+tier2:')).toBe(true);
    expect(brief.measurements.every((step) => step.bytes > 0)).toBe(true);
    expect(brief.measurements[brief.measurements.length - 1]!.bytes).toBe(brief.bytes);
  });

  it('минимальный Tier-1 не влезает — технический исход over_budget', async () => {
    const result = await compileCatalogBrief({ input: await inputFor(TEXT_WORK), purpose: 'reply-or-route', budget: { maxBytes: 32 } });
    expect(result.status).toBe('over_budget');
    if (result.status !== 'over_budget') throw new Error('ожидался over_budget');
    expect(result.minimalBytes).toBeGreaterThan(32);
    expect(result.brief?.tier1.length).toBeGreaterThan(0);
  });

  it('over_budget не зовёт модель и не включает исполнителя', async () => {
    const model = scriptedFixedModel({ script: [scriptedReply('короче: решили не торопиться')] });
    const result = await routeRequest(await inputFor(TEXT_WORK), {
      replyOrRoute: createReplyOrRouteRunner({ model, llmCallsRemaining: () => 2, deadlineMs: 5_000 }),
      modelId: model.modelId,
      handler: sandboxHostCapabilityHandler(),
      brief: { budget: { maxBytes: 32 } },
    });
    expect(result.decision.outcome).toBe('technical_error');
    expect(result.decision.reasonCode).toBe('BRIEF_BUDGET_EXCEEDED');
    expect(result.decision.modelCalls).toBe(0);
    expect(result.execution.agentDispatchAttempts).toBe(0);
    expect(result.reply).toBeNull();
    expect(result.continuation).toBeNull();
    expect(result.decision.escalationAttempt).toBe(false);
    expect(result.brief?.status).toBe('over_budget');
  });

  it('детерминированный путь от бюджета brief не зависит', async () => {
    const result = await routeRequest(await inputFor('что сейчас в работе?'), {
      replyOrRoute: createReplyOrRouteRunner({ model: scriptedFixedModel(), llmCallsRemaining: () => 2 }),
      handler: sandboxHostCapabilityHandler(),
      brief: { budget: { maxBytes: 32 } },
    });
    expect(result.decision.outcome).toBe('dispatched');
    expect(result.reply?.text).toContain('T-1042');
    expect(result.brief?.status).toBe('ok');
  });
});

describe('P20 · интеграция: рецепт и исполнитель', () => {
  it('модель получает brief с именами, ограничениями и ссылками, без инструментов', async () => {
    const model = capturingModel(scriptedReply('короче: решили не торопиться', ['catalog:capabilities-v1:tasks.list_active']));
    const result = await routeRequest(await inputFor(TEXT_WORK), {
      replyOrRoute: createReplyOrRouteRunner({ model, llmCallsRemaining: () => 2, deadlineMs: 5_000 }),
      modelId: model.modelId,
      handler: sandboxHostCapabilityHandler(),
    });
    expect(result.decision.outcome).toBe('reply');
    expect(result.decision.route).toBe('llm');
    expect(model.requests.length).toBe(1);
    const request = model.requests[0]!;
    expect(request.tools).toBeUndefined();
    const brief = request.brief as {
      briefId: string;
      capabilities: Array<{ id: string; routingName: string; availability: string; definitionRef: string }>;
      tier2: Array<{ id: string }>;
      budget: { measuredBytes: number; withinBudget: boolean };
    };
    expect(brief.briefId).toMatch(/^[0-9a-f]{64}$/);
    expect(brief.capabilities.length).toBeGreaterThan(0);
    expect(brief.capabilities[0]!.routingName).toMatch(/^[a-z][a-z0-9_]+$/);
    expect(brief.capabilities[0]!.availability).toBeDefined();
    expect(brief.capabilities[0]!.definitionRef).toContain('capabilities:');
    expect(brief.tier2.length).toBeGreaterThan(0);
    for (const entry of brief.tier2) {
      expect(brief.capabilities.map((cap) => cap.id)).toContain(entry.id);
    }
    expect(brief.capabilities.length).toBeGreaterThan(0);
    expect(brief.budget.withinBudget).toBe(true);
    expect(brief.budget.measuredBytes).toBeGreaterThan(0);
  });

  it('discovery-индекс исполнителя содержит только разрешённые возможности', async () => {
    const input = await inputFor('найди пять конкурентов и сравни цены', {
      grants: { grantedCapabilityIds: catalog.capabilities.filter((c) => c.id !== 'google-drive.share_file').map((c) => c.id) },
    });
    const result = await routeRequest(input, {
      replyOrRoute: createReplyOrRouteRunner({ model: scriptedFixedModel(), llmCallsRemaining: () => 2 }),
      handler: sandboxHostCapabilityHandler(),
    });
    expect(result.decision.needsExecutor).toBe(true);
    expect(result.workOrder).not.toBeNull();
    expect(result.continuation?.requiredCapabilities).not.toContain('google-drive.share_file');
    expect(result.continuation?.requiredCapabilities).toContain('tasks.list_active');
  });

  it('управляемый сбой модели остаётся техническим исходом при собранном brief', async () => {
    const model = scriptedFixedModel({ fault: 'refused' });
    const result = await routeRequest(await inputFor(TEXT_WORK), {
      replyOrRoute: createReplyOrRouteRunner({ model, llmCallsRemaining: () => 2, deadlineMs: 5_000 }),
      modelId: model.modelId,
      handler: sandboxHostCapabilityHandler(),
    });
    expect(result.decision.outcome).toBe('technical_error');
    expect(result.decision.reasonCode).toBe('MODEL_REFUSED');
    expect(result.decision.needsExecutor).toBe(false);
    expect(result.execution.agentDispatchAttempts).toBe(0);
    expect(result.brief?.status).toBe('ok');
  });
});

describe('P20 · проверка метаданных каталога', () => {
  it('коллизии явных имён и режим вне supportedModes — невалидный снимок', () => {
    const duplicate = validateCatalog({
      version: catalog.version,
      capabilities: catalog.capabilities.map((c, index) => (index === 1 ? { ...c, routingName: catalog.capabilities[0]!.routingName } : c)),
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errors.join('; ')).toContain('routingName: duplicate');

    const badMode = validateCatalog({
      version: catalog.version,
      capabilities: catalog.capabilities.map((c) => (c.id === 'service.help' ? { ...c, preferredMode: 'agent' as const } : c)),
    });
    expect(badMode.ok).toBe(false);
    expect(badMode.errors.join('; ')).toContain('preferredMode');

    const badName = validateCatalog({
      version: catalog.version,
      capabilities: catalog.capabilities.map((c) => (c.id === 'service.help' ? { ...c, routingName: 'С Пробелами' } : c)),
    });
    expect(badName.ok).toBe(false);
    expect(badName.errors.join('; ')).toContain('routingName: expected snake_case');
  });

  it('невалидный снимок каталога даёт технический исход без исполнителя', async () => {
    const input = await inputFor(TEXT_WORK);
    const broken = {
      ...input,
      catalog: { version: catalog.version, capabilities: input.catalog.capabilities.map((c) => (c.id === 'service.help' ? { ...c, preferredMode: 'agent' as const } : c)) },
    };
    const result = await routeRequest(broken, {
      replyOrRoute: createReplyOrRouteRunner({ model: scriptedFixedModel(), llmCallsRemaining: () => 2 }),
      handler: sandboxHostCapabilityHandler(),
      brief: {},
    });
    expect(result.decision.outcome).toBe('technical_error');
    expect(result.decision.reasonCode).toBe('BRIEF_METADATA_INVALID');
    expect(result.decision.needsExecutor).toBe(false);
    expect(result.execution.agentDispatchAttempts).toBe(0);
    expect(result.brief?.status).toBe('invalid');
  });
});
