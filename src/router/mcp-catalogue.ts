import type { HostMcpCatalogueBinding, McpCatalogueScope, McpCatalogueSnapshot, SelectedMcpInstruction } from './mcp-catalogue-types';

const namePattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,199}$/;
const TEST_PROFILE = 'integration-telegram-ux-v1';
const TEST_TOOL = 'registry.fixture_read';
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const reference = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const scopeKey = (scope: McpCatalogueScope) => JSON.stringify([scope.taskId, scope.generation, scope.profileId, scope.principalId]);
const policyKey = (binding: HostMcpCatalogueBinding) => JSON.stringify([scopeKey(binding.scope), binding.serverId, binding.bindingRef, binding.policyVersion, [...binding.allowedTools].sort()]);

export class McpCatalogueError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'McpCatalogueError';
  }
}

function refuse(code: string): never {
  throw new McpCatalogueError(code);
}

function validateScope(scope: McpCatalogueScope) {
  if (!scope || !reference(scope.taskId) || !reference(scope.profileId) || !reference(scope.principalId) || !Number.isSafeInteger(scope.generation) || scope.generation < 1) refuse('scope_invalid');
}

export class McpCatalogueAdapter {
  private readonly snapshots = new Map<string, { scope: McpCatalogueScope; tools: Map<string, SelectedMcpInstruction>; policies: Map<string, string> }>();

  constructor(private readonly resolveBindings: (scope: Readonly<McpCatalogueScope>) => Promise<readonly HostMcpCatalogueBinding[]>) {}

  private async bindings(scope: McpCatalogueScope) {
    validateScope(scope);
    let bindings: readonly HostMcpCatalogueBinding[];
    try { bindings = await this.resolveBindings(Object.freeze({ ...scope })); }
    catch { return refuse('binding_unavailable'); }
    if (!Array.isArray(bindings) || bindings.length === 0) refuse('binding_unavailable');
    const servers = new Set<string>();
    for (const binding of bindings) {
      if (!binding || !binding.scope || scopeKey(binding.scope) !== scopeKey(scope)) refuse('binding_scope_mismatch');
      const discovery = binding.discoveryAuthorization;
      if (!discovery || discovery.principalId !== scope.principalId || discovery.profileId !== scope.profileId
        || discovery.scope !== 'mcp:discover' || !Array.isArray(discovery.methods) || discovery.methods.length !== 1 || discovery.methods[0] !== 'tools/list') refuse('discovery_authorization_invalid');
      if (!reference(binding.serverId) || !reference(binding.bindingRef) || !reference(binding.policyVersion) || typeof binding.request !== 'function' || !Array.isArray(binding.allowedTools) || binding.allowedTools.some((name: unknown) => typeof name !== 'string' || !namePattern.test(name))) refuse('binding_invalid');
      if (scope.profileId === TEST_PROFILE && (binding.allowedTools.length !== 1 || binding.allowedTools[0] !== TEST_TOOL)) refuse('binding_invalid');
      if (servers.has(binding.serverId) || new Set(binding.allowedTools).size !== binding.allowedTools.length) refuse('binding_conflict');
      servers.add(binding.serverId);
    }
    return bindings;
  }

  async discover(scope: McpCatalogueScope): Promise<McpCatalogueSnapshot> {
    scope = Object.freeze({ ...scope });
    const catalogueId = crypto.randomUUID();
    const tools = new Map<string, SelectedMcpInstruction>();
    const policies = new Map<string, string>();
    const bindings = await this.bindings(scope);
    const deadline = Date.now() + 15_000;
    let namesChars = 0;
    let metadataChars = 0;
    for (const binding of bindings) {
      policies.set(binding.serverId, policyKey(binding));
      const allowed = new Set(binding.allowedTools);
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let page = 0;
      do {
        const remaining = deadline - Date.now();
        if (remaining <= 0) refuse('discovery_timeout');
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const id = `${catalogueId}:${binding.serverId}:${page++}`;
        let rpc: unknown;
        try {
          rpc = await Promise.race([
            binding.request({ jsonrpc: '2.0', id, method: 'tools/list', params: cursor === undefined ? {} : { cursor } }, controller.signal),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => { controller.abort(); reject(new McpCatalogueError('discovery_timeout')); }, remaining);
            }),
          ]);
        } catch (error) {
          if (error instanceof McpCatalogueError) throw error;
          refuse('discovery_unavailable');
        } finally { clearTimeout(timer); }
        if (!object(rpc) || rpc.jsonrpc !== '2.0' || rpc.id !== id || rpc.error || !object(rpc.result) || !Array.isArray(rpc.result.tools)) refuse('discovery_malformed');
        for (const tool of rpc.result.tools) {
          if (!object(tool) || typeof tool.name !== 'string' || !namePattern.test(tool.name) || !object(tool.inputSchema) || tool.inputSchema.type !== 'object' || (tool.description !== undefined && typeof tool.description !== 'string')) refuse('tool_metadata_invalid');
          if (!allowed.has(tool.name)) continue;
          if (tools.has(tool.name)) refuse('tool_name_conflict');
          namesChars += tool.name.length;
          if (tools.size >= 256 || namesChars > 24_000) refuse('catalogue_budget_exceeded');
          let inputSchema: Record<string, unknown>;
          try {
            const encoded = JSON.stringify(tool.inputSchema);
            metadataChars += encoded.length + (tool.description?.length ?? 0);
            if (encoded.length > 120_000 || (tool.description?.length ?? 0) > 120_000 || metadataChars > 1_048_576) refuse('metadata_budget_exceeded');
            inputSchema = JSON.parse(encoded);
          } catch (error) {
            if (error instanceof McpCatalogueError) throw error;
            refuse('tool_metadata_invalid');
          }
          tools.set(tool.name, { catalogueId, scope: { ...scope }, serverId: binding.serverId, bindingRef: binding.bindingRef, policyVersion: binding.policyVersion, name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema, readiness: 'not_verified' });
        }
        const next = rpc.result.nextCursor;
        if (next !== undefined && (typeof next !== 'string' || !next || next.length > 2048 || cursors.has(next))) refuse('pagination_invalid');
        cursor = next as string | undefined;
        if (cursor !== undefined) cursors.add(cursor);
      } while (cursor !== undefined);
    }
    if (!tools.size) refuse('catalogue_empty');
    this.snapshots.set(catalogueId, { scope: { ...scope }, tools, policies });
    return { catalogueId, decisionOptions: [...tools.keys()].map(id => Object.freeze({ id })), readiness: 'not_verified' };
  }

  async selectedInstruction(scope: McpCatalogueScope, catalogueId: string, name: string): Promise<SelectedMcpInstruction> {
    scope = Object.freeze({ ...scope });
    validateScope(scope);
    const snapshot = this.snapshots.get(catalogueId);
    if (!snapshot || scopeKey(snapshot.scope) !== scopeKey(scope)) refuse('snapshot_scope_mismatch');
    const selected = snapshot.tools.get(name);
    if (!selected) refuse('selection_unknown');
    const bindings = await this.bindings(scope);
    if (bindings.length !== snapshot.policies.size || bindings.some(binding => snapshot.policies.get(binding.serverId) !== policyKey(binding))) refuse('snapshot_stale');
    return structuredClone(selected);
  }
}
