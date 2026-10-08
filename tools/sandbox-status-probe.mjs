#!/usr/bin/env node
import { createHmac } from 'node:crypto';

const taskId = process.env.CP_SANDBOX_TASK_ID || '';
if (!/^ut-[a-z0-9]{20}$/.test(taskId)) {
  console.error('CP_SANDBOX_TASK_ID must be an existing sandbox userTaskId (ut- followed by 20 lowercase letters or digits).');
  process.exit(2);
}
const secret = process.env.CP_INTEGRATION_V1_PRINCIPAL_SECRET;
if (!secret || secret.length < 32) {
  console.error('CP_INTEGRATION_V1_PRINCIPAL_SECRET must be a sandbox-only secret of at least 32 characters.');
  process.exit(2);
}

const baseUrl = 'https://trained-assist-cp-telegram-ux-v1-sandbox.skillset-apply.workers.dev';
const principalId = 'sde-codex-smoke-v1';
const signature = createHmac('sha256', secret).update(principalId).digest('hex');
const startedAt = performance.now();
const response = await fetch(`${baseUrl}/status?taskId=${encodeURIComponent(taskId)}`, {
  headers: { 'x-principal': principalId, 'x-principal-sig': signature },
  signal: AbortSignal.timeout(30_000),
});
const elapsedMs = Math.round(performance.now() - startedAt);
let body;
try { body = await response.json(); } catch { body = {}; }
const task = body?.taskStore;
const result = task?.result && typeof task.result === 'object' && !Array.isArray(task.result) ? task.result : {};
const reasonCode = typeof result.reasonCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(result.reasonCode)
  ? result.reasonCode : null;
const output = {
  httpStatus: response.status,
  elapsedMs,
  taskFound: task?.id === taskId,
  ...(task?.id === taskId ? {
    taskStatus: typeof task.status === 'string' ? task.status : null,
    stage: typeof task.stage === 'string' ? task.stage : null,
    resultStatus: typeof result.status === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(result.status) ? result.status : null,
    reasonCode,
    generation: Number.isInteger(task.generation) ? task.generation : null,
    runCount: Array.isArray(body.runs) ? body.runs.length : null,
    deliveryCount: Array.isArray(body.deliveries) ? body.deliveries.length : null,
    artifactCount: Array.isArray(body.artifacts) ? body.artifacts.length : null,
    nativeStopCount: Array.isArray(body.nativeStops) ? body.nativeStops.length : null,
  } : {}),
};
console.log(JSON.stringify(output));
if (!response.ok || !output.taskFound) process.exitCode = 1;
