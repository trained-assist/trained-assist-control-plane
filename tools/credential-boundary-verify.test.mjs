import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOnlyClient, verifyBoundary, readPrivateJson, runCli } from './credential-boundary-verify.mjs';

function fixture() {
  const expected = { version: 'credential-boundary-verify-v1', cpOrigin: 'https://cp.fixture', statusMethod: 'GET',
    taskId: 'ut-fixture', profileId: 'integration-v1', hostPrincipalId: 'integration-v1-google-host', conversationRef: 'fixture-conversation',
    awaitingInputId: 'fixture-wait', provider: 'google', bindingRef: 'fixture-binding', providerSessionRef: 'fixture-session',
    eventId: 'fixture-ready-event', generation: 1, waitVersion: 1,
    runId: 'run_01234567-89ab-cdef-0123-456789abcdef', engine: 'dynamic-ip-azure-agent-run' };
  const binding = { baseUrl: expected.cpOrigin, principalId: expected.hostPrincipalId, profileId: expected.profileId, principalSignature: 'a'.repeat(64) };
  const event = { status: 'ready', eventId: expected.eventId, userTaskId: expected.taskId, profileId: expected.profileId,
    provider: expected.provider, bindingRef: expected.bindingRef, providerSessionRef: expected.providerSessionRef, generation: 1, version: 1 };
  const completion = duplicate => ({ status: 200, body: { awaitingInputId: expected.awaitingInputId, duplicate, delivered: true } });
  const checkpoint = { ...expected, version: 'credential-boundary-prepare-v1', phase: 'verified_event_delivered_not_work_verified',
    providerVerified: true, readyEventSent: true, event, firstCompletion: completion(false), repeatedCompletion: completion(true) };
  const ready = { status: 'ready', bindingRef: expected.bindingRef, provider: 'google', eventId: expected.eventId, generation: 1, version: 1 };
  const wait = { awaiting_input_id: expected.awaitingInputId, user_task_id: expected.taskId, purpose: 'credential', status: 'answered',
    respondent_scope: expected.profileId, generation: 1, version: 1, checkpoint_ref: null, answered_at: 1000, answer_signal_id: 3,
    schema_json: JSON.stringify({ type: 'object', credential: { hostPrincipalId: expected.hostPrincipalId, provider: 'google',
      bindingRef: expected.bindingRef, providerSessionRef: expected.providerSessionRef } }), answer_json: JSON.stringify(ready), answer: ready };
  const status = { taskStore: { id: expected.taskId, conversation_id: expected.conversationRef, generation: 1, status: 'done', awaiting_input_id: null,
    awaiting: { id: expected.awaitingInputId, status: 'answered' },
    signals: [{ id: 3, step: expected.awaitingInputId, type: 'credential_ready', consumed: 1000, rejected: null,
      payload: JSON.stringify({ status: 'ready', bindingRef: expected.bindingRef, provider: 'google' }) }],
    result: { ok: true, mode: 'engine', persistence: 'persisted', runId: expected.runId, ownerGeneration: 1,
      exitReason: 'completed', answer: 'synthetic native answer', engineText: { source: 'runner_status_answer' } } },
    runs: [{ task_id: expected.taskId, generation: 1, session_id: expected.runId, engine: expected.engine,
      status: 'success', started_at: 1100, finished_at: 1200, error_class: null }] };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.includes('/awaiting/') ? wait : status);
  };
  return { expected, binding, checkpoint, wait, status, calls, fetchImpl };
}

