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
const controlPlaneUrl = new URL(bindings.CONTROL_PLANE_URL);
assert.ok(controlPlaneUrl.protocol === 'https:' && !controlPlaneUrl.username && !controlPlaneUrl.password);
const report = { taskId, startedAt: new Date().toISOString(), outcome: 'fail', artifacts: [], telegramDelivered: false };
let phase = 'status_transport';

async function boundedBytes(response, maximum) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks, size);
      size += chunk.value.byteLength;
      assert.ok(size <= maximum);
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

try {
  const response = await fetch(new URL('/status', controlPlaneUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-principal': bindings.CONTROL_PLANE_PRINCIPAL,
      'x-principal-sig': bindings.CONTROL_PLANE_PRINCIPAL_SIGNATURE,
    },
    body: JSON.stringify({ taskId }), signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  assert.ok(response.ok, `status HTTP ${response.status}`);
  const state = JSON.parse((await boundedBytes(response, 4194304)).toString('utf8'));
  phase = 'task_not_terminal_success';
  assert.equal(state.taskStore?.id, taskId, 'status returned another task');
  if (['active', 'awaiting_input', 'done', 'failed', 'cancelled'].includes(state.taskStore?.status)) report.status = state.taskStore.status;
  if (Number.isSafeInteger(state.taskStore?.generation) && state.taskStore.generation > 0) report.generation = state.taskStore.generation;
  assert.equal(report.status, 'done', 'task is not terminal done');
  const result = state.taskStore.result;
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'engine');
  assert.equal(result.persistence, 'persisted');
  assert.equal(result.engineText?.source, 'runner_status_answer', 'answer is not the native final-answer channel');
  assert.match(result.runId ?? '', /^run_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  assert.ok(typeof result.answer === 'string' && result.answer.trim().length > 0, 'persisted agent answer is missing');
  assert.equal(state.runs.length, 1, 'expected one admitted attempt');
  assert.equal(state.runs[0].status, 'success');
  assert.equal(state.runs[0].session_id, result.runId);
  assert.equal(state.runs[0].task_id, taskId);
  assert.equal(state.runs[0].generation, report.generation);
  phase = 'artifact_manifest_invalid';
  const artifact = result.artifacts.find(entry => typeof entry.ref === 'string' && entry.ref.endsWith('/outputs/category-results.csv'));
  assert.ok(artifact, 'declared CSV is absent from final manifest');
  const reference = new URL(artifact.ref);
  const match = reference.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/blob\/([a-f0-9]{40})\/(artifacts\/outputs\/category-results\.csv)$/);
  assert.ok(reference.protocol === 'https:' && reference.hostname === 'github.com' && !reference.username && !reference.password && !reference.port && !reference.search && !reference.hash && match, 'expected immutable GitHub artifact reference');
  const rawUrl = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
  phase = 'artifact_transport';
  const downloaded = await fetch(rawUrl, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  assert.ok(downloaded.ok, `artifact HTTP ${downloaded.status}`);
  const bytes = await boundedBytes(downloaded, 1048576);
  phase = 'artifact_readback_mismatch';
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(artifact.sizeBytes, bytes.length, 'persisted byte size mismatch');
  assert.equal(artifact.sha256, digest, 'persisted checksum mismatch');
  assert.equal(bytes.toString('utf8').replace(/\r\n/g, '\n').trim(), 'category,total\nfood,150\ntravel,275', 'CSV readback differs from known fixture totals');
  const stored = state.artifacts.find(entry => entry.artifact_ref === artifact.ref);
  assert.ok(stored, 'artifact absent from Task Store');
  assert.equal(stored.user_task_id, taskId);
  assert.equal(stored.run_id, result.runId);
  assert.equal(stored.size_bytes, bytes.length);
  assert.equal(stored.checksum, `sha256:${digest}`);
  Object.assign(report, { outcome: 'pass', runId: result.runId, persistedAnswer: true, attemptCount: 1 });
  report.artifacts.push({ commit: match[3], sizeBytes: bytes.length, sha256: digest, readbackVerified: true });
} catch {
  report.reason = phase;
  process.exitCode = 1;
}
if (process.env.INTEGRATION_REPORT_FILE) {
  writeFileSync(process.env.INTEGRATION_REPORT_FILE, JSON.stringify(report, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify(report));
