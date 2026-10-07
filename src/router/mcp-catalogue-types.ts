export interface McpCatalogueScope {
  taskId: string;
  generation: number;
  profileId: string;
  principalId: string;
}

/** Separate pre-Run authorization. It has no runId and can only list tools. */
export interface McpDiscoveryAuthorization {
  principalId: string;
  profileId: string;
  scope: 'mcp:discover';
  methods: readonly ['tools/list'];
}

export interface McpListRequest {
  jsonrpc: '2.0';
  id: string;
  method: 'tools/list';
  params: { cursor?: string };
}

export interface HostMcpCatalogueBinding {
  scope: McpCatalogueScope;
  discoveryAuthorization: McpDiscoveryAuthorization;
  url: string;
  serverId: string;
  bindingRef: string;
  /** Runner/Registry execution scope, distinct from pre-submit mcp:discover. */
  executionScope: string;
  policyVersion: string;
  /** Stable host-pinned version, distinct from the per-request catalogueId. */
  catalogueVersion: string;
  /** Registry configuration digest pinned by Host and checked again by Runner. */
  registryDigest?: string;
  /** Optional pinned digest of the authorized tools/list metadata. */
  catalogueDigest?: string;
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
  url: string;
  serverId: string;
  bindingRef: string;
  executionScope: string;
  policyVersion: string;
  catalogueVersion: string;
  registryDigest?: string;
  catalogueDigest: string;
  name: string;
  description?: string;
  inputSchema: Readonly<Record<string, unknown>>;
  readiness: 'not_verified';
}
