#!/usr/bin/env node
import { sandbox3OperatorSecret, verifySandbox3PairingBindings, verifySandbox3OperatorPrincipal } from './sandbox3-cp-pairing.mjs';
import { sandbox3CpProbeRequest } from './sandbox3-cp-probe-request.mjs';
import { SANDBOX3 } from '../src/deployment/sandbox3.ts';
import { isRunnerRunId } from '../src/runner-adapter/run-id.ts';
import { verifySandbox3PublicRoute, verifySandbox3RunnerPrincipal, waitForSandbox3RunnerPrincipal } from './sandbox3-public-route.mjs';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import {
  TELEGRAM_UX_SANDBOX,
  TELEGRAM_UX_SANDBOX_CREDENTIALS,
  validateSandboxBuildSha,
  validateTelegramUxSandboxConfig,
} from '../src/deployment/telegram-ux-sandbox.ts';
import { commandFailureReason } from './command-failure.mjs';
import { sanitizedRunnerInventory, sanitizedRunnerPermissions, sanitizedRunnerFileMetadata, sanitizedSandbox3Namespace, sanitizedSandbox3Probe, sanitizedSandbox3ProxyConfiguration, sandbox3Credentials, verifiedSandboxScript } from './verified-sandbox-script.mjs';

const SANDBOX3_CP_URL = 'https://trained-assist-cp-sandbox3.skillset-apply.workers.dev';
const CP_URL = 'https://trained-assist-cp-telegram-ux-v1-sandbox.skillset-apply.workers.dev';
const RUNNER_PRINCIPAL_ID = 'integration-telegram-ux-v1-mock-test';
const RUNNER_PROFILE_ID = 'integration-telegram-ux-v1-mock-test';
const RUNNER_TENANT_ID = 'integration-telegram-ux-v1-mock-test';
const RUNNER_KEY_CONTEXT = 'trained-assist/runner-api-cp-sandbox3/integration-telegram-ux-v1-mock-test/v1';
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
  runnerService: TELEGRAM_UX_SANDBOX.runnerMockTestWorker,
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
    runnerAdmissionInventory: 'NOT_RUN',
    runnerInventoryPermissions: 'NOT_RUN',
    runnerCandidateVerification: 'NOT_RUN',
    sandbox3OperatorInventory: 'NOT_RUN',
    sandbox3ProxyInspection: 'NOT_RUN',
    sandbox3ProxyConfiguration: 'NOT_RUN',
    sandbox3NativeConfiguration: 'NOT_RUN',
    sandbox3PublicRoute: 'NOT_RUN',
    sandbox3CpCredentialPairing: 'NOT_RUN',
    sandbox3RunnerCredentialSync: 'NOT_RUN',
    sandbox3CpMockContract: 'NOT_RUN',
    sandbox3MockContract: 'NOT_RUN',
    sandbox3NamespacePreparation: 'NOT_RUN',
    sandbox3CandidateInstallation: 'NOT_RUN',
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

function validateInputs(preflight = false, freshSandbox3 = false, requiresVmOperator = true) {
  const sourceSha = validateSandboxBuildSha(requiredEnv('GITHUB_SHA'));
  const accountId = TELEGRAM_UX_SANDBOX.accountId;
  process.env.CLOUDFLARE_API_TOKEN = requiredEnv('CF_API_TOKEN');
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
  const principalSecret = freshSandbox3 ? null : requiredEnv('CP_TELEGRAM_UX_PRINCIPAL_SECRET');
  if (!freshSandbox3 && new TextEncoder().encode(principalSecret).length < 32) fail('cp_principal_secret_invalid');
  const key = preflight || freshSandbox3 ? null : deriveRunnerMockApiKey(requiredEnv('RUNNER_MOCK_KEY_SEED'));
  const privateKey = requiresVmOperator ? requiredEnv('VM2_SSH_PRIVATE_KEY') : null;
  if (privateKey && !privateKey.includes('PRIVATE KEY')) fail('vm2_ssh_private_key_invalid');
  return { sourceSha, accountId, principalSecret, key, privateKey };
}

