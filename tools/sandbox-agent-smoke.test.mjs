import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runControlPlaneAgentSmoke } from './control-plane-agent-smoke.mjs';
import { SANDBOX_AGENT_SMOKE } from './sandbox-agent-smoke.mjs';

const SHA = 'a'.repeat(40);
const SECRET = 'sandbox-principal-secret-fixture-long-enough';

test('sandbox agent smoke checks profile route and captures only the Runner event tail', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cp-sandbox-agent-smoke-'));
  const reportFile = join(directory, 'report.json');
  const env = { CONTROL_PLANE_EXPECTED_BUILD_SHA: SHA, CP_TELEGRAM_UX_PRINCIPAL_SECRET: ` ${SECRET}\n`,
    RUNNER_API_KEY_AGENT_API: 'sandbox-runner-api-key', RUNNER_PROFILE_DELEGATION_SECRET: 'sandbox-runner-delegation-secret',
    GITHUB_RUN_ID: '98765', GITHUB_RUN_ATTEMPT: '1', INTEGRATION_REPORT_FILE: reportFile };
  const paths = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === new URL(SANDBOX_AGENT_SMOKE.baseUrl).hostname) paths.push(parsed.pathname);
    if (parsed.hostname === new URL(SANDBOX_AGENT_SMOKE.runnerApiUrl).hostname) {
      if (parsed.pathname === '/healthz') return Response.json({ service: 'ai-agent-runner-api', placement: 'cloudflare-worker', executionWorker: 'eu-vm-agent-run' });
      if (parsed.pathname === '/version') return Response.json({ runtime: 'cloudflare-worker', buildSha: 'b'.repeat(40) });
      const runnerHeaders = new Headers(init.headers);
      assert.equal(runnerHeaders.get('authorization'), 'Bearer sandbox-runner-api-key');
      assert.equal(runnerHeaders.get('x-agent-profile-id'), SANDBOX_AGENT_SMOKE.runnerProfile);
      assert.equal(runnerHeaders.get('x-agent-profile-tenant'), SANDBOX_AGENT_SMOKE.runnerTenant);
      const expiresAt = runnerHeaders.get('x-agent-profile-exp');
      const runnerSignature = createHmac('sha256', 'sandbox-runner-delegation-secret')
        .update(`${SANDBOX_AGENT_SMOKE.runnerPrincipal}\0${SANDBOX_AGENT_SMOKE.runnerTenant}\0${SANDBOX_AGENT_SMOKE.runnerProfile}\0${expiresAt}`).digest('hex');
      assert.equal(runnerHeaders.get('x-agent-profile-sig'), runnerSignature);
      if (parsed.pathname.endsWith('/status')) return Response.json({ runId: 'run_sandbox_agent_1', state: 'succeeded' });
      if (parsed.pathname.endsWith('/events')) return Response.json({ events: [{ sequence: 4, type: 'completed', payload: { output: 'do not retain' } }] });
      if (parsed.pathname.endsWith('/result')) return Response.json({ runId: 'run_sandbox_agent_1', outcome: 'succeeded', exitReason: 'completed' });
    }
    const headers = new Headers(init.headers);
    assert.equal(headers.get('x-principal'), SANDBOX_AGENT_SMOKE.principal);
    assert.equal(headers.get('x-principal-sig'), createHmac('sha256', SECRET).update(SANDBOX_AGENT_SMOKE.principal).digest('hex'));
    if (parsed.pathname === '/healthz') return Response.json({ service: 'trained-assist-control-plane', status: 'healthy', buildSha: SHA });
    if (parsed.pathname === '/intake') {
      const body = JSON.parse(init.body);
      assert.equal(body.profileId, SANDBOX_AGENT_SMOKE.profile);
      assert.match(body.requestId, /^sandbox-agent-smoke-/);
      return Response.json({ durable: true, userTaskId: 'ut-sandbox-smoke', profileId: SANDBOX_AGENT_SMOKE.profile });
    }
    if (parsed.pathname === '/route') return Response.json({ route: 'agent', reasonCode: 'COMMUNICATION_SELECTED', continuation: { issued: true } });
    if (parsed.pathname === '/status') return Response.json({ taskStore: { status: 'done', profile_id: SANDBOX_AGENT_SMOKE.profile },
      runs: [{ status: 'success', session_id: 'run_sandbox_agent_1' }] });
    if (parsed.pathname === '/events') return Response.json({ events: [
      { sequence: 10, type: 'started', kind: 'run_started', runId: 'run_sandbox_agent_1', payload: { text: 'must not be included' } },
      { sequence: 11, type: 'progress', kind: 'runner_event', runId: 'run_sandbox_agent_1', payload: { output: 'must not be included' } },
    ] });
    throw new Error(`unexpected ${parsed.pathname}`);
  };
  try {
    const report = await runControlPlaneAgentSmoke(SANDBOX_AGENT_SMOKE, env, fetchImpl);
    assert.equal(report.outcome, 'passed');
    assert.equal(report.deployedBuildSha, SHA);
    assert.equal(report.route, 'agent');
    assert.equal(report.taskStatus, 'done');
    assert.equal(report.runCount, 1);
    assert.equal(report.runnerRunId, 'run_sandbox_agent_1');
    assert.equal(report.executionWorker, 'eu-vm-agent-run');
    assert.equal(report.runnerApiBuildSha, 'b'.repeat(40));
    assert.equal(report.runnerState, 'succeeded');
    assert.equal(report.controlPlaneEventCount, 2);
    assert.equal(report.runnerEventCount, 1);
    assert.equal(report.workerTailCapture, 'captured');
    assert.deepEqual(paths, ['/healthz', '/intake', '/route', '/status', '/events']);
    const saved = readFileSync(reportFile, 'utf8');
    assert.doesNotMatch(saved, new RegExp(SECRET));
    assert.doesNotMatch(saved, /must not be included|do not retain/);
    assert.match(saved, /run_sandbox_agent_1/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('sandbox agent smoke fails closed on a missing Runner event tail', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cp-sandbox-agent-smoke-'));
  const env = { CONTROL_PLANE_EXPECTED_BUILD_SHA: SHA, CP_TELEGRAM_UX_PRINCIPAL_SECRET: SECRET,
    RUNNER_API_KEY_AGENT_API: 'sandbox-runner-api-key', RUNNER_PROFILE_DELEGATION_SECRET: 'sandbox-runner-delegation-secret',
    GITHUB_RUN_ID: '98766', INTEGRATION_REPORT_FILE: join(directory, 'report.json') };
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    if (new URL(url).hostname === new URL(SANDBOX_AGENT_SMOKE.runnerApiUrl).hostname) {
      if (path === '/healthz') return Response.json({ service: 'ai-agent-runner-api', placement: 'cloudflare-worker', executionWorker: 'eu-vm-agent-run' });
      if (path === '/version') return Response.json({ runtime: 'cloudflare-worker', buildSha: 'b'.repeat(40) });
      if (path.endsWith('/status')) return Response.json({ runId: 'run_sandbox_agent_1', state: 'succeeded' });
      if (path.endsWith('/events')) return Response.json({ events: [] });
      if (path.endsWith('/result')) return Response.json({ runId: 'run_sandbox_agent_1', outcome: 'succeeded' });
    }
    if (path === '/healthz') return Response.json({ service: 'trained-assist-control-plane', status: 'healthy', buildSha: SHA });
    if (path === '/intake') return Response.json({ durable: true, userTaskId: 'ut-sandbox-smoke', profileId: SANDBOX_AGENT_SMOKE.profile });
    if (path === '/route') return Response.json({ route: 'agent', continuation: { issued: true } });
    if (path === '/status') return Response.json({ taskStore: { status: 'done', profile_id: SANDBOX_AGENT_SMOKE.profile },
      runs: [{ status: 'success', session_id: 'run_sandbox_agent_1' }] });
    if (path === '/events') return Response.json({ events: [] });
    throw new Error(`unexpected ${path}`);
  };
  try {
    const report = await runControlPlaneAgentSmoke(SANDBOX_AGENT_SMOKE, env, fetchImpl);
    assert.equal(report.outcome, 'failed');
    assert.equal(report.reason, 'worker_tail_missing_runner_run');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('sandbox agent smoke preserves the failed Runner tail before requesting cancellation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cp-sandbox-agent-smoke-'));
  const env = { CONTROL_PLANE_EXPECTED_BUILD_SHA: SHA, CP_TELEGRAM_UX_PRINCIPAL_SECRET: SECRET,
    RUNNER_API_KEY_AGENT_API: 'sandbox-runner-api-key', RUNNER_PROFILE_DELEGATION_SECRET: 'sandbox-runner-delegation-secret',
    GITHUB_RUN_ID: '98767', INTEGRATION_REPORT_FILE: join(directory, 'report.json') };
  const runnerHost = new URL(SANDBOX_AGENT_SMOKE.runnerApiUrl).hostname;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === runnerHost) {
      if (parsed.pathname === '/healthz') return Response.json({ service: 'ai-agent-runner-api', placement: 'cloudflare-worker', executionWorker: 'eu-vm-agent-run' });
      if (parsed.pathname === '/version') return Response.json({ runtime: 'cloudflare-worker', buildSha: 'b'.repeat(40) });
      if (parsed.pathname.endsWith('/status')) return Response.json({ runId: 'run_failed_1', state: 'failed' });
      if (parsed.pathname.endsWith('/events')) return Response.json({ events: [{ sequence: 8, type: 'failed', payload: { code: 'TIMEOUT' } }] });
      if (parsed.pathname.endsWith('/result')) return Response.json({ runId: 'run_failed_1', outcome: 'failed', exitReason: 'timeout' });
    }
    if (parsed.pathname === '/healthz') return Response.json({ service: 'trained-assist-control-plane', status: 'healthy', buildSha: SHA });
    if (parsed.pathname === '/intake') return Response.json({ durable: true, userTaskId: 'ut-failed', profileId: SANDBOX_AGENT_SMOKE.profile });
    if (parsed.pathname === '/route') return Response.json({ route: 'agent', continuation: { issued: true } });
    if (parsed.pathname === '/status') return Response.json({ taskStore: { status: 'failed', profile_id: SANDBOX_AGENT_SMOKE.profile },
      runs: [{ status: 'failed', session_id: 'run_failed_1' }] });
    if (parsed.pathname === '/events') return Response.json({ events: [
      { sequence: 12, type: 'attempt_failed', kind: 'run_finished', runId: 'run_failed_1', payload: { userText: 'do not retain' } },
    ] });
    if (parsed.pathname === '/cancel') return Response.json({ cancelled: true });
    throw new Error(`unexpected ${parsed.pathname}`);
  };
  try {
    const report = await runControlPlaneAgentSmoke(SANDBOX_AGENT_SMOKE, env, fetchImpl);
    assert.equal(report.outcome, 'failed');
    assert.equal(report.reason, 'agent_task_failed');
    assert.equal(report.runnerRunId, 'run_failed_1');
    assert.equal(report.runnerState, 'failed');
    assert.equal(report.runnerExitReason, 'timeout');
    assert.equal(report.workerTailCapture, 'captured');
    assert.equal(report.cancelRequested, true);
    const saved = readFileSync(env.INTEGRATION_REPORT_FILE, 'utf8');
    assert.doesNotMatch(saved, /do not retain/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
