#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = 'https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev';
const OUTPUT = join(process.env.GITHUB_WORKSPACE ?? process.cwd(), 'sandbox3-live-free-run-evidence.json');
const TIMEOUT_MS = 180_000;
const MAX_WAIT_MS = TIMEOUT_MS + 20_000;
const MAX_BYTES = 64 * 1024;

const evidence = {
  schemaVersion: 1,
  mode: 'sandbox3-live-free-run-smoke',
  outcome: 'failed',
  runnerApi: 'trained-assist-runner-api-sandbox3',
  runnerApiBuildSha: null,
  executionWorker: null,
  profileBinding: 'integration-sandbox3-v1',
  modelRungRequested: 'free',
  timeoutMs: TIMEOUT_MS,
  maxOutputBytes: MAX_BYTES,
  userTaskId: null,
  runId: null,
  idempotentReceipt: null,
  state: null,
  outcomeValue: null,
  exitReason: null,
  answerMatches: false,
  answerLength: null,
  answerSha256: null,
  usageStatus: null,
  persistence: null,
  cleanup: null,
  failureCode: null,
};

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function safeFailureCode(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_:-]{0,79}$/.test(value) ? value : fallback;
}

async function request(path, { method = 'GET', body, idempotencyKey, signal } = {}) {
  const headers = { 'cache-control': 'no-store' };
  if (method !== 'GET') headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  Object.assign(headers, {
    authorization: `Bearer ${requiredEnv('RUNNER_API_KEY_AGENT_API')}`,
  });
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(10_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error('runner_api_request_failed');
  }
  const raw = await response.text();
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch { /* keep only bounded status evidence */ }
  return { response, json };
}

async function verifyRoute() {
  const [health, version, capabilities] = await Promise.all([
    fetch(`${BASE}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(10_000) }),
    fetch(`${BASE}/version`, { redirect: 'error', signal: AbortSignal.timeout(10_000) }),
    request('/v1/capabilities'),
  ]);
  const healthBody = await health.json().catch(() => null);
  const versionBody = await version.json().catch(() => null);
  if (!health.ok || healthBody?.service !== 'ai-agent-runner-api'
      || healthBody?.placement !== 'cloudflare-worker'
      || healthBody?.executionWorker !== 'eu-vm-agent-run') throw new Error('runner_api_route_mismatch');
  if (!version.ok || versionBody?.runtime !== 'cloudflare-worker') throw new Error('runner_api_version_unavailable');
  if (!capabilities.response.ok || capabilities.json?.contract?.name !== 'ai-agent-runner/serverless-agent-api'
      || capabilities.json?.placement !== 'cloudflare-worker'
      || !capabilities.json?.executionRegions?.includes('eu-vm-agent-run')) throw new Error('runner_api_profile_not_authorized');
  evidence.runnerApiBuildSha = /^[a-f0-9]{40}$/.test(versionBody.buildSha ?? '') ? versionBody.buildSha : null;
  evidence.executionWorker = healthBody.executionWorker;
}

function stableIds() {
  const workflowRunId = process.env.GITHUB_RUN_ID;
  if (!/^\d{1,30}$/.test(workflowRunId ?? '')) throw new Error('sandbox3_live_run_id_missing');
  const id = `sandbox3-free-${workflowRunId}`;
  evidence.userTaskId = id;
  return { id, idempotencyKey: `sandbox3-live-free-${workflowRunId}` };
}

async function submit(input, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await request('/v1/runs', {
        method: 'POST', body, idempotencyKey: input.idempotencyKey,
      });
      if (result.response.ok) {
        if (!/^run_[a-f0-9]{64}_[a-f0-9]{24}$/.test(result.json?.runId ?? '')
            || result.json?.userTaskId !== input.id) throw new Error('runner_receipt_invalid');
        evidence.runId = result.json.runId;
        evidence.idempotentReceipt = result.json.deduplicated === true;
        return;
      }
      const code = safeFailureCode(result.json?.error?.code, `http_${result.response.status}`);
      if ((result.response.status >= 500 || result.response.status === 429) && attempt === 0) continue;
      throw new Error(code);
    } catch (error) {
      const code = safeFailureCode(error?.message, 'runner_api_submit_failed');
      if (code === 'runner_api_request_failed' && attempt === 0) continue;
      throw new Error(code);
    }
  }
  throw new Error('runner_api_submit_outcome_unknown');
}

async function observe(runId, expectedAnswer) {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    let current;
    try {
      current = await request(`/v1/runs/${encodeURIComponent(runId)}/status`);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      continue;
    }
    if (!current.response.ok || !['queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(current.json?.state)) {
      throw new Error(safeFailureCode(current.json?.error?.code, `status_http_${current.response.status}`));
    }
    evidence.state = current.json.state;
    if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(current.json.state)) break;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  if (!evidence.state || ['queued', 'starting', 'running'].includes(evidence.state)) {
    evidence.state = 'unknown';
    throw new Error('runner_run_observation_timeout');
  }
  if (evidence.state === 'unknown') throw new Error('runner_run_outcome_unknown');
  const result = await request(`/v1/runs/${encodeURIComponent(runId)}/result`);
  if (!result.response.ok || !result.json || typeof result.json !== 'object') {
    throw new Error(safeFailureCode(result.json?.error?.code, `result_http_${result.response.status}`));
  }
  const text = typeof result.json.text === 'string' ? result.json.text.trim() : '';
  evidence.outcomeValue = ['succeeded', 'failed', 'cancelled'].includes(result.json.outcome) ? result.json.outcome : null;
  evidence.exitReason = safeFailureCode(result.json.exitReason, 'unknown_exit_reason');
  evidence.answerMatches = text === expectedAnswer;
  evidence.answerLength = text.length;
  evidence.answerSha256 = createHash('sha256').update(text).digest('hex');
  evidence.usageStatus = result.json.usage?.status === 'known' ? 'known' : 'unknown';
  evidence.persistence = ['pending', 'persisted', 'failed', 'not_required'].includes(result.json.persistence)
    ? result.json.persistence : null;
  evidence.cleanup = ['pending', 'completed', 'failed'].includes(result.json.cleanup) ? result.json.cleanup : null;
  if (evidence.outcomeValue !== 'succeeded') throw new Error('runner_run_failed');
  if (!evidence.answerMatches) throw new Error('runner_answer_mismatch');
}

async function main() {
  try {
    await verifyRoute();
    const input = stableIds();
    const expectedAnswer = `sandbox3-free-ok-${input.id}`;
    const body = {
      userTaskId: input.id,
      conversationId: input.id,
      engine: { name: 'eu-vm-agent-run', adapterVersion: '1', modelSettings: { model: 'free' } },
      input: { inlinePrompt: `Reply with exactly ${expectedAnswer} and no other text. Do not call tools or modify files.` },
      envAllowlist: ['LLM_LADDER_TOKEN'],
      limits: { timeoutMs: TIMEOUT_MS, maxOutputBytes: MAX_BYTES, maxLogBytes: MAX_BYTES },
    };
    await submit(input, body);
    await observe(evidence.runId, expectedAnswer);
    evidence.outcome = 'passed';
  } catch (error) {
    evidence.failureCode = safeFailureCode(error?.message, 'sandbox3_live_free_run_failed');
    if (evidence.state === 'queued' || evidence.state === 'starting' || evidence.state === 'running') evidence.state = 'unknown';
  } finally {
    await writeFile(OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (evidence.outcome !== 'passed') process.exitCode = 1;
}

await main();