async function verifyConfigAndAccount(accountId, freshSandbox3 = false) {
  const config = JSON.parse(await readFile(freshSandbox3 ? 'wrangler.sandbox3.jsonc' : 'wrangler.telegram-ux-v1.jsonc', 'utf8'));
  if (freshSandbox3) validateSandbox3Config(config);
  else validateTelegramUxSandboxConfig(config);
  if (!freshSandbox3 && (config.name !== TELEGRAM_UX_SANDBOX.workerName || config.workers_dev !== true)) {
    fail('sandbox_worker_config_mismatch');
  }
  const output = capture('npx', ['wrangler', 'whoami']);
  if (!output.includes(accountId)) {
    fail('cloudflare_authenticated_account_mismatch');
  }
}

async function verifySandboxLiveness(expectedBuildSha = null, baseUrl = CP_URL) {
  let response;
  try {
    response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(15_000) });
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
  const registry = JSON.stringify([{
    keyHash: createHash('sha256').update(input.key).digest('hex'),
    principalId: RUNNER_PRINCIPAL_ID,
    tenantId: RUNNER_TENANT_ID,
    profileId: RUNNER_PROFILE_ID,
    scopes: ['runs:read', 'runs:write'],
    engines: ['mock-test'],
  }]);
  capture('npx', ['wrangler', 'secret', 'put', TELEGRAM_UX_SANDBOX_CREDENTIALS.runnerMockRegistryBinding,
    '--name', TELEGRAM_UX_SANDBOX.runnerMockTestWorker], { input: registry });
  await waitForSandbox3RunnerPrincipal(input.key);
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

async function executeVerifiedRunnerHelper(input, source, filename, digest, command, prefix) {
  const script = await verifiedSandboxScript(
    `https://raw.githubusercontent.com/trained-assist/ai-agent-runner/${source}/scripts/${filename}`, digest);
  return withRunnerSsh(input, (args) => {
    const result = spawnSync('ssh', [...args, command], {
      input: script, encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 30_000,
    });
    if (result.error) fail(commandFailureReason('ssh', result));
    let body;
    try { body = JSON.parse(result.stdout); } catch {
      fail(result.status === 0 ? `runner_${prefix}_response_invalid` : commandFailureReason('ssh', result));
    }
    if (prefix === 'inventory' && body?.schemaVersion === 1
      && body.target === 'agent-runner-api-mcp-test' && body.fileMetadata != null) {
      evidence.runnerFileMetadata = sanitizedRunnerFileMetadata(body.fileMetadata);
    }
    if (result.status !== 0) {
      // Reasons originate from the byte-verified helper, never raw SSH output.
      if (body?.schemaVersion === 1 && body.target === 'agent-runner-api-mcp-test'
        && typeof body.reasonCode === 'string'
        && new RegExp(`^sandbox_${prefix}_[a-z_]{1,60}$`).test(body.reasonCode)) fail(body.reasonCode);
      fail(commandFailureReason('ssh', result));
    }
    return body;
  });
}

async function readRunnerInventory(input) {
  const source = TELEGRAM_UX_SANDBOX_CREDENTIALS.runnerInventorySourceSha;
  const body = await executeVerifiedRunnerHelper(input, source, 'inspect-api-sandbox.py',
    TELEGRAM_UX_SANDBOX_CREDENTIALS.runnerInventoryScriptSha256,
    'sudo -n python3 - --inventory', 'inventory');
  evidence.runnerInventory = sanitizedRunnerInventory(body);
  evidence.runnerInventoryInspectorSha = source;
  if (!evidence.runnerInventory.journalTerminalOnly) fail('runner_admissions_unresolved');
}

async function restrictRunnerPermissions(input) {
  const source = TELEGRAM_UX_SANDBOX_CREDENTIALS.runnerPermissionsSourceSha;
  const body = await executeVerifiedRunnerHelper(input, source, 'restrict-api-sandbox-permissions.py',
    TELEGRAM_UX_SANDBOX_CREDENTIALS.runnerPermissionsScriptSha256,
    'sudo -n python3 - --restrict', 'permissions');
  evidence.runnerPermissions = sanitizedRunnerPermissions(body);
  evidence.runnerPermissionsOperatorSha = source;
}

