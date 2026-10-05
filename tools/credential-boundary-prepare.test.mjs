import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareBoundary, privateClient } from './credential-boundary-prepare.mjs';

function fixture(overrides = {}) {
  const calls = [];
  let intakeCalls = 0;
  let opened = false;
  let conversationRef;
  let credential;
  const call = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/intake') {
      conversationRef = body.conversationRef;
      const duplicate = intakeCalls++ > 0;
      return { status: duplicate ? 200 : 201, body: { durable: true, duplicate, profileId: 'integration-v1',
        userTaskId: duplicate && overrides.changedReceipt ? 'other-task' : 'fixture-task' } };
    }
    if (path.startsWith('/status?')) return { status: 200, body: { taskStore: { id: 'fixture-task', generation: overrides.generation ?? 1,
      conversation_id: conversationRef, status: opened ? 'awaiting_input' : 'active', awaiting_input_id: opened ? 'fixture-wait' : null,
      signals: [], history: [] }, runs: [] } };
    if (path === '/awaiting') {
      opened = true;
      credential = { ...body.credential, hostPrincipalId: 'integration-v1-google-host' };
      return { status: overrides.waitStatus ?? 201, body: { awaitingInputId: 'fixture-wait', generation: 1, version: 1 } };
    }
    if (path.endsWith('/answer')) return { status: overrides.answerStatus ?? 409, body: {} };
    if (path === '/signal') return { status: 200, body: { delivered: overrides.delivered ?? false, reason: 'verified_credential_event_required' } };
    if (path === '/awaiting/fixture-wait') return { status: 200, body: { status: 'open', purpose: 'credential', generation: 1,
      version: 1, answer_json: null, schema_json: JSON.stringify({ credential }) } };
    throw new Error('unexpected endpoint');
  };
  const origin = 'https://cp.fixture';
  return { calls, input: { user: { principalId: 'integration-v1-user', origin, call },
    host: { principalId: 'integration-v1-google-host', origin, call },
    goal: 'Process the provided CSV; no Sheet target is claimed.', csvRef: 'https://fixture/input.csv',
    bindingRef: 'isolated-google-binding', providerSessionRef: 'isolated-google-session', nonce: 'fixture-nonce' } };
}

test('prepares a fresh receipt and exact bound wait, never dispatches or attests readiness', async () => {
  const { input, calls } = fixture();
  const checkpoints = [];
  const record = await prepareBoundary({ ...input, providerVerified: true, status: 'ready',
    checkpoint: async value => checkpoints.push(structuredClone(value)) });
  assert.equal(record.providerVerified, false);
  assert.equal(record.readyEventSent, false);
  assert.equal(record.phase, 'prepared_no_verification_or_event');
  assert.deepEqual(checkpoints.map(value => value.phase), ['accepted', 'registered', 'prepared_no_verification_or_event']);
  assert.ok(calls.every(value => !/credential-ready|\/route|\/start|\/recover/.test(value.path)));
  assert.equal(calls.filter(value => value.path === '/intake').length, 2);
  assert.deepEqual(calls.find(value => value.path === '/awaiting').body.credential, {
    provider: 'google', bindingRef: input.bindingRef, providerSessionRef: input.providerSessionRef,
  });
});

for (const [name, overrides, reason] of [
  ['changed generation', { generation: 2 }, 'preexecution_same_task_generation_required'],
  ['generic answer accepted', { answerStatus: 200 }, 'generic_answer_not_refused'],
  ['generic signal accepted', { delivered: true }, 'generic_text_not_refused'],
  ['changed retry receipt', { changedReceipt: true }, 'receipt_retry_identity_changed'],
  ['unprovisioned host allowlist', { waitStatus: 403 }, 'registered_credential_wait_required'],
]) test(`refuses ${name}`, async () => {
  await assert.rejects(prepareBoundary(fixture(overrides).input), new RegExp(reason));
});

test('refuses the user principal as credential host before any requests', async () => {
  const { input, calls } = fixture();
  input.host.principalId = input.user.principalId;
  await assert.rejects(prepareBoundary(input), /host_user_binding_mismatch/);
  assert.equal(calls.length, 0);
});

test('private transport refuses event, model-start, recovery and foreign-origin paths', async () => {
  let calls = 0;
  const client = privateClient({ baseUrl: 'https://cp.fixture', profileId: 'integration-v1',
    principalId: 'integration-v1-google-host', principalSignature: 'fixture-signature' }, async () => { calls++; });
  for (const path of ['/awaiting/fixture-wait/credential-ready', '/route', '/start', '/recover', 'https://foreign.fixture/status']) {
    await assert.rejects(client.call('POST', path, { status: 'ready', providerVerified: true }), /operator_endpoint_forbidden/);
  }
  assert.equal(calls, 0);
});
