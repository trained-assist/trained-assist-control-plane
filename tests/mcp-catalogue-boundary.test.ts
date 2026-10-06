import { describe, expect, it, vi } from 'vitest';
import { McpCatalogueAdapter } from '../src/router/mcp-catalogue';
import type { HostMcpCatalogueBinding, McpCatalogueScope } from '../src/router/mcp-catalogue-types';

const scope: McpCatalogueScope = { taskId: 'accepted-task', generation: 1, profileId: 'integration-v1', principalId: 'bound-principal' };
const metadata = (name: string) => ({ name, description: `Authoritative instruction for ${name}`, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } });

function binding(names: string[], serverId = 'native-domain'): HostMcpCatalogueBinding {
  return { scope: { ...scope }, serverId, bindingRef: `binding:${serverId}`, policyVersion: 'policy-v1', allowedTools: names,
    request: vi.fn(async message => ({ jsonrpc: '2.0', id: message.id, result: { tools: names.map(metadata) } })),
  };
}

describe('host-authorized full MCP catalogue boundary', () => {
  for (const count of [66, 256]) {
    it(`aggregates all ${count} authorized names across servers, without descriptions in selector options`, async () => {
      const names = Array.from({ length: count }, (_, index) => `actual_method_${index}`);
      const servers = [binding(names.slice(0, count / 2), 'first'), binding(names.slice(count / 2), 'second')];
      const adapter = new McpCatalogueAdapter(async () => servers);
      const snapshot = await adapter.discover(scope);
      expect(snapshot.decisionOptions).toEqual(names.map(id => ({ id })));
      expect(snapshot.readiness).toBe('not_verified');
      const selected = await adapter.selectedInstruction(scope, snapshot.catalogueId, names.at(-1)!);
      expect(selected).toMatchObject({ name: names.at(-1), serverId: 'second', bindingRef: 'binding:second', policyVersion: 'policy-v1', scope, readiness: 'not_verified' });
      expect(selected.description).toBe(metadata(names.at(-1)!).description);
      expect(selected.inputSchema).toEqual(metadata(names.at(-1)!).inputSchema);
      for (const server of servers) expect(server.request).toHaveBeenCalledOnce();
    });
  }

  it('follows every tools/list page and never invokes tools/call during discovery or selection', async () => {
    const server = binding(['web_current_page', 'browser_session_remote_url']);
    server.request = vi.fn(async message => ({ jsonrpc: '2.0', id: message.id, result: message.params.cursor
      ? { tools: [metadata('browser_session_remote_url')] }
      : { tools: [metadata('web_current_page')], nextCursor: 'second-page' } }));
    const adapter = new McpCatalogueAdapter(async () => [server]);
    const snapshot = await adapter.discover(scope);
    expect(snapshot.decisionOptions).toEqual([{ id: 'web_current_page' }, { id: 'browser_session_remote_url' }]);
    await adapter.selectedInstruction(scope, snapshot.catalogueId, 'web_current_page');
    const calls = vi.mocked(server.request).mock.calls;
    expect(calls.map(([message]) => message.method)).toEqual(['tools/list', 'tools/list']);
    expect(calls[1]?.[0].params).toEqual({ cursor: 'second-page' });
  });

  it('excludes unauthorized registered names and never resolves or invokes an unknown selection', async () => {
    const server = binding(['web_current_page']);
    server.request = vi.fn(async message => ({ jsonrpc: '2.0', id: message.id, result: { tools: [metadata('web_current_page'), metadata('other_profile_write')] } }));
    const resolver = vi.fn(async () => [server]);
    const adapter = new McpCatalogueAdapter(resolver);
    const snapshot = await adapter.discover(scope);
    expect(snapshot.decisionOptions).toEqual([{ id: 'web_current_page' }]);
    for (const name of ['other_profile_write', 'invented_method', 'no_matching_option']) await expect(adapter.selectedInstruction(scope, snapshot.catalogueId, name)).rejects.toMatchObject({ code: 'selection_unknown' });
    expect(resolver).toHaveBeenCalledOnce();
    expect(server.request).toHaveBeenCalledOnce();
  });

  it.each(['profileId', 'principalId', 'taskId', 'generation'] as const)('rejects a mismatched binding %s before transport', async field => {
    const server = binding(['web_current_page']);
    server.scope = { ...scope, [field]: field === 'generation' ? 2 : 'other' };
    await expect(new McpCatalogueAdapter(async () => [server]).discover(scope)).rejects.toMatchObject({ code: 'binding_scope_mismatch' });
    expect(server.request).not.toHaveBeenCalled();
  });

  it.each(['profileId', 'principalId', 'taskId', 'generation'] as const)('fences snapshot reuse under another %s', async field => {
    const server = binding(['web_current_page']);
    const adapter = new McpCatalogueAdapter(async () => [server]);
    const snapshot = await adapter.discover(scope);
    await expect(adapter.selectedInstruction({ ...scope, [field]: field === 'generation' ? 2 : 'other' }, snapshot.catalogueId, 'web_current_page')).rejects.toMatchObject({ code: 'snapshot_scope_mismatch' });
    expect(server.request).toHaveBeenCalledOnce();
  });

  it.each(['policyVersion', 'bindingRef'] as const)('refuses a changed host %s before execution handoff', async field => {
    const server = binding(['web_current_page']);
    const adapter = new McpCatalogueAdapter(async () => [server]);
    const snapshot = await adapter.discover(scope);
    server[field] = 'changed';
    await expect(adapter.selectedInstruction(scope, snapshot.catalogueId, 'web_current_page')).rejects.toMatchObject({ code: 'snapshot_stale' });
  });

  it('refuses revoked tool grants and empty host bindings', async () => {
    const server = binding(['web_current_page']);
    const adapter = new McpCatalogueAdapter(async () => [server]);
    const snapshot = await adapter.discover(scope);
    server.allowedTools = [];
    await expect(adapter.selectedInstruction(scope, snapshot.catalogueId, 'web_current_page')).rejects.toMatchObject({ code: 'snapshot_stale' });
    await expect(new McpCatalogueAdapter(async () => []).discover(scope)).rejects.toMatchObject({ code: 'binding_unavailable' });
  });

  it('refuses duplicate aggregate method names instead of shadowing or renaming', async () => {
    await expect(new McpCatalogueAdapter(async () => [binding(['web_current_page'], 'first'), binding(['web_current_page'], 'second')]).discover(scope)).rejects.toMatchObject({ code: 'tool_name_conflict' });
  });

  it('refuses 257 names explicitly rather than yielding a partial snapshot', async () => {
    const server = binding(Array.from({ length: 257 }, (_, index) => `actual_method_${index}`));
    await expect(new McpCatalogueAdapter(async () => [server]).discover(scope)).rejects.toMatchObject({ code: 'catalogue_budget_exceeded' });
  });

  it('refuses repeated pagination tokens', async () => {
    const server = binding(['web_current_page']);
    server.request = vi.fn(async message => ({ jsonrpc: '2.0', id: message.id, result: { tools: [], nextCursor: 'same' } }));
    await expect(new McpCatalogueAdapter(async () => [server]).discover(scope)).rejects.toMatchObject({ code: 'pagination_invalid' });
    expect(server.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { jsonrpc: '2.0', id: 'wrong', result: { tools: [] } },
    { jsonrpc: '2.0', id: 'wrong', error: { message: 'PRIVATE_PROVIDER_ERROR' } },
  ])('sanitizes malformed protocol/provider failure without leaking raw errors', async reply => {
    const server = binding(['web_current_page']);
    server.request = async () => reply;
    await expect(new McpCatalogueAdapter(async () => [server]).discover(scope)).rejects.toMatchObject({ message: 'discovery_malformed' });
  });

  it('sanitizes host credential failure', async () => {
    const server = binding(['web_current_page']);
    server.request = async () => { throw new Error('PRIVATE_TOKEN'); };
    await expect(new McpCatalogueAdapter(async () => [server]).discover(scope)).rejects.toMatchObject({ message: 'discovery_unavailable' });
  });

  it('selection metadata cannot mutate the stored authoritative snapshot', async () => {
    const server = binding(['web_current_page']);
    const adapter = new McpCatalogueAdapter(async () => [server]);
    const snapshot = await adapter.discover(scope);
    const selected = await adapter.selectedInstruction(scope, snapshot.catalogueId, 'web_current_page');
    (selected.inputSchema.properties as Record<string, unknown>).text = 'forged';
    expect((await adapter.selectedInstruction(scope, snapshot.catalogueId, 'web_current_page')).inputSchema).toEqual(metadata('web_current_page').inputSchema);
  });

  it.each([
    { name: 'web_current_page', inputSchema: 'not-a-schema' },
    { name: 'web_current_page', inputSchema: { type: 'array' } },
    { name: 'web_current_page', inputSchema: { type: 'object' }, description: 42 },
  ])('refuses malformed authoritative tool metadata', async tool => {
    const server = binding(['web_current_page']);
    server.request = async message => ({ jsonrpc: '2.0', id: message.id, result: { tools: [tool] } });
    await expect(new McpCatalogueAdapter(async () => [server]).discover(scope)).rejects.toMatchObject({ code: 'tool_metadata_invalid' });
  });

  it('refuses over-budget selected metadata without publishing a partial catalogue', async () => {
    const server = binding(['web_current_page']);
    server.request = async message => ({ jsonrpc: '2.0', id: message.id, result: { tools: [{ ...metadata('web_current_page'), description: 'x'.repeat(120_001) }] } });
    await expect(new McpCatalogueAdapter(async () => [server]).discover(scope)).rejects.toMatchObject({ code: 'metadata_budget_exceeded' });
  });

  it('aborts stalled discovery without any execution call', async () => {
    vi.useFakeTimers();
    try {
      const server = binding(['web_current_page']);
      let signal: AbortSignal | undefined;
      server.request = vi.fn(async (_message, receivedSignal) => {
        signal = receivedSignal;
        return new Promise(() => {});
      });
      const outcome = new McpCatalogueAdapter(async () => [server]).discover(scope).catch(error => error);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await outcome).toMatchObject({ code: 'discovery_timeout' });
      expect(signal?.aborted).toBe(true);
      expect(server.request).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
