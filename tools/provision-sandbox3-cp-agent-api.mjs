import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const WORKER = 'trained-assist-cp-sandbox3';
const EXPECTED_RUNNER_URL = 'https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev';
const EXPECTED_PRINCIPAL = 'sandbox3-agent-api-principal';
const EXPECTED_TENANT = 'sandbox3-acceptance-a-20261008';
const OUTPUT = process.env.GITHUB_WORKSPACE
  ? `${process.env.GITHUB_WORKSPACE}/sandbox3-cp-agent-api-evidence.json` : null;

function fail(code) { throw new Error(code); }

export function validateSandbox3CpAgentApiBindings(bindings) {
  if (!Array.isArray(bindings)) fail('sandbox3_cp_binding_list_invalid');
  const values = new Map(bindings.map(binding => [binding.name, binding]));
  const service = values.get('RUNNER_API_SERVICE');
  if (values.get('DEPLOYMENT_ENV')?.text !== 'sandbox3'
    || values.get('DEPLOYMENT_ENV')?.type !== 'plain_text'
    || values.get('RUNNER_API_URL')?.text !== EXPECTED_RUNNER_URL
    || values.get('RUNNER_API_URL')?.type !== 'plain_text'
    || service?.type !== 'service' || service.service !== 'trained-assist-runner-api-sandbox3'
    || values.get('RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID')?.text !== EXPECTED_PRINCIPAL
    || values.get('RUNNER_PROFILE_DELEGATION_TENANT_ID')?.text !== EXPECTED_TENANT
    || values.get('PREVIEW_ONLY')?.text !== 'true'
    || values.get('PILOT_ENABLED')?.text !== 'false'
    || values.get('ROUTER_AGENT_ALLOWED')?.text !== 'false'
    || values.get('PRINCIPAL_SECRET_SANDBOX3')?.type !== 'secret_text') {
    fail('sandbox3_cp_runtime_contract_mismatch');
  }
  return true;
}

async function readWorkerBindings(token) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER}/settings`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success !== true || !Array.isArray(body?.result?.bindings)) {
    fail(`sandbox3_cp_settings_read_failed:${response.status}`);
  }
  return body.result.bindings;
}

function putWorkerSecret(name, value, token) {
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', name,
    '--name', WORKER, '--config', 'wrangler.sandbox3.jsonc'], {
    input: value,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'pipe'],
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
  });
  if (result.error || result.status !== 0) fail(`sandbox3_cp_secret_write_failed:${name}`);
}

export async function provisionSandbox3CpAgentApi(env = process.env) {
  const token = env.CF_API_TOKEN?.trim();
  const apiKey = env.SANDBOX3_RUNNER_API_KEY?.trim();
  const delegationSecret = env.SANDBOX3_PROFILE_DELEGATION_SECRET?.trim();
  if (!token || token.length < 20) fail('sandbox3_cp_cloudflare_token_missing');
  if (!apiKey || Buffer.byteLength(apiKey) < 32 || apiKey.length > 500
    || !delegationSecret || Buffer.byteLength(delegationSecret) < 32) {
    fail('sandbox3_cp_profile_credentials_invalid');
  }
  const before = await readWorkerBindings(token);
  validateSandbox3CpAgentApiBindings(before);
  putWorkerSecret('RUNNER_API_KEY_AGENT_API', apiKey, token);
  putWorkerSecret('RUNNER_PROFILE_DELEGATION_SECRET', delegationSecret, token);
  const after = await readWorkerBindings(token);
  validateSandbox3CpAgentApiBindings(after);
  const apiKeyBinding = after.find(binding => binding.name === 'RUNNER_API_KEY_AGENT_API');
  const delegationBinding = after.find(binding => binding.name === 'RUNNER_PROFILE_DELEGATION_SECRET');
  if (apiKeyBinding?.type !== 'secret_text' || delegationBinding?.type !== 'secret_text') {
    fail('sandbox3_cp_agent_api_secret_binding_missing');
  }
  return {
    worker: WORKER,
    runnerUrl: EXPECTED_RUNNER_URL,
    principalId: EXPECTED_PRINCIPAL,
    tenantId: EXPECTED_TENANT,
    credentialsBound: true,
    executionFlagsRemainDisabled: true,
  };
}

if (process.argv[1]?.endsWith('/provision-sandbox3-cp-agent-api.mjs')) {
  const evidence = { schemaVersion: 1, result: 'failed', runCreated: false, workerOrModelCalled: false };
  try {
    Object.assign(evidence, await provisionSandbox3CpAgentApi());
    evidence.result = 'passed';
  } catch (error) {
    evidence.failureCode = error instanceof Error && /^sandbox3_[a-z0-9:_-]+$/.test(error.message)
      ? error.message : 'sandbox3_cp_agent_api_provision_failed';
  } finally {
    if (OUTPUT) await writeFile(OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify(evidence));
  if (evidence.result !== 'passed') process.exitCode = 1;
}
