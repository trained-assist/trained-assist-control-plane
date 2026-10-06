import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './env';
import { TaskStore, FencedError } from '../src/taskstore';
import { CfWorkflowPort } from '../src/workflow-port';
import { communicationSelector, communicationWriter, SelectorError } from '../src/router/communication-client';
import { communicationV1Catalog, durableConversationContext, probeRunnerHealth } from '../src/router/communication-v1';
import { deriveAuthorization } from '../src/router/authorization';
import { routeRequest } from '../src/router/service';
import type { RouteResult } from '../src/router/service';
import type { RoutingInput } from '../src/router/router-types';
import { commitQuickAnswer, dispatchAcceptedAgent } from '../src/output/communication-v1';
import { RunnerNotFoundError } from '../src/runner-adapter/errors';
import { signPrincipal } from '../src/auth/principal-auth';
import { IntakeService } from '../src/intake';
import { PilotRouter } from '../src/pilot/pilot-router';
import worker from '../src/index';

const catalog = communicationV1Catalog();
const createdIds: string[] = [];
const nextId = () => {
  const id = `selector-${crypto.randomUUID()}`;
  createdIds.push(id);
  return id;
};
const healthy = async () => ({ runner: 'reachable' as const, checkedAt: '2026-10-05T10:00:00Z' });
const selection = (decision: string) => async () => ({ user_goal: 'Проверить запрошенное пользователем состояние.', decision });

async function routingInput(text: string, id = nextId()): Promise<RoutingInput> {
  return {
    envelope: { principalId: 'selector-principal', profileId: 'selector-profile', userTaskId: id, conversationId: null, requestId: id, catalogVersion: catalog.version, policyVersion: 'communication-v1', budgets: { llmCallsRemaining: 2, agentAllowed: true }, runId: null },
    prepared: { text, originalInput: { inputItems: [{ text }] }, context: { pendingProposal: null, lastAssistantText: null, sessionEmpty: true, relevantTurns: 0 }, attachments: [], typedSignal: null, contextVersion: 'context-1', readinessSnapshotPresent: true },
    catalog,
    authorization: await deriveAuthorization({ principalId: 'selector-principal', profileId: 'selector-profile', scopes: ['tasks:read', 'tasks:control'], grantedCapabilityIds: catalog.capabilities.map((entry) => entry.id), grantedIntegrationIds: [] }, catalog),
    hostFacts: { clockMs: Date.now(), connections: {}, profileFields: {}, activeTasks: [], tasksYesterday: [] },
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  const ids = createdIds.splice(0);
  for (const id of ids) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM task_events WHERE user_task_id = ?').bind(id),
      env.DB.prepare('DELETE FROM executions WHERE task_id = ?').bind(id),
      env.DB.prepare('DELETE FROM durable_tasks WHERE id = ?').bind(id),
    ]);
  }
  for (const id of ids) await env.DB.prepare('DELETE FROM conversations WHERE conversation_id = ?').bind(id).run();
});

