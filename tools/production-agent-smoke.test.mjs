import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runProductionAgentSmoke } from './production-agent-smoke.mjs';

const SHA = 'a'.repeat(40);
const SECRET = 'production-smoke-fixture-secret-with-enough-entropy';
const envFor = directory => ({
  CONTROL_PLANE_EXPECTED_BUILD_SHA: SHA,
  PRODUCTION_AGENT_SMOKE_PRINCIPAL_SECRET: `  ${SECRET}\n`,
  RUNNER_API_KEY_AGENT_API: 'production-runner-api-key',
  RUNNER_PROFILE_DELEGATION_SECRET: 'production-runner-delegation-secret',
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '1',
  INTEGRATION_REPORT_FILE: join(directory, 'report.json'),
});
const jsonResponse = (body, init) => Response.json(body, init);

test('production smoke admits, routes and confirms a completed CP-to-Runner task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cp-production-agent-smoke-'));
  const requests = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'trained-assist-runner-api-production.skillset-apply.workers.dev') {
      if (parsed.pathname === '/healthz') return jsonResponse({ service: 'ai-agent-runner-api', placement: 'cloudflare-worker', executionWorker: 'eu-vm-agent-run' });
      if (parsed.pathname === '/version') return jsonResponse({ runtime: 'cloudflare-worker', buildSha: 'b'.repeat(40) });
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), 'Bearer production-runner-api-key');
      assert.equal(headers.get('x-agent-profile-id'), 'production-agent-smoke-v1');
      assert.equal(headers.get('x-agent-profile-tenant'), 'trained-assist-production');
      const expiresAt = headers.get('x-agent-profile-exp');
      const signature = createHmac('sha256', 'production-runner-delegation-secret')
        .update(`cp-production-runner\0trained-assist-production\0production-agent-smoke-v1\0${expiresAt}`).digest('hex');
      assert.equal(headers.get('x-agent-profile-sig'), signature);
      if (parsed.pathname.endsWith('/status')) return jsonResponse({ runId: 'runner-run-1', state: 'succeeded', routeMode: 'gha' });
      if (parsed.pathname.endsWith('/events')) return jsonResponse({ events: [{ sequence: 3, type: 'run_finished', payload: { text: 'do not retain' } }] });
      if (parsed.pathname.endsWith('/result')) return jsonResponse({ runId: 'runner-run-1', outcome: 'succeeded', exitReason: 'completed' });
    }
    const headers = new Headers(init.headers);
    if (parsed.hostname === 'trained-assist-cp-production.skillset-apply.workers.dev') {
      requests.push({ path: parsed.pathname, body: init.body ? JSON.parse(init.body) : null, headers });
    }
    assert.equal(headers.get('x-principal'), 'production-agent-smoke-v1');
    assert.equal(headers.get('x-principal-sig'), createHmac('sha256', SECRET).update('production-agent-smoke-v1').digest('hex'));
    if (parsed.pathname === '/healthz') return jsonResponse({ service: 'trained-assist-control-plane', status: 'healthy', buildSha: SHA });
    if (parsed.pathname === '/intake') return jsonResponse({ durable: true, userTaskId: 'ut-production-smoke', profileId: 'production-agent-smoke-v1' });
    if (parsed.pathname === '/route') return jsonResponse({ route: 'agent', reasonCode: 'COMMUNICATION_SELECTED', continuation: { issued: true } });
    if (parsed.pathname === '/status') return jsonResponse({ taskStore: { status: 'done', profile_id: 'production-agent-smoke-v1' }, runs: [{ status: 'success', session_id: 'runner-run-1' }] });
    if (parsed.pathname === '/events') return jsonResponse({ events: [
      { sequence: 1, type: 'started', kind: 'run_started', runId: 'runner-run-1', payload: { prompt: 'must not leak' } },
    ] });
    throw new Error(`unexpected request ${parsed.pathname}`);
  };
  try {
    const report = await runProductionAgentSmoke(envFor(directory), fetchImpl);
    assert.equal(report.outcome, 'passed');
    assert.equal(report.deployedBuildSha, SHA);
    assert.equal(report.profile, 'production-agent-smoke-v1');
    assert.equal(report.runnerSessionObserved, true);
    assert.equal(report.runnerRunId, 'runner-run-1');
    assert.equal(report.runnerState, 'succeeded');
    assert.deepEqual(report.runnerEventTail, [{ sequence: 3, type: 'run_finished', code: null, phase: null, status: null }]);
    assert.deepEqual(requests.map(request => request.path), ['/healthz', '/intake', '/route', '/status', '/events']);
    assert.equal(requests[1].body.profileId, 'production-agent-smoke-v1');
    assert.equal(requests[1].body.runnerRouteMode, 'gha');
    assert.equal(requests[2].body.continue, true);
    assert.equal(requests[2].body.runnerRouteMode, 'gha');
    assert.equal(report.runnerRouteMode, 'gha');
    const evidence = readFileSync(envFor(directory).INTEGRATION_REPORT_FILE, 'utf8');
    assert.doesNotMatch(evidence, /PRODUCTION_AGENT_SMOKE_PRINCIPAL_SECRET|собеседования|do not retain/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production smoke refuses a mismatched deployment before admitting a task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cp-production-agent-smoke-'));
  let intakeCalled = false;
  const fetchImpl = async url => {
    if (new URL(url).hostname === 'trained-assist-cp-production.skillset-apply.workers.dev'
        && new URL(url).pathname === '/healthz') return jsonResponse({ service: 'trained-assist-control-plane', status: 'healthy', buildSha: 'b'.repeat(40) });
    intakeCalled = true;
    throw new Error('unexpected request');
  };
  try {
    const report = await runProductionAgentSmoke(envFor(directory), fetchImpl);
    assert.equal(report.outcome, 'failed');
    assert.equal(report.reason, 'control_plane_build_sha_mismatch');
    assert.equal(intakeCalled, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production smoke reports signature rejection without exposing principal credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cp-production-agent-smoke-'));
  const fetchImpl = async url => {
    const parsed = new URL(url);
    if (parsed.hostname === 'trained-assist-cp-production.skillset-apply.workers.dev' && parsed.pathname === '/healthz') return jsonResponse({ service: 'trained-assist-control-plane', status: 'healthy', buildSha: SHA });
    if (parsed.hostname === 'trained-assist-runner-api-production.skillset-apply.workers.dev' && parsed.pathname === '/healthz') return jsonResponse({ service: 'ai-agent-runner-api', placement: 'cloudflare-worker', executionWorker: 'eu-vm-agent-run' });
    if (parsed.hostname === 'trained-assist-runner-api-production.skillset-apply.workers.dev' && parsed.pathname === '/version') return jsonResponse({ runtime: 'cloudflare-worker', buildSha: 'b'.repeat(40) });
    return jsonResponse({ name: 'PrincipalUnauthorizedError', error: 'unauthorized principal: (missing)' }, { status: 401 });
  };
  try {
    const report = await runProductionAgentSmoke(envFor(directory), fetchImpl);
    assert.equal(report.outcome, 'failed');
    assert.match(report.reason, /principal_signature_rejected/);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(SECRET));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production smoke cancels an unfinished task at its deadline or on failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cp-production-agent-smoke-'));
  const paths = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const host = new URL(url).hostname;
    if (host === 'trained-assist-runner-api-production.skillset-apply.workers.dev') {
      if (path === '/healthz') return jsonResponse({ service: 'ai-agent-runner-api', placement: 'cloudflare-worker', executionWorker: 'eu-vm-agent-run' });
      if (path === '/version') return jsonResponse({ runtime: 'cloudflare-worker', buildSha: 'b'.repeat(40) });
    }
    paths.push(path);
    if (path === '/healthz') return jsonResponse({ service: 'trained-assist-control-plane', status: 'healthy', buildSha: SHA });
    if (path === '/intake') return jsonResponse({ durable: true, userTaskId: 'ut-production-smoke', profileId: 'production-agent-smoke-v1' });
    if (path === '/route') return jsonResponse({ route: 'agent', reasonCode: 'COMMUNICATION_SELECTED', continuation: { issued: true } });
    if (path === '/status') throw new Error('synthetic status failure');
    if (path === '/events') return jsonResponse({ events: [] });
    if (path === '/cancel') return jsonResponse({ cancelled: true });
    throw new Error(`unexpected request ${path}`);
  };
  try {
    const report = await runProductionAgentSmoke(envFor(directory), fetchImpl);
    assert.equal(report.outcome, 'failed');
    assert.equal(report.cancelRequested, true);
    assert.equal(report.workerTailCapture, 'failed');
    assert.ok(paths.includes('/cancel'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
