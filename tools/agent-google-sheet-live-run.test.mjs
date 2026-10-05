import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeEnvelope } from '../src/intake/envelope.ts';
import { buildRunSpec, runSpecPolicyOf, toSubmitRequest, validateRunSpec } from '../src/run-spec/run-spec.ts';
import { runGoogleSheet, sheetEnvelope, sourceSheetId, spreadsheetId, summaryPath } from './agent-google-sheet-live-run.mjs';

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), 'google-sheet-operator-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = { INTEGRATION_REQUEST_ID: 'google-stable-case', INTEGRATION_REPORT_FILE: join(directory, 'checkpoint.json'),
    INTEGRATION_BINDINGS_FILE: join(directory, 'bindings.json'), INTEGRATION_SOURCE_FILE: join(directory, 'source.json'),
    INTEGRATION_HOST_APPROVAL_FILE: join(directory, 'approval.json') };
  const bindings = { CONTROL_PLANE_URL: 'https://cp.fixture', CONTROL_PLANE_PROFILE: 'integration-v1',
    CONTROL_PLANE_PRINCIPAL: 'fixture-client', CONTROL_PLANE_PRINCIPAL_SIGNATURE: 'a'.repeat(64) };
  const source = { schemaVersion: 'google-sheet-source-v1', spreadsheetId, sourceSheetId, sourceSheetName: 'Expenses', sourceRange: 'A1:D1000' };
  const server = { serverId: 'google-documents', transport: 'remote', url: 'https://mcp.fixture/mcp',
    bindingRef: 'google-sheet-fixture-binding', allowedTools: ['gdrive_read_sheet', 'gdrive_write_sheet'], toolTimeoutMs: 30000 };
  const approval = { schemaVersion: 'google-sheet-host-approval-v1', approved: true, taskId: 'fixture-task',
    profileId: 'integration-v1', conversationId: environment.INTEGRATION_REQUEST_ID, generation: 1,
    hostEnv: { RUN_SPEC_POLICY_PROFILE: 'integration-v1', RUN_SPEC_INPUT_REFS: '[]',
      RUN_SPEC_OUTPUTS: JSON.stringify([{ path: summaryPath, mime: 'application/json' }]),
      RUN_SPEC_MCP: JSON.stringify({ servers: [server] }), ROUTER_AGENT_ENGINE: 'dynamic-ip-azure-agent-run' } };
  const save = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  save(environment.INTEGRATION_BINDINGS_FILE, bindings);
  save(environment.INTEGRATION_SOURCE_FILE, source);
  save(environment.INTEGRATION_HOST_APPROVAL_FILE, approval);
  const state = { calls: [], tasks: new Map(), runs: [], generation: 1, status: 'active', stage: 'queued',
    engine: { error: 'instance does not exist' }, lostIntakeAck: false, lostRouteAck: false, routeMalformed: false };
  const fetchImpl = async (url, options) => {
    assert.equal(url.origin, 'https://cp.fixture');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-principal-sig'], 'a'.repeat(64));
    assert.ok(options.signal instanceof AbortSignal);
    const body = options.body ? JSON.parse(options.body) : undefined;
    state.calls.push({ path: url.pathname, body });
    if (url.pathname === '/intake') {
      const normalized = normalizeEnvelope(body);
      assert.equal(normalized.requestedExecutionPolicy, null);
      assert.equal(normalized.inputItems[0].artifactRefs, undefined);
      assert.equal(normalized.inputItems[0].snapshotId, undefined);
      assert.ok(!('mcp' in body));
      const duplicate = state.tasks.has(normalized.requestId);
      state.tasks.set(normalized.requestId, 'fixture-task');
      if (state.lostIntakeAck) { state.lostIntakeAck = false; throw new Error('private lost ACK sentinel'); }
      return Response.json({ durable: true, duplicate, profileId: 'integration-v1', requestId: normalized.requestId, userTaskId: 'fixture-task' });
    }
    if (url.pathname === '/status') return Response.json({ taskStore: { id: 'fixture-task', generation: state.generation,
      conversation_id: environment.INTEGRATION_REQUEST_ID, status: state.status, stage: state.stage },
      runs: state.runs, engine: state.engine });
    assert.equal(url.pathname, '/route');
    assert.deepEqual(body, { taskId: 'fixture-task', continue: true });
    const checkpoint = JSON.parse(readFileSync(environment.INTEGRATION_REPORT_FILE, 'utf8'));
    assert.equal(checkpoint.phase, 'route');
    assert.equal(checkpoint.taskId, 'fixture-task');
    assert.ok(/^[a-f0-9]{64}$/.test(checkpoint.hostApprovalSha256));
    assert.equal(state.runs.length, 0);
    state.runs.push({ id: 'fixture-attempt', generation: 1, status: 'running' });
    state.engine = { status: 'running' };
    state.stage = 'running';
    if (state.lostRouteAck) throw new Error('private route ACK sentinel');
    return Response.json({ route: 'agent', ...(state.routeMalformed ? {} : { decisionId: 'fixture-decision' }),
      continuation: { issued: true, generation: 1, runId: 'fixture-attempt', executor: 'dynamic-ip-azure-agent-run' } });
  };
  return { environment, bindings, source, server, approval, state, fetchImpl, save };
}