describe('communication MCP client', () => {
  const request = { request_id: 'request-1', decision_options: [{ id: 'system_health' }, { id: 'agent' }] };
  it('calls the native MCP method with scoped bearer and validates structured output', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const rpc = JSON.parse(String(init?.body));
      expect(rpc.params.name).toBe('resolve_user_intent');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-credential');
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { user_goal: 'Проверить состояние системы.', decision: 'system_health' } } });
    });
    const resolve = communicationSelector({ url: 'https://communication.example.test', token: 'test-credential', fetcher: fetcher as typeof fetch });
    expect((await resolve(request)).decision).toBe('system_health');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { user_goal: 'Полная цель пользователя.', decision: 'invented' },
    { user_goal: 'Полная цель пользователя.', decision: 'agent', confidence: 1 },
    { user_goal: 'коротко', decision: 'agent' },
    { user_goal: 'x'.repeat(4001), decision: 'agent' },
  ])('rejects invalid or unknown output %j', async (output) => {
    const resolve = communicationSelector({ url: 'https://communication.example.test', token: 'test-credential', fetcher: (async () => Response.json({ id: request.request_id, result: { structuredContent: output } })) as typeof fetch });
    await expect(resolve(request)).rejects.toBeInstanceOf(SelectorError);
  });

  it('fails oversized context before network without truncation', async () => {
    const fetcher = vi.fn();
    const resolve = communicationSelector({ url: 'https://communication.example.test', token: 'test-credential', fetcher });
    await expect(resolve({ ...request, history: 'x'.repeat(120_001) })).rejects.toMatchObject({ code: 'input_too_large' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the writer method and rejects stale context revisions', async () => {
    const write = communicationWriter({ url: 'https://communication.example.test', token: 'test-credential', fetcher: (async (_url, init) => {
      const rpc = JSON.parse(String(init?.body));
      expect(rpc.params.name).toBe('generate_next_message_to_conversation_partner');
      return Response.json({ id: rpc.id, result: { structuredContent: { status: 'generated', message_text: 'facts', context_revision: 'old' } } });
    }) as typeof fetch });
    await expect(write({ request_id: 'writer', context_revision: 'new' })).rejects.toMatchObject({ code: 'writer_rejected' });
  });

  it('preserves service receiver and bearer auth; service errors never retry externally', async () => {
    const externalFetch = vi.fn();
    vi.stubGlobal('fetch', externalFetch);
    const service = {
      fetch: vi.fn(async function (this: unknown, url: unknown, init?: RequestInit) {
        expect(this).toBe(service);
        expect(url).toBe('https://communication.example.test/mcp');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-credential');
        return new Response('unauthorized', { status: 401 });
      }),
    };
    const resolve = communicationSelector({ url: 'https://communication.example.test', token: 'test-credential', service: service as unknown as Fetcher, fetcher: externalFetch });
    await expect(resolve(request)).rejects.toMatchObject({ code: 'http_401' });
    expect(service.fetch).toHaveBeenCalledTimes(1);
    expect(externalFetch).not.toHaveBeenCalled();
  });
});

