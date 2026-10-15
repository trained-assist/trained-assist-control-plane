import type { McpSpec } from '../run-spec/run-spec';

export const USER_MCP_SERVER = 'mem-gpt';
export const USER_MCP_BINDING = 'mem-gpt-user-sandbox';
export const USER_MCP_SCOPE = 'mcp:user-agent-run';
export const USER_MCP_POLICY = 'mem-gpt-user-run-v1';
export const USER_MCP_CATALOGUE = 'mem-gpt-user-catalogue-v1';
export const USER_MCP_DIGEST = '8c17e64a0d71123698b139bd5957a10fff71a2b15f12601a95adcde150350e71';
export const USER_MCP_URL = 'https://trained-assist-mcp-user-sandbox.skillset-apply.workers.dev/mcp';

/** Host-owned, sandbox-only descriptor for the product user catalog. */
export function userSandboxMcpSpec(): McpSpec {
  return { servers: [{ serverId: USER_MCP_SERVER, transport: 'remote', url: USER_MCP_URL,
    bindingRef: USER_MCP_BINDING, scope: USER_MCP_SCOPE,
    allowedTools: ['identity.whoami', 'google_docs.connect', 'google_docs.get_document'],
    policyVersion: USER_MCP_POLICY, catalogueVersion: USER_MCP_CATALOGUE, registryDigest: USER_MCP_DIGEST }] };
}
