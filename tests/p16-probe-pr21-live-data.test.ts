/**
 * Проба PR-21 (AC-126): вопрос о живых данных не получает выдуманный быстрый
 * ответ — ни числа, ни содержимого страницы «из памяти».
 *
 * Источник ловушки: stories/PROBES.md PR-21 (FR-050, FR-051). Пара-ловушка —
 * PR-23/FR-052: та же ссылка В ЦИТАТЕ не является просьбой читать страницу.
 *
 * Проверяются обе части «Проверки» пробы:
 *  - что видит пользователь: честное «передаю исполнителю», а не число;
 *  - сигнал по журналу: `run_started` не появляется (агент не запускался),
 *    решение содержит needsExecutor/executor/reasonCode, а права решения
 *    приходят из снимка идентичности.
 *
 * Проба идёт через настоящий HTTP-поток control plane: приём задачи → `POST
 * /route` с подписью принципала. Исполнитель не запускается: `POST /route`
 * возвращает AgentWorkOrder, а запуск остаётся за M1.3/P17.
 */
import { describe, expect, it, vi } from 'vitest';
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import { signPrincipal } from '../src/auth/principal-auth';
import { deriveAuthorization } from '../src/router/authorization';
import { sandboxCapabilityCatalog } from '../src/router/catalog';
import { routeRequest } from '../src/router/service';
import type { CapabilityEntry } from '../src/router/router-types';

const SECRET = 'sandbox-p16-secret';
let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const worker = () => import('../src/index');

interface RouteEnv {
  DB: D1Database;
  TASK_WORKFLOW: Workflow;
  PRINCIPAL_SECRET: string;
  ROUTER_PROFILE_FACTS: string;
  ROUTER_GRANTS: string;
  ROUTER_CLOCK: string;
}

async function envFor(overrides: Partial<RouteEnv> = {}): Promise<RouteEnv> {
  const base: RouteEnv = {
    DB: env.DB,
    TASK_WORKFLOW: env.TASK_WORKFLOW,
    PRINCIPAL_SECRET: SECRET,
    ROUTER_PROFILE_FACTS: JSON.stringify({ connections: { 'google-drive': true, 'web-search': true }, profileFields: {} }),
    ROUTER_GRANTS: JSON.stringify({ 'sandbox-p16': { capabilities: [], integrations: [] } }),
    ROUTER_CLOCK: String(Date.parse('2026-09-30T23:10:00+03:00')),
    ...overrides,
  };
  return base;
}

async function seed(): Promise<TaskStore> {
  const store = new TaskStore(env.DB);
  await store.upsertPrincipal({
    principalId: 'sandbox-p16',
    profileId: 'profile-p16',
    scopes: ['tasks:intake', 'tasks:read', 'tasks:signal', 'tasks:control'],
  });
  return store;
}

/** Приём задачи + маршрут её текста: полный пользовательский поток. */
async function routeText(text: string, overrides: Partial<RouteEnv> = {}, bodyExtra: Record<string, unknown> = {}) {
  const mod = await worker();
  const requestId = nextId('req');
  const sig = await signPrincipal('sandbox-p16', SECRET);
  const headers = { 'content-type': 'application/json', 'x-principal': 'sandbox-p16', 'x-principal-sig': sig };

  const intake = await mod.default.fetch(
    new Request('https://example.test/intake', {
      method: 'POST',
      headers,
      body: JSON.stringify({ contractVersion: 1, requestId, profileId: 'profile-p16', inputItems: [{ text }] }),
    }),
    await envFor(overrides),
  );
  const admitted = (await intake.json()) as { userTaskId: string };
  expect(intake.status).toBe(201);

  const routed = await mod.default.fetch(
    new Request('https://example.test/route', {
      method: 'POST',
      headers,
      body: JSON.stringify({ taskId: admitted.userTaskId, ...bodyExtra }),
    }),
    await envFor(overrides),
  );
  const decision = (await routed.json()) as {
    route: string | null;
    reasonCode: string;
    outcome: string;
    needsExecutor: boolean;
    executor: string | null;
    replyAllowed: boolean;
    reply: { text: string } | null;
    workOrder: { executor: string; originalRequestRef: string; goal: string; requiresConfirmation: boolean } | null;
    execution: { agentDispatchAttempts: number; capabilityExecutions: number; recipeCalls: number };
    evidence: {
      urlHosts: string[];
      urlQuoted: boolean;
      urlReadIntent: boolean;
      intents: string[];
      permissionSource: string;
      authorizationRef: string;
    };
  };
  return { status: routed.status, decision, userTaskId: admitted.userTaskId, store: new TaskStore(env.DB) };
}

