import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sanitizedRunnerInventory, sanitizedRunnerPermissions, sanitizedRunnerFileMetadata, verifiedSandboxScript } from './verified-sandbox-script.mjs';

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
