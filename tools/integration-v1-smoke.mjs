#!/usr/bin/env node
import { createHmac, randomUUID } from 'node:crypto';

const baseUrl = (process.env.CP_INTEGRATION_V1_URL || 'https://trained-assist-cp-telegram-ux-v1-sandbox.skillset-apply.workers.dev').replace(/\/$/, '');
const secret = process.env.CP_INTEGRATION_V1_PRINCIPAL_SECRET;
const principalId = process.env.CP_INTEGRATION_V1_PRINCIPAL_ID || 'sde-codex-smoke-v1';
const profileId = process.env.CP_INTEGRATION_V1_PROFILE_ID || 'integration-telegram-ux-v1';
if (!secret || secret.length < 32) {
  console.error('CP_INTEGRATION_V1_PRINCIPAL_SECRET must be a sandbox-only secret of at least 32 characters.');
  process.exit(2);
}

const signature = createHmac('sha256', secret).update(principalId).digest('hex');
const headers = { 'x-principal': principalId, 'x-principal-sig': signature };
const requestId = `sde-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID()}`;
let runnerProfileHealth = null;
if (process.env.CP_INTEGRATION_V1_RUNNER_PROBE === 'true') {
  const healthResponse = await fetch(`${baseUrl}/internal/runner/profile-health`, { headers });
  const healthBody = await healthResponse.json();
  runnerProfileHealth = healthBody;
  if (healthResponse.status !== 200 || runnerProfileHealth.runnerApi !== 'reachable') {
    const safeReasons = {
      'runner not configured': 'runner_not_configured',
      'runner unavailable': 'runner_unavailable',
    };
    const reasonCode = runnerProfileHealth.reasonCode
      ?? safeReasons[runnerProfileHealth.error]
      ?? null;
    console.error(JSON.stringify({ stage: 'profile_runner_health', status: healthResponse.status,
      runnerApi: runnerProfileHealth.runnerApi ?? null, reasonCode }));
    process.exit(1);
  }
}

const response = await fetch(`${baseUrl}/intake`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    contractVersion: 1,
    requestId,
    profileId,
    inputItems: [{ text: `Sandbox contract smoke ${requestId}` }],
    requestedExecutionPolicy: 'accept_only',
  }),
});
const receipt = await response.json();
if (response.status !== 201 || receipt.durable !== true || !receipt.userTaskId || receipt.profileId !== profileId) {
  console.error(JSON.stringify({ stage: 'intake', status: response.status, requestId }));
  process.exit(1);
}

const statusResponse = await fetch(`${baseUrl}/status?taskId=${encodeURIComponent(receipt.userTaskId)}`, { headers });
const status = await statusResponse.json();
if (!statusResponse.ok || status.taskStore?.id !== receipt.userTaskId) {
  console.error(JSON.stringify({ stage: 'status', status: statusResponse.status, requestId, userTaskId: receipt.userTaskId }));
  process.exit(1);
}

const eventsResponse = await fetch(`${baseUrl}/events?taskId=${encodeURIComponent(receipt.userTaskId)}`, { headers });
const events = await eventsResponse.json();
if (!eventsResponse.ok || !Array.isArray(events.events)) {
  console.error(JSON.stringify({ stage: 'events', status: eventsResponse.status, requestId, userTaskId: receipt.userTaskId }));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  endpoint: baseUrl,
  clientSourceSha: process.env.GITHUB_SHA || process.env.GIT_COMMIT || 'local',
  requestId,
  userTaskId: receipt.userTaskId,
  receiptId: receipt.receiptId,
  durable: receipt.durable,
  status: status.taskStore.status,
  eventCount: events.events.length,
  ...(runnerProfileHealth ? { runnerApi: runnerProfileHealth.runnerApi, runnerHealthCached: runnerProfileHealth.cached } : {}),
}));
