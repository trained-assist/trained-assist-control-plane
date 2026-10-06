import { McpCatalogueAdapter } from './mcp-catalogue';
import type { HostMcpRoutingDeps } from './host-mcp-routing';
import type { McpCatalogueScope } from './mcp-catalogue-types';
import type { McpSpec } from '../run-spec/run-spec';

export const REGISTRY_FIXTURE_PROFILE = 'integration-telegram-ux-v1';
export const REGISTRY_FIXTURE_PRINCIPAL = 'integration-telegram-ux-v1';
export const REGISTRY_FIXTURE_SERVER = 'trained-assist-registry-test';
export const REGISTRY_FIXTURE_BINDING = 'registry-mcp-test-160-read';
export const REGISTRY_FIXTURE_TOOL = 'registry.fixture_read';
export const REGISTRY_FIXTURE_POLICY = 'registry-fixture-policy-v1';
export const REGISTRY_FIXTURE_CATALOGUE = 'registry-fixture-catalogue-v1';
export const REGISTRY_FIXTURE_DIGEST = 'sha256-f88f1d0502220618f596906d27a671e8d086c4be0eff2da6fd77b4f160f9f07d';
export const REGISTRY_FIXTURE_URL = 'https://registry-test.trainedassist.store/mcp';

export function registryFixtureMcpSpec(): McpSpec {
  return { servers: [{ serverId: REGISTRY_FIXTURE_SERVER, transport: 'remote', url: REGISTRY_FIXTURE_URL,
    bindingRef: REGISTRY_FIXTURE_BINDING, scope: 'registry:fixture-read', allowedTools: [REGISTRY_FIXTURE_TOOL],
    policyVersion: REGISTRY_FIXTURE_POLICY, catalogueVersion: REGISTRY_FIXTURE_CATALOGUE,
    registryDigest: '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9' }] };
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty MCP response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('MCP response exceeds the discovery limit');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}

function parseRpcResponse(raw: string, contentType: string, expectedId: string): unknown {
  const records = contentType.includes('text/event-stream')
    ? raw.split(/\r?\n\r?\n/).flatMap(event => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      return data ? [data] : [];
    })
    : [raw];
  if (records.length !== 1) throw new Error('unexpected MCP discovery event count');
  const value = JSON.parse(records[0]!);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.jsonrpc !== '2.0' || value.id !== expectedId) {
    throw new Error('invalid MCP discovery response');
  }
  return value;
}

export function registryFixtureHostMcp(
  scope: McpCatalogueScope,
  bearer: string | undefined,
  executionMcp: McpSpec | null,
  fetcher: typeof fetch = fetch,
): HostMcpRoutingDeps | undefined {
  if (!bearer || scope.profileId !== REGISTRY_FIXTURE_PROFILE || scope.principalId !== REGISTRY_FIXTURE_PRINCIPAL
      || !/^[-A-Za-z0-9._~]{16,2048}$/.test(bearer)) return undefined;
  const expectedPolicy = registryFixtureMcpSpec();
  const declared = executionMcp?.servers.length === 1 ? executionMcp.servers[0] : undefined;
  if (!declared || declared.serverId !== REGISTRY_FIXTURE_SERVER || declared.transport !== 'remote'
      || declared.url !== REGISTRY_FIXTURE_URL || declared.bindingRef !== REGISTRY_FIXTURE_BINDING
      || declared.policyVersion !== REGISTRY_FIXTURE_POLICY || declared.catalogueVersion !== REGISTRY_FIXTURE_CATALOGUE
      || declared.allowedTools.length !== 1 || declared.allowedTools[0] !== REGISTRY_FIXTURE_TOOL) return undefined;

  const catalogue = new McpCatalogueAdapter(async actualScope => {
    if (actualScope.taskId !== scope.taskId || actualScope.generation !== scope.generation
        || actualScope.profileId !== scope.profileId || actualScope.principalId !== scope.principalId) throw new Error('MCP discovery scope changed');
    return [{
      scope: actualScope,
      discoveryAuthorization: { principalId: REGISTRY_FIXTURE_PRINCIPAL, profileId: REGISTRY_FIXTURE_PROFILE, scope: 'mcp:discover', methods: ['tools/list'] },
      url: REGISTRY_FIXTURE_URL,
      serverId: REGISTRY_FIXTURE_SERVER,
      bindingRef: REGISTRY_FIXTURE_BINDING,
      executionScope: 'registry:fixture-read',
      policyVersion: REGISTRY_FIXTURE_POLICY,
      catalogueVersion: REGISTRY_FIXTURE_CATALOGUE,
      catalogueDigest: REGISTRY_FIXTURE_DIGEST,
      registryDigest: '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9',
      allowedTools: [REGISTRY_FIXTURE_TOOL],
      request: async (message, signal) => {
        if (message.method !== 'tools/list' || Object.keys(message).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))) {
          throw new Error('only tools/list is available during discovery');
        }
        const headers = new Headers({
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2024-11-05',
          'x-mcp-operation': 'discovery',
          'x-mcp-user-task-id': actualScope.taskId,
          'x-mcp-profile': actualScope.profileId,
          'x-mcp-principal-id': actualScope.principalId,
          'x-mcp-generation': String(actualScope.generation),
        });
        const response = await fetcher(REGISTRY_FIXTURE_URL, { method: 'POST', headers, body: JSON.stringify(message), redirect: 'manual', signal });
        if (response.status >= 300 && response.status < 400) throw new Error('MCP discovery redirects are refused');
        if (!response.ok) throw new Error(`MCP discovery returned HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json') && !contentType.includes('text/event-stream')) throw new Error('unexpected MCP discovery content type');
        const text = await boundedText(response, 131_072);
        return parseRpcResponse(text, contentType, message.id);
      },
    }];
  });

  return {
    enabled: true,
    catalogue,
    readExecutionState: async () => ({ scope: { ...scope }, policyVersion: REGISTRY_FIXTURE_POLICY, mcp: structuredClone(expectedPolicy) }),
  };
}
