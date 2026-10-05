export interface IntentSelection {
  user_goal: string;
  decision: string;
}

export class SelectorError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'SelectorError';
  }
}

export interface CommunicationConfig {
  url?: string;
  token?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

async function callTool(config: CommunicationConfig, name: string, input: Record<string, unknown>): Promise<unknown> {
  if (!config.url || !config.token) throw new SelectorError('not_configured');
  const timeoutMs = config.timeoutMs ?? 70_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new SelectorError('invalid_timeout');
  if (JSON.stringify(input).length > 120_000) throw new SelectorError('input_too_large');
  let response: Response;
  try {
    response = await (config.fetcher ?? fetch)(`${config.url.replace(/\/+$/, '')}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': '2024-11-05' },
      body: JSON.stringify({ jsonrpc: '2.0', id: input.request_id, method: 'tools/call', params: { name, arguments: input } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { throw new SelectorError('unavailable_or_timeout'); }
  if (!response.ok) throw new SelectorError(`http_${response.status}`);
  let rpc: { id?: unknown; error?: unknown; result?: { isError?: boolean; structuredContent?: unknown } };
  try { rpc = await response.json(); } catch { throw new SelectorError('malformed'); }
  if (!rpc || rpc.id !== input.request_id || rpc.error || rpc.result?.isError) throw new SelectorError('tool_error');
  return rpc.result?.structuredContent;
}

export function communicationWriter(config: CommunicationConfig) {
  return async (input: Record<string, unknown>): Promise<string> => {
    const output = await callTool(config, 'generate_next_message_to_conversation_partner', input) as { status?: string; message_text?: string; context_revision?: string } | null;
    if (output?.status !== 'generated' || typeof output.message_text !== 'string' || output.context_revision !== input.context_revision) throw new SelectorError('writer_rejected');
    return output.message_text;
  };
}

export function communicationSelector(config: CommunicationConfig): (input: Record<string, unknown>) => Promise<IntentSelection> {
  return async (input) => {
    const output = await callTool(config, 'resolve_user_intent', input);
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw new SelectorError('malformed');
    const value = output as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'decision,user_goal' || typeof value.user_goal !== 'string' || value.user_goal.trim().length < 10 || typeof value.decision !== 'string') {
      throw new SelectorError('malformed');
    }
    const options = input.decision_options as Array<{ id: string }>;
    if (value.decision !== 'no_matching_option' && !options.some((option) => option.id === value.decision)) throw new SelectorError('unknown_id');
    return { user_goal: value.user_goal, decision: value.decision };
  };
}
