import type { TaskReplyTool, TaskReplyMcp } from '../../src/router/task-reply-mcp';
export const taskTools: TaskReplyTool[] = ['system_health', 'catalog.brief'].map(name => ({
  name, description: `Fixture method ${name}`, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}));
export const taskReplies: TaskReplyMcp = {
  list: async () => taskTools,
  call: async (tool, _id, context) => tool.name === 'system_health' ? 'Сервис работает! Отправляйте задание!'
    : `Каталог: ${JSON.stringify(context)}; требует подключения; работоспособность интеграции не проверена`,
};
export function taskRpc(rpc: { id: string; method: string; params: { name?: string } }): Response | undefined {
  if (rpc.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: taskTools } });
  if (taskTools.some(tool => tool.name === rpc.params.name)) return Response.json({ jsonrpc: '2.0', id: rpc.id,
    result: { structuredContent: { text: rpc.params.name === 'system_health' ? 'Сервис работает! Отправляйте задание!' : 'Каталог MCP' } } });
}
