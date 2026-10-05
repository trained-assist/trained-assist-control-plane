import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCsvFile } from './agent-csv-file-live-run.mjs';

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), 'csv-retry-fixture-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const bindingsPath = join(directory, 'bindings.json');
  const reportPath = join(directory, 'report.json');
  const bindings = { CONTROL_PLANE_URL: 'https://cp.fixture', CONTROL_PLANE_PROFILE: 'integration-v1',
    CONTROL_PLANE_PRINCIPAL: 'fixture-principal', CONTROL_PLANE_PRINCIPAL_SIGNATURE: 'a'.repeat(64) };
  writeFileSync(bindingsPath, JSON.stringify(bindings), { mode: 0o600 });
  const environment = { INTEGRATION_BINDINGS_FILE: bindingsPath, INTEGRATION_REPORT_FILE: reportPath,
    INTEGRATION_REQUEST_ID: 'csv-stable-fixture' };
  const state = { calls: [], tasks: new Map(), attempts: [], loseIntakeAck: false, loseRouteAck: false,
    generation: 1, runStatus: 'running', engineStatus: 'running', malformedIds: false };
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    const path = url.pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    state.calls.push({ path, body });
    if (path === '/intake') {
      const duplicate = state.tasks.has(body.requestId);
      state.tasks.set(body.requestId, 'fixture-task');
      if (state.loseIntakeAck) { state.loseIntakeAck = false; throw new Error('lost intake ACK'); }
      return Response.json({ userTaskId: 'fixture-task', requestId: body.requestId, profileId: 'integration-v1', durable: true, duplicate });
    }
    if (path === '/status') return Response.json({ taskStore: { id: 'fixture-task', generation: state.generation,
      conversation_id: 'csv-stable-fixture', status: 'active' }, runs: state.attempts.map(id => ({ id, generation: 1, status: state.runStatus })),
      engine: { status: state.engineStatus } });
    assert.equal(path, '/route');
    if (!state.attempts.length) state.attempts.push('fixture-attempt');
    if (state.loseRouteAck) { state.loseRouteAck = false; throw new Error('lost route ACK'); }
    return Response.json({ route: 'agent', ...(state.malformedIds ? {} : { decisionId: 'fixture-decision' }),
      continuation: { issued: true, generation: 1, executor: 'dynamic-ip-azure-agent-run',
        ...(state.malformedIds ? {} : { runId: state.attempts[0] }) } });
  };
  return { environment, bindings, bindingsPath, reportPath, state, fetchImpl };
}

test('requires an explicit stable request ID before creating a checkpoint or sending HTTP', async context => {
  const fixtureData = fixture(context);
  delete fixtureData.environment.INTEGRATION_REQUEST_ID;
  assert.equal((await runCsvFile(fixtureData.environment, fixtureData.fetchImpl)).ok, false);
  assert.equal(fixtureData.state.calls.length, 0);
  assert.equal(existsSync(fixtureData.reportPath), false);
});

test('a fresh invocation refuses an already accepted request before any routing', async context => {
  const fixtureData = fixture(context);
  fixtureData.state.tasks.set(fixtureData.environment.INTEGRATION_REQUEST_ID, 'fixture-task');
  assert.equal((await runCsvFile(fixtureData.environment, fixtureData.fetchImpl)).ok, false);
  assert.deepEqual(fixtureData.state.calls.map(call => call.path), ['/intake']);
  assert.equal(fixtureData.state.attempts.length, 0);
});

test('fresh run exclusively creates a private checkpoint; implicit rerun never overwrites it', async context => {
  const fixtureData = fixture(context);
  const first = await runCsvFile(fixtureData.environment, fixtureData.fetchImpl);
  assert.equal(first.ok, true);
  assert.equal(first.report.verified, false);
  assert.equal(first.report.routeReplaySameAttempt, true);
  const prompt = fixtureData.state.calls.find(call => call.path === '/intake').body.inputItems[0].text;
  assert.ok(!prompt.includes('150') && !prompt.includes('275'));
  assert.ok(prompt.includes('category,total') && prompt.includes('outputs/category-results.csv'));
  assert.equal(first.report.verified, false);
  assert.equal(first.report.telegramDelivered, false);
  const original = readFileSync(fixtureData.reportPath, 'utf8');
  const calls = fixtureData.state.calls.length;
  assert.equal((await runCsvFile(fixtureData.environment, fixtureData.fetchImpl)).ok, false);
  assert.equal(fixtureData.state.calls.length, calls);
  assert.equal(readFileSync(fixtureData.reportPath, 'utf8'), original);
  assert.equal(statSync(fixtureData.reportPath).mode & 0o777, 0o600);
  assert.equal(fixtureData.state.tasks.size, 1);
  assert.equal(fixtureData.state.attempts.length, 1);
});

for (const phase of ['Intake', 'Route']) test(`lost ${phase} ACK resumes only the same durable request/task/attempt`, async context => {
  const fixtureData = fixture(context);
  fixtureData.state[`lose${phase}Ack`] = true;
  assert.equal((await runCsvFile(fixtureData.environment, fixtureData.fetchImpl)).ok, false);
  const checkpoint = JSON.parse(readFileSync(fixtureData.reportPath, 'utf8'));
  assert.equal(checkpoint.requestId, fixtureData.environment.INTEGRATION_REQUEST_ID);
  fixtureData.environment.INTEGRATION_RESUME = 'true';
  const resumed = await runCsvFile(fixtureData.environment, fixtureData.fetchImpl);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.report.taskId, 'fixture-task');
  assert.equal(resumed.report.runId, 'fixture-attempt');
  assert.equal(fixtureData.state.tasks.size, 1);
  assert.equal(fixtureData.state.attempts.length, 1);
  if (phase === 'Route') assert.equal(fixtureData.state.calls.filter(call => call.path === '/intake').length, 2);
});

