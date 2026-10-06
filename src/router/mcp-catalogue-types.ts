export interface McpCatalogueScope {
  taskId: string;
  generation: number;
  profileId: string;
  principalId: string;
}

export interface McpListRequest {
  jsonrpc: '2.0';
  id: string;
  method: 'tools/list';
  params: { cursor?: string };
}

export interface HostMcpCatalogueBinding {
  scope: McpCatalogueScope;
  serverId: string;
  bindingRef: string;
  policyVersion: string;
  allowedTools: readonly string[];
  request: (message: McpListRequest, signal: AbortSignal) => Promise<unknown>;
}

export interface McpCatalogueSnapshot {
  catalogueId: string;
  decisionOptions: ReadonlyArray<Readonly<{ id: string }>>;
  readiness: 'not_verified';
}

export interface SelectedMcpInstruction {
  catalogueId: string;
  scope: Readonly<McpCatalogueScope>;
  serverId: string;
  bindingRef: string;
  policyVersion: string;
  name: string;
  description?: string;
  inputSchema: Readonly<Record<string, unknown>>;
  readiness: 'not_verified';
}