describe('v1 routing', () => {
  it.each(['Работает?', 'Система ещё отвечает?', 'Проверишь доступность помощника?'])('routes paraphrases through the shared selector: %s', async (text) => {
    const select = vi.fn(selection('system_health'));
    const result = await routeRequest(await routingInput(text), { communicationV1: { select, health: healthy } });
    expect(result.decision.capabilityId).toBe('system_health');
    expect(result.reply?.text).toContain('Runner API — доступен');
    expect(result.reply?.text).toContain('не подтверждены');
    expect(select).toHaveBeenCalledTimes(1);
    const payload = select.mock.calls[0] as unknown as [Record<string, unknown>];
    expect((payload[0].decision_options as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['system_health', 'catalog.brief', 'agent']);
    expect(result.execution.recipeCalls).toBe(0);
  });

  it.each(['agent', 'no_matching_option', 'unknown'])('preserves a compound task on decision %s', async (decision) => {
    const text = 'Работает? Тогда обработай таблицу и запиши итоги, исходный лист сохрани.';
    const result = await routeRequest(await routingInput(text), { communicationV1: { select: selection(decision), health: healthy } });
    expect(result.decision.route).toBe('agent');
    expect(result.continuation?.goal).toBe(text);
    expect(result.agentInstructions).toContain(text);
    if (decision === 'agent') {
      expect(result.agentInstructions).toContain('Проверить запрошенное пользователем состояние.');
      expect(result.agentInstructions).toContain('исходный запрос пользователя имеет приоритет');
    } else expect(result.agentInstructions).toContain(text);
    expect(result.reply).toBeNull();
  });

  it.each(['unavailable_or_timeout', 'malformed', 'tool_error', 'input_too_large'])('falls back to agent on %s', async (code) => {
    const result = await routeRequest(await routingInput('Неизвестная задача'), { communicationV1: { select: async () => { throw new SelectorError(code); }, health: healthy } });
    expect(result.decision.route).toBe('agent');
    expect(result.decision.providerCode).toBe(code);
    expect(result.decision.degraded).toBe(true);
  });

  it('renders catalog and grants without claiming external tools work', async () => {
    const input = await routingInput('Что умеешь?');
    input.authorization.grantedCapabilityIds = ['system_health', 'catalog.brief', 'google-drive.read'];
    const result = await routeRequest(input, { communicationV1: { select: selection('catalog.brief'), health: healthy } });
    expect(result.reply?.text).toContain('требует подключения');
    expect(result.reply?.text).not.toContain('google-drive.share_file');
    expect(result.reply?.evidenceRefs).toContain(input.authorization.snapshotRef);
  });

  it('uses the writer once with verified facts; altered facts fall back deterministically', async () => {
    const input = await routingInput('Работает?');
    const write = vi.fn(async (payload: Record<string, unknown>) => (payload.context as { verified_reply: string }).verified_reply);
    const result = await routeRequest(input, { communicationV1: { select: selection('system_health'), health: healthy, write } });
    expect(result.rendering?.source).toBe('communication_writer');
    expect(write).toHaveBeenCalledTimes(1);
    const failed = await routeRequest(input, { communicationV1: { select: selection('system_health'), health: healthy, write: async () => 'Все инструменты работают!' } });
    expect(failed.rendering?.source).toBe('deterministic');
    expect(failed.reply?.text).not.toContain('Все инструменты работают');
  });

  it('reports Runner 404 as reachable and probe failure honestly', async () => {
    expect((await probeRunnerHealth({ status: async () => { throw new RunnerNotFoundError('absent'); } })).runner).toBe('reachable');
    expect((await probeRunnerHealth({ status: async () => new Promise(() => {} ) }, 1)).runner).toBe('unreachable');
    expect((await probeRunnerHealth(null)).runner).toBe('not_configured');
  });
});

describe('Task Store and Output ownership', () => {
  it('preserves full conversation inputs/results and excludes foreign profiles', async () => {
    const store = new TaskStore(env.DB);
    const conversationId = nextId();
    const priorId = nextId();
    const longValue = `${'facts '.repeat(22_000)}DO_NOT_LOSE_THIS_OBLIGATION`;
    await store.admitTask({ id: priorId, profileId: 'selector-profile', goal: 'previous', conversationId, userValue: { inputItems: [{ text: longValue }] } });
    await store.commit(priorId, 1, { status: 'done', result: { answer: longValue, spreadsheet: 'sheet-ref' } });
    await store.admitTask({ id: nextId(), profileId: 'foreign-profile', goal: 'foreign-private', conversationId });
    const currentId = nextId();
    await store.admitTask({ id: currentId, profileId: 'selector-profile', goal: 'add monthly totals', conversationId });
    const context = await durableConversationContext(store, await store.requireTask(currentId));
    expect(context.history).toHaveLength(2);
    expect(context.history[0]?.text).toContain(longValue);
    expect(context.history[1]?.text).toContain('sheet-ref');
    const input = await routingInput('add monthly totals', currentId);
    input.prepared.durableContext = context;
    const fetcher = vi.fn();
    const result = await routeRequest(input, { communicationV1: { select: communicationSelector({ url: 'https://communication.example.test', token: 'test-credential', fetcher }), health: healthy } });
    expect(result.decision.route).toBe('agent');
    expect(result.agentInstructions).toContain('DO_NOT_LOSE_THIS_OBLIGATION');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('concurrent competing selections share one durable winner and one terminal result', async () => {
    const store = new TaskStore(env.DB);
    const id = nextId();
    await store.admitTask({ id, profileId: 'selector-profile', goal: 'health' });
    const input = await routingInput('health', id);
    const quick = await routeRequest(input, { communicationV1: { select: selection('system_health'), health: healthy } });
    const agent = await routeRequest(input, { communicationV1: { select: selection('agent'), health: healthy } });
    const saved = await Promise.all([store.saveRoutingSelection(id, 1, quick), store.saveRoutingSelection(id, 1, agent)]) as RouteResult[];
    expect(saved[0]).toEqual(saved[1]);
    const task = await store.requireTask(id);
    if (saved[0]?.reply) {
      await Promise.all(saved.map((result) => commitQuickAnswer(store, task, result)));
      expect((await store.requireTask(id)).status).toBe('done');
      expect((await store.history(id)).filter((event) => event.kind === 'task_status_changed' && event.status_after === 'done')).toHaveLength(1);
    }
    expect((await store.history(id)).filter((event) => event.kind === 'routing.selected')).toHaveLength(1);
  });

  it('starts the accepted task once at existing generation with no resume or synthetic autoRun', async () => {
    const store = new TaskStore(env.DB);
    const id = nextId();
    await store.admitTask({ id, profileId: 'selector-profile', goal: 'perform original task', executionPolicy: { workStyle: 'explore', source: 'explicit' }, userValue: { inputItems: [{ text: 'perform original task' }] } });
    const instances = new Map<string, unknown>();
    const create = vi.fn(async (request: { id: string; params: unknown }) => {
      if (instances.has(request.id)) throw new Error('already exists');
      instances.set(request.id, request.params);
      return {};
    });
    const wf = { create, get: async (instanceId: string) => { if (!instances.has(instanceId)) throw new Error('missing'); return { status: async () => ({ status: 'running' }) }; } } as unknown as Workflow;
    const port = new CfWorkflowPort(wf, store);
    const task = await store.requireTask(id);
    const result = await routeRequest(await routingInput(task.goal, id), { communicationV1: { select: selection('agent'), health: healthy } });
    const receipts = await Promise.all([dispatchAcceptedAgent(store, port, task, result), dispatchAcceptedAgent(store, port, task, result)]);
    expect(receipts[0].runId).toBe(receipts[1].runId);
    expect((await store.listRuns(id))).toHaveLength(1);
    expect((await store.history(id)).filter((event) => event.kind === 'run_started')).toHaveLength(1);
    expect((await store.requireTask(id)).generation).toBe(1);
    expect(instances.get(id)).toMatchObject({ taskId: id, generation: 1, instructions: expect.stringContaining('Режим запуска: explore') });
    expect((instances.get(id) as { goal: string; instructions: string }).instructions).toContain('Проверить запрошенное пользователем состояние.');
    expect((instances.get(id) as { goal: string; instructions: string }).instructions).toContain('perform original task');
    expect((instances.get(id) as { autoRun?: boolean }).autoRun).not.toBe(true);
    await dispatchAcceptedAgent(store, port, task, result);
    expect((await store.listRuns(id))).toHaveLength(1);
  });

  it('fences stale selection writes', async () => {
    const store = new TaskStore(env.DB);
    const id = nextId();
    await store.admitTask({ id, profileId: 'selector-profile', goal: 'task' });
    await store.bumpGeneration(id, { reason: 'cancel old routing' });
    await expect(store.saveRoutingSelection(id, 1, {})).rejects.toBeInstanceOf(FencedError);
  });

  it('does not silently rerun an unknown execution on repeated dispatch', async () => {
    const store = new TaskStore(env.DB);
    const id = nextId();
    await store.admitTask({ id, profileId: 'selector-profile', goal: 'external action' });
    const task = await store.requireTask(id);
    const run = await store.startRun(id, { generation: 1, idempotent: true });
    await store.markConnectionLost(run.id);
    const port = new CfWorkflowPort({ create: vi.fn(), get: vi.fn() } as unknown as Workflow, store);
    const result = await routeRequest(await routingInput(task.goal, id), { communicationV1: { select: selection('agent'), health: healthy } });
    expect(await dispatchAcceptedAgent(store, port, task, result)).toMatchObject({ issued: false, refusal: 'existing_run_requires_reconciliation', runId: run.id });
    expect((await store.requireTask(id)).generation).toBe(1);
    expect(await store.listRuns(id)).toHaveLength(1);
  });

  it.each(['external', 'service'])('HTTP toggle uses %s transport for selector/writer and reuses durable answers', async (transport) => {
    const store = new TaskStore(env.DB);
    const id = nextId();
    await store.upsertPrincipal({ principalId: 'selector-principal', profileId: 'selector-profile', scopes: ['tasks:read', 'tasks:control'] });
    await store.admitTask({ id, profileId: 'selector-profile', goal: 'Что умеешь?', userValue: { inputItems: [{ text: 'Что умеешь?' }] } });
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(_url).toBe('https://communication.example.test/mcp');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-credential');
      const rpc = JSON.parse(String(init?.body));
      const data = rpc.params.name === 'resolve_user_intent'
        ? { user_goal: 'Узнать доступные возможности помощника.', decision: 'catalog.brief' }
        : { status: 'generated', message_text: rpc.params.arguments.context.verified_reply, context_revision: rpc.params.arguments.context_revision };
      return Response.json({ id: rpc.id, result: { structuredContent: data } });
    });
    const externalFetch = transport === 'external' ? fetcher : vi.fn(async () => { throw new Error('unexpected external request'); });
    vi.stubGlobal('fetch', externalFetch);
    const signature = await signPrincipal('selector-principal', 'test-principal-secret');
    const request = () => new Request('https://control.example.test/route', { method: 'POST', headers: { 'content-type': 'application/json', 'x-principal': 'selector-principal', 'x-principal-sig': signature }, body: JSON.stringify({ taskId: id, continue: true }) });
    const bindings = { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, PRINCIPAL_SECRET: 'test-principal-secret', ROUTER_SELECTOR: 'communication_v1', COMMUNICATION_API_URL: 'https://communication.example.test', COMMUNICATION_TOKEN: 'test-credential', ...(transport === 'service' ? { COMMUNICATION_SERVICE: { fetch: fetcher } as unknown as Fetcher } : {}) };
    const first = await worker.fetch(request(), bindings);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ route: 'deterministic', capabilityId: 'catalog.brief' });
    const task = await store.requireTask(id);
    expect(task.status).toBe('done');
    expect(JSON.parse(task.result_json!).answer).toContain('Каталог');
    expect((await worker.fetch(request(), bindings)).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    if (transport === 'service') expect(externalFetch).not.toHaveBeenCalled();
  });

  it('HTTP fallback dispatches through Output without requiring gateway start', async () => {
    const store = new TaskStore(env.DB);
    const goal = 'Разбери паттерны сильных заголовков Instagram и предложи 10 свежих вариантов для карусели про неожиданные поступки кандидатов на собеседовании. Не повторяй формулировки из исходных историй.';
    await store.upsertPrincipal({ principalId: 'selector-principal', profileId: 'selector-profile', scopes: ['tasks:intake', 'tasks:read', 'tasks:control'] });
    const pilot = new PilotRouter({ config: { enabled: true, activatedAt: null, cohortProfileIds: ['selector-profile'], legacyProfileIds: null } });
    const admitted = await new IntakeService(store, pilot).admit({ principalId: 'selector-principal' }, {
      contractVersion: 1, requestId: nextId(), inputItems: [{ text: goal }],
    });
    const id = admitted.userTaskId;
    createdIds.push(id);
    const fetcher = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const instances = new Map<string, unknown>();
    const workflow = {
      create: async (request: { id: string; params: unknown }) => { instances.set(request.id, request.params); return {}; },
      get: async (instanceId: string) => { if (!instances.has(instanceId)) throw new Error('absent'); return { status: async () => ({ status: 'running' }) }; },
    } as unknown as Workflow;
    const signature = await signPrincipal('selector-principal', 'test-principal-secret');
    const request = () => new Request('https://control.example.test/route', { method: 'POST', headers: { 'content-type': 'application/json', 'x-principal': 'selector-principal', 'x-principal-sig': signature }, body: JSON.stringify({ taskId: id, continue: true }) });
    const bindings = { DB: env.DB, TASK_WORKFLOW: workflow, PRINCIPAL_SECRET: 'test-principal-secret', ROUTER_SELECTOR: 'communication_v1', ROUTER_CONTINUATION_ENABLED: 'true', ROUTER_AGENT_ENGINE: 'dynamic-ip-azure-agent-run', COMMUNICATION_API_URL: 'https://communication.example.test', COMMUNICATION_TOKEN: 'test-credential', RUNNER_API_URL: 'https://runner.example.test', RUNNER_API_KEY: 'test-runner-credential' };
    const response = await worker.fetch(request(), bindings);
    expect(response.status).toBe(200);
    const body = await response.json() as { continuation: { runId: string } };
    expect(body).toMatchObject({ route: 'agent', degraded: true, continuation: { owner: 'output', requested: true, issued: true, generation: 1, executor: 'dynamic-ip-azure-agent-run' } });
    expect(body.continuation.runId).toBeTruthy();
    expect((await worker.fetch(request(), bindings)).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await store.listRuns(id)).toHaveLength(1);
    const launched = instances.get(id) as { goal: string; instructions: string; generation: number; runnerEngine: string };
    expect(launched).toMatchObject({ goal, generation: 1, runnerEngine: 'dynamic-ip-azure-agent-run' });
    expect(launched.instructions).toContain(goal);
    expect(launched.instructions.match(/\[work-style:v1\]/g)).toHaveLength(1);
    expect(launched.instructions).toContain('Режим запуска: auto');
  });
});
