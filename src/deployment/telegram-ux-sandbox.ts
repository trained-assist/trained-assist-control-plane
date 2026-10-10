export const TELEGRAM_UX_SANDBOX = {
  workerName: 'trained-assist-cp-telegram-ux-v1-sandbox',
  databaseName: 'ta-integration-telegram-ux-v1-taskstore',
  databaseId: '01d17f46-63e2-46bc-947d-9eda3e0bb697',
  workflowName: 'ta-integration-telegram-ux-v1-task-workflow',
  accountId: 'd740a05e9442c1d0feacae2dfc673e93',
  accountEmail: 'typeformowner@gmail.com',
  principalId: 'integration-telegram-ux-v1',
  keychainService: 'trained-assist-cp-test-principal-hmac-v1',
  runnerMockTestUrl: 'https://trained-assist-runner-api-cp-sandbox3.skillset-apply.workers.dev',
  runnerMockTestWorker: 'trained-assist-runner-api-cp-sandbox3',
  runnerMockServiceBinding: 'RUNNER_API_MOCK_TEST_SERVICE',
  runnerApiWorker: 'trained-assist-runner-api-telegram-ux-v1-sandbox',
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
  vm2SshKnownHostEntry: '169.58.15.230 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK77e5U6jwbq0mY1ZuJcTR3gzdFBm+5EsTcZLmYVqhah',
  runnerMockKeyBinding: 'RUNNER_API_KEY_TELEGRAM_UX_MOCK_TEST',
  runnerMockRegistryBinding: 'RUNNER_API_KEYS_ADDITIONAL',
  sandbox3OperatorSourceSha: '88d3ed0132c705eb6dd84e47bebb52b755543efe',
  sandbox3BootstrapDigest: '5e71d8cc2802864d9f47938b64b9e3aa274922c7b301ad02f2849b7c773de0b9',
  sandbox3PreparerDigest: 'aea1214b42e63fb799a151bf3cccf3d04bca1b5de557f5088b16b59c3945e86b',
  sandbox3InstallerDigest: '789a0e3f0c9bbbbb7762a8e1006dc95acb4332583a6934e59a92b2a6e127a69c',
  sandbox3JournalCheckerDigest: '602f6fcbb4a9c4938159e5f84840fd0a10f7b852a861615e82d3ba635f7a72ac',
  runnerCandidateRunId: '37865618383',
  runnerCandidateSourceSha: 'ab8e7a3da4efa45c2154d67423542a6974576f22',
  runnerCandidateBundleSha256: '42adc29e0ed20125c8703d661694c36fca59667e8294132c723cee0f0080ed4a',
  runnerPermissionsSourceSha: '9e4ea19da47fb22e9edb99ac35c39827024c81ab',
  runnerPermissionsScriptSha256: 'fe01823e0f21e5a40d99f9a89b3ea954179935473a6a17c107ea07adcc299a94',
  runnerInventorySourceSha: 'b96bb96cf428998063a548bf589536352d0c7519',
  runnerInventoryScriptSha256: 'b1eb4ea47c9cc9820c307ebe98a4041308b1ad32d62d17975e82c667c29f5f89',
} as const;

export function validateSandboxBuildSha(value: unknown): string {
  const sha = String(value ?? '').trim();
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('sandbox_build_sha_invalid');
  return sha.toLowerCase();
}

export function isExpectedTelegramUxCloudflareAccount(output: string): boolean {
  return output.includes(TELEGRAM_UX_SANDBOX.accountId)
    && output.toLowerCase().includes(TELEGRAM_UX_SANDBOX.accountEmail.toLowerCase());
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
  if (config.vars?.RUNNER_API_URL_TELEGRAM_UX !== undefined) {
    throw new Error('sandbox_telegram_runner_must_be_unconfigured');
  }
  let profileOverrides: Record<string, any> = {};
  try { profileOverrides = JSON.parse(config.vars?.RUN_SPEC_PROFILE_OVERRIDES ?? '{}'); }
  catch { throw new Error('sandbox_profile_runner_url_mapping_invalid'); }
  if (profileOverrides[TELEGRAM_UX_SANDBOX.principalId]?.runnerUrlBinding !== undefined) {
    throw new Error('sandbox_profile_runner_url_mapping_mismatch');
  }
  if (config.vars?.RUNNER_API_ENGINE_SELECTION !== 'agent_api'
    || config.vars?.RUNNER_API_URL !== 'https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev'
    || config.vars?.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID !== TELEGRAM_UX_SANDBOX.principalId
    || config.vars?.RUNNER_PROFILE_DELEGATION_TENANT_ID !== 'telegram-ux-sandbox-20261009'
    || profileOverrides[TELEGRAM_UX_SANDBOX.principalId]?.runnerKeyBinding !== undefined) {
    throw new Error('sandbox_agent_api_target_mismatch');
  }
  const services = (config.services ?? []).map((service: { binding: string; service: string }) =>
    `${service.binding}:${service.service}`).sort();
  const expectedServices = [
    'COMMUNICATION_SERVICE:trained-assist-communication-v1-sandbox',
    'INGRESS_BUFFER:trained-assist-ingress-buffer-sandbox',
    'REGISTRY_MCP_HOST_SERVICE:trained-assist-mcp-host-test-160',
    `${TELEGRAM_UX_SANDBOX.runnerMockServiceBinding}:${TELEGRAM_UX_SANDBOX.runnerMockTestWorker}`,
    `RUNNER_API_SERVICE:${TELEGRAM_UX_SANDBOX.runnerApiWorker}`,
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
