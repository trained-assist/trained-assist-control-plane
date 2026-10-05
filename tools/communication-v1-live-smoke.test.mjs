import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSmoke } from './communication-v1-live-smoke.mjs';

const sentinel = 'SECRET_RESPONSE_TEXT_SENTINEL';

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), 'smoke-transport-fixture-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const reportPath = join(directory, 'report.json');
  const bindingsPath = join(directory, 'bindings.json');
  const bindings = { CONTROL_PLANE_URL: 'https://cp.fixture', CONTROL_PLANE_PRINCIPAL: 'fixture-principal',
    CONTROL_PLANE_PRINCIPAL_SIGNATURE: 'a'.repeat(64), CONTROL_PLANE_PROFILE: 'integration-v1' };
  writeFileSync(bindingsPath, JSON.stringify(bindings), { mode: 0o600 });
  const environment = { INTEGRATION_BINDINGS_FILE: bindingsPath, INTEGRATION_REPORT_FILE: reportPath };
  const state = { calls: [], tasks: new Map(), routeCalls: new Map(), failurePath: undefined,
    oversized: false, malformed: false, fallback: false, answerMismatch: false, engineRuns: 0, missingDecisionId: false };
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(url.origin, 'https://cp.fixture');
    const body = JSON.parse(options.body);
    state.calls.push({ path: url.pathname, body });
    if (state.failurePath === url.pathname) throw new Error(sentinel);
    if (state.oversized) return new Response('x'.repeat(4194305));
    if (state.malformed) return new Response(`<html>${sentinel}</html>`);
    if (url.pathname === '/intake') {
      const name = body.requestId.endsWith(':health') ? 'health' : 'capabilities';
      const taskId = `fixture-${name}`;
      state.tasks.set(taskId, name);
      return Response.json({ userTaskId: taskId, durable: true });
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const evidence = report.scenarios.find(value => value.userTaskId === body.taskId);
    assert.ok(evidence, 'accepted identity must be durable before any route/status request');
    const name = state.tasks.get(body.taskId);
    const capabilityId = name === 'health' ? 'system_health' : 'catalog.brief';
    if (url.pathname === '/route') {
      assert.equal(evidence.phase, 'route_transport');
      state.routeCalls.set(body.taskId, (state.routeCalls.get(body.taskId) ?? 0) + 1);
      const replay = state.routeCalls.get(body.taskId) > 1;
      return Response.json({ route: state.fallback ? 'agent' : 'deterministic', capabilityId,
        ...(state.missingDecisionId ? {} : { decisionId: `decision:${body.taskId}` }),
        reply: { text: replay && state.answerMismatch ? sentinel : 'Fixture answer' }, continuation: { issued: false } });
    }
    assert.equal(url.pathname, '/status');
    return Response.json({ taskStore: { id: body.taskId, status: 'done', generation: 1,
      result: { answer: 'Fixture answer', quickAnswer: { id: capabilityId }, rendering: { source: 'communication_writer', failure: null } } },
      runs: Array.from({ length: state.engineRuns }, () => ({ status: 'running' })) });
  };
  return { environment, bindings, bindingsPath, reportPath, state, fetchImpl };
}

test('preserves both factual scenarios, receipt/route identity, timings and zero-engine evidence', async context => {
  const fixtureData = fixture(context);
  const result = await runSmoke(fixtureData.environment, fixtureData.fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.report.outcome, 'pass');
  assert.deepEqual(result.report.scenarios.map(value => value.name), ['health', 'capabilities']);
  for (const evidence of result.report.scenarios) {
    assert.equal(evidence.outcome, 'pass');
    assert.equal(evidence.engineRuns, 0);
    assert.equal(evidence.intakeReplaySameTask, true);
    assert.equal(evidence.routeReplaySameDecision, true);
    assert.equal(evidence.telegramDelivered, false);
    assert.deepEqual(evidence.rendering, { source: 'communication_writer', failure: null });
    assert.ok(evidence.decisionId && evidence.requestId && evidence.userTaskId && evidence.elapsedMs >= 0);
  }
  assert.equal(statSync(fixtureData.reportPath).mode & 0o777, 0o600);
});

