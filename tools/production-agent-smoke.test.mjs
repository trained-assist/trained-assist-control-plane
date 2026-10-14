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
  PRODUCTION_AGENT_SMOKE_PRINCIPAL_SECRET: SECRET,
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '1',
  INTEGRATION_REPORT_FILE: join(directory, 'report.json'),
});
const jsonResponse = body => Response.json(body);

test('production smoke admits, routes and confirms a completed CP-to-Runner task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cp-production-agent-smoke-'));
  const requests = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const headers = new Headers(init.headers);
    requests.push({ path: parsed.pathname, body: init.body ? JSON.parse(init.body) : null, headers });
    assert.equal(headers.get('x-principal'), 'production-agent-smoke-v1');
    assert.equal(headers.get('x-principal-sig'), createHmac('sha256', SECRET).update('production-agent-smoke-v1').digest('hex'));
    if (parsed.pathname === '/healthz') return jsonResponse({ service: 'trained-assist-control-plane', status: 'healthy', buildSha: SHA });
    if (parsed.pathname === '/intake') return jsonResponse({ durable: true, userTaskId: 'ut-production-smoke' });
    if (parsed.pathname === '/route') return jsonResponse({ route: 'agent', reasonCode: 'COMMUNICATION_SELECTED', continuation: { issued: true } });
    if (parsed.pathname === '/status') return jsonResponse({ taskStore: { status: 'done' }, runs: [{ status: 'success', session_id: 'runner-run-1' }] });
    throw new Error(`unexpected request ${parsed.pathname}`);
  };
  try {
    const report = await runProductionAgentSmoke(envFor(directory), fetchImpl);
    assert.equal(report.outcome, 'passed');
    assert.equal(report.deployedBuildSha, SHA);
    assert.equal(report.profile, 'production-agent-smoke-v1');
    assert.equal(report.runnerSessionObserved, true);
    assert.deepEqual(requests.map(request => request.path), ['/healthz', '/intake', '/route', '/status']);
    assert.equal(requests[1].body.profileId, 'production-agent-smoke-v1');
    assert.equal(requests[2].body.continue, true);
    const evidence = readFileSync(envFor(directory).INTEGRATION_REPORT_FILE, 'utf8');
    assert.doesNotMatch(evidence, /PRODUCTION_AGENT_SMOKE_PRINCIPAL_SECRET|собеседования/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production smoke refuses a mismatched deployment before admitting a task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cp-production-agent-smoke-'));
  let intakeCalled = false;
  const fetchImpl = async url => {
    if (new URL(url).pathname === '/healthz') return jsonResponse({ service: 'trained-assist-control-plane', status: 'healthy', buildSha: 'b'.repeat(40) });
    intakeCalled = true;
    throw new Error('unexpected request');
  };
  try {
    const report = await runProductionAgentSmoke(envFor(directory), fetchImpl);
    assert.equal(report.outcome, 'failed');
    assert.match(report.reason, /does not match/);
    assert.equal(intakeCalled, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production smoke cancels an unfinished task at its deadline or on failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cp-production-agent-smoke-'));
  const paths = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === '/healthz') return jsonResponse({ service: 'trained-assist-control-plane', status: 'healthy', buildSha: SHA });
    if (path === '/intake') return jsonResponse({ durable: true, userTaskId: 'ut-production-smoke' });
    if (path === '/route') return jsonResponse({ route: 'agent', reasonCode: 'COMMUNICATION_SELECTED', continuation: { issued: true } });
    if (path === '/status') throw new Error('synthetic status failure');
    if (path === '/cancel') return jsonResponse({ cancelled: true });
    throw new Error(`unexpected request ${path}`);
  };
  try {
    const report = await runProductionAgentSmoke(envFor(directory), fetchImpl);
    assert.equal(report.outcome, 'failed');
    assert.equal(report.cancelRequested, true);
    assert.ok(paths.includes('/cancel'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
