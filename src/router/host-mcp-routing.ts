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
  const state = await deps.readExecutionState();
  if (!sameMcpScope(state.scope, instruction.scope)) throw new McpCatalogueError('execution_scope_changed');
  if (state.policyVersion !== instruction.policyVersion) throw new McpCatalogueError('execution_policy_changed');
  const server = state.mcp?.servers.find(candidate => candidate.serverId === instruction.serverId);
  if (!server || server.bindingRef !== instruction.bindingRef || !server.allowedTools.includes(instruction.name)) {
    throw new McpCatalogueError('execution_binding_missing');
  }
  if (server.transport !== 'remote') throw new McpCatalogueError('execution_transport_unsupported');
  return { servers: [{ ...structuredClone(server), allowedTools: [instruction.name],
    catalogueVersion: instruction.catalogueId, policyVersion: instruction.policyVersion }] };
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
  if (!server || server.bindingRef !== instruction.bindingRef || !server.allowedTools.includes(instruction.name)) {
    throw new McpCatalogueError('execution_binding_missing');
  }
}