test('verifies typed answered wait, exact checkpoint scope and one successful native attempt using only two reads', async () => {
  const data = fixture();
  const client = readOnlyClient(data.binding, data.expected, data.fetchImpl);
  const result = await verifyBoundary({ ...data, client });
  assert.equal(result.outcome, 'pass');
  assert.equal(result.successfulNativeAttemptCount, 1);
  assert.equal(result.providerReverified, false);
  assert.equal(result.csvReadbackVerified, false);
  assert.equal(result.googleSheetsVerified, false);
  assert.equal(result.telegramDelivered, false);
  assert.deepEqual(data.calls.map(call => [call.options.method, new URL(call.url).pathname]), [['GET', '/awaiting/fixture-wait'], ['GET', '/status']]);
  for (const call of data.calls) {
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers['x-principal'], data.expected.hostPrincipalId);
    assert.equal(call.options.headers['x-principal-sig'], data.binding.principalSignature);
    assert.equal(call.options.body, undefined);
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test('POST status is a read projection with an exact task-only body, never a continuation mutation', async () => {
  const data = fixture();
  data.expected.statusMethod = 'POST';
  const result = await verifyBoundary({ ...data, client: readOnlyClient(data.binding, data.expected, data.fetchImpl) });
  assert.equal(result.outcome, 'pass');
  assert.equal(data.calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(data.calls[1].options.body), { taskId: data.expected.taskId });
});

for (const key of ['taskId', 'profileId', 'conversationRef', 'awaitingInputId', 'provider', 'bindingRef', 'providerSessionRef', 'eventId', 'generation', 'waitVersion']) {
  test(`checkpoint ${key} mismatch refuses before networking`, async () => {
    const data = fixture();
    data.checkpoint[key] = typeof data.checkpoint[key] === 'number' ? 2 : 'foreign-scope';
    await assert.rejects(verifyBoundary({ ...data, client: readOnlyClient(data.binding, data.expected, data.fetchImpl) }));
    assert.equal(data.calls.length, 0);
  });
}

const mutations = [
  ['unverified checkpoint', data => { data.checkpoint.providerVerified = false; }],
  ['ambiguous first delivery', data => { data.checkpoint.firstCompletion.status = 503; }],
  ['replay not deduplicated', data => { data.checkpoint.repeatedCompletion.body.duplicate = false; }],
  ['ready event extra payload', data => { data.checkpoint.event.token = 'synthetic-secret'; }],
  ['foreign wait task', data => { data.wait.user_task_id = 'other-task'; }],
  ['foreign profile', data => { data.wait.respondent_scope = 'other-profile'; }],
  ['open wait', data => { data.wait.status = 'open'; }],
  ['changed wait generation', data => { data.wait.generation = 2; }],
  ['changed wait version', data => { data.wait.version = 2; }],
  ['existing native checkpoint', data => { data.wait.checkpoint_ref = 'native-checkpoint'; }],
  ['wrong schema session', data => { data.wait.schema_json = data.wait.schema_json.replace('fixture-session', 'foreign-session'); }],
  ['generic ready answer', data => { data.wait.answer_json = JSON.stringify({ answer: 'ready' }); }],
  ['answer projection differs', data => { data.wait.answer.version = 2; }],
  ['different task result', data => { data.status.taskStore.id = 'other-task'; }],
  ['generation changed', data => { data.status.taskStore.generation = 2; }],
  ['conversation changed', data => { data.status.taskStore.conversation_id = 'other-conversation'; }],
  ['still running', data => { data.status.taskStore.status = 'active'; }],
  ['unconsumed typed signal', data => { data.status.taskStore.signals[0].consumed = null; }],
  ['duplicate typed signal', data => { data.status.taskStore.signals.push(structuredClone(data.status.taskStore.signals[0])); }],
  ['diagnostic answer', data => { data.status.taskStore.result.engineText.source = 'runner_log_stdout'; }],
  ['result from another run', data => { data.status.taskStore.result.runId = 'run_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; }],
  ['extra failed attempt', data => { data.status.runs.push({ status: 'failed' }); }],
  ['bare UUID attempt', data => { data.status.runs[0].session_id = data.expected.runId.slice(4); }],
  ['unknown attempt', data => { data.status.runs[0].status = 'unknown'; }],
  ['wrong native engine', data => { data.status.runs[0].engine = 'fake'; }],
  ['execution before readiness', data => { data.status.runs[0].started_at = 900; }],
];
for (const [name, mutate] of mutations) test(`refuses ${name}`, async () => {
  const data = fixture();
  mutate(data);
  await assert.rejects(verifyBoundary({ ...data, client: readOnlyClient(data.binding, data.expected, data.fetchImpl) }));
});

test('transport pins origin/principal and cannot access mutation or foreign-scope routes', async () => {
  const data = fixture();
  for (const change of [{ baseUrl: 'https://foreign.fixture' }, { baseUrl: 'https://cp.fixture/path' },
    { baseUrl: 'https://cp.fixture?secret=synthetic' }, { principalId: 'integration-v1-user' }, { profileId: 'foreign-profile' }]) {
    assert.throws(() => readOnlyClient({ ...data.binding, ...change }, data.expected, data.fetchImpl));
  }
  const client = readOnlyClient(data.binding, data.expected, data.fetchImpl);
  for (const route of ['/ready', '/awaiting/fixture-wait/credential-ready', '/start', '/route', '/recover', '/replay',
    '/status?taskId=other-task', '/status?taskId=ut-fixture&extra=1', '/awaiting/other-wait', 'https://foreign.fixture/status']) {
    await assert.rejects(client.call('GET', route));
    await assert.rejects(client.call('POST', route, { taskId: data.expected.taskId }));
  }
  data.expected.statusMethod = 'POST';
  const postClient = readOnlyClient(data.binding, data.expected, data.fetchImpl);
  await assert.rejects(postClient.call('POST', '/status', { taskId: data.expected.taskId, status: 'ready' }));
  assert.equal(data.calls.length, 0);
});

test('expectation rejects unknown schema, unpinned origins and noncanonical runs before requests', () => {
  const data = fixture();
  for (const change of [{ version: 'other-schema' }, { extra: 'unexpected' }, { cpOrigin: 'http://cp.fixture' },
    { cpOrigin: 'https://cp.fixture/' }, { cpOrigin: 'https://cp.fixture/path' }, { cpOrigin: 'https://cp.fixture?secret=synthetic' },
    { cpOrigin: 'https://user:synthetic@cp.fixture' }, { runId: data.expected.runId.slice(4) }, { profileId: 'other-profile' },
    { generation: 0 }, { waitVersion: 1.5 }, { statusMethod: 'DELETE' }, { engine: 'fake' }]) {
    assert.throws(() => readOnlyClient(data.binding, { ...data.expected, ...change }, data.fetchImpl));
  }
  assert.equal(data.calls.length, 0);
});

test('unsuccessful response is cancelled without reading or exposing its body', async () => {
  const data = fixture();
  let cancelled = false;
  const stream = new ReadableStream({ cancel: () => { cancelled = true; } });
  const client = readOnlyClient(data.binding, data.expected, async () => new Response(stream, { status: 403 }));
  await assert.rejects(client.call('GET', '/awaiting/fixture-wait'), /read_transport_refused/);
  assert.equal(cancelled, true);
});

test('response size, malformed JSON, scalar bodies, redirects and failed status fail closed', async () => {
  const data = fixture();
  for (const response of [new Response('x'.repeat(1048577)), new Response('private-secret-invalid-json'), Response.json([]), Response.json(null),
    Response.json({ private_key: 'synthetic-secret' }, { status: 403 }), new Response(null, { status: 302, headers: { location: 'https://foreign.fixture' } })]) {
    const client = readOnlyClient(data.binding, data.expected, async () => response);
    await assert.rejects(client.call('GET', '/awaiting/fixture-wait'));
  }
});

test('CLI uses only synthetic private files and never prints binding, response, paths or exceptions', async context => {
  const root = await mkdtemp(join(tmpdir(), 'credential-verify-test-'));
  await chmod(root, 0o700);
  context.after(() => rm(root, { recursive: true, force: true }));
  const data = fixture();
  const files = ['expected', 'host', 'checkpoint'].map(name => join(root, name + '.json'));
  for (const [index, value] of [data.expected, data.binding, data.checkpoint].entries()) await writeFile(files[index], JSON.stringify(value), { mode: 0o600 });
  const output = [];
  assert.equal(await runCli(['verify', ...files], { fetchImpl: data.fetchImpl, write: text => output.push(text) }), 0);
  assert.equal(JSON.parse(output.pop()).outcome, 'pass');
  assert.equal(await runCli(['verify', ...files], { fetchImpl: async () => { throw new Error(data.binding.principalSignature + root); }, write: text => output.push(text) }), 1);
  assert.doesNotMatch(output.join(''), new RegExp(data.binding.principalSignature));
  assert.ok(!output.join('').includes(root));
  assert.equal(await runCli([], { fetchImpl: data.fetchImpl, write: text => output.push(text) }), 1);
  await chmod(files[1], 0o644);
  await assert.rejects(readPrivateJson(files[1]));
  await chmod(files[1], 0o600);
  const alias = join(root, 'symlink.json');
  await symlink(files[1], alias);
  await assert.rejects(readPrivateJson(alias));
  await writeFile(files[0], 'x'.repeat(1048577));
  await assert.rejects(readPrivateJson(files[0]));
});