test('prepare accepts actual intake shape and checkpoints same task with no route/Google/Runner calls', async context => {
  const data = fixture(context);
  delete data.environment.INTEGRATION_HOST_APPROVAL_FILE;
  const result = await runGoogleSheet('prepare', data.environment, data.fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.report.phase, 'prepared');
  assert.equal(result.report.taskId, 'fixture-task');
  assert.equal(result.report.verified, false);
  assert.deepEqual(data.state.calls.map(call => call.path), ['/intake', '/status']);
  assert.equal(data.state.runs.length, 0);
  assert.equal(statSync(data.environment.INTEGRATION_REPORT_FILE).mode & 0o777, 0o600);
  const prompt = result.report.envelope.inputItems[0].text;
  assert.ok(prompt.includes(spreadsheetId) && prompt.includes(String(sourceSheetId)));
  assert.ok(prompt.includes('operationId') && prompt.includes('source_sheet_name') && prompt.includes(summaryPath));
  assert.ok(!/230|120|200|550|750/.test(prompt));
  assert.ok(!prompt.includes('mcp.fixture') && !prompt.includes(data.server.bindingRef));
});

test('explicit start preserves actual host RUN_SPEC_MCP contract and required artifact; does not inject client policy', async context => {
  const data = fixture(context);
  await runGoogleSheet('prepare', data.environment, data.fetchImpl);
  const normalized = normalizeEnvelope(sheetEnvelope(data.environment.INTEGRATION_REQUEST_ID, data.source));
  const policy = runSpecPolicyOf(data.approval.hostEnv);
  const built = buildRunSpec({ userTaskId: 'fixture-task', profileId: 'integration-v1', conversationId: normalized.conversationRef,
    ownerGeneration: 1, engineName: data.approval.hostEnv.ROUTER_AGENT_ENGINE, prompt: normalized.inputItems[0].text,
    refs: [], instructions: null, attemptRunId: 'fixture-attempt', timeoutMs: 300000 }, policy);
  assert.deepEqual(validateRunSpec(built.spec), { ok: true });
  const submit = toSubmitRequest(built.spec);
  assert.deepEqual(submit.mcp, { servers: [data.server] });
  assert.deepEqual(submit.outputs, [{ path: summaryPath, mime: 'application/json' }]);
  assert.equal(submit.engine.name, 'dynamic-ip-azure-agent-run');
  assert.ok(!submit.input.refs?.length);
  const started = await runGoogleSheet('start', data.environment, data.fetchImpl);
  assert.equal(started.ok, true);
  assert.equal(started.report.phase, 'dispatched_not_verified');
  assert.equal(started.report.verified, false);
  assert.equal(started.report.telegramDelivered, false);
  assert.equal(started.report.runId, 'fixture-attempt');
  assert.ok(/^[a-f0-9]{64}$/.test(started.report.hostApprovalSha256));
  assert.equal(data.state.calls.filter(call => call.path === '/route').length, 1);
});