async function verifyRunnerCandidate(operation = null) {
  const credentials = TELEGRAM_UX_SANDBOX_CREDENTIALS;
  const directory = await mkdtemp(join(tmpdir(), 'ta-runner-candidate-'));
  try {
    const repository = 'trained-assist/ai-agent-runner';
    let run;
    try { run = JSON.parse(capture('gh', ['run', 'view', credentials.runnerCandidateRunId,
      '--repo', repository, '--json', 'conclusion,workflowName'])); } catch (error) {
      if (error instanceof SyntaxError) fail('runner_candidate_run_response_invalid');
      throw error;
    }
    if (run.conclusion !== 'success' || run.workflowName !== 'Runner API sandbox candidate') {
      fail('runner_candidate_run_not_verified');
    }
    capture('gh', ['run', 'download', credentials.runnerCandidateRunId, '--repo', repository,
      '--name', `runner-api-sandbox-candidate-${credentials.runnerCandidateSourceSha}`, '--dir', directory]);
    const archive = join(directory, 'runner-api-sandbox-candidate.tar.gz');
    if ((await stat(archive)).size > 64 * 1024 * 1024) fail('runner_candidate_archive_too_large');
    if (createHash('sha256').update(await readFile(archive)).digest('hex') !== credentials.runnerCandidateBundleSha256) {
      fail('runner_candidate_digest_mismatch');
    }
    capture('gh', ['attestation', 'verify', archive, '--repo', repository,
      '--signer-workflow', `${repository}/.github/workflows/runner-api-sandbox-candidate.yml`]);
    let manifest;
    try { manifest = JSON.parse(capture('tar', ['-xOf', archive, 'candidate-manifest.json'])); } catch {
      fail('runner_candidate_manifest_invalid');
    }
    if (manifest.target !== 'agent-runner-api-mcp-test'
      || manifest.sourceSha !== credentials.runnerCandidateSourceSha || manifest.packageVersion !== '0.3.3') {
      fail('runner_candidate_manifest_mismatch');
    }
    evidence.runnerCandidate = { runId: credentials.runnerCandidateRunId,
      sourceSha: credentials.runnerCandidateSourceSha, bundleSha256: credentials.runnerCandidateBundleSha256,
      artifactTarget: 'agent-runner-api-mcp-test', attestation: 'PASS', installed: false };
    if (operation) await operation(archive);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function validateSandbox3Config(config) {
  if (config.name !== 'trained-assist-cp-sandbox3' || config.workers_dev !== true
    || config.d1_databases?.length !== 1 || config.d1_databases[0].binding !== 'DB'
    || config.d1_databases[0].database_id !== '1e1b8108-9186-43e2-8e50-436598233165'
    || config.workflows?.length !== 1 || config.workflows[0].name !== 'ta-cp-sandbox3-task-workflow'
    || config.workflows[0].binding !== 'TASK_WORKFLOW') fail('sandbox3_bootstrap_config_mismatch');
}

const shellQuote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;

async function sandbox3Script(filename, digest) {
  return verifiedSandboxScript(
    `https://raw.githubusercontent.com/trained-assist/ai-agent-runner/${TELEGRAM_UX_SANDBOX_CREDENTIALS.sandbox3OperatorSourceSha}/scripts/${filename}`, digest);
}

function sandbox3Response(result) {
  if (result.error) fail(commandFailureReason('ssh', result));
  let body;
  try { body = JSON.parse(result.stdout); } catch { fail('sandbox3_operator_response_invalid'); }
  if (body?.schemaVersion !== 1 || body.target !== 'agent-runner-api-sandbox3') fail('sandbox3_operator_response_invalid');
  if (result.status !== 0) {
    if (typeof body.reasonCode === 'string' && /^sandbox3_(prepare|probe|proxy|native)_[a-z_]{1,70}$/.test(body.reasonCode)) fail(body.reasonCode);
    fail(commandFailureReason('ssh', result));
  }
  return body;
}

async function inspectSandbox3(input) {
  const script = await sandbox3Script('prepare-api-sandbox3.py', TELEGRAM_UX_SANDBOX_CREDENTIALS.sandbox3PreparerDigest);
  const body = await withRunnerSsh(input, args => sandbox3Response(spawnSync('ssh', [...args,
    `sudo -n python3 -c ${shellQuote(script.toString('utf8'))} --inspect`], {
    encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 60_000,
  })));
  const metadata = sanitizedSandbox3Namespace(body);
  evidence.sandbox3Namespace = metadata;
  evidence.sandbox3OperatorSourceSha = TELEGRAM_UX_SANDBOX_CREDENTIALS.sandbox3OperatorSourceSha;
  return metadata;
}

async function probeSandbox3(input, mock) {
  const script = await sandbox3Script('prepare-api-sandbox3.py', TELEGRAM_UX_SANDBOX_CREDENTIALS.sandbox3PreparerDigest);
  const payload = mock ? JSON.stringify({ schemaVersion: 1, target: 'agent-runner-api-sandbox3',
    apiKey: sandbox3Credentials(requiredEnv('RUNNER_MOCK_KEY_SEED')).apiKey }) : undefined;
  const body = await withRunnerSsh(input, args => sandbox3Response(spawnSync('ssh', [...args,
    `sudo -n python3 -c ${shellQuote(script.toString('utf8'))} ${mock ? '--mock-probe' : '--proxy-inspect'}`], {
    input: payload, encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 60_000,
  })));
  evidence[mock ? 'sandbox3MockContract' : 'sandbox3ProxyInspection'] = sanitizedSandbox3Probe(body, mock ? 'mock' : 'proxy');
  evidence.sandbox3OperatorSourceSha = TELEGRAM_UX_SANDBOX_CREDENTIALS.sandbox3OperatorSourceSha;
}

async function configureSandbox3Proxy(input) {
  const script = await sandbox3Script('prepare-api-sandbox3.py', TELEGRAM_UX_SANDBOX_CREDENTIALS.sandbox3PreparerDigest);
  const body = await withRunnerSsh(input, args => sandbox3Response(spawnSync('ssh', [...args,
    `sudo -n python3 -c ${shellQuote(script.toString('utf8'))} --configure-proxy`], {
    encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 60_000,
  })));
  evidence.sandbox3ProxyConfiguration = sanitizedSandbox3ProxyConfiguration(body);
  evidence.sandbox3OperatorSourceSha = TELEGRAM_UX_SANDBOX_CREDENTIALS.sandbox3OperatorSourceSha;
}

async function sandbox3CpSettings(input) {
  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/scripts/${SANDBOX3.workerName}/settings`, {
      headers: { authorization: `Bearer ${requiredEnv('CF_API_TOKEN')}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    if (response.status !== 200 || body.success !== true || !Array.isArray(body.result?.bindings)) fail('sandbox3_cp_settings_unavailable');
    return body.result.bindings;
  } catch { fail('sandbox3_cp_settings_unavailable'); }
}

function sandbox3PrincipalQuery(sql) {
  let body;
  try { body = JSON.parse(capture('npx', ['wrangler', 'd1', 'execute', 'ta-sandbox3-taskstore',
    '--config', 'wrangler.sandbox3.jsonc', '--remote', '--json', '--command', sql])); }
  catch (error) { if (error instanceof SyntaxError) fail('sandbox3_cp_principal_query_invalid'); throw error; }
  if (!Array.isArray(body) || body.length !== 1 || body[0].success !== true || !Array.isArray(body[0].results)) fail('sandbox3_cp_principal_query_invalid');
  return body[0].results;
}

async function pairSandbox3Cp(input) {
  if (evidence.cpDeployedSha !== input.sourceSha) fail('sandbox3_cp_deployed_source_mismatch');
  const seed = requiredEnv('RUNNER_MOCK_KEY_SEED');
  const keys = sandbox3Credentials(seed);
  const secrets = { RUNNER_API_KEY_AGENT_API: keys.apiKey, RUNNER_PROFILE_DELEGATION_SECRET: keys.delegationSecret,
    PRINCIPAL_SECRET_SANDBOX3_OPS: sandbox3OperatorSecret(seed) };
  verifySandbox3PairingBindings(await sandbox3CpSettings(input));
  evidence.sandbox3PublicRoute = await verifySandbox3PublicRoute();
  const runnerKeyRegistry = JSON.stringify([{ keyHash: createHash('sha256').update(keys.apiKey).digest('hex'),
    principalId: SANDBOX3.diagnosticPrincipalId, profileId: SANDBOX3.profileId,
    scopes: ['runs:read', 'runs:write'], engines: ['mock-test'] }]);
  capture('npx', ['wrangler', 'secret', 'put', 'RUNNER_API_KEYS', '--name', SANDBOX3.runnerWorkerName], { input: runnerKeyRegistry });
  evidence.sandbox3RunnerCredentialSync = { credentialsSynced: true, workerName: SANDBOX3.runnerWorkerName,
    principalId: SANDBOX3.diagnosticPrincipalId, profileId: SANDBOX3.profileId, scopes: ['runs:read', 'runs:write'], engines: ['mock-test'] };
  evidence.boundaries.sandbox3RunnerCredentialSync = 'PASS';
  await waitForSandbox3RunnerPrincipal(keys.apiKey);
  const principalSql = `SELECT profile_id, scopes, enabled FROM admission_principals WHERE principal_id = '${SANDBOX3.diagnosticPrincipalId}'`;
  let rows = sandbox3PrincipalQuery(principalSql);
  if (rows.length > 1) fail('sandbox3_cp_operator_principal_invalid');
  if (rows.length === 1) verifySandbox3OperatorPrincipal(rows[0]);
  else {
    const now = Date.now();
    sandbox3PrincipalQuery(`INSERT INTO admission_principals (principal_id, profile_id, scopes, enabled, created_at, updated_at) VALUES ('${SANDBOX3.diagnosticPrincipalId}', '${SANDBOX3.profileId}', '["tasks:read"]', 1, ${now}, ${now})`);
    rows = sandbox3PrincipalQuery(principalSql);
    if (rows.length !== 1) fail('sandbox3_cp_operator_principal_invalid');
    verifySandbox3OperatorPrincipal(rows[0]);
  }
  evidence.sandbox3CpSecretNamesWritten = [];
  for (const [name, value] of Object.entries(secrets)) {
    capture('npx', ['wrangler', 'secret', 'put', name, '--config', 'wrangler.sandbox3.jsonc'], { input: value });
    evidence.sandbox3CpSecretNamesWritten.push(name);
  }
  evidence.sandbox3CpPairing = { credentialsSynced: true, diagnosticPrincipalId: SANDBOX3.diagnosticPrincipalId,
    profileId: SANDBOX3.profileId, scopes: ['tasks:read'], intakeCredentialChanged: false, realExecutionEnabled: false };
}

async function probeSandbox3Cp(input) {
  if (evidence.cpDeployedSha !== input.sourceSha) fail('sandbox3_cp_deployed_source_mismatch');
  const secret = sandbox3OperatorSecret(requiredEnv('RUNNER_MOCK_KEY_SEED'));
  const signature = createHmac('sha256', secret).update(SANDBOX3.diagnosticPrincipalId).digest('hex');
  let response, body;
  try {
    ({ response, body } = await sandbox3CpProbeRequest(`${SANDBOX3_CP_URL}/internal/sandbox/runner-mock-probe`, {
      method: 'POST', body: '{}', redirect: 'error', headers: {
        'content-type': 'application/json', 'x-principal': SANDBOX3.diagnosticPrincipalId, 'x-principal-sig': signature,
      },
    }));
  } catch { fail('sandbox3_cp_mock_probe_unreachable'); }
  evidence.sandbox3CpMockHttpStatus = response.status;
  if (response.status !== 200 || body.ok !== true) {
    const safeCode = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(value) ? value : null;
    const safeRunnerCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : null;
    const reachability = body?.runnerReachability;
    evidence.sandbox3CpMockFailure = {
      reasonCode: safeCode(body?.reasonCode),
      runnerErrorCode: safeRunnerCode(body?.runnerErrorCode),
      runnerReachability: reachability && typeof reachability === 'object' ? {
        outcome: ['reachable_auth_required', 'http_response', 'fetch_failed'].includes(reachability.outcome) ? reachability.outcome : null,
        httpStatus: Number.isInteger(reachability.httpStatus) && reachability.httpStatus >= 100 && reachability.httpStatus <= 599 ? reachability.httpStatus : null,
      } : null,
      runnerAdmissionMayBePersisted: body?.sideEffects?.runnerAdmissionMayBePersisted === true,
    };
    fail('sandbox3_cp_mock_probe_failed');
  }
  if (response.status !== 200 || body.ok !== true || body.principalId !== SANDBOX3.diagnosticPrincipalId || body.buildSha !== input.sourceSha
    || body.answer !== 'pong' || body.runnerState !== 'succeeded' || body.runnerOutcome !== 'succeeded'
    || body.sideEffects?.cpTaskCreated !== false || body.sideEffects?.workerOrModelCalled !== false
    || body.sideEffects?.runnerAdmissionPersisted !== true || typeof body.runId !== 'string'
    || !isRunnerRunId(body.runId)) fail('sandbox3_cp_mock_probe_failed');
  evidence.sandbox3CpMockContract = { runId: body.runId, runnerState: 'succeeded', answer: 'pong',
    runnerOutcome: 'succeeded', cpTaskCreated: false, workerOrModelCalled: false, realTelegramE2E: false };
}

async function withSandbox3Transport(input, files, operation) {
  const localDirectory = await mkdtemp(join(tmpdir(), 'ta-sandbox3-operator-'));
  try {
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(localDirectory, name), bytes, { mode: 0o600 });
    return await withRunnerSsh(input, async args => {
      const remoteDirectory = capture('ssh', [...args, 'mktemp -d /tmp/ta-sandbox3-operator.XXXXXX']).trim();
      if (!/^\/tmp\/ta-sandbox3-operator\.[A-Za-z0-9]{6,20}$/.test(remoteDirectory)) fail('sandbox3_operator_temp_path_invalid');
      try {
        for (const name of Object.keys(files)) {
          capture('scp', [...args.slice(0, -1), join(localDirectory, name), `${args.at(-1)}:${remoteDirectory}/${name}`]);
        }
        return await operation(args, remoteDirectory);
      } finally {
        capture('ssh', [...args, `rm -rf -- ${shellQuote(remoteDirectory)}`]);
      }
    });
  } finally { await rm(localDirectory, { recursive: true, force: true }); }
}

