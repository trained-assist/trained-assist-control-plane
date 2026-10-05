import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const bindings = process.env.INTEGRATION_BINDINGS_FILE
  ? JSON.parse(readFileSync(process.env.INTEGRATION_BINDINGS_FILE, 'utf8')) : process.env;
const required = ['CONTROL_PLANE_URL', 'CONTROL_PLANE_PRINCIPAL', 'CONTROL_PLANE_PRINCIPAL_SIGNATURE', 'CONTROL_PLANE_PROFILE'];
for (const name of required) assert.ok(bindings[name], `${name} is required`);
const runId = `live-v1-${randomUUID()}`;
const report = { runId, startedAt: new Date().toISOString(), scenarios: [] };
const headers = {
  'content-type': 'application/json',
  'x-principal': bindings.CONTROL_PLANE_PRINCIPAL,
  'x-principal-sig': bindings.CONTROL_PLANE_PRINCIPAL_SIGNATURE,
};

async function request(path, body) {
  const response = await fetch(new URL(path, bindings.CONTROL_PLANE_URL), {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  assert.ok(response.ok, `${path} returned HTTP ${response.status}`);
  return response.json();
}

for (const [name, text, capabilityId] of [
  ['health', 'Работает?', 'system_health'],
  ['capabilities', 'Какие у тебя функции и что можно подключить?', 'catalog.brief'],
]) {
  const started = performance.now();
  const evidence = { name, outcome: 'fail', requestId: `${runId}:${name}` };
  try {
    const envelope = {
      contractVersion: 1, requestId: evidence.requestId, profileId: bindings.CONTROL_PLANE_PROFILE,
      conversationRef: runId, sessionId: runId, inputItems: [{ text }],
    };
    const receipt = await request('/intake', envelope);
    evidence.userTaskId = receipt.userTaskId;
    assert.equal(receipt.durable, true);
    assert.ok(receipt.userTaskId);
    const intakeReplay = await request('/intake', envelope);
    assert.equal(intakeReplay.userTaskId, receipt.userTaskId);
    const route = await request('/route', { taskId: receipt.userTaskId, continue: true });
    assert.equal(route.route, 'deterministic');
    assert.equal(route.capabilityId, capabilityId);
    assert.ok(route.reply?.text);
    const replay = await request('/route', { taskId: receipt.userTaskId, continue: true });
    assert.equal(replay.decisionId, route.decisionId);
    assert.equal(replay.reply?.text, route.reply.text);
    assert.equal(replay.continuation?.issued, false);
    const state = await request('/status', { taskId: receipt.userTaskId });
    assert.equal(state.taskStore?.status, 'done');
    assert.equal(state.taskStore.result?.answer, route.reply.text);
    assert.equal(state.taskStore.result?.quickAnswer?.id, capabilityId);
    assert.equal(state.runs.length, 0);
    Object.assign(evidence, {
      outcome: 'pass', capabilityId, generation: state.taskStore.generation,
      rendering: state.taskStore.result.rendering, persistedAnswer: true, engineRuns: 0,
      intakeReplaySameTask: true, routeReplaySameDecision: true, telegramDelivered: false,
    });
  } catch (error) {
    evidence.reason = error instanceof assert.AssertionError ? error.message : 'transport_error';
    process.exitCode = 1;
  }
  evidence.elapsedMs = Math.round(performance.now() - started);
  report.scenarios.push(evidence);
  console.log(JSON.stringify(evidence));
  if (process.env.INTEGRATION_REPORT_FILE) {
    writeFileSync(process.env.INTEGRATION_REPORT_FILE, JSON.stringify(report, null, 2), { mode: 0o600 });
  }
}
