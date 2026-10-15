import { SelectorError, type CommunicationConfig } from './communication-client';

export interface TaskReplyTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface TaskReplyMcp {
  list(): Promise<TaskReplyTool[]>;
  call(tool: TaskReplyTool, requestId: string, context: Record<string, unknown>): Promise<string>;
}

// Dedicated authenticated server binding grants ONLY read-only no-argument
// replies. Tools requiring model-generated arguments remain agent tools. The
// selector's two-field contract cannot invent executable arguments or rights.
export function taskReplyMcp(config: CommunicationConfig): TaskReplyMcp {
  async function rpc(method: string, id: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!config.url || !config.token) throw new SelectorError('mcp_not_configured');
    const signal = AbortSignal.timeout(config.timeoutMs ?? 25_000);
    let response: Response;
    try {
      const fetcher = config.service ? config.service.fetch.bind(config.service) : config.fetcher ?? fetch;
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      if (body.length > 120_000) throw new SelectorError('mcp_input_too_large');
      response = await fetcher(`${config.url.replace(/\/+$/, '')}/mcp/task-tools`, {
        method: 'POST', signal,
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': '2024-11-05' }, body,
      });
    } catch (error) {
      if (error instanceof SelectorError) throw error;
      throw new SelectorError(signal.aborted ? 'mcp_timeout' : 'mcp_unavailable');
    }
    if (!response.ok) throw new SelectorError(`mcp_http_${response.status}`);
    if (Number(response.headers.get('content-length') ?? 0) > 120_000) throw new SelectorError('mcp_output_too_large');
    const raw = await response.text();
    if (raw.length > 120_000) throw new SelectorError('mcp_output_too_large');
    let reply;
    try { reply = JSON.parse(raw); } catch { throw new SelectorError('mcp_malformed'); }
    if (reply?.jsonrpc !== '2.0' || reply.id !== id || reply.error || !reply.result || reply.result.isError) throw new SelectorError('mcp_tool_error');
    return reply.result;
  }
  return {
    async list() {
      const result = await rpc('tools/list', crypto.randomUUID());
      if (!Array.isArray(result.tools) || result.nextCursor || result.tools.length > 64) throw new SelectorError('mcp_invalid_catalogue');
      const names = new Set<string>();
      for (const tool of result.tools) {
        const schema = tool?.inputSchema;
        if (!tool || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name)
          || ['agent', 'no_matching_option'].includes(tool.name) || names.has(tool.name)
          || typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 4000
          || tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint !== false
          || tool.annotations?.openWorldHint !== false
          || !schema || schema.type !== 'object' || schema.additionalProperties !== false
          || !schema.properties || Object.keys(schema.properties).length !== 0
          || Object.keys(schema).some(key => !['type', 'properties', 'additionalProperties', 'required'].includes(key))
          || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length))) throw new SelectorError('mcp_invalid_catalogue');
        names.add(tool.name);
      }
      return result.tools as TaskReplyTool[];
    },
    async call(tool, requestId, context) {
      const result = await rpc('tools/call', requestId, { name: tool.name, arguments: {}, _meta: { 'trained-assist/context': context } });
      const output = result.structuredContent as { text?: unknown } | undefined;
      if (!output || typeof output.text !== 'string' || !output.text.trim() || output.text.length > 24_000) throw new SelectorError('mcp_invalid_result');
      return output.text;
    },
  };
}