async function configureSandbox3Native(input) {
  const bindings = await sandbox3CpSettings(input);
  for (const [name, value] of Object.entries({ PREVIEW_ONLY: 'true', PILOT_ENABLED: 'false', ROUTER_AGENT_ALLOWED: 'false' })) {
    if (bindings.find(binding => binding.name === name)?.text !== value) fail('sandbox3_cp_execution_not_disabled');
  }
  const workerSha = requiredEnv('SANDBOX3_NATIVE_WORKER_SHA');
  if (!/^[a-f0-9]{40}$/.test(workerSha)) fail('sandbox3_native_source_invalid');
  let storageCredentials;
  try { storageCredentials = JSON.parse(requiredEnv('SANDBOX3_GCS_CREDENTIALS')); }
  catch { fail('sandbox3_native_storage_credential_invalid'); }
  const request = JSON.stringify({ schemaVersion: 1, target: 'agent-runner-api-sandbox3',
    workerSha, workerToken: requiredEnv('SANDBOX3_NATIVE_WORKER_TOKEN'),
    profileGitHubToken: requiredEnv('SANDBOX3_PROFILE_GITHUB_TOKEN'),
    storageBucket: requiredEnv('SANDBOX3_GCS_BUCKET'), storageCredentials });
  const credentials = TELEGRAM_UX_SANDBOX_CREDENTIALS;
  const preparer = await sandbox3Script('prepare-api-sandbox3.py', credentials.sandbox3PreparerDigest);
  const checker = await sandbox3Script('check-api-sandbox-journal.py', credentials.sandbox3JournalCheckerDigest);
  await withSandbox3Transport(input, { 'prepare.py': preparer, 'check-api-sandbox-journal.py': checker }, async (args, directory) => {
    const body = sandbox3Response(spawnSync('ssh', [...args,
      `sudo -n python3 ${shellQuote(`${directory}/prepare.py`)} --configure-native`], {
      input: request, encoding: 'utf8', maxBuffer: 65536, timeout: 150_000,
    }));
    if (body.nativeConfigured !== true || body.admissionFenceDrained !== true
      || body.runtimeSourceSha !== credentials.runnerCandidateSourceSha || body.workerSourceSha !== workerSha
      || body.oldSharedServiceChanged !== false || body.modelCalled !== false || body.realTelegramE2E !== false) {
      fail('sandbox3_native_response_invalid');
    }
    evidence.sandbox3NativeConfiguration = { nativeConfigured: true, admissionFenceDrained: true,
      runtimeSourceSha: body.runtimeSourceSha, workerSourceSha: workerSha,
      oldSharedServiceChanged: false, modelCalled: false, realTelegramE2E: false };
  });
}

