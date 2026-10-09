#!/usr/bin/env node
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import {
  TELEGRAM_UX_SANDBOX,
  TELEGRAM_UX_SANDBOX_CREDENTIALS,
  validateSandboxBuildSha,
  validateTelegramUxSandboxConfig,
} from '../src/deployment/telegram-ux-sandbox.ts';
import { commandFailureReason } from './command-failure.mjs';

const CP_URL = 'https://trained-assist-cp-telegram-ux-v1-sandbox.skillset-apply.workers.dev';
const RUNNER_PRINCIPAL_ID = 'integration-telegram-ux-v1-mock-test';
const RUNNER_PROFILE_ID = 'integration-telegram-ux-v1-mock-test';
const RUNNER_TENANT_ID = 'integration-telegram-ux-v1-mock-test';
const RUNNER_KEY_CONTEXT = 'trained-assist/agent-runner-api-mcp-test/integration-telegram-ux-v1-mock-test/v1';
const EVIDENCE_PATH = process.env.GITHUB_WORKSPACE
  ? join(process.env.GITHUB_WORKSPACE, 'sandbox-bootstrap-evidence.json')
  : join(process.cwd(), 'sandbox-bootstrap-evidence.json');

const evidence = {
  schemaVersion: 1,
  mode: 'bootstrap',
  outcome: 'failed',
  sourceSha: null,
  cloudflareAccountId: TELEGRAM_UX_SANDBOX.accountId,
  cpWorker: TELEGRAM_UX_SANDBOX.workerName,
  cpMockKeySecretName: TELEGRAM_UX_SANDBOX_CREDENTIALS.runnerMockKeyBinding,
  cpPrincipalSecretName: 'PRINCIPAL_SECRET_TELEGRAM_UX',
  runnerService: 'agent-runner-api-mcp-test.service',
  runnerPrincipalId: RUNNER_PRINCIPAL_ID,
  runnerProfileId: RUNNER_PROFILE_ID,
  runnerMockEngine: 'mock-test',
  boundaries: {
    sourceAndConfig: 'NOT_RUN',
    cloudflareAccount: 'NOT_RUN',
    sandboxPreDeployLiveness: 'NOT_RUN',
    sandboxMigrations: 'NOT_RUN',
    sandboxDeploy: 'NOT_RUN',
    sandboxPostDeployLiveness: 'NOT_RUN',
    runnerPrincipalProvisioning: 'NOT_RUN',
    cpMockKeySync: 'NOT_RUN',
    authenticatedCpToRunnerProbe: 'NOT_RUN',
    sandboxMigrationRead: 'NOT_RUN',
    runnerSshIdentity: 'NOT_RUN',
    authenticatedLaneReadiness: 'NOT_RUN',
    authenticatedProfileHealth: 'NOT_RUN',
  },
  probe: {
    httpStatus: null,
    runId: null,
    runnerState: null,
    answer: null,
    runnerOutcome: null,
    cpTaskCreated: false,
    workerOrModelCalled: false,
    runnerAdmissionPersisted: null,
  },
  secretValuesIncluded: false,
};

function fail(code) {
  throw new Error(code);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 180_000,
    ...options,
  });
  if (result.error || result.status !== 0) fail(commandFailureReason(command, result));
  return result.stdout ?? '';
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) fail(`required_environment_missing:${name}`);
  return value;
}

function deriveRunnerMockApiKey(seed) {
  if (new TextEncoder().encode(seed).length < 32) fail('runner_mock_key_seed_too_short');
  return `ta_mock_${createHmac('sha256', seed).update(RUNNER_KEY_CONTEXT).digest('base64url')}`;
}

function validateInputs(preflight = false) {
  const sourceSha = validateSandboxBuildSha(requiredEnv('GITHUB_SHA'));
  const accountId = TELEGRAM_UX_SANDBOX.accountId;
  process.env.CLOUDFLARE_API_TOKEN = requiredEnv('CF_API_TOKEN');
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
  const principalSecret = requiredEnv('CP_TELEGRAM_UX_PRINCIPAL_SECRET');
  if (new TextEncoder().encode(principalSecret).length < 32) fail('cp_principal_secret_invalid');
  const key = preflight ? null : deriveRunnerMockApiKey(requiredEnv('RUNNER_MOCK_KEY_SEED'));
  const privateKey = requiredEnv('VM2_SSH_PRIVATE_KEY');
  if (!privateKey.includes('PRIVATE KEY')) fail('vm2_ssh_private_key_invalid');
  return { sourceSha, accountId, principalSecret, key, privateKey };
}

