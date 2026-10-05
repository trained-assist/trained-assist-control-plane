import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const identity = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,199}$/.test(value);
const source = 'https://raw.githubusercontent.com/vovalikessmoothy-png/opencode-gha-runner/a4acd6c1f428d56abb1fdb6610889528f3049fb5/fixtures/integration-v1/category-source.csv';

function envelopeOf(requestId) {
  return {
    contractVersion: 1, requestId, profileId: 'integration-v1', conversationRef: requestId, sessionId: requestId,
    inputItems: [{ text: `Скачай отдельный тестовый CSV ${source} и сохрани inputs/category-source.csv. Прочитай сохранённый CSV как файл, посчитай суммы по category и создай outputs/category-results.csv. Формат результата: category,total; отсортируй строки по category, разделитель запятая. Исходный CSV и остальные файлы репозитория не изменяй. Не вызывай Google и другие пользовательские интеграции. В финальном ответе укажи результат и путь файла. Выполни задачу, не ограничивайся планом.` }],
  };
}

function routeIdentity(route) {
  assert.equal(route.route, 'agent');
  assert.ok(identity(route.decisionId));
  assert.equal(route.continuation?.issued, true);
  assert.equal(route.continuation?.executor, 'dynamic-ip-azure-agent-run');
  assert.equal(route.continuation?.generation, 1);
  assert.ok(identity(route.continuation?.runId));
  return { decisionId: route.decisionId, runId: route.continuation.runId };
}

