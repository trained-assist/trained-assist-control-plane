import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const bindings = process.env.INTEGRATION_BINDINGS_FILE
  ? JSON.parse(readFileSync(process.env.INTEGRATION_BINDINGS_FILE, 'utf8')) : process.env;
const taskId = process.env.INTEGRATION_TASK_ID;
for (const name of ['CONTROL_PLANE_URL', 'CONTROL_PLANE_PRINCIPAL', 'CONTROL_PLANE_PRINCIPAL_SIGNATURE']) {
  assert.ok(bindings[name], `${name} is required`);
}
assert.match(taskId ?? '', /^ut-[A-Za-z0-9_-]+$/);
const report = { taskId, startedAt: new Date().toISOString(), outcome: 'fail', artifacts: [], telegramDelivered: false };

try {
  const response = await fetch(new URL('/status', bindings.CONTROL_PLANE_URL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-principal': bindings.CONTROL_PLANE_PRINCIPAL,
      'x-principal-sig': bindings.CONTROL_PLANE_PRINCIPAL_SIGNATURE,
    },
    body: JSON.stringify({ taskId }), signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `status HTTP ${response.status}`);
  const state = await response.json();
  report.status = state.taskStore?.status;
  report.generation = state.taskStore?.generation;
  assert.equal(report.status, 'done', 'task is not terminal done');
  const result = state.taskStore.result;
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'engine');
  assert.equal(result.persistence, 'persisted');
  assert.match(result.runId ?? '', /^run_[a-f0-9-]{36}$/i);
  assert.ok(typeof result.answer === 'string' && result.answer.trim().length > 0, 'persisted agent answer is missing');
  assert.equal(state.runs.length, 1, 'expected one admitted attempt');
  assert.equal(state.runs[0].status, 'success');
  assert.equal(state.runs[0].session_id, result.runId);
  const artifact = result.artifacts.find(entry => typeof entry.ref === 'string' && entry.ref.endsWith('/outputs/category-results.csv'));
  assert.ok(artifact, 'declared CSV is absent from final manifest');
  const reference = new URL(artifact.ref);
  const match = reference.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/blob\/([a-f0-9]{40})\/(artifacts\/outputs\/category-results\.csv)$/);
  assert.ok(reference.protocol === 'https:' && reference.hostname === 'github.com' && !reference.username && !reference.password && !reference.port && !reference.search && !reference.hash && match, 'expected immutable GitHub artifact reference');
  const rawUrl = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
  const downloaded = await fetch(rawUrl, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  assert.ok(downloaded.ok, `artifact HTTP ${downloaded.status}`);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  assert.ok(bytes.length <= 1048576, 'artifact exceeds fixture limit');
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(artifact.sizeBytes, bytes.length, 'persisted byte size mismatch');
  assert.equal(artifact.sha256, digest, 'persisted checksum mismatch');
  assert.equal(bytes.toString('utf8').replace(/\r\n/g, '\n').trim(), 'category,total\nfood,150\ntravel,275', 'CSV readback differs from known fixture totals');
  const stored = state.artifacts.find(entry => entry.artifact_ref === artifact.ref);
  assert.ok(stored, 'artifact absent from Task Store');
  assert.equal(stored.size_bytes, bytes.length);
  assert.equal(stored.checksum, `sha256:${digest}`);
  Object.assign(report, { outcome: 'pass', runId: result.runId, persistedAnswer: true, attemptCount: 1 });
  report.artifacts.push({ commit: match[3], sizeBytes: bytes.length, sha256: digest, readbackVerified: true });
} catch (error) {
  report.reason = error instanceof assert.AssertionError ? error.message : 'transport_or_response_error';
  process.exitCode = 1;
}
if (process.env.INTEGRATION_REPORT_FILE) {
  writeFileSync(process.env.INTEGRATION_REPORT_FILE, JSON.stringify(report, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify(report));
