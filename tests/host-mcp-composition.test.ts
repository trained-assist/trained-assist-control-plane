import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import { CfWorkflowPort } from '../src/workflow-port';
import { conversationPlan, type PlanParams } from '../src/workflow-port/conversation-plan';
import type { StepCtx } from '../src/workflow-port/step-ctx';
import { defaultRunSpecPolicy } from '../src/run-spec/run-spec';
import { RunnerApiAdapter } from '../src/runner-adapter';
import { McpCatalogueAdapter, McpCatalogueError } from '../src/router/mcp-catalogue';
import { communicationV1Catalog } from '../src/router/communication-v1';
import type { HostMcpRoutingDeps } from '../src/router/host-mcp-routing';
import { deriveAuthorization } from '../src/router/authorization';
import { routeRequest } from '../src/router/service';
import type { RoutingInput } from '../src/router/router-types';
import { dispatchAcceptedAgent, persistMcpTaskBlock } from '../src/output/communication-v1';
import { signPrincipal } from '../src/auth/principal-auth';
import worker from '../src/index';
import { registryMcpTest160Descriptor as runnerDescriptorFixture } from './fixtures/registry-mcp-test-160-descriptor';

afterEach(() => vi.unstubAllGlobals());

async function fixture(count = 66, profileId = 'integration-telegram-ux-v1', userValue?: Record<string, unknown>) {
  const store = new TaskStore(env.DB);
  const taskId = `host-mcp-${crypto.randomUUID()}`;
  const principalId = 'host-mcp-fixture-principal';
  const scope = { taskId, profileId, principalId, generation: 1 };
  const names = ['registry.fixture_read', ...Array.from({ length: Math.max(0, count - 1) }, (_unused, index) => `ungranted_method_${index}`)];
  const selectedName = names[0]!;
  const selectedDescription = 'Read the pinned marker from the Registry MCP test fixture.';
  const description = (index: number) => index === 0 ? selectedDescription : `UNSELECTED_DESCRIPTION_${index}`;
  const inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  let policyVersion = 'registry-fixture-policy-v1';
  let catalogueDescription = selectedDescription;
  const rpc = vi.fn(async (message: { id: string; method: string; params?: unknown; runId?: unknown }) => {
    expect(message.method).toBe('tools/list');
    expect(message).not.toHaveProperty('runId');
    return { jsonrpc: '2.0', id: message.id, result: { tools: names.map((name, index) => ({ name, description: index === 0 ? catalogueDescription : description(index), inputSchema })) } };
  });
  const catalogue = new McpCatalogueAdapter(async requestedScope => [{ scope: { ...requestedScope },
    discoveryAuthorization: { principalId: requestedScope.principalId, profileId: requestedScope.profileId, scope: 'mcp:discover', methods: ['tools/list'] },
    url: 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp',
    serverId: 'trained-assist-registry-test', bindingRef: 'registry-mcp-test-160-read', executionScope: 'registry:fixture-read', policyVersion,
    catalogueVersion: 'registry-fixture-catalogue-v1', catalogueDigest: 'sha256-f88f1d0502220618f596906d27a671e8d086c4be0eff2da6fd77b4f160f9f07d',
    registryDigest: '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9',
    allowedTools: ['registry.fixture_read'], request: rpc }]);
  const mcp = { servers: [{ serverId: 'trained-assist-registry-test', transport: 'remote' as const,
    url: 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp', bindingRef: 'registry-mcp-test-160-read',
    scope: 'registry:fixture-read', registryDigest: '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9',
    policyVersion: 'registry-fixture-policy-v1', catalogueVersion: 'registry-fixture-catalogue-v1', allowedTools: [selectedName] }] };
  const state = { scope: { ...scope }, policyVersion, mcp };
  const hostMcp: HostMcpRoutingDeps = { enabled: true, catalogue, readExecutionState: async () => structuredClone(state) };
  const text = 'Use the approved document method and preserve this complete original request';
  await store.admitTask({ id: taskId, profileId, goal: text, userValue: userValue ?? { inputItems: [{ text }] } });
  const catalog = communicationV1Catalog();
  const input: RoutingInput = {
    envelope: { userTaskId: taskId, profileId, principalId, generation: 1, conversationId: null, requestId: taskId,
      catalogVersion: catalog.version, policyVersion: catalog.version, runId: null, budgets: { llmCallsRemaining: 2, agentAllowed: true } },
    prepared: { text, originalInput: { inputItems: [{ text }] }, attachments: [], typedSignal: null,
      contextVersion: 'fixture-context', readinessSnapshotPresent: true,
      context: { pendingProposal: null, lastAssistantText: null, sessionEmpty: true, relevantTurns: 0 } },
    catalog, authorization: await deriveAuthorization({ profileId, principalId, scopes: ['tasks:read', 'tasks:control'],
      grantedCapabilityIds: catalog.capabilities.map(entry => entry.id), grantedIntegrationIds: [] }, catalog),
    hostFacts: { clockMs: Date.now(), connections: {}, profileFields: {}, activeTasks: [], tasksYesterday: [] },
  };
  const health = vi.fn(async () => ({ runner: 'unknown' as const, checkedAt: 'fixture-time' }));
  return { store, taskId, profileId, principalId, scope, names, selectedName, selectedDescription, inputSchema, input, hostMcp, state, rpc, health,
    changeRegistry: () => { policyVersion = 'registry-fixture-policy-v2'; },
    changeCatalogue: () => { catalogueDescription = 'Changed host instructions'; } };
}

