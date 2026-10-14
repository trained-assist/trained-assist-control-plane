import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PRINCIPAL = 'production-agent-smoke-v1';
const PROFILE = 'production-agent-smoke-v1';
const CONTROL_PLANE = 'https://trained-assist-cp-production.skillset-apply.workers.dev';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function validSha(value) { return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value); }

export async function runProductionAgentSmoke(environment = process.env, fetchImpl = fetch) {
  const expectedBuildSha = environment.CONTROL_PLANE_EXPECTED_BUILD_SHA;
  const secret = environment.PRODUCTION_AGENT_SMOKE_PRINCIPAL_SECRET;
  const reportFile = environment.INTEGRATION_REPORT_FILE;
  const runKey = environment.GITHUB_RUN_ID ?? randomUUID();
  const report = { outcome: 'failed', profile: PROFILE, startedAt: new Date().toISOString(), expectedBuildSha };
  const save = () => {
    if (reportFile) writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  };
  let taskId;
  let taskCompleted = false;

  try {
    assert.ok(validSha(expectedBuildSha), 'expected CP build SHA must be a full Git SHA');
    assert.ok(typeof secret === 'string' && secret.length >= 32, 'production smoke principal secret is missing');
    assert.ok(reportFile, 'INTEGRATION_REPORT_FILE is required');
    const base = new URL(CONTROL_PLANE);
    const signature = createHmac('sha256', secret).update(PRINCIPAL).digest('hex');
    const requestId = `production-agent-smoke-${runKey}-${environment.GITHUB_RUN_ATTEMPT ?? '1'}`;

    const call = async (path, body, timeoutMs = 20_000) => {
      const response = await fetchImpl(new URL(path, base), {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          'x-principal': PRINCIPAL, 'x-principal-sig': signature },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
      const parsed = await response.json();
      assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${path} returned invalid JSON`);
      return parsed;
    };

    const health = await call('/healthz');
    assert.equal(health.service, 'trained-assist-control-plane');
    assert.equal(health.status, 'healthy');
    assert.equal(health.buildSha, expectedBuildSha, 'live production CP revision does not match the requested build');
    report.deployedBuildSha = health.buildSha;

    const envelope = {
      contractVersion: 1,
      requestId,
      profileId: PROFILE,
      conversationRef: requestId,
      sessionId: requestId,
      inputItems: [{ text: 'Составь три коротких нейтральных вопроса для собеседования. Не используй инструменты.' }],
    };
    const receipt = await call('/intake', envelope, 60_000);
    assert.equal(receipt.durable, true);
    assert.ok(typeof receipt.userTaskId === 'string' && receipt.userTaskId.length > 0);
    taskId = receipt.userTaskId;
    report.userTaskId = taskId;

    const route = await call('/route', { taskId, continue: true }, 90_000);
    assert.equal(route.route, 'agent');
    assert.equal(route.reasonCode, 'COMMUNICATION_SELECTED');
    assert.equal(route.continuation?.issued, true);
    report.route = route.route;
    report.continuationIssued = route.continuation.issued;

    const deadline = Date.now() + 8 * 60_000;
    let state;
    while (Date.now() < deadline) {
      state = await call('/status', { taskId }, 30_000);
      const task = state.taskStore;
      if (task?.status === 'done') {
        taskCompleted = true;
        const successfulRunnerRun = Array.isArray(state.runs)
          && state.runs.some(run => run.status === 'success' && typeof run.session_id === 'string' && run.session_id.length > 0);
        assert.ok(successfulRunnerRun, 'CP task completed without a successful Runner API session receipt');
        report.taskStatus = task.status;
        report.runCount = state.runs.length;
        report.runnerSessionObserved = true;
        report.outcome = 'passed';
        break;
      }
      if (['failed', 'cancelled'].includes(task?.status)) {
        report.taskStatus = task.status;
        throw new Error(`agent task reached terminal status ${task.status}`);
      }
      await sleep(3_000);
    }
    if (!taskCompleted) {
      report.taskStatus = state?.taskStore?.status ?? 'unknown';
      throw new Error('agent task did not complete before the 8 minute deadline');
    }
  } catch (error) {
    report.reason = error instanceof Error ? error.message : 'production smoke failed';
  } finally {
    if (taskId && !taskCompleted) {
      try {
        const response = await fetchImpl(new URL('/cancel', CONTROL_PLANE), {
          method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', 'x-principal': PRINCIPAL,
            'x-principal-sig': createHmac('sha256', secret ?? '').update(PRINCIPAL).digest('hex') },
          body: JSON.stringify({ taskId, reason: 'production_agent_smoke_deadline_or_failure' }),
          signal: AbortSignal.timeout(20_000),
        });
        report.cancelRequested = response.ok;
      } catch { report.cancelRequested = false; }
    }
    report.finishedAt = new Date().toISOString();
    save();
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runProductionAgentSmoke();
  console.log(JSON.stringify(report));
  if (report.outcome !== 'passed') process.exitCode = 1;
}