async function verifyConfigAndAccount(accountId) {
  const config = JSON.parse(await readFile('wrangler.telegram-ux-v1.jsonc', 'utf8'));
  validateTelegramUxSandboxConfig(config);
  if (config.name !== TELEGRAM_UX_SANDBOX.workerName || config.workers_dev !== true) {
    fail('sandbox_worker_config_mismatch');
  }
  const output = capture('npx', ['wrangler', 'whoami']);
  if (!output.includes(accountId)) {
    fail('cloudflare_authenticated_account_mismatch');
  }
}

async function verifySandboxLiveness(expectedBuildSha = null) {
  let response;
  try {
    response = await fetch(`${CP_URL}/healthz`, { signal: AbortSignal.timeout(15_000) });
  } catch {
    fail('sandbox_worker_unreachable');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.service !== 'trained-assist-control-plane' || body.check !== 'liveness') {
    fail('sandbox_worker_liveness_failed');
  }
  if (typeof body.buildSha !== 'string' || !/^[a-f0-9]{40}$/.test(body.buildSha)) {
    fail('sandbox_worker_build_sha_missing');
  }
  evidence.cpDeployedSha = body.buildSha;
  if (expectedBuildSha && body.buildSha !== expectedBuildSha) fail('sandbox_worker_build_sha_mismatch');
}

function applySandboxMigrations() {
  capture('npx', ['wrangler', 'd1', 'migrations', 'apply', TELEGRAM_UX_SANDBOX.databaseName,
    '--remote', '--config', 'wrangler.telegram-ux-v1.jsonc']);
}

function deploySandbox(sourceSha) {
  capture('npx', ['wrangler', 'deploy', '--config', 'wrangler.telegram-ux-v1.jsonc', '--var', `BUILD_SHA:${sourceSha}`]);
}

async function provisionRunnerPrincipal(input) {
  return withRunnerSsh(input, (args) => {
    const request = JSON.stringify({ schemaVersion: 1, target: 'agent-runner-api-mcp-test',
      keyHash: createHash('sha256').update(input.key).digest('hex') });
    const stdout = capture('ssh', [...args,
      `sudo -n ${TELEGRAM_UX_SANDBOX_CREDENTIALS.runnerMockProvisioner}`], { input: request });
    let result;
    try { result = JSON.parse(stdout); } catch { fail('runner_provisioner_response_invalid'); }
    if (!['registered', 'already_registered'].includes(result.status)
      || result.principalId !== RUNNER_PRINCIPAL_ID
      || result.profileId !== RUNNER_PROFILE_ID
      || result.tenantId !== RUNNER_TENANT_ID) {
      fail('runner_provisioner_target_or_response_mismatch');
    }
  });
}

