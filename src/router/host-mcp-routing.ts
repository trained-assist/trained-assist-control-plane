import type { McpSpec } from '../run-spec/run-spec';
import { McpCatalogueAdapter, McpCatalogueError } from './mcp-catalogue';
import type { McpCatalogueScope, SelectedMcpInstruction } from './mcp-catalogue-types';

export interface HostMcpRoutingDeps {
  enabled: boolean;
  catalogue: McpCatalogueAdapter;
  readExecutionState: () => Promise<{ scope: McpCatalogueScope; policyVersion: string; mcp: McpSpec | null }>;
}

/** Build RunSpec metadata only from the current trusted host execution policy. */
export async function runMcpDescriptor(deps: HostMcpRoutingDeps | undefined, instruction: SelectedMcpInstruction): Promise<McpSpec> {
  if (!deps?.enabled) throw new McpCatalogueError('host_mcp_disabled');
  const verified = await deps.catalogue.revalidateInstruction(instruction);
  const state = await deps.readExecutionState();
  if (!sameMcpScope(state.scope, verified.scope)) throw new McpCatalogueError('execution_scope_changed');
  if (state.policyVersion !== verified.policyVersion) throw new McpCatalogueError('execution_policy_changed');
  const server = state.mcp?.servers.find(candidate => candidate.serverId === verified.serverId);
  if (!server) throw new McpCatalogueError('execution_binding_missing');
  if (server.transport !== 'remote') throw new McpCatalogueError('execution_transport_unsupported');
  if (!server.allowedTools.includes(verified.name)) throw new McpCatalogueError('execution_binding_missing');
  if (server.bindingRef !== verified.bindingRef || server.url !== verified.url || server.scope !== verified.executionScope
      || server.catalogueVersion !== verified.catalogueVersion || server.policyVersion !== verified.policyVersion
      || server.registryDigest !== verified.registryDigest) throw new McpCatalogueError('execution_policy_changed');
  // `scope` and `registryDigest` are host-side pins used above to revalidate
  // the selected instruction. They are not fields in Runner's public RunSpec:
  // Runner resolves scope and registry identity from its own trusted policy.
  // Sending them across the API boundary makes Runner reject the whole submit.
  return { servers: [{ serverId: server.serverId, transport: 'remote', url: server.url,
    bindingRef: server.bindingRef, allowedTools: [verified.name],
    ...(server.policyVersion ? { policyVersion: server.policyVersion } : {}),
    ...(server.catalogueVersion ? { catalogueVersion: server.catalogueVersion } : {}),
    ...(server.toolTimeoutMs ? { toolTimeoutMs: server.toolTimeoutMs } : {}) }] };
}

export function sameMcpScope(first: McpCatalogueScope, second: McpCatalogueScope): boolean {
  return first.taskId === second.taskId && first.generation === second.generation
    && first.profileId === second.profileId && first.principalId === second.principalId;
}

export async function validateHostMcpExecution(deps: HostMcpRoutingDeps | undefined, instruction: SelectedMcpInstruction): Promise<void> {
  if (!deps?.enabled) throw new McpCatalogueError('host_mcp_disabled');
  const state = await deps.readExecutionState();
  if (!sameMcpScope(state.scope, instruction.scope)) throw new McpCatalogueError('execution_scope_changed');
  if (state.policyVersion !== instruction.policyVersion) throw new McpCatalogueError('execution_policy_changed');
  const server = state.mcp?.servers.find(candidate => candidate.serverId === instruction.serverId);
  if (!server) throw new McpCatalogueError('execution_binding_missing');
  if (server.transport !== 'remote') throw new McpCatalogueError('execution_transport_unsupported');
  if (!server.allowedTools.includes(instruction.name)) throw new McpCatalogueError('execution_binding_missing');
  if (server.bindingRef !== instruction.bindingRef || server.url !== instruction.url || server.scope !== instruction.executionScope
      || server.catalogueVersion !== instruction.catalogueVersion || server.policyVersion !== instruction.policyVersion
      || server.registryDigest !== instruction.registryDigest) throw new McpCatalogueError('execution_policy_changed');
}
