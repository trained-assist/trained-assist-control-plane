import { describe, expect, it, vi } from 'vitest';
import { registryFixtureHostMcp, registryFixtureMcpSpec, REGISTRY_FIXTURE_PROFILE, REGISTRY_FIXTURE_PRINCIPAL, REGISTRY_FIXTURE_TOOL } from '../src/router/registry-test-mcp';

const scope = { taskId: 'telegram-task-160', generation: 1, profileId: REGISTRY_FIXTURE_PROFILE, principalId: REGISTRY_FIXTURE_PRINCIPAL };
const metadata = [{ name: REGISTRY_FIXTURE_TOOL,
  description: 'Read the pinned marker from the Registry MCP test fixture.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];

describe('live registry test discovery binding', () => {
  it('calls only tools/list with task/profile/principal discovery scope and no run binding', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({ jsonrpc: '2.0', method: 'tools/list', params: {} });
      return Response.json({ jsonrpc: '2.0', id: request.id, result: { tools: metadata } });
    });
    const hostMcp = registryFixtureHostMcp(scope, 'fixture_bearer_0123456789', registryFixtureMcpSpec(), fetcher as typeof fetch)!;
    const snapshot = await hostMcp.catalogue.discover(scope);
    expect(snapshot.decisionOptions).toEqual([{ id: REGISTRY_FIXTURE_TOOL }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer fixture_bearer_0123456789');
    expect(headers.get('x-mcp-operation')).toBe('discovery');
    expect(headers.get('x-mcp-user-task-id')).toBe(scope.taskId);
    expect(headers.get('x-mcp-profile')).toBe(scope.profileId);
    expect(headers.get('x-mcp-principal-id')).toBe(scope.principalId);
    expect(headers.get('x-mcp-generation')).toBe(String(scope.generation));
    expect(headers.has('x-mcp-run-id')).toBe(false);
    expect(headers.has('x-mcp-run-binding')).toBe(false);
  });

  it('refuses profile/principal drift, redirects, and non-JSON RPC responses', async () => {
    expect(registryFixtureHostMcp({ ...scope, principalId: 'other' }, 'fixture_bearer_0123456789', registryFixtureMcpSpec())).toBeUndefined();
    const redirect = registryFixtureHostMcp(scope, 'fixture_bearer_0123456789', registryFixtureMcpSpec(), vi.fn(async () => new Response(null, { status: 302 })) as typeof fetch)!;
    await expect(redirect.catalogue.discover(scope)).rejects.toMatchObject({ code: 'discovery_unavailable' });
    const wrongType = registryFixtureHostMcp(scope, 'fixture_bearer_0123456789', registryFixtureMcpSpec(), vi.fn(async () => new Response('no', { headers: { 'content-type': 'text/plain' } })) as typeof fetch)!;
    await expect(wrongType.catalogue.discover(scope)).rejects.toMatchObject({ code: 'discovery_unavailable' });
  });
});