describe('PR-21: живой вопрос о данных уходит исполнителю, число не выдумывается', () => {
  it('«какой сейчас курс доллара?» — маршрут к исполнителю, ответа-числа нет', async () => {
    await seed();
    const { decision, userTaskId, store } = await routeText('какой сейчас курс доллара?');

    expect(decision.route).toBe('agent');
    expect(decision.reasonCode).toBe('LIVE_DATA_NO_CAPABILITY');
    expect(decision.needsExecutor).toBe(true);
    expect(decision.executor).toBe('opencode');
    expect(decision.replyAllowed).toBe(false);
    expect(decision.reply).toBeNull();
    expect(decision.execution.recipeCalls).toBe(0);
    // Живой вопрос не проходит через recipe: данных у модели нет.
    expect(decision.evidence.intents).toContain('freshness');

    // Исполнитель только заявка; в журнале задачи попытки запуска нет.
    expect(decision.workOrder?.executor).toBe('opencode');
    expect(decision.workOrder?.goal).toBe('какой сейчас курс доллара?');
    const history = await store.history(userTaskId);
    expect(history.filter((e) => e.kind === 'run_started')).toHaveLength(0);
  });

  it('«что сейчас написано на главной https://example.com ?» — содержимое страницы не сочиняется', async () => {
    await seed();
    const { decision, userTaskId, store } = await routeText('что сейчас написано на главной https://example.com ?');

    expect(decision.route).toBe('agent');
    expect(decision.replyAllowed).toBe(false);
    expect(decision.reply).toBeNull();
    expect(decision.evidence.urlHosts).toEqual(['example.com']);
    expect(decision.evidence.urlQuoted).toBe(false);
    // Эскалация вызвана признаком «живые данные», а не самим фактом ссылки:
    // интенты показывают, какое ИМЕННО правило сработало.
    expect(decision.evidence.intents).toContain('freshness');
    expect(decision.workOrder?.originalRequestRef).toContain(userTaskId);

    const history = await store.history(userTaskId);
    expect(history.filter((e) => e.kind === 'run_started')).toHaveLength(0);
    // Никакого fetch/сетевого действия в ответе нет — только заявка исполнителю.
    expect(JSON.stringify(decision.reply)).toBe('null');
  });

  it('пара-ловушка: та же ссылка В ЦИТАТЕ остаётся быстрым ответом (агент не включается)', async () => {
    await seed();
    const { decision, userTaskId, store } = await routeText(
      'Коллега пишет: «см. https://example.com/pricing — там всё дорого». Как вежливо ответить, что посмотрим позже?',
    );

    expect(decision.route).toBe('llm');
    expect(decision.needsExecutor).toBe(false);
    expect(decision.execution.agentDispatchAttempts).toBe(0);
    expect(decision.workOrder).toBeNull();
    // Ссылка помечена как цитата: признак есть, просьбы читать страницу нет.
    expect(decision.evidence.urlQuoted).toBe(true);
    expect(decision.evidence.urlReadIntent).toBe(false);
    expect(decision.evidence.intents).toContain('url_quoted');
    expect(decision.evidence.intents).not.toContain('read_intent');
    expect(decision.replyAllowed).toBe(true);
    const history = await store.history(userTaskId);
    expect(history.filter((e) => e.kind === 'run_started')).toHaveLength(0);
  });

  it('объявленная read-only capability живых данных обслуживается детерминированно, а не агентом', async () => {
    const catalog = sandboxCapabilityCatalog();
    const pageRead: CapabilityEntry = {
      id: 'web.page_read',
      version: 1,
      title: 'Чтение страницы',
      aliases: ['на главной', 'главной странице', 'открой страницу'],
      dataSource: 'external_live',
      effect: 'read',
      integrationId: 'web-search',
      requiredInputs: [],
      routeHint: 'capability_dispatch',
      supportedModes: ['deterministic', 'llm'],
      templateId: null,
    };
    const withPageRead = { ...catalog, capabilities: [...catalog.capabilities, pageRead] };
    const authorization = await deriveAuthorization(
      {
        principalId: 'sandbox-p16',
        profileId: 'profile-p16',
        scopes: ['tasks:intake', 'tasks:read'],
        grantedCapabilityIds: withPageRead.capabilities.map((c) => c.id),
        grantedIntegrationIds: ['web-search'],
      },
      withPageRead,
    );

    const result = await routeRequest(
      {
        envelope: {
          principalId: 'sandbox-p16',
          profileId: 'profile-p16',
          userTaskId: `ut-${nextId('declared')}`,
          conversationId: null,
          catalogVersion: withPageRead.version,
          policyVersion: withPageRead.version,
          budgets: { llmCallsRemaining: 1, agentAllowed: true },
          runId: null,
          requestId: `req-${nextId('declared')}`,
        },
        prepared: {
          text: 'что сейчас написано на главной https://example.com ?',
          context: { pendingProposal: null, lastAssistantText: null, sessionEmpty: true, relevantTurns: 0 },
          attachments: [],
          typedSignal: null,
          contextVersion: 'ctx-declared',
          readinessSnapshotPresent: true,
        },
        catalog: withPageRead,
        authorization,
        hostFacts: {
          clockMs: Date.parse('2026-09-30T23:10:00+03:00'),
          connections: { 'web-search': true },
          profileFields: {},
          activeTasks: [],
          tasksYesterday: [],
        },
      },
      {
        replyOrRoute: async () => ({
          kind: 'reply',
          text: 'страница прочитана',
          evidenceRefs: ['host:web.page_read'],
          modelCalls: 1,
          assessment: { contextSufficient: true, needsFreshData: false, needsActions: false, needsAdaptiveTools: false },
        }),
      },
    );

    expect(result.decision.route).toBe('deterministic');
    expect(result.decision.capabilityId).toBe('web.page_read');
    expect(result.decision.needsExecutor).toBe(false);
    expect(result.execution.agentDispatchAttempts).toBe(0);
  });

  it('журнал решения содержит профиль, задачу, попытку, ключ события и причину перехода', async () => {
    await seed();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '));
    });
    try {
      await routeText('какой сейчас курс доллара?');
    } finally {
      spy.mockRestore();
    }
    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);

    const decision = events.find((e) => e.event === 'routing.decision');
    expect(decision).toBeDefined();
    expect(decision!.profileId).toBe('profile-p16');
    expect(String(decision!.userTaskId)).toMatch(/^ut-/);
    expect(Object.hasOwn(decision!, 'runId')).toBe(true);
    expect(decision!.reason).toBe('LIVE_DATA_NO_CAPABILITY');
    expect(decision!.policyVersion).toBe('route-policy-v1-2026-10-04');
    expect(decision!.permissionSource).toBe('identity_snapshot');

    const escalated = events.find((e) => e.event === 'routing.escalated');
    expect(escalated).toBeDefined();
    expect(escalated!.executor).toBe('opencode');
    expect(escalated!.profileId).toBe('profile-p16');

    // Текст запроса и любые секреты в журнал не попадают.
    expect(lines.join('\n')).not.toContain('курс доллара');
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});
