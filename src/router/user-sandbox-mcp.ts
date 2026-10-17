import type { McpSpec } from '../run-spec/run-spec';

export const USER_MCP_SERVER = 'mem-gpt';
export const USER_MCP_BINDING = 'mem-gpt-user-sandbox';
export const USER_MCP_SCOPE = 'mcp:user-agent-run';
export const USER_MCP_POLICY = 'mem-gpt-user-run-v1';
export const USER_MCP_CATALOGUE = 'mem-gpt-user-catalogue-v2';
export const USER_MCP_DIGEST = '483e6d2f949b32c05a70186f4e25aba291b1483eeb0bdc9a7a3bca4b9b7cdf11';
export const USER_MCP_URL = 'https://trained-assist-mcp-user-sandbox.skillset-apply.workers.dev/mcp';

/** Host-owned, sandbox-only descriptor for the product user catalog. */
export function userSandboxMcpSpec(): McpSpec {
  return { servers: [{ serverId: USER_MCP_SERVER, transport: 'remote', url: USER_MCP_URL,
    bindingRef: USER_MCP_BINDING, scope: USER_MCP_SCOPE,
    allowedTools: ['identity.whoami', 'google_docs.connect', 'google_docs.get_document',
      'zerocreds_wallet_form_create', 'zerocreds_wallet_form_status',
      'zerocreds_wallet_connection_status', 'zerocreds_wallet_connection_revoke'],
    policyVersion: USER_MCP_POLICY, catalogueVersion: USER_MCP_CATALOGUE, registryDigest: USER_MCP_DIGEST }] };
}