test('missing stable ID or invalid command refuses before HTTP/checkpoint creation', async context => {
  const data = fixture(context);
  delete data.environment.INTEGRATION_REQUEST_ID;
  assert.equal((await runGoogleSheet('prepare', data.environment, data.fetchImpl)).ok, false);
  assert.equal((await runGoogleSheet('auto', data.environment, data.fetchImpl)).ok, false);
  assert.equal(data.state.calls.length, 0);
  assert.equal(existsSync(data.environment.INTEGRATION_REPORT_FILE), false);
});

test('start without a separate private approval cannot dispatch the prepared task', async context => {
  const data = fixture(context);
  await runGoogleSheet('prepare', data.environment, data.fetchImpl);
  delete data.environment.INTEGRATION_HOST_APPROVAL_FILE;
  const calls = data.state.calls.length;
  assert.equal((await runGoogleSheet('start', data.environment, data.fetchImpl)).ok, false);
  assert.deepEqual(data.state.calls.slice(calls).map(call => call.path), ['/status']);
  assert.equal(data.state.runs.length, 0);
});

test('accepted identity survives status failure before registration and execution', async context => {
  const data = fixture(context);
  const failed = await runGoogleSheet('prepare', data.environment, async (url, options) => {
    if (url.pathname === '/status') throw new Error('secret status sentinel');
    return data.fetchImpl(url, options);
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.report.taskId, 'fixture-task');
  assert.equal(failed.report.phase, 'intake');
  assert.ok(!JSON.stringify(failed.report).includes('secret status sentinel'));
  assert.equal(data.state.runs.length, 0);
  data.environment.INTEGRATION_RESUME = 'true';
  const prepared = await runGoogleSheet('prepare', data.environment, data.fetchImpl);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.report.taskId, failed.report.taskId);
  assert.equal(data.state.tasks.size, 1);
});

test('fresh duplicate receipt retains accepted task but never starts', async context => {
  const data = fixture(context);
  data.state.tasks.set(data.environment.INTEGRATION_REQUEST_ID, 'fixture-task');
  const result = await runGoogleSheet('prepare', data.environment, data.fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.report.taskId, 'fixture-task');
  assert.deepEqual(data.state.calls.map(call => call.path), ['/intake']);
});

test('exclusive checkpoint and lock prevent implicit rerun and concurrent prepare without replacement', async context => {
  const data = fixture(context);
  await runGoogleSheet('prepare', data.environment, data.fetchImpl);
  const before = readFileSync(data.environment.INTEGRATION_REPORT_FILE, 'utf8');
  const calls = data.state.calls.length;
  assert.equal((await runGoogleSheet('prepare', data.environment, data.fetchImpl)).ok, false);
  assert.equal(readFileSync(data.environment.INTEGRATION_REPORT_FILE, 'utf8'), before);
  data.save(`${data.environment.INTEGRATION_REPORT_FILE}.lock`, {});
  assert.equal((await runGoogleSheet('start', data.environment, data.fetchImpl)).ok, false);
  assert.equal(data.state.calls.length, calls);
  assert.ok(existsSync(`${data.environment.INTEGRATION_REPORT_FILE}.lock`));
});