describe('inactive host MCP routing composition', () => {
  it('routes the full name-only catalogue into one same-task native run with only selected metadata', async () => {
    const current = await fixture();
    const select = vi.fn(async (request: Record<string, unknown>) => {
      expect(request.decision_options).toEqual([{ id: 'registry.fixture_read' }]);
      const encoded = JSON.stringify(request);
      expect(encoded).not.toContain('DESCRIPTION');
      expect(encoded).not.toContain('inputSchema');
      expect(request).not.toHaveProperty('capabilities');
      return { user_goal: 'model reformulation must not replace input', decision: current.selectedName };
    });
    const routed = await routeRequest(current.input, { communicationV1: { select, health: current.health, hostMcp: current.hostMcp } });
    expect(routed).toMatchObject({ decision: { route: 'agent', degraded: false }, reply: null,
      mcpInstruction: { name: current.selectedName, description: current.selectedDescription, inputSchema: current.inputSchema,
        scope: current.scope, readiness: 'not_verified' }, execution: { capabilityExecutions: 0, agentDispatchAttempts: 1 } });
    expect(routed.agentInstructions).toContain(current.input.prepared.text);
    expect(routed.agentInstructions).not.toContain(current.selectedDescription);
    expect(routed.agentInstructions).not.toContain('UNSELECTED_DESCRIPTION');
    expect(routed.agentInstructions).toContain('Используй capability только если она нужна');
    const saved = await current.store.saveRoutingSelection(current.taskId, 1, routed);
    expect(saved).toEqual(routed);
    let params: PlanParams | undefined;
    const create = vi.fn(async (request: { id: string; params: PlanParams }) => { params = request.params; return {}; });
    const workflow = { create, get: async () => {
      if (!params) throw new Error('Fixture instance not created');
      return { status: async () => ({ status: 'running' }) };
    } } as unknown as Workflow;
    const port = new CfWorkflowPort(workflow, current.store);
    const task = await current.store.requireTask(current.taskId);
    await dispatchAcceptedAgent(current.store, port, task, routed, 'dynamic-ip-azure-agent-run', current.hostMcp);
    await dispatchAcceptedAgent(current.store, port, task, routed, 'dynamic-ip-azure-agent-run', current.hostMcp);
    expect(create).toHaveBeenCalledOnce();
    expect(params).toMatchObject({ taskId: current.taskId, profileId: current.profileId, generation: 1, instructions: routed.agentInstructions });
    expect(params!.mcpDescriptor).toEqual({ servers: [runnerDescriptorFixture] });
    const canonicalRun = `run_${crypto.randomUUID()}`;
    const submit = vi.fn();
    const adapter = new RunnerApiAdapter('https://runner-fixture.example.test', 'fixture-key', async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/runs') {
        const body = JSON.parse(String(init?.body));
        submit(body);
        expect(body).toMatchObject({ userTaskId: current.taskId, engine: { name: 'dynamic-ip-azure-agent-run' },
        mcp: { servers: [{ ...current.state.mcp.servers[0], scope: 'registry:fixture-read', registryDigest: '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9',
          catalogueVersion: 'registry-fixture-catalogue-v1', policyVersion: routed.mcpInstruction!.policyVersion }] } });
        expect(body.input.inlinePrompt).toContain(routed.agentInstructions);
        return Response.json({ userTaskId: current.taskId, runId: canonicalRun, requestId: 'fixture-native-receipt', deduplicated: false });
      }
      if (path.endsWith('/status')) return Response.json({ runId: canonicalRun, state: 'succeeded', answer: 'fixture native answer' });
      if (path.endsWith('/result')) return Response.json({ runId: canonicalRun, userTaskId: current.taskId, profileId: current.profileId,
        ownerGeneration: 1, outcome: 'succeeded', exitReason: 'completed', exitObserved: true, persistence: 'not_required', outputRefs: [] });
      if (path.endsWith('/events')) return Response.json({ events: [], cursor: 0, hasMore: false });
      if (path.endsWith('/artifacts')) return Response.json({ artifacts: [] });
      throw new Error('Unexpected fixture Runner request');
    });
    const context: StepCtx = { step: async (_name, callback) => callback({ attempt: 1 }), sleep: async () => {},
      waitFor: async () => { throw new Error('Unexpected awaiting'); } };
    expect(await conversationPlan(context, current.store, params!, { adapter,
      runSpecPolicy: defaultRunSpecPolicy() })).toMatchObject({ ok: true, answer: 'fixture native answer' });
    expect(submit).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(await current.store.listRuns(current.taskId)).toHaveLength(1);
    expect(await current.store.requireTask(current.taskId)).toMatchObject({ status: 'done', generation: 1 });
    expect(current.health).not.toHaveBeenCalled();
  });

  it.each(['registry', 'profile', 'generation', 'binding', 'principal'] as const)
  ('requires explicit revalidation and no dispatch after %s drift', async drift => {
    const current = await fixture();
    const select = async () => {
      if (drift === 'registry') current.changeRegistry();
      if (drift === 'profile') current.state.scope.profileId = 'foreign-profile';
      if (drift === 'principal') current.state.scope.principalId = 'foreign-principal';
      if (drift === 'generation') current.state.scope.generation = 2;
      if (drift === 'binding') current.state.mcp.servers[0]!.bindingRef = 'foreign-ref';
      return { user_goal: 'untrusted reformulation', decision: current.selectedName };
    };
    const routed = await routeRequest(current.input, { communicationV1: { select, health: current.health, hostMcp: current.hostMcp } });
    expect(routed).toMatchObject({ decision: { route: 'agent', outcome: 'blocked', needsExecutor: false,
      reasonCode: 'MCP_REVALIDATION_REQUIRED', degraded: true, degradedNotice: { text: expect.any(String) } } });
    expect(routed.mcpInstruction).toBeUndefined();
    expect(routed.continuation).toBeNull();
    expect(routed.agentInstructions).toBeUndefined();
    expect(await current.store.listRuns(current.taskId)).toHaveLength(0);
  });

  it.each([
    ['missing-host', 'host_mcp_disabled'], ['scope', 'MCP_REVALIDATION_REQUIRED'],
    ['policy', 'MCP_REVALIDATION_REQUIRED'], ['grant', 'execution_binding_missing'],
  ] as const)('holds cached selected route before dispatch with %s', async (drift, reasonCode) => {
    const current = await fixture();
    const routed = await routeRequest(current.input, { communicationV1: { select: async () => ({ user_goal: '', decision: current.selectedName }),
      health: current.health, hostMcp: current.hostMcp } });
    await current.store.saveRoutingSelection(current.taskId, 1, routed);
    const cached = await current.store.routingSelection(current.taskId, 1) as typeof routed;
    if (drift === 'scope') current.state.scope.taskId = 'foreign-task';
    if (drift === 'policy') current.state.policyVersion = 'new-registry-revision';
    if (drift === 'grant') current.state.mcp.servers[0]!.allowedTools = [];
    const submit = vi.fn();
    const port = { submit } as unknown as CfWorkflowPort;
    expect(await dispatchAcceptedAgent(current.store, port, await current.store.requireTask(current.taskId), cached,
      'dynamic-ip-azure-agent-run', drift === 'missing-host' ? undefined : current.hostMcp))
      .toMatchObject({ issued: false, refusal: reasonCode });
    expect(await current.store.requireTask(current.taskId)).toMatchObject({ status: 'blocked', blocker_reason: reasonCode });
    expect(submit).not.toHaveBeenCalled();
  });

  it('re-reads the authorized catalogue at Output handoff and blocks catalogue drift', async () => {
    const current = await fixture();
    const routed = await routeRequest(current.input, { communicationV1: { select: async () => ({ user_goal: '', decision: current.selectedName }),
      health: current.health, hostMcp: current.hostMcp } });
    expect(routed.mcpInstruction).toBeDefined();
    current.changeCatalogue();
    const submit = vi.fn();
    const outcome = await dispatchAcceptedAgent(current.store, { submit } as unknown as CfWorkflowPort,
      await current.store.requireTask(current.taskId), routed, 'dynamic-ip-azure-agent-run', current.hostMcp);
    expect(outcome).toMatchObject({ issued: false, refusal: 'MCP_REVALIDATION_REQUIRED' });
    expect(await current.store.requireTask(current.taskId)).toMatchObject({ status: 'blocked', blocker_reason: 'MCP_REVALIDATION_REQUIRED' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('reports a selected-instruction scope change as revalidation-required', async () => {
    const current = await fixture();
    const routed = await routeRequest(current.input, { communicationV1: { select: async () => ({ user_goal: '', decision: current.selectedName }),
      health: current.health, hostMcp: current.hostMcp } });
    routed.mcpInstruction = { ...routed.mcpInstruction!, scope: { ...routed.mcpInstruction!.scope, profileId: 'foreign-profile' } };
    const submit = vi.fn();
    const outcome = await dispatchAcceptedAgent(current.store, { submit } as unknown as CfWorkflowPort,
      await current.store.requireTask(current.taskId), routed, 'dynamic-ip-azure-agent-run', current.hostMcp);
    expect(outcome).toMatchObject({ issued: false, refusal: 'MCP_REVALIDATION_REQUIRED' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('revalidates the catalogue after model selection and preserves non-drift discovery errors', async () => {
    const current = await fixture();
    const drifted = await routeRequest(current.input, { communicationV1: { select: async () => {
      current.changeCatalogue();
      return { user_goal: '', decision: current.selectedName };
    }, health: current.health, hostMcp: current.hostMcp } });
    expect(drifted.decision).toMatchObject({ outcome: 'blocked', reasonCode: 'MCP_REVALIDATION_REQUIRED', providerCode: 'catalogue_drift' });
    expect(current.rpc).toHaveBeenCalledTimes(2);

    const unavailable = await fixture();
    unavailable.hostMcp.catalogue = new McpCatalogueAdapter(async () => { throw new McpCatalogueError('discovery_unavailable'); });
    const fallback = await routeRequest(unavailable.input, { communicationV1: { select: async () => ({ user_goal: '', decision: 'agent' }),
      health: unavailable.health, hostMcp: unavailable.hostMcp } });
    expect(fallback.decision).toMatchObject({ outcome: 'blocked', reasonCode: 'MCP_BINDING_UNAVAILABLE', providerCode: 'binding_unavailable' });
  });

  it.each(['policy-drift', 'discovery-failure'] as const)(
    'keeps an admitted run authoritative on repeated dispatch after %s', async failure => {
      const current = await fixture();
      const routed = await routeRequest(current.input, { communicationV1: {
        select: async () => ({ user_goal: '', decision: current.selectedName }),
        health: current.health, hostMcp: current.hostMcp,
      } });
      const instances = new Map<string, unknown>();
      const workflow = { create: vi.fn(async (request: { id: string; params: unknown }) => { instances.set(request.id, request.params); return {}; }),
        get: async (id: string) => instances.has(id) ? { status: async () => ({ status: 'running' }) } : null } as unknown as Workflow;
      const port = new CfWorkflowPort(workflow, current.store);
      const first = await dispatchAcceptedAgent(current.store, port, await current.store.requireTask(current.taskId), routed,
        'dynamic-ip-azure-agent-run', current.hostMcp);
      const submit = vi.spyOn(port, 'submit');
      const run = (await current.store.listRuns(current.taskId))[0]!;
      expect(first).toMatchObject({ issued: true, runId: run.id });
      if (failure === 'policy-drift') current.changeRegistry();
      else current.rpc.mockRejectedValueOnce(new Error('offline discovery'));
      const outcome = await dispatchAcceptedAgent(current.store, port,
        await current.store.requireTask(current.taskId), routed, 'dynamic-ip-azure-agent-run', current.hostMcp);
      expect(outcome).toMatchObject({ issued: false, refusal: 'existing_run_requires_reconciliation', runId: run.id });
      expect(await current.store.requireTask(current.taskId)).not.toMatchObject({ status: 'blocked' });
      expect(await current.store.listRuns(current.taskId)).toHaveLength(1);
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it('honors GTD continuation ownership before MCP revalidation', async () => {
    const current = await fixture(66, 'integration-telegram-ux-v1', { gtdId: 'gtd-owned-task' });
    const routed = await routeRequest(current.input, { communicationV1: {
      select: async () => ({ user_goal: '', decision: current.selectedName }),
      health: current.health, hostMcp: current.hostMcp,
    } });
    current.rpc.mockClear();
    const submit = vi.fn();
    const outcome = await dispatchAcceptedAgent(current.store, { submit } as unknown as CfWorkflowPort,
      await current.store.requireTask(current.taskId), routed, 'dynamic-ip-azure-agent-run', current.hostMcp);
    expect(outcome).toMatchObject({ issued: false, refusal: 'gtd_owns_continuation' });
    expect(current.rpc).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('disabled injection does not discover or expose host catalogue metadata', async () => {
    const current = await fixture();
    current.hostMcp.enabled = false;
    const routed = await routeRequest(current.input, { communicationV1: { select: async () => ({ user_goal: '', decision: 'agent' }),
      health: current.health, hostMcp: current.hostMcp } });
    expect(current.rpc).not.toHaveBeenCalled();
    expect(routed.mcpInstruction).toBeUndefined();
    expect(routed.decision.degraded).toBe(false);
  });

  it('rejects discovery credentials outside the profile-scoped tools/list scope', async () => {
    const current = await fixture();
    const adapter = new McpCatalogueAdapter(async scope => [{ scope,
      discoveryAuthorization: { principalId: scope.principalId, profileId: scope.profileId, scope: 'mcp:discover', methods: ['tools/call'] as unknown as ['tools/list'] },
      url: 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp',
      serverId: 'trained-assist-registry-test', bindingRef: 'registry-mcp-test-160-read', executionScope: 'registry:fixture-read', policyVersion: 'registry-fixture-policy-v1',
      catalogueVersion: 'registry-fixture-catalogue-v1', catalogueDigest: 'sha256-f88f1d0502220618f596906d27a671e8d086c4be0eff2da6fd77b4f160f9f07d', allowedTools: ['registry.fixture_read'],
      registryDigest: '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9',
      request: async () => ({}) }]);
    await expect(adapter.discover(current.scope)).rejects.toMatchObject({ code: 'discovery_authorization_invalid' });
  });

  it('missing host execution binding cannot authorize selected metadata', async () => {
    const current = await fixture();
    current.state.mcp.servers = [];
    const routed = await routeRequest(current.input, { communicationV1: { select: async () => ({ user_goal: '', decision: current.selectedName }),
      health: current.health, hostMcp: current.hostMcp } });
    expect(routed.decision).toMatchObject({ outcome: 'blocked', reasonCode: 'MCP_EXECUTION_BINDING_MISSING', degraded: true, providerCode: 'execution_binding_missing' });
    expect(routed.mcpInstruction).toBeUndefined();
  });

  it('preserves discovery/network refusal instead of relabeling it as policy drift', async () => {
    const current = await fixture();
    current.rpc.mockRejectedValue(new Error('fixture network failure'));
    const routed = await routeRequest(current.input, { communicationV1: { select: async () => ({ user_goal: '', decision: current.selectedName }),
      health: current.health, hostMcp: current.hostMcp } });
    expect(routed).toMatchObject({ mcpRefusalCode: 'discovery_unavailable', decision: {
      outcome: 'blocked', reasonCode: 'MCP_DISCOVERY_UNAVAILABLE', providerCode: 'discovery_unavailable' }, continuation: null });
    await persistMcpTaskBlock(current.store, await current.store.requireTask(current.taskId), routed.mcpRefusalCode!);
    expect(await current.store.requireTask(current.taskId)).toMatchObject({ status: 'blocked', blocker_reason: 'discovery_unavailable' });
    expect(await current.store.listRuns(current.taskId)).toHaveLength(0);
  });

  it.each([1, 256])('keeps all %i actual names without synthetic options or trimming', async count => {
    const current = await fixture(count);
    const select = vi.fn(async (request: Record<string, unknown>) => {
      expect(request.decision_options).toEqual([{ id: 'registry.fixture_read' }]);
      return { user_goal: 'original task', decision: current.selectedName };
    });
    const routed = await routeRequest(current.input, { communicationV1: { select, health: current.health, hostMcp: current.hostMcp } });
    expect(routed.mcpInstruction?.name).toBe(current.selectedName);
  });

  it('an ungranted method named agent is not treated as a tool or catalogue drift', async () => {
    const current = await fixture();
    current.names.push('agent');
    current.state.mcp.servers[0]!.allowedTools.push('agent');
    const routed = await routeRequest(current.input, { communicationV1: { select: async () => ({ user_goal: 'original task', decision: 'agent' }),
      health: current.health, hostMcp: current.hostMcp } });
    expect(routed.decision).toMatchObject({ outcome: 'dispatched', reasonCode: 'COMMUNICATION_FALLBACK', providerCode: 'unknown_id' });
    expect(routed.mcpInstruction).toBeUndefined();
  });

  it('no matching method starts ordinary agent work with the capability available, without requiring a call', async () => {
    const current = await fixture();
    const routed = await routeRequest(current.input, { communicationV1: { select: async () => ({ user_goal: 'original task', decision: 'no_matching_option' }),
      health: current.health, hostMcp: current.hostMcp } });
    expect(routed.decision).toMatchObject({ route: 'agent', outcome: 'dispatched', degraded: false });
    expect(routed.agentInstructions).toContain(current.input.prepared.text);
    expect(routed.agentInstructions).toContain('не вызывай её автоматически');
    expect(routed.mcpInstruction).toMatchObject({ name: 'registry.fixture_read', readiness: 'not_verified' });
  });

  it('the exported Worker cannot enable catalogue routing through request body or an unprovisioned flag', async () => {
    const current = await fixture(1, 'ordinary-test-profile');
    await current.store.upsertPrincipal({ principalId: current.principalId, profileId: current.profileId, scopes: ['tasks:read', 'tasks:control'] });
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const rpc = JSON.parse(String(init?.body));
      expect(rpc.params.name).toBe('resolve_user_intent');
      expect(rpc.params.arguments.decision_options).toEqual([{ id: 'system_health' }, { id: 'catalog.brief' }, { id: 'agent' }]);
      return Response.json({ id: rpc.id, result: { structuredContent: { user_goal: 'Preserve the original accepted task', decision: 'agent' } } });
    });
    vi.stubGlobal('fetch', fetcher);
    const signature = await signPrincipal(current.principalId, 'fixture-principal-secret');
    const response = await worker.fetch(new Request('https://cp-fixture.example.test/route', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-principal': current.principalId, 'x-principal-sig': signature },
      body: JSON.stringify({ taskId: current.taskId, hostMcp: { enabled: true }, catalogue: current.names }) }),
    { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, PRINCIPAL_SECRET: 'fixture-principal-secret',
      ROUTER_SELECTOR: 'communication_v1', ROUTER_SELECTOR_NAMES_ONLY: 'true', ROUTER_HOST_MCP_ENABLED: 'true',
      COMMUNICATION_API_URL: 'https://communication-fixture.example.test', COMMUNICATION_TOKEN: 'fixture-token' } as never);
    expect(response.status).toBe(200);
    expect(current.rpc).not.toHaveBeenCalled();
    expect(await current.store.listRuns(current.taskId)).toHaveLength(0);
  });
});
