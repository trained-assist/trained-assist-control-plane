import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sanitizedRunnerInventory, sanitizedRunnerPermissions, sanitizedRunnerFileMetadata, sanitizedSandbox3Namespace, sanitizedSandbox3Probe, sandbox3Credentials, verifiedSandboxScript } from './verified-sandbox-script.mjs';

test('verifies exact downloaded bytes and refuses tampering before execution', async () => {
  const body = Buffer.from('print("synthetic-inventory")');
  const digest = createHash('sha256').update(body).digest('hex');
  const fetcher = async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(body);
  };
  assert.deepEqual(await verifiedSandboxScript('https://fixture.test/pinned', digest, fetcher), body);
  await assert.rejects(verifiedSandboxScript('https://fixture.test/pinned', '0'.repeat(64), fetcher), /runner_inventory_script_digest_mismatch/);
});

test('caps bytes and sanitizes transport or streaming exceptions', async () => {
  await assert.rejects(verifiedSandboxScript('https://fixture.test', '0'.repeat(64), async () => new Response('x'.repeat(65 * 1024))), /runner_inventory_script_too_large/);
  await assert.rejects(verifiedSandboxScript('https://fixture.test', '0'.repeat(64), async () => { throw new Error('private_secret'); }), /^Error: runner_inventory_script_unreachable$/);
  const stream = new ReadableStream({ start(controller) { controller.error(new Error('private_secret')); } });
  await assert.rejects(verifiedSandboxScript('https://fixture.test', '0'.repeat(64), async () => new Response(stream)), /^Error: runner_inventory_script_read_failed$/);
});

function fixture() {
  return {
    schemaVersion: 1, target: 'agent-runner-api-mcp-test', sourceSha: 'a'.repeat(40),
    admissionCount: 2, nonterminalAdmissionCount: 1, unknownOutcomeCount: 1, launchRecordedCount: 2,
    journalTerminalOnly: false, serviceActive: true, sandboxMode: true, mockTestEnabled: true,
    journalTargetMatches: true, registryTargetMatches: true, portMatches: true,
    profileOwnerIsSandbox: false, ladderCredentialConfigured: true, workerEngines: ['dynamic-ip-azure-agent-run'],
    bindingPresence: Object.fromEntries(['AGENT_API_WORKERS', 'EXTERNAL_WORKER_URL', 'EXTERNAL_WORKER_TOKEN',
      'AGENT_API_PROFILE_WORKSPACE_ROOT', 'AGENT_API_PROFILE_OWNER', 'AGENT_API_PROFILE_GITHUB_TOKEN',
      'AGENT_API_PROFILE_TENANT_ROUTES_JSON', 'AGENT_API_PROFILE_DELEGATION_SECRET', 'AGENT_API_PUBLIC_URL',
      'GCS_BUCKET', 'GOOGLE_APPLICATION_CREDENTIALS'].map(name => [name, false])),
  };
}

test('emits only allowlisted metadata, preserving unknown admission counts', () => {
  const value = { ...fixture(), rawPrompt: 'private_user_text', rawCredential: 'private_secret' };
  const result = sanitizedRunnerInventory(value);
  assert.equal(result.nonterminalAdmissionCount, 1);
  assert.equal(result.journalTerminalOnly, false);
  assert.equal(JSON.stringify(result).includes('private_'), false);
});

test('rejects foreign targets, unsafe engine names and inconsistent state counts', () => {
  for (const patch of [{ target: 'production' }, { workerEngines: ['private_secret'] },
    { nonterminalAdmissionCount: 3 }, { unknownOutcomeCount: 2 }, { journalTerminalOnly: true },
    { admissionCount: -1 }, { sourceSha: 'private_secret' }, { serviceActive: 'true' }]) {
    assert.throws(() => sanitizedRunnerInventory({ ...fixture(), ...patch }), /^Error: runner_inventory_response_invalid$/);
  }
});

test('permission repair evidence retains only known components and statuses', () => {
  const result = { schemaVersion: 1, target: 'agent-runner-api-mcp-test',
    components: { environment: 'restricted', journal: 'already_private', secret: 'private_secret' }, secret: 'private_secret' };
  assert.equal(JSON.stringify(sanitizedRunnerPermissions(result)).includes('private_secret'), false);
  assert.throws(() => sanitizedRunnerPermissions({ ...result, target: 'production' }), /runner_permissions_response_invalid/);
  assert.throws(() => sanitizedRunnerPermissions({ ...result, components: { environment: 'private_secret', journal: 'restricted' } }), /runner_permissions_response_invalid/);
});