async function prepareSandbox3(input) {
  const credentials = TELEGRAM_UX_SANDBOX_CREDENTIALS;
  const bootstrap = await sandbox3Script('bootstrap-api-sandbox-lane.sh', credentials.sandbox3BootstrapDigest);
  const preparer = await sandbox3Script('prepare-api-sandbox3.py', credentials.sandbox3PreparerDigest);
  const keys = sandbox3Credentials(requiredEnv('RUNNER_MOCK_KEY_SEED'));
  const request = JSON.stringify({ schemaVersion: 1, target: 'agent-runner-api-sandbox3',
    keyHash: createHash('sha256').update(keys.apiKey).digest('hex'), delegationSecret: keys.delegationSecret });
  await withSandbox3Transport(input, { 'bootstrap.sh': bootstrap, 'prepare.py': preparer }, async (args, directory) => {
    const body = sandbox3Response(spawnSync('ssh', [...args,
      `sudo -n bash ${shellQuote(`${directory}/bootstrap.sh`)} --contract-sandbox3 ${shellQuote(`${directory}/prepare.py`)} --prepare`], {
      input: request, encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 60_000,
    }));
    if (body.namespacePrepared !== true || body.serviceStarted !== false || body.realExecutionEnabled !== false) {
      fail('sandbox3_operator_response_invalid');
    }
    evidence.sandbox3Preparation = { namespacePrepared: true, serviceStarted: false,
      realExecutionEnabled: false, cpCredentialsSynced: false };
    evidence.sandbox3OperatorSourceSha = credentials.sandbox3OperatorSourceSha;
  });
}

