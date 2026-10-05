import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const report = { phase: 'configuration', telegramDelivered: false, verified: false };
let bindings;
let base;
let envelope;
try {
  bindings = JSON.parse(readFileSync(process.env.INTEGRATION_BINDINGS_FILE, 'utf8'));
  base = new URL(bindings.CONTROL_PLANE_URL);
  assert.ok(base.protocol === 'https:' && !base.username && !base.password);
  assert.equal(bindings.CONTROL_PLANE_PROFILE, 'integration-v1');
  assert.ok(bindings.CONTROL_PLANE_PRINCIPAL && /^[a-f0-9]{64}$/.test(bindings.CONTROL_PLANE_PRINCIPAL_SIGNATURE));
  assert.ok(process.env.INTEGRATION_REPORT_FILE);
  const requestId = process.env.INTEGRATION_REQUEST_ID ?? `integration-csv-file:${randomUUID()}`;
  assert.match(requestId, /^[A-Za-z0-9._:-]{1,199}$/);
  const source = 'https://raw.githubusercontent.com/vovalikessmoothy-png/opencode-gha-runner/a4acd6c1f428d56abb1fdb6610889528f3049fb5/fixtures/integration-v1/category-source.csv';
  envelope = {
    contractVersion: 1, requestId, profileId: 'integration-v1', conversationRef: requestId, sessionId: requestId,
    inputItems: [{ text: `Скачай отдельный тестовый CSV ${source} и сохрани inputs/category-source.csv. Прочитай сохранённый CSV как файл, посчитай суммы по category и создай outputs/category-results.csv. Формат результата: category,total; строки food,150 и travel,275, в этом порядке, разделитель запятая. Исходный CSV и остальные файлы репозитория не изменяй. Не вызывай Google и другие пользовательские интеграции. В финальном ответе укажи результат и путь файла. Выполни задачу, не ограничивайся планом.` }],
  };
  Object.assign(report, { requestId, envelope });
} catch {
  console.log(JSON.stringify({ phase: 'configuration', reason: 'invalid_configuration', verified: false }));
  process.exit(1);
}

function checkpoint() {
  writeFileSync(process.env.INTEGRATION_REPORT_FILE, JSON.stringify(report, null, 2), { mode: 0o600 });
}

async function request(path, body) {
  const response = await fetch(new URL(path, base), {
    method: 'POST', headers: {
      'content-type': 'application/json', 'x-principal': bindings.CONTROL_PLANE_PRINCIPAL,
      'x-principal-sig': bindings.CONTROL_PLANE_PRINCIPAL_SIGNATURE,
    }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60000),
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
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

try {
  report.phase = 'intake';
  checkpoint();
  const accepted = await request('/intake', envelope);
  report.taskId = accepted.userTaskId;
  checkpoint();
  assert.ok(accepted.durable && report.taskId);
  const duplicate = await request('/intake', envelope);
  assert.equal(duplicate.userTaskId, report.taskId);
  report.phase = 'route';
  checkpoint();
  const started = performance.now();
  const route = await request('/route', { taskId: report.taskId, continue: true });
  report.routeMs = Math.round(performance.now() - started);
  assert.equal(route.route, 'agent');
  assert.equal(route.continuation?.executor, 'dynamic-ip-azure-agent-run');
  assert.equal(route.continuation?.generation, 1);
  const replay = await request('/route', { taskId: report.taskId, continue: true });
  assert.equal(replay.decisionId, route.decisionId);
  assert.equal(replay.continuation?.runId, route.continuation.runId);
  report.phase = 'dispatched_not_verified';
  report.intakeReplaySameTask = true;
  report.routeReplaySameAttempt = true;
} catch {
  report.reason = `${report.phase}_failed_reconcile_existing_request`;
  process.exitCode = 1;
}
checkpoint();
console.log(JSON.stringify({ taskId: report.taskId, requestId: report.requestId, phase: report.phase,
  routeMs: report.routeMs, reason: report.reason, verified: false, telegramDelivered: false }));