test('failed inventory file metadata cannot emit arbitrary owners or paths', () => {
  const data = { environment: { exists: true, owner: 'other', regular: true, unique: true,
    privateMode: true, serviceCanRead: false, serviceCanWrite: false, rawPath: 'private-secret' },
    journal: { exists: false }, rawOwner: 'private-secret' };
  const output = sanitizedRunnerFileMetadata(data);
  assert.equal(output.environment.owner, 'other');
  assert.equal(JSON.stringify(output).includes('private-secret'), false);
  assert.throws(() => sanitizedRunnerFileMetadata({ ...data, environment: { ...data.environment, owner: 'private-secret' } }), /runner_file_metadata_invalid/);
  assert.throws(() => sanitizedRunnerFileMetadata({ ...data, journal: {} }), /runner_file_metadata_invalid/);
});

test('fresh namespace evidence drops raw config and preserves unavailable runtime proof', () => {
  const value = { schemaVersion: 1, target: 'agent-runner-api-sandbox3', serviceActive: false,
    serviceExecSourceVerified: false, runtimeSourceSha: null, realExecutionVerified: false,
    serviceFailureResult: 'exit-code', serviceExitStatus: 200,
    componentsExist: Object.fromEntries(['environment', 'registry', 'unit', 'state', 'runtime'].map(name => [name, false])),
    proxyServicesActive: { caddy: true, nginx: false }, rawSecret: 'private-secret' };
  const result = sanitizedSandbox3Namespace(value);
  assert.equal(JSON.stringify(result).includes('private-secret'), false);
  assert.equal(result.runtimeSourceSha, null);
  assert.throws(() => sanitizedSandbox3Namespace({ ...value, target: 'production' }), /sandbox3_operator_response_invalid/);
  assert.throws(() => sanitizedSandbox3Namespace({ ...value, runtimeSourceSha: 'private-secret' }), /sandbox3_operator_response_invalid/);
});
test('sandbox3 bootstrap credentials are repeatable and separated by role and target', () => {
  const first = sandbox3Credentials('synthetic-seed-0123456789-abcdefghijk');
  assert.deepEqual(sandbox3Credentials('synthetic-seed-0123456789-abcdefghijk'), first);
  assert.notEqual(first.apiKey, first.delegationSecret);
  assert.match(first.apiKey, /^ta_sb3_[A-Za-z0-9_-]{43}$/);
  assert.match(first.delegationSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => sandbox3Credentials('short'), /sandbox3_operator_seed_invalid/);
});

test('probe projections reject readiness inflation and never expose raw secrets', () => {
  const base = { schemaVersion: 1, target: 'agent-runner-api-sandbox3', rawSecret: 'private-secret' };
  const proxy = { ...base, hostMentioned: true, tlsMentioned: true, legacyPathMentioned: true,
    sandbox3PathMentioned: false, sandbox3UpstreamMentioned: false, qualifiedRouteTargetCount: 1, publicRouteVerified: false };
  assert.equal(JSON.stringify(sanitizedSandbox3Probe(proxy, 'proxy')).includes('private-secret'), false);
  assert.throws(() => sanitizedSandbox3Probe({ ...proxy, publicRouteVerified: true }, 'proxy'));
  for (const qualifiedRouteTargetCount of [-1, 101, 'private-secret', 0.5]) {
    assert.throws(() => sanitizedSandbox3Probe({ ...proxy, qualifiedRouteTargetCount }, 'proxy'));
  }
  const mock = { ...base, mockTerminalPong: true, idempotentReceipt: true, eventsReadable: true,
    authRefusal: true, workerOrModelCalled: false, realTelegramE2E: false,
    runId: 'run_12345678-1234-1234-1234-123456789abc', requestId: 'req_12345678-1234-1234-1234-123456789abc' };
  assert.equal(JSON.stringify(sanitizedSandbox3Probe(mock, 'mock')).includes('private-secret'), false);
  for (const change of [{ realTelegramE2E: true }, { mockTerminalPong: false }, { runId: 'private-secret' }, { target: 'production' }]) {
    assert.throws(() => sanitizedSandbox3Probe({ ...mock, ...change }, 'mock'));
  }
});