async function withRunnerSsh(input, operation) {
  const directory = await mkdtemp(join(tmpdir(), 'ta-runner-bootstrap-'));
  try {
    const keyPath = join(directory, 'id_ed25519');
    const knownHostsPath = join(directory, 'known_hosts');
    await writeFile(keyPath, input.privateKey.endsWith('\n') ? input.privateKey : `${input.privateKey}\n`, { mode: 0o600 });
    await writeFile(knownHostsPath, `${TELEGRAM_UX_SANDBOX_CREDENTIALS.vm2SshKnownHostEntry}\n`, { mode: 0o600 });
    return await operation([
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${knownHostsPath}`, '-o', 'ConnectTimeout=10',
      '-i', keyPath, `${TELEGRAM_UX_SANDBOX_CREDENTIALS.vm2SshUser}@${TELEGRAM_UX_SANDBOX_CREDENTIALS.vm2SshHost}`,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readSandboxMigrations() {
  const output = capture('npx', ['wrangler', 'd1', 'execute', TELEGRAM_UX_SANDBOX.databaseName,
    '--remote', '--config', 'wrangler.telegram-ux-v1.jsonc',
    '--command', 'SELECT name FROM d1_migrations', '--json']);
  let response;
  try { response = JSON.parse(output); } catch { fail('sandbox_migration_read_response_invalid'); }
  if (!Array.isArray(response) || response.length !== 1 || response[0]?.success !== true
    || !Array.isArray(response[0].results)) fail('sandbox_migration_read_response_invalid');
  const expected = (await readdir('migrations')).filter(name => name.endsWith('.sql'));
  const applied = response[0].results.map(row => row?.name);
  if (applied.some(name => typeof name !== 'string' || !expected.includes(name))) {
    fail('sandbox_migration_source_mismatch');
  }
  evidence.pendingMigrationCount = expected.filter(name => !applied.includes(name)).length;
}

async function readAuthenticatedBoundary(path, secret) {
  const signature = createHmac('sha256', secret).update(TELEGRAM_UX_SANDBOX.principalId).digest('hex');
  let response;
  try {
    response = await fetch(`${CP_URL}${path}`, {
      headers: { 'x-principal': TELEGRAM_UX_SANDBOX.principalId, 'x-principal-sig': signature },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
  } catch { fail('sandbox_authenticated_read_unreachable'); }
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function preflight(input, setStage) {
  const failures = [];
  const check = async (boundary, probe) => {
    setStage(boundary);
    try {
      await probe();
      evidence.boundaries[boundary] = 'PASS';
    } catch (error) {
      evidence.boundaries[boundary] = 'BLOCKED';
      failures.push({ boundary, reasonCode: error instanceof Error
        && /^[a-z][a-z0-9:_-]{1,100}$/.test(error.message) ? error.message : 'sandbox_preflight_failed' });
    }
  };
  await check('sandboxMigrationRead', async () => {
    await readSandboxMigrations();
    if (evidence.pendingMigrationCount > 0) fail('sandbox_pending_migrations');
  });
  await check('runnerSshIdentity', () => withRunnerSsh(input, (args) => {
    const hostname = capture('ssh', [...args, 'hostname -s']).trim();
    if (hostname !== 'vmi3617957') fail('runner_ssh_host_identity_mismatch');
  }));
  await check('authenticatedLaneReadiness', async () => {
    const lane = await readAuthenticatedBoundary('/internal/sandbox/readiness', input.principalSecret);
    const occupied = lane.status === 409 && lane.body.reasonCode === 'sandbox_lane_has_nonterminal_task';
    if (!(lane.status === 200 && lane.body.ok === true) && !occupied) fail('sandbox_lane_readiness_failed');
    if (lane.body.principalId !== TELEGRAM_UX_SANDBOX.principalId
      || lane.body.profileId !== TELEGRAM_UX_SANDBOX.principalId) fail('sandbox_lane_identity_mismatch');
    if (!Number.isSafeInteger(lane.body.nonterminalTaskCount) || lane.body.nonterminalTaskCount < 0) {
      fail('sandbox_lane_readiness_response_invalid');
    }
    evidence.nonterminalTaskCount = lane.body.nonterminalTaskCount;
    if (occupied || evidence.nonterminalTaskCount > 0) fail('sandbox_lane_has_nonterminal_task');
  });
  await check('authenticatedProfileHealth', async () => {
    const health = await readAuthenticatedBoundary('/internal/runner/profile-health', input.principalSecret);
    if (health.status !== 200 || health.body.runnerApi !== 'reachable'
      || health.body.profileId !== TELEGRAM_UX_SANDBOX.principalId) fail('sandbox_profile_runner_not_ready');
  });
  evidence.boundaryFailures = failures;
  if (failures.length) {
    setStage(failures[0].boundary);
    fail(failures[0].reasonCode);
  }
  evidence.outcome = 'preflight_passed';
}

function syncCpMockKey(key) {
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', TELEGRAM_UX_SANDBOX_CREDENTIALS.runnerMockKeyBinding,
    '--config', 'wrangler.telegram-ux-v1.jsonc'], {
    input: key,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) fail(commandFailureReason('npx', result));
}

async function authenticatedProbe(secret) {
  const signature = createHmac('sha256', secret).update(TELEGRAM_UX_SANDBOX.principalId).digest('hex');
  let response;
  try {
    response = await fetch(`${CP_URL}/internal/sandbox/runner-mock-probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-principal': TELEGRAM_UX_SANDBOX.principalId,
        'x-principal-sig': signature, 'cache-control': 'no-store' },
      body: '{}',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail('authenticated_cp_runner_probe_unreachable');
  }
  const body = await response.json().catch(() => ({}));
  evidence.probe.httpStatus = response.status;
  evidence.probe.runId = typeof body.runId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(body.runId) ? body.runId : null;
  evidence.probe.runnerState = typeof body.runnerState === 'string' ? body.runnerState : null;
  evidence.probe.answer = body.answer === 'pong' ? 'pong' : null;
  evidence.probe.runnerOutcome = typeof body.runnerOutcome === 'string' ? body.runnerOutcome : null;
  evidence.probe.runnerAdmissionPersisted = body.sideEffects?.runnerAdmissionPersisted === true;
  if (!response.ok || body.ok !== true || body.runnerState !== 'succeeded' || body.answer !== 'pong'
    || body.runnerOutcome !== 'succeeded' || evidence.probe.runnerAdmissionPersisted !== true
    || body.sideEffects?.cpTaskCreated !== false || body.sideEffects?.workerOrModelCalled !== false) {
    fail('authenticated_cp_runner_probe_failed');
  }
}

async function writeEvidence() {
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  let stage = 'sourceAndConfig';
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && !['--preflight', '--bootstrap'].includes(args[0]))) {
      fail('sandbox_bootstrap_mode_invalid');
    }
    const readOnly = args[0] === '--preflight';
    evidence.mode = readOnly ? 'preflight' : 'bootstrap';
    const input = validateInputs(readOnly);
    evidence.sourceSha = input.sourceSha;
    const config = JSON.parse(await readFile('wrangler.telegram-ux-v1.jsonc', 'utf8'));
    validateTelegramUxSandboxConfig(config);
    if (config.name !== TELEGRAM_UX_SANDBOX.workerName || config.workers_dev !== true) {
      fail('sandbox_worker_config_mismatch');
    }
    evidence.boundaries.sourceAndConfig = 'PASS';

    stage = 'cloudflareAccount';
    await verifyConfigAndAccount(input.accountId);
    evidence.boundaries.cloudflareAccount = 'PASS';

    stage = 'sandboxPreDeployLiveness';
    await verifySandboxLiveness();
    evidence.boundaries.sandboxPreDeployLiveness = 'PASS';

    if (readOnly) {
      await preflight(input, value => { stage = value; });
    } else {
      stage = 'sandboxMigrations';
      applySandboxMigrations();
      evidence.boundaries.sandboxMigrations = 'PASS';

      stage = 'sandboxDeploy';
      deploySandbox(input.sourceSha);
      evidence.boundaries.sandboxDeploy = 'PASS';

      stage = 'sandboxPostDeployLiveness';
      await verifySandboxLiveness(input.sourceSha);
      evidence.boundaries.sandboxPostDeployLiveness = 'PASS';

      stage = 'runnerPrincipalProvisioning';
      await provisionRunnerPrincipal(input);
      evidence.boundaries.runnerPrincipalProvisioning = 'PASS';

      stage = 'cpMockKeySync';
      syncCpMockKey(input.key);
      evidence.boundaries.cpMockKeySync = 'PASS';

      stage = 'authenticatedCpToRunnerProbe';
      await authenticatedProbe(input.principalSecret);
      evidence.boundaries.authenticatedCpToRunnerProbe = 'PASS';
      evidence.outcome = 'passed';
    }
  } catch (error) {
    evidence.failure = {
      boundary: stage,
      reasonCode: error instanceof Error && /^[a-z][a-z0-9:_-]{1,100}$/.test(error.message)
        ? error.message : 'sandbox_bootstrap_failed',
    };
  } finally {
    await writeEvidence();
  }
  console.log(JSON.stringify({ outcome: evidence.outcome, sourceSha: evidence.sourceSha,
    boundaries: evidence.boundaries, failure: evidence.failure ?? null }));
  if (!['passed', 'preflight_passed'].includes(evidence.outcome)) process.exitCode = 1;
}

main().catch(async () => {
  evidence.failure = { boundary: 'evidence', reasonCode: 'sandbox_evidence_write_failed' };
  try { await writeEvidence(); } catch { /* The workflow will fail without emitting credential data. */ }
  process.exitCode = 1;
});
