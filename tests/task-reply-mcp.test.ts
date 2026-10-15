import { describe, it, expect, vi } from 'vitest';
import { taskReplyMcp } from '../src/router/task-reply-mcp';
import { communicationV1Catalog, routeCommunicationV1 } from '../src/router/communication-v1';
import { deriveAuthorization } from '../src/router/authorization';
import type { RoutingInput } from '../src/router/router-types';
const third = { name: 'new_provider_method', description: 'A newly registered standalone reply',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };
function client(tools: unknown[] = [third], failure = false) {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const rpc = JSON.parse(String(init?.body));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture');
    if (rpc.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools } });
    expect(rpc.params.arguments).toEqual({});
    expect(rpc.params._meta['trained-assist/context'].authorizationRef).toMatch(/^authz-/);
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: failure
      ? { isError: true, structuredContent: { text: 'Do not show false success' } }
      : { structuredContent: { text: 'Provider-owned third reply' } } });
  });
  return { fetcher, mcp: taskReplyMcp({ url: 'https://fixture.test', token: 'fixture', fetcher: fetcher as typeof fetch }) };
}
async function input(granted = true): Promise<RoutingInput> {
  const catalog = communicationV1Catalog([third]);
  return {
    envelope: { userTaskId: 'task', principalId: 'principal', profileId: 'profile', conversationId: null, requestId: 'request', runId: null,
      catalogVersion: catalog.version, policyVersion: 'test', budgets: { llmCallsRemaining: 2, agentAllowed: true } },
    prepared: { text: 'Original complete request', originalInput: { inputItems: [{ text: 'Original complete request' }] },
      context: { pendingProposal: null, lastAssistantText: null, sessionEmpty: true, relevantTurns: 0 },
      attachments: [], typedSignal: null, contextVersion: 'v1', readinessSnapshotPresent: true },
    catalog, authorization: await deriveAuthorization({ principalId: 'principal', profileId: 'profile', scopes: ['tasks:control'],
      grantedCapabilityIds: granted ? [third.name] : [], grantedIntegrationIds: [] }, catalog),
    hostFacts: { clockMs: Date.now(), connections: {}, profileFields: {}, activeTasks: [], tasksYesterday: [] },
  };
}
const select = async () => ({ decision: third.name, user_goal: 'Original complete request' });
describe('generic MCP reply dispatch', () => {
  it('discovers and invokes a third method without a core branch or writer', async () => {
    const { mcp, fetcher } = client();
    const result = await routeCommunicationV1(await input(), { taskReplies: mcp, select });
    expect(result.reply?.text).toBe('Provider-owned third reply');
    expect(result.decision.capabilityId).toBe(third.name);
    expect(result.execution).toMatchObject({ capabilityExecutions: 1, agentDispatchAttempts: 0, modelCalls: 1 });
    expect(result.continuation).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not call an ungranted method even when the selector chooses it', async () => {
    const { mcp, fetcher } = client();
    const result = await routeCommunicationV1(await input(false), { taskReplies: mcp, select });
    expect(result.reply).toBeNull();
    expect(result.decision.providerCode).toBe('unknown_id');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('never turns an MCP error into a successful reply and preserves the task', async () => {
    const { mcp } = client([third], true);
    const result = await routeCommunicationV1(await input(), { taskReplies: mcp, select });
    expect(result.reply).toBeNull();
    expect(result.decision).toMatchObject({ degraded: true, providerCode: 'mcp_tool_error', route: 'agent' });
    expect(result.continuation?.goal).toBe('Original complete request');
    expect(result.decision.degradedNotice?.text).toContain('MCP');
  });
  it.each([
    { ...third, inputSchema: { ...third.inputSchema, required: ['command'] } },
    { ...third, inputSchema: { ...third.inputSchema, oneOf: [{ required: ['command'] }] } },
    { ...third, annotations: { ...third.annotations, readOnlyHint: false } },
    { ...third, name: 'agent' },
  ])('rejects unsupported or unsafe tool contracts before selection', async tool => {
    await expect(client([tool]).mcp.list()).rejects.toMatchObject({ code: 'mcp_invalid_catalogue' });
  });
  it('preserves attachments and never calls a quick method for them', async () => {
    const current = await input();
    current.prepared.attachments.push({ artifactRef: 'file:1', kind: 'artifact', extracted: false, chars: null });
    const { mcp, fetcher } = client();
    const result = await routeCommunicationV1(current, { taskReplies: mcp, select });
    expect(result.reply).toBeNull();
    expect(result.continuation?.goal).toBe('Original complete request');
    expect(result.agentInstructions).not.toContain('Original complete request');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