test('lost intake ACK resumes identical envelope and stops prepared; prepared resume is status-only', async context => {
  const data = fixture(context);
  data.state.lostIntakeAck = true;
  const failed = await runGoogleSheet('prepare', data.environment, data.fetchImpl);
  assert.equal(failed.ok, false);
  assert.ok(!JSON.stringify(failed.report).includes('private lost ACK sentinel'));
  assert.equal((await runGoogleSheet('start', data.environment, data.fetchImpl)).ok, false);
  data.environment.INTEGRATION_RESUME = 'true';
  assert.equal((await runGoogleSheet('prepare', data.environment, data.fetchImpl)).ok, true);
  assert.equal(data.state.tasks.size, 1);
  const calls = data.state.calls.length;
  assert.equal((await runGoogleSheet('prepare', data.environment, data.fetchImpl)).ok, true);
  assert.deepEqual(data.state.calls.slice(calls).map(call => call.path), ['/status']);
  assert.equal(data.state.runs.length, 0);
});

for (const mismatch of ['request', 'scope', 'source', 'envelope']) test(`checkpoint ${mismatch} mismatch refuses without HTTP or mutation`, async context => {
  const data = fixture(context);
  await runGoogleSheet('prepare', data.environment, data.fetchImpl);
  const checkpoint = JSON.parse(readFileSync(data.environment.INTEGRATION_REPORT_FILE, 'utf8'));
  if (mismatch === 'request') checkpoint.requestId = 'other-case';
  if (mismatch === 'scope') checkpoint.scope.origin = 'https://other.fixture';
  if (mismatch === 'source') checkpoint.source.sourceSheetName = 'other-source';
  if (mismatch === 'envelope') checkpoint.envelope.inputItems[0].text = 'other-work';
  data.save(data.environment.INTEGRATION_REPORT_FILE, checkpoint);
  const before = readFileSync(data.environment.INTEGRATION_REPORT_FILE, 'utf8');
  const calls = data.state.calls.length;
  assert.equal((await runGoogleSheet('start', data.environment, data.fetchImpl)).ok, false);
  assert.equal(data.state.calls.length, calls);
  assert.equal(readFileSync(data.environment.INTEGRATION_REPORT_FILE, 'utf8'), before);
});

for (const mismatch of ['task', 'generation', 'binding', 'url', 'tools', 'output', 'engine', 'secret-field']) {
  test(`start refuses ${mismatch} host approval before any route`, async context => {
    const data = fixture(context);
    await runGoogleSheet('prepare', data.environment, data.fetchImpl);
    if (mismatch === 'task') data.approval.taskId = 'other-task';
    if (mismatch === 'generation') data.approval.generation = 2;
    if (mismatch === 'binding') data.server.bindingRef = '';
    if (mismatch === 'url') data.server.url = 'https://secret@mcp.fixture/mcp';
    if (mismatch === 'tools') data.server.allowedTools.push('gdrive_create_spreadsheet');
    if (mismatch === 'output') data.approval.hostEnv.RUN_SPEC_OUTPUTS = '[]';
    if (mismatch === 'engine') data.approval.hostEnv.ROUTER_AGENT_ENGINE = 'opencode';
    if (mismatch === 'secret-field') data.server.token = 'secret sentinel';
    data.approval.hostEnv.RUN_SPEC_MCP = JSON.stringify({ servers: [data.server] });
    data.save(data.environment.INTEGRATION_HOST_APPROVAL_FILE, data.approval);
    assert.equal((await runGoogleSheet('start', data.environment, data.fetchImpl)).ok, false);
    assert.equal(data.state.calls.filter(call => call.path === '/route').length, 0);
  });
}

for (const unsafe of ['generation', 'existing-run', 'running-stage', 'unknown-engine']) test(`prepared start refuses ${unsafe} execution state`, async context => {
  const data = fixture(context);
  await runGoogleSheet('prepare', data.environment, data.fetchImpl);
  if (unsafe === 'generation') data.state.generation = 2;
  if (unsafe === 'existing-run') data.state.runs = [{ id: 'other-attempt', generation: 1, status: 'running' }];
  if (unsafe === 'running-stage') data.state.stage = 'running';
  if (unsafe === 'unknown-engine') data.state.engine = { status: 'unknown' };
  assert.equal((await runGoogleSheet('start', data.environment, data.fetchImpl)).ok, false);
  assert.equal(data.state.calls.filter(call => call.path === '/route').length, 0);
});

