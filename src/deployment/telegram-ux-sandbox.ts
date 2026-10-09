export const TELEGRAM_UX_SANDBOX = {
  workerName: 'trained-assist-cp-telegram-ux-v1-sandbox',
  databaseName: 'ta-integration-telegram-ux-v1-taskstore',
  databaseId: '01d17f46-63e2-46bc-947d-9eda3e0bb697',
  workflowName: 'ta-integration-telegram-ux-v1-task-workflow',
  accountId: 'd740a05e9442c1d0feacae2dfc673e93',
  accountEmail: 'typeformowner@gmail.com',
  principalId: 'integration-telegram-ux-v1',
  keychainService: 'trained-assist-cp-test-principal-hmac-v1',
  runnerMockTestUrl: 'https://169-58-15-230.sslip.io/runner-mcp-test',
} as const;

export const TELEGRAM_UX_SANDBOX_CREDENTIALS = {
  githubEnvironment: 'sandbox',
  runnerKeySeedSecret: 'RUNNER_MOCK_KEY_SEED',
  cpPrincipalSecret: 'CP_TELEGRAM_UX_PRINCIPAL_SECRET',
  cloudflareApiTokenSecret: 'CF_API_TOKEN',
  cloudflareAccountIdVariable: 'CF_ACCOUNT_ID',
  vm2SshPrivateKeySecret: 'VM2_SSH_PRIVATE_KEY',
  vm2SshHost: '169.58.15.230',
  vm2SshUser: 'root',
  vm2SshKnownHostEntry: '169.58.15.230 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIqY97L/HqL+EjcMNau36t5E2BgVprJsPu18ZsGztv/f',
  runnerMockKeyBinding: 'RUNNER_API_KEY_TELEGRAM_UX_MOCK_TEST',
  runnerMockProvisioner: '/usr/local/sbin/runner-api-mcp-test-provision-principal',
  sandbox3OperatorSourceSha: '6c13e48c6a74fb38b31f9755c74f53249cab3204',
  sandbox3BootstrapDigest: '5e71d8cc2802864d9f47938b64b9e3aa274922c7b301ad02f2849b7c773de0b9',
  sandbox3PreparerDigest: '0fb507b7c23453393254c26f7dbc5efcfa4248db041f3abdaa939b9d820e715a',
  sandbox3InstallerDigest: '70cf9eb56bc1f7787d721c67f6e9fb4d9711e8531f675510dc7bd7160fa9abfc',
  sandbox3JournalCheckerDigest: '602f6fcbb4a9c4938159e5f84840fd0a10f7b852a861615e82d3ba635f7a72ac',
  runnerCandidateRunId: '37865618383',
  runnerCandidateSourceSha: 'ab8e7a3da4efa45c2154d67423542a6974576f22',
  runnerCandidateBundleSha256: '42adc29e0ed20125c8703d661694c36fca59667e8294132c723cee0f0080ed4a',
  runnerPermissionsSourceSha: '9e4ea19da47fb22e9edb99ac35c39827024c81ab',
  runnerPermissionsScriptSha256: 'fe01823e0f21e5a40d99f9a89b3ea954179935473a6a17c107ea07adcc299a94',
  runnerInventorySourceSha: '9e4ea19da47fb22e9edb99ac35c39827024c81ab',
  runnerInventoryScriptSha256: 'd2c8cbdbbfc45465d6bdc5c942002e059ad6954467d230300513d3ecd9fe61bf',
} as const;

export function validateSandboxBuildSha(value: unknown): string {
  const sha = String(value ?? '').trim();
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('sandbox_build_sha_invalid');
  return sha.toLowerCase();
}

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
  if (config.vars?.SANDBOX_RUNNER_MOCK_PROBE_ENABLED !== 'true') {
    throw new Error('sandbox_mock_probe_gate_mismatch');
  }
  if (config.vars?.SANDBOX_RUNNER_MOCK_TEST_URL !== TELEGRAM_UX_SANDBOX.runnerMockTestUrl) {
    throw new Error('sandbox_mock_runner_url_mismatch');
  }
  if (config.vars?.RUNNER_API_URL_TELEGRAM_UX !== TELEGRAM_UX_SANDBOX.runnerMockTestUrl) {
    throw new Error('sandbox_telegram_runner_url_mismatch');
  }
  let profileOverrides: Record<string, any> = {};
  try { profileOverrides = JSON.parse(config.vars?.RUN_SPEC_PROFILE_OVERRIDES ?? '{}'); }
  catch { throw new Error('sandbox_profile_runner_url_mapping_invalid'); }
  if (profileOverrides[TELEGRAM_UX_SANDBOX.principalId]?.runnerUrlBinding !== 'RUNNER_API_URL_TELEGRAM_UX') {
    throw new Error('sandbox_profile_runner_url_mapping_mismatch');
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

export function isSandboxReadinessEndpointMissing(status: number, body: unknown): boolean {
  if (status === 404) return true;
  if (status !== 400 || !body || typeof body !== 'object' || Array.isArray(body)) return false;
  // Older sandbox revisions route this unknown internal path through the
  // legacy task-status handler, whose stable response is this exact 400.
  return (body as Record<string, unknown>).error === 'taskId is required';
}

export async function telegramUxPrincipalSignature(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(TELEGRAM_UX_SANDBOX.principalId));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