async function installSandbox3(input, archive) {
  const credentials = TELEGRAM_UX_SANDBOX_CREDENTIALS;
  const installer = await sandbox3Script('install-api-sandbox-lane-candidate.sh', credentials.sandbox3InstallerDigest);
  const checker = await sandbox3Script('check-api-sandbox-journal.py', credentials.sandbox3JournalCheckerDigest);
  await withSandbox3Transport(input, { 'install.sh': installer, 'journal-check.py': checker,
    'candidate.tar.gz': await readFile(archive) }, async (args, directory) => {
    capture('ssh', [...args, `sudo -n bash ${shellQuote(`${directory}/install.sh`)} sandbox3 ${credentials.runnerCandidateSourceSha} ${credentials.runnerCandidateBundleSha256} ${shellQuote(`${directory}/candidate.tar.gz`)} ${shellQuote(`${directory}/journal-check.py`)} --existing-mcp-runtime`], { timeout: 240_000 });
  });
  const state = await inspectSandbox3(input);
  if (!state.serviceActive || !state.serviceExecSourceVerified || state.runtimeSourceSha !== credentials.runnerCandidateSourceSha) {
    fail('sandbox3_installed_source_not_verified');
  }
  evidence.runnerCandidate.installed = true;
  evidence.sandbox3Installation = { target: 'agent-runner-api-sandbox3',
    sourceSha: state.runtimeSourceSha, activeProcessSourceVerified: true, cpCredentialsSynced: false,
    realExecutionVerified: false, publicRouteVerified: false };
}