for (const outcome of ['running', 'empty-unknown', 'terminal', 'malformed-route']) test(`ambiguous ${outcome} route outcome never repeats dispatch`, async context => {
  const data = fixture(context);
  await runGoogleSheet('prepare', data.environment, data.fetchImpl);
  data.state.lostRouteAck = outcome !== 'malformed-route';
  data.state.routeMalformed = outcome === 'malformed-route';
  assert.equal((await runGoogleSheet('start', data.environment, data.fetchImpl)).ok, false);
  const checkpoint = JSON.parse(readFileSync(data.environment.INTEGRATION_REPORT_FILE, 'utf8'));
  assert.equal(checkpoint.phase, 'route');
  assert.equal(checkpoint.taskId, 'fixture-task');
  if (outcome === 'empty-unknown') { data.state.runs = []; data.state.engine = { status: 'unknown' }; }
  if (outcome === 'terminal') { data.state.status = 'done'; data.state.runs[0].status = 'success'; }
  const calls = data.state.calls.length;
  assert.equal((await runGoogleSheet('start', data.environment, data.fetchImpl)).ok, false);
  assert.deepEqual(data.state.calls.slice(calls).map(call => call.path), ['/status']);
  assert.equal(data.state.calls.filter(call => call.path === '/route').length, 1);
});

test('dispatched checkpoint is status-only on repeated start and never claims artifact/Sheet acceptance', async context => {
  const data = fixture(context);
  await runGoogleSheet('prepare', data.environment, data.fetchImpl);
  await runGoogleSheet('start', data.environment, data.fetchImpl);
  const calls = data.state.calls.length;
  const result = await runGoogleSheet('start', data.environment, data.fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.report.verified, false);
  assert.deepEqual(data.state.calls.slice(calls).map(call => call.path), ['/status']);
  data.state.runs = [];
  assert.equal((await runGoogleSheet('start', data.environment, data.fetchImpl)).ok, false);
  assert.equal(data.state.calls.filter(call => call.path === '/route').length, 1);
});

for (const response of ['redirect', 'oversized', 'oversized-stream', 'invalid-json']) test(`bounded ${response} transport refuses with fixed phase code and retains existing ID`, async context => {
  const data = fixture(context);
  await runGoogleSheet('prepare', data.environment, data.fetchImpl);
  const badFetch = async (_url, options) => {
    assert.equal(options.redirect, 'error');
    if (response === 'redirect') return new Response('secret sentinel', { status: 302 });
    if (response === 'oversized') return new Response('secret sentinel', { headers: { 'content-length': '4194305' } });
    if (response === 'oversized-stream') return new Response('s'.repeat(4194305));
    return new Response('secret sentinel');
  };
  const result = await runGoogleSheet('start', data.environment, badFetch);
  assert.equal(result.ok, false);
  assert.equal(result.report.taskId, 'fixture-task');
  assert.ok(!JSON.stringify(result.report).includes('secret sentinel'));
  assert.equal(data.state.runs.length, 0);
});

test('source target/range and unexpected fields are pinned before intake', async context => {
  const data = fixture(context);
  for (const invalid of [{ spreadsheetId: 'other' }, { sourceSheetId: 0 }, { sourceRange: 'A1:Z1000' }, { expectedTotals: [999] }]) {
    data.save(data.environment.INTEGRATION_SOURCE_FILE, { ...data.source, ...invalid });
    assert.equal((await runGoogleSheet('prepare', data.environment, data.fetchImpl)).ok, false);
  }
  assert.equal(data.state.calls.length, 0);
});