test('fallback agent failure retains accepted task before route and stops without another scenario/retry', async context => {
  const fixtureData = fixture(context);
  fixtureData.state.fallback = true;
  const result = await runSmoke(fixtureData.environment, fixtureData.fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.report.scenarios.length, 1);
  assert.equal(result.report.scenarios[0].reason, 'route_not_quick_answer');
  const stored = JSON.parse(readFileSync(fixtureData.reportPath, 'utf8'));
  assert.equal(stored.scenarios[0].userTaskId, 'fixture-health');
  assert.deepEqual(fixtureData.state.calls.map(call => call.path), ['/intake', '/intake', '/route']);
});

test('route transport ACK loss retains accepted identity with only a fixed phase code', async context => {
  const fixtureData = fixture(context);
  fixtureData.state.failurePath = '/route';
  const result = await runSmoke(fixtureData.environment, fixtureData.fetchImpl);
  assert.equal(result.report.scenarios[0].reason, 'route_transport');
  assert.equal(result.report.scenarios[0].userTaskId, 'fixture-health');
  assert.ok(!JSON.stringify(result.report).includes(sentinel));
  assert.ok(!readFileSync(fixtureData.reportPath, 'utf8').includes(sentinel));
});

test('assertion mismatches never expose received answer text or raw assertion messages', async context => {
  const fixtureData = fixture(context);
  fixtureData.state.answerMismatch = true;
  const result = await runSmoke(fixtureData.environment, fixtureData.fetchImpl);
  assert.equal(result.report.scenarios[0].reason, 'route_replay_invalid');
  assert.ok(!JSON.stringify(result.report).includes(sentinel));
  assert.ok(!readFileSync(fixtureData.reportPath, 'utf8').includes(sentinel));
});

for (const invalid of ['oversized', 'malformed']) test(`refuses ${invalid} response with bounded, sanitized transport failure`, async context => {
  const fixtureData = fixture(context);
  fixtureData.state[invalid] = true;
  const result = await runSmoke(fixtureData.environment, fixtureData.fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.report.scenarios[0].reason, 'intake_transport');
  assert.equal(fixtureData.state.calls.length, 1);
  assert.ok(!JSON.stringify(result.report).includes(sentinel));
});

test('missing route IDs and unexpected engine runs cannot pass quick-answer acceptance', async context => {
  for (const invalid of ['missingDecisionId', 'engineRuns']) {
    const fixtureData = fixture(context);
    fixtureData.state[invalid] = invalid === 'engineRuns' ? 1 : true;
    const result = await runSmoke(fixtureData.environment, fixtureData.fetchImpl);
    assert.equal(result.ok, false);
    assert.equal(result.report.scenarios[0].reason, invalid === 'engineRuns' ? 'persisted_answer_invalid' : 'route_not_quick_answer');
  }
});

test('configuration errors are sanitized even at the CLI boundary, with no HTTP or report overwrite', async context => {
  const fixtureData = fixture(context);
  fixtureData.bindings.CONTROL_PLANE_URL = `https://${sentinel}@cp.fixture`;
  writeFileSync(fixtureData.bindingsPath, JSON.stringify(fixtureData.bindings));
  const result = await runSmoke(fixtureData.environment, fixtureData.fetchImpl);
  assert.equal(result.report.reason, 'invalid_configuration');
  assert.equal(fixtureData.state.calls.length, 0);
  assert.equal(existsSync(fixtureData.reportPath), false);
  const cli = spawnSync(process.execPath, ['tools/communication-v1-live-smoke.mjs'], { env: { ...process.env, ...fixtureData.environment }, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, '');
  assert.ok(!cli.stdout.includes(sentinel));
  assert.equal(JSON.parse(cli.stdout).reason, 'invalid_configuration');
});

test('an existing report is refused before HTTP and remains unchanged', async context => {
  const fixtureData = fixture(context);
  writeFileSync(fixtureData.reportPath, 'existing accepted task checkpoint', { mode: 0o600 });
  const result = await runSmoke(fixtureData.environment, fixtureData.fetchImpl);
  assert.equal(result.report.reason, 'report_checkpoint');
  assert.equal(fixtureData.state.calls.length, 0);
  assert.equal(readFileSync(fixtureData.reportPath, 'utf8'), 'existing accepted task checkpoint');
});