async function preflight(input, setStage, { includeRunnerInventory = false, repairPermissions = false, candidateVerification = false } = {}) {
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
  if (repairPermissions) {
    await check('runnerInventoryPermissions', () => restrictRunnerPermissions(input));
  }
  if (includeRunnerInventory) {
    await check('runnerAdmissionInventory', () => readRunnerInventory(input));
  }
  if (candidateVerification) {
    await check('runnerCandidateVerification', () => verifyRunnerCandidate());
  }
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
    if (args.length > 1 || (args.length === 1 && !['--preflight', '--inventory', '--repair-permissions', '--candidate-preflight', '--sandbox3-public-preflight', '--pair-sandbox3-cp', '--sandbox3-cp-mock-probe', '--bootstrap'].includes(args[0]))) {
      fail('sandbox_bootstrap_mode_invalid');
    }
    const freshSandbox3 = ['--sandbox3-public-preflight', '--pair-sandbox3-cp', '--sandbox3-cp-mock-probe'].includes(args[0]);
    const diagnosticMode = ['--preflight', '--inventory', '--repair-permissions', '--candidate-preflight'].includes(args[0]);
    const requiresVmOperator = !freshSandbox3 && args[0] !== '--bootstrap';
    evidence.mode = diagnosticMode || freshSandbox3 ? args[0].slice(2) : 'bootstrap';
    const input = validateInputs(diagnosticMode || freshSandbox3, freshSandbox3, requiresVmOperator);
    evidence.sourceSha = input.sourceSha;
    const config = JSON.parse(await readFile(freshSandbox3 ? 'wrangler.sandbox3.jsonc' : 'wrangler.telegram-ux-v1.jsonc', 'utf8'));
    if (freshSandbox3) {
      validateSandbox3Config(config);
      evidence.cpWorker = 'trained-assist-cp-sandbox3';
      evidence.runnerService = SANDBOX3.runnerWorkerName;
      evidence.runnerPrincipalId = 'sandbox3-agent-api-principal';
      evidence.runnerProfileId = 'integration-sandbox3-v1';
      evidence.cpMockKeySecretName = 'RUNNER_API_KEY_AGENT_API';
      evidence.cpPrincipalSecretName = 'PRINCIPAL_SECRET_SANDBOX3';
    } else validateTelegramUxSandboxConfig(config);
    if (!freshSandbox3 && (config.name !== TELEGRAM_UX_SANDBOX.workerName || config.workers_dev !== true)) {
      fail('sandbox_worker_config_mismatch');
    }
    evidence.boundaries.sourceAndConfig = 'PASS';

    stage = 'cloudflareAccount';
    await verifyConfigAndAccount(input.accountId, freshSandbox3);
    evidence.boundaries.cloudflareAccount = 'PASS';

    stage = 'sandboxPreDeployLiveness';
    await verifySandboxLiveness(undefined, freshSandbox3 ? SANDBOX3_CP_URL : CP_URL);
    evidence.boundaries.sandboxPreDeployLiveness = 'PASS';

    if (freshSandbox3) {
      if (['--pair-sandbox3-cp', '--sandbox3-cp-mock-probe'].includes(args[0])) {
        if (args[0] === '--pair-sandbox3-cp') {
          stage = 'sandbox3CpCredentialPairing';
          await pairSandbox3Cp(input);
          evidence.boundaries[stage] = 'PASS';
        }
        stage = 'sandbox3CpMockContract';
        await probeSandbox3Cp(input);
        evidence.boundaries[stage] = 'PASS';
        evidence.outcome = 'passed';
      } else if (args[0] === '--sandbox3-public-preflight') {
        stage = 'sandbox3PublicRoute';
        evidence.sandbox3PublicRoute = await verifySandbox3PublicRoute();
        await verifySandbox3RunnerPrincipal(sandbox3Credentials(requiredEnv('RUNNER_MOCK_KEY_SEED')).apiKey);
        evidence.sandbox3PublicRoute.authenticatedContractVerified = true;
        evidence.boundaries[stage] = 'PASS';
        evidence.outcome = 'preflight_passed';
      }
    } else if (diagnosticMode) {
      await preflight(input, value => { stage = value; }, {
        includeRunnerInventory: ['--inventory', '--repair-permissions'].includes(args[0]),
        repairPermissions: args[0] === '--repair-permissions', candidateVerification: args[0] === '--candidate-preflight',
      });
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
    if (Object.hasOwn(evidence.boundaries, stage) && evidence.boundaries[stage] !== 'PASS') evidence.boundaries[stage] = 'BLOCKED';
    evidence.failure = {
      boundary: stage,
      reasonCode: error instanceof Error && (/^[a-z][a-z0-9:_-]{1,100}$/.test(error.message)
        || /^required_environment_missing:(GITHUB_SHA|CF_API_TOKEN|CP_TELEGRAM_UX_PRINCIPAL_SECRET|RUNNER_MOCK_KEY_SEED|VM2_SSH_PRIVATE_KEY|SANDBOX3_NATIVE_WORKER_SHA|SANDBOX3_NATIVE_WORKER_TOKEN|SANDBOX3_PROFILE_GITHUB_TOKEN|SANDBOX3_GCS_BUCKET|SANDBOX3_GCS_CREDENTIALS)$/.test(error.message))
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
