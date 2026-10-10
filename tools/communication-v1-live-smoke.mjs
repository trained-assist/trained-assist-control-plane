import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const identity = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,199}$/.test(value);
const safeWriterFailure = value => typeof value === 'string'
  && (/^(?:not_configured|invalid_timeout|input_too_large|timeout|unavailable|malformed|tool_error|writer_rejected|writer_changed_verified_facts)$/.test(value)
    || /^http_[1-5][0-9]{2}$/.test(value))
  ? value : 'writer_failed';
class CheckpointError extends Error {}

export async function runSmoke(environment = process.env, fetchImpl = fetch) {
  let report;
  let reportPath;
  let ownsReport = false;
  let phase = 'invalid_configuration';
  const checkpoint = () => {
    const temporary = `${reportPath}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(report, null, 2));
      fsyncSync(descriptor);
      renameSync(temporary, reportPath);
    } catch { throw new CheckpointError(); }
    finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch {}
    }
  };
  try {
    const bindings = environment.INTEGRATION_BINDINGS_FILE
      ? JSON.parse(readFileSync(environment.INTEGRATION_BINDINGS_FILE, 'utf8')) : environment;
    const base = new URL(bindings.CONTROL_PLANE_URL);
    assert.ok(base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash);
    assert.ok(identity(bindings.CONTROL_PLANE_PRINCIPAL) && identity(bindings.CONTROL_PLANE_PROFILE));
    const principalSignature = bindings.CONTROL_PLANE_PRINCIPAL_SIGNATURE
      ?? (environment.CP_INTEGRATION_V1_PRINCIPAL_SECRET
        ? createHmac('sha256', environment.CP_INTEGRATION_V1_PRINCIPAL_SECRET)
          .update(bindings.CONTROL_PLANE_PRINCIPAL).digest('hex')
        : '');
    assert.match(principalSignature, /^[a-f0-9]{64}$/);
    const expectedBuildSha = environment.CONTROL_PLANE_EXPECTED_BUILD_SHA;
    if (expectedBuildSha !== undefined) assert.match(expectedBuildSha, /^[a-f0-9]{40}$/);
    assert.ok(environment.INTEGRATION_REPORT_FILE);
    reportPath = resolve(environment.INTEGRATION_REPORT_FILE);
    phase = 'report_checkpoint';
    const descriptor = openSync(reportPath, 'wx', 0o600);
    closeSync(descriptor);
    ownsReport = true;
    const runId = `live-v1-${randomUUID()}`;
    report = { runId, startedAt: new Date().toISOString(), outcome: 'fail', telegramDelivered: false, scenarios: [],
      ...(expectedBuildSha ? { expectedBuildSha } : {}) };
    checkpoint();
    if (expectedBuildSha) {
      phase = 'sandbox_health_probe';
      const response = await fetchImpl(new URL('/healthz', base), {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      assert.ok(response.ok);
      const health = await response.json();
      assert.equal(health?.service, 'trained-assist-control-plane');
      assert.equal(health?.status, 'healthy');
      assert.equal(health?.check, 'liveness');
      assert.match(health?.buildSha ?? '', /^[a-f0-9]{40}$/);
      assert.equal(health.buildSha, expectedBuildSha);
      report.deployedBuildSha = health.buildSha;
      checkpoint();
    }
    const request = async (path, body) => {
      const response = await fetchImpl(new URL(path, base), {
        method: 'POST', redirect: 'error', headers: {
          'content-type': 'application/json', 'x-principal': bindings.CONTROL_PLANE_PRINCIPAL,
          'x-principal-sig': principalSignature,
        }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
      });
      assert.ok(response.ok);
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            const parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
            assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
            return parsed;
          }
          size += chunk.value.byteLength;
          assert.ok(size <= 4194304);
          chunks.push(Buffer.from(chunk.value));
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
    };

    for (const [name, text, capabilityId] of [
      ['health', 'Работает?', 'system_health'],
      ['capabilities', 'Какие у тебя функции и что можно подключить?', 'catalog.brief'],
    ]) {
      const started = performance.now();
      const evidence = { name, outcome: 'fail', requestId: `${runId}:${name}`, telegramDelivered: false };
      report.scenarios.push(evidence);
      try {
        const envelope = { contractVersion: 1, requestId: evidence.requestId, profileId: bindings.CONTROL_PLANE_PROFILE,
          conversationRef: runId, sessionId: runId, inputItems: [{ text }] };
        phase = 'intake_transport';
        evidence.phase = phase;
        checkpoint();
        const receipt = await request('/intake', envelope);
        phase = 'receipt_invalid';
        assert.ok(identity(receipt.userTaskId));
        evidence.userTaskId = receipt.userTaskId;
        checkpoint();
        assert.equal(receipt.durable, true);
        phase = 'intake_replay_transport';
        const intakeReplay = await request('/intake', envelope);
        phase = 'receipt_replay_invalid';
        assert.equal(intakeReplay.durable, true);
        assert.equal(intakeReplay.userTaskId, receipt.userTaskId);
        phase = 'route_transport';
        evidence.phase = phase;
        checkpoint();
        const route = await request('/route', { taskId: receipt.userTaskId, continue: true });
        phase = 'route_not_quick_answer';
        assert.equal(route.route, 'deterministic');
        assert.equal(route.capabilityId, capabilityId);
        assert.ok(typeof route.reply?.text === 'string' && route.reply.text.trim());
        assert.ok(identity(route.decisionId));
        evidence.decisionId = route.decisionId;
        checkpoint();
        phase = 'route_replay_transport';
        const replay = await request('/route', { taskId: receipt.userTaskId, continue: true });
        phase = 'route_replay_invalid';
        assert.ok(identity(replay.decisionId));
        assert.equal(replay.decisionId, route.decisionId);
        assert.equal(replay.reply?.text, route.reply.text);
        assert.equal(replay.continuation?.issued, false);
        phase = 'status_transport';
        const state = await request('/status', { taskId: receipt.userTaskId });
        phase = 'persisted_answer_invalid';
        assert.equal(state.taskStore?.id, receipt.userTaskId);
        assert.equal(state.taskStore?.status, 'done');
        assert.equal(state.taskStore.result?.answer, route.reply.text);
        assert.equal(state.taskStore.result?.quickAnswer?.id, capabilityId);
        assert.ok(Number.isSafeInteger(state.taskStore.generation) && state.taskStore.generation > 0);
        assert.ok(Array.isArray(state.runs));
        assert.equal(state.runs.length, 0);
        const rendering = state.taskStore.result.rendering;
        if (['communication_writer', 'deterministic'].includes(rendering?.source)) {
          evidence.rendering = { source: rendering.source,
            failure: rendering.failure === null ? null : safeWriterFailure(rendering.failure) };
        }
        Object.assign(evidence, { outcome: 'pass', phase: 'verified_quick_answer', capabilityId, generation: state.taskStore.generation,
          persistedAnswer: true, engineRuns: 0, intakeReplaySameTask: true, routeReplaySameDecision: true });
      } catch (error) {
        evidence.reason = error instanceof CheckpointError ? 'report_checkpoint' : phase;
        evidence.phase = evidence.reason;
      }
      evidence.elapsedMs = Math.round(performance.now() - started);
      checkpoint();
      if (evidence.outcome !== 'pass') return { ok: false, report };
    }
    report.outcome = 'pass';
    checkpoint();
    return { ok: true, report };
  } catch (error) {
    const reason = error instanceof CheckpointError ? 'report_checkpoint' : phase;
    if (!ownsReport || !report) return { ok: false, report: { outcome: 'fail', reason, telegramDelivered: false } };
    report.outcome = 'fail';
    report.reason = reason;
    return { ok: false, report };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { ok, report } = await runSmoke();
  if (!ok) process.exitCode = 1;
  console.log(JSON.stringify(report));
}
