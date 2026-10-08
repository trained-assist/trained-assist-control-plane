export const TELEGRAM_UX_SANDBOX = {
  workerName: 'trained-assist-cp-telegram-ux-v1-sandbox',
  databaseName: 'ta-integration-telegram-ux-v1-taskstore',
  databaseId: '01d17f46-63e2-46bc-947d-9eda3e0bb697',
  workflowName: 'ta-integration-telegram-ux-v1-task-workflow',
  accountId: 'd740a05e9442c1d0feacae2dfc673e93',
  accountEmail: 'typeformowner@gmail.com',
  principalId: 'integration-telegram-ux-v1',
  runnerEngine: 'dynamic-ip-azure-agent-run',
  keychainService: 'trained-assist-cp-test-principal-hmac-v1',
} as const;

export function validateTelegramUxSandboxConfig(config: Record<string, any>): true {
  if (config.name !== TELEGRAM_UX_SANDBOX.workerName || config.workers_dev !== true) {
    throw new Error('sandbox_worker_mismatch');
  }
  if (config.d1_databases?.length !== 1
    || config.d1_databases[0].database_name !== TELEGRAM_UX_SANDBOX.databaseName
    || config.d1_databases[0].database_id !== TELEGRAM_UX_SANDBOX.databaseId) {
    throw new Error('sandbox_database_mismatch');
  }
  if (!Array.isArray(config.workflows) || config.workflows.length !== 1
    || config.workflows[0].name !== TELEGRAM_UX_SANDBOX.workflowName) {
    throw new Error('sandbox_workflow_mismatch');
  }
  if (config.vars?.ROUTER_AGENT_ENGINE !== TELEGRAM_UX_SANDBOX.runnerEngine) {
    throw new Error('sandbox_runner_engine_mismatch');
  }
  const services = (config.services ?? []).map((service: { binding: string; service: string }) =>
    `${service.binding}:${service.service}`).sort();
  const expectedServices = [
    'COMMUNICATION_SERVICE:trained-assist-communication-v1-sandbox',
    'INGRESS_BUFFER:trained-assist-ingress-buffer-sandbox',
    'REGISTRY_MCP_HOST_SERVICE:trained-assist-mcp-host-test-160',
  ].sort();
  if (JSON.stringify(services) !== JSON.stringify(expectedServices)) throw new Error('sandbox_service_binding_mismatch');
  return true;
}

export async function telegramUxPrincipalSignature(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(TELEGRAM_UX_SANDBOX.principalId));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