for (const mismatch of ['request', 'scope', 'envelope', 'legacy']) test(`refuses ${mismatch} checkpoint mismatch without writes or HTTP`, async context => {
  const fixtureData = fixture(context);
  fixtureData.state.loseRouteAck = true;
  await runCsvFile(fixtureData.environment, fixtureData.fetchImpl);
  if (mismatch === 'request') fixtureData.environment.INTEGRATION_REQUEST_ID = 'replacement-case';
  else {
    const checkpoint = JSON.parse(readFileSync(fixtureData.reportPath, 'utf8'));
    if (mismatch === 'scope') checkpoint.scope.principalId = 'other-principal';
    if (mismatch === 'envelope') checkpoint.envelope.inputItems[0].text = 'different work';
    if (mismatch === 'legacy') delete checkpoint.schemaVersion;
    writeFileSync(fixtureData.reportPath, JSON.stringify(checkpoint));
  }
  const original = readFileSync(fixtureData.reportPath, 'utf8');
  const calls = fixtureData.state.calls.length;
  fixtureData.environment.INTEGRATION_RESUME = 'true';
  assert.equal((await runCsvFile(fixtureData.environment, fixtureData.fetchImpl)).ok, false);
  assert.equal(fixtureData.state.calls.length, calls);
  assert.equal(readFileSync(fixtureData.reportPath, 'utf8'), original);
});

for (const unsafe of ['generation', 'unknown']) test(`refuses ${unsafe} execution before routing on resume`, async context => {
  const fixtureData = fixture(context);
  fixtureData.state.loseRouteAck = true;
  await runCsvFile(fixtureData.environment, fixtureData.fetchImpl);
  if (unsafe === 'generation') fixtureData.state.generation = 2;
  else fixtureData.state.runStatus = 'unknown';
  const routes = fixtureData.state.calls.filter(call => call.path === '/route').length;
  fixtureData.environment.INTEGRATION_RESUME = 'true';
  assert.equal((await runCsvFile(fixtureData.environment, fixtureData.fetchImpl)).ok, false);
  assert.equal(fixtureData.state.calls.filter(call => call.path === '/route').length, routes);
});

for (const unsafe of ['empty-runs-unknown-engine', 'checkpoint-run-missing', 'mismatched-run', 'unknown-engine', 'errored-engine']) {
  test(`route-phase resume refuses ${unsafe} before any route requests`, async context => {
    const fixtureData = fixture(context);
    let routeCalls = 0;
    const lostReplayAck = async (url, options) => {
      if (url.pathname === '/route' && ++routeCalls === 2) throw new Error('lost route replay ACK');
      return fixtureData.fetchImpl(url, options);
    };
    assert.equal((await runCsvFile(fixtureData.environment, lostReplayAck)).ok, false);
    const checkpoint = JSON.parse(readFileSync(fixtureData.reportPath, 'utf8'));
    assert.equal(checkpoint.phase, 'route');
    assert.equal(checkpoint.runId, 'fixture-attempt');
    if (unsafe === 'empty-runs-unknown-engine') {
      delete checkpoint.runId;
      delete checkpoint.decisionId;
      writeFileSync(fixtureData.reportPath, JSON.stringify(checkpoint));
      fixtureData.state.attempts = [];
      fixtureData.state.engineStatus = 'unknown';
    } else if (unsafe === 'checkpoint-run-missing') fixtureData.state.attempts = [];
    else if (unsafe === 'mismatched-run') fixtureData.state.attempts = ['different-attempt'];
    else fixtureData.state.engineStatus = unsafe === 'unknown-engine' ? 'unknown' : 'errored';
    const calls = fixtureData.state.calls.length;
    fixtureData.environment.INTEGRATION_RESUME = 'true';
    const resumed = await runCsvFile(fixtureData.environment, fixtureData.fetchImpl);
    assert.equal(resumed.ok, false);
    assert.deepEqual(fixtureData.state.calls.slice(calls).map(call => call.path), ['/status']);
  });
}

test('missing replay IDs cannot satisfy undefined-equals-undefined or claim dispatch success', async context => {
  const fixtureData = fixture(context);
  fixtureData.state.malformedIds = true;
  const result = await runCsvFile(fixtureData.environment, fixtureData.fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.report.routeReplaySameAttempt, undefined);
  assert.equal(result.report.phase, 'route');
});

test('completed submission resume reads status only and never re-dispatches', async context => {
  const fixtureData = fixture(context);
  await runCsvFile(fixtureData.environment, fixtureData.fetchImpl);
  const calls = fixtureData.state.calls.length;
  fixtureData.environment.INTEGRATION_RESUME = 'true';
  assert.equal((await runCsvFile(fixtureData.environment, fixtureData.fetchImpl)).ok, true);
  assert.deepEqual(fixtureData.state.calls.slice(calls).map(call => call.path), ['/status']);
});

test('a held checkpoint lock prevents concurrent resume without HTTP or checkpoint replacement', async context => {
  const fixtureData = fixture(context);
  await runCsvFile(fixtureData.environment, fixtureData.fetchImpl);
  writeFileSync(`${fixtureData.reportPath}.lock`, '', { mode: 0o600 });
  const original = readFileSync(fixtureData.reportPath, 'utf8');
  const calls = fixtureData.state.calls.length;
  fixtureData.environment.INTEGRATION_RESUME = 'true';
  assert.equal((await runCsvFile(fixtureData.environment, fixtureData.fetchImpl)).ok, false);
  assert.equal(fixtureData.state.calls.length, calls);
  assert.equal(readFileSync(fixtureData.reportPath, 'utf8'), original);
  assert.equal(existsSync(`${fixtureData.reportPath}.lock`), true);
});