export async function runCsvFile(environment = process.env, fetchImpl = fetch) {
  let report;
  let reportPath;
  let lockPath;
  let lock;
  let phase = 'configuration';
  const checkpoint = () => {
    const temporary = `${reportPath}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(report, null, 2));
      fsyncSync(descriptor);
      renameSync(temporary, reportPath);
    } finally {
      closeSync(descriptor);
      try { unlinkSync(temporary); } catch {}
    }
  };
  try {
    assert.ok(identity(environment.INTEGRATION_REQUEST_ID));
    assert.ok(environment.INTEGRATION_REPORT_FILE);
    assert.ok(environment.INTEGRATION_RESUME === undefined || environment.INTEGRATION_RESUME === 'true');
    const bindings = JSON.parse(readFileSync(environment.INTEGRATION_BINDINGS_FILE, 'utf8'));
    const base = new URL(bindings.CONTROL_PLANE_URL);
    assert.ok(base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash);
    assert.equal(bindings.CONTROL_PLANE_PROFILE, 'integration-v1');
    assert.ok(identity(bindings.CONTROL_PLANE_PRINCIPAL) && /^[a-f0-9]{64}$/.test(bindings.CONTROL_PLANE_PRINCIPAL_SIGNATURE));
    const requestId = environment.INTEGRATION_REQUEST_ID;
    const envelope = envelopeOf(requestId);
    const scope = { origin: base.origin, profileId: bindings.CONTROL_PLANE_PROFILE, principalId: bindings.CONTROL_PLANE_PRINCIPAL };
    reportPath = resolve(environment.INTEGRATION_REPORT_FILE);
    lockPath = `${reportPath}.lock`;
    lock = openSync(lockPath, 'wx', 0o600);
    if (environment.INTEGRATION_RESUME === 'true') {
      const descriptor = openSync(reportPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let previous;
      try {
        const stat = fstatSync(descriptor);
        assert.ok(stat.isFile() && stat.size <= 1048576 && (stat.mode & 0o077) === 0);
        previous = JSON.parse(readFileSync(descriptor, 'utf8'));
      } finally { closeSync(descriptor); }
      assert.equal(previous.schemaVersion, 'csv-file-submission-v2');
      assert.equal(previous.requestId, requestId);
      assert.deepEqual(previous.scope, scope);
      assert.deepEqual(previous.envelope, envelope);
      assert.ok(['intake', 'route', 'dispatched_not_verified'].includes(previous.phase));
      assert.equal(previous.verified, false);
      assert.equal(previous.telegramDelivered, false);
      assert.ok(previous.taskId === undefined || identity(previous.taskId));
      if (previous.phase !== 'intake') assert.ok(identity(previous.taskId));
      if (previous.phase === 'dispatched_not_verified') assert.ok(identity(previous.runId) && identity(previous.decisionId));
      report = previous;
    } else {
      const descriptor = openSync(reportPath, 'wx', 0o600);
      closeSync(descriptor);
      report = { schemaVersion: 'csv-file-submission-v2', scope, requestId, envelope,
        phase: 'intake', telegramDelivered: false, verified: false };
      checkpoint();
    }

    const request = async (path, body) => {
      const response = await fetchImpl(new URL(path, base), {
        method: body === undefined ? 'GET' : 'POST', headers: {
          'content-type': 'application/json', 'x-principal': bindings.CONTROL_PLANE_PRINCIPAL,
          'x-principal-sig': bindings.CONTROL_PLANE_PRINCIPAL_SIGNATURE,
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(60000),
      });
      assert.ok(response.ok);
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
          size += chunk.value.byteLength;
          assert.ok(size <= 4194304);
          chunks.push(Buffer.from(chunk.value));
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
    };
    phase = report.phase;
    if (phase === 'intake') {
      const accepted = await request('/intake', envelope);
      assert.equal(accepted.durable, true);
      assert.equal(accepted.profileId, scope.profileId);
      assert.equal(accepted.requestId, requestId);
      assert.ok(identity(accepted.userTaskId));
      assert.equal(typeof accepted.duplicate, 'boolean');
      if (environment.INTEGRATION_RESUME !== 'true') assert.equal(accepted.duplicate, false);
      if (report.taskId) assert.equal(accepted.userTaskId, report.taskId);
      report.taskId = accepted.userTaskId;
      checkpoint();
      const duplicate = await request('/intake', envelope);
      assert.equal(duplicate.durable, true);
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.userTaskId, report.taskId);
    }
    const status = await request(`/status?taskId=${encodeURIComponent(report.taskId)}`);
    assert.equal(status.taskStore.id, report.taskId);
    assert.equal(status.taskStore.generation, 1);
    assert.equal(status.taskStore.conversation_id, envelope.conversationRef);
    assert.ok(Array.isArray(status.runs) && status.runs.length <= 1);
    const attempt = status.runs[0];
    if (attempt) {
      assert.ok(identity(attempt.id));
      assert.equal(attempt.generation, 1);
      if (report.runId) assert.equal(attempt.id, report.runId);
    }
    if (phase === 'dispatched_not_verified') {
      assert.ok(attempt);
      return { ok: true, report };
    }
    assert.equal(status.taskStore.status, 'active');
    if (attempt) {
      assert.equal(attempt.status, 'running');
      assert.ok(['running', 'waiting', 'queued'].includes(status.engine?.status));
    }
    phase = 'route';
    report.phase = phase;
    if (attempt) report.runId = attempt.id;
    checkpoint();
    const started = performance.now();
    const route = routeIdentity(await request('/route', { taskId: report.taskId, continue: true }));
    if (report.runId) assert.equal(route.runId, report.runId);
    if (report.decisionId) assert.equal(route.decisionId, report.decisionId);
    Object.assign(report, route, { routeMs: Math.round(performance.now() - started) });
    checkpoint();
    const replay = routeIdentity(await request('/route', { taskId: report.taskId, continue: true }));
    assert.deepEqual(replay, route);
    Object.assign(report, { phase: 'dispatched_not_verified', intakeReplaySameTask: true, routeReplaySameAttempt: true });
    delete report.reason;
    checkpoint();
    return { ok: true, report };
  } catch {
    if (report) {
      report.reason = `${phase}_failed_reconcile_existing_request`;
      try { checkpoint(); } catch {}
    }
    return { ok: false, report: report ?? { phase: 'configuration', reason: 'invalid_configuration', verified: false, telegramDelivered: false } };
  } finally {
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { ok, report } = await runCsvFile();
  if (!ok) process.exitCode = 1;
  console.log(JSON.stringify({ taskId: report.taskId, requestId: report.requestId, phase: report.phase,
    routeMs: report.routeMs, reason: report.reason, verified: false, telegramDelivered: false }));
}
