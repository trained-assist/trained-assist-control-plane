import { describe, expect, it } from 'vitest';
import { inspectProductionTask, logReferenceKind, redactDiagnosticText } from '../scripts/inspect-production-task.mjs';

const attempt = { id: 'cp-attempt-1', session_id: `run_${'a'.repeat(24)}`, engine: 'azure-cloud', status: 'failed', generation: 2,
  started_at: 1_797_500_000_000, finished_at: 1_797_500_010_000, error_class: 'ENGINE_EXIT_NONZERO', profile_id: 'profile-test' };
const runnerProfileDelegation = { secret: 'delegation-test-secret', principalId: 'cp-production-runner', tenantId: 'trained-assist-production' };

function mockFetch({ includeAttempt = true, includeGatewayRun = false, logUrl = 'https://storage.googleapis.com/private?sig=secret', engine = 'azure-cloud' } = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/d1/database?')) return Response.json({ success: true, result: [{ name: 'opencode-gha-runner-gateway-state', uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] });
    if (url.includes('/d1/database/')) {
      const params = JSON.parse(String(init?.body ?? '{}')).params ?? [];
      const gatewayQuery = params.length > 1;
      return Response.json({ success: true, result: [{ success: true, results: gatewayQuery
        ? includeGatewayRun ? [{ run_id: attempt.session_id, user_task_id: 'ut-abcdefgh1234', github_run_id: 123456, github_repo: 'trained-assist/runner-ring' }] : []
        : includeAttempt ? [attempt] : [] }] });
    }
    if (url.endsWith('/status')) return Response.json({ state: 'failed', engine, routeMode: engine === 'eu-vm-agent-run' ? 'auto' : 'gha', workerStartPhase: 'ready', workerStartAttempts: 1 });
    if (url.endsWith('/result')) return Response.json({ outcome: 'failed', exitReason: 'agent_exited_nonzero', exitCode: 17, exitSignal: null,
      exitObserved: true, failure: { code: 'ENGINE_EXIT_NONZERO', failureClass: 'engine_failure', safeSummary: 'Agent process exited with code 17', retryable: false } });
    if (url.includes('/events?')) return Response.json({ events: [{ sequence: 7, timestamp: '2026-10-16T00:00:00Z', type: 'log', payload: { stream: 'stderr', message: 'token=sk-' + 'x'.repeat(30) } }], resetRequired: false });
    if (url.includes('/logs?after=0')) return new Response('event: stdout\ndata: "agent output"\n\nevent: stderr\ndata: "token=sk-' + 'x'.repeat(30) + '"\n\n', { status: 200 });
    if (url.endsWith('/artifacts')) return Response.json({ artifacts: [], logUrl });
    if (url.startsWith('https://storage.googleapis.com/')) return new Response(`Runner diagnostic\nBearer ${'b'.repeat(32)}\nexitCode=17`, { status: 200 });
    throw new Error(`unexpected request: ${url}`);
  };
  return { fetchImpl, calls };
}

describe('production task diagnostics', () => {
  it('requires a CP task id and redacts credentials from event text', async () => {
    await expect(inspectProductionTask({ taskId: 'run_wrong', accountId: 'a'.repeat(32), apiToken: 't'.repeat(32), runnerApiKey: 'r'.repeat(32) }))
      .rejects.toThrow('invalid_task_id');
    expect(redactDiagnosticText(`Bearer ${'b'.repeat(32)} sk-${'x'.repeat(30)}`)).toContain('[REDACTED]');
    expect(redactDiagnosticText(`Bearer ${'b'.repeat(32)} sk-${'x'.repeat(30)}`)).not.toContain('x'.repeat(30));
  });

  it('does not call internal and local log references downloadable logs', () => {
    expect(logReferenceKind(`worker-run:${attempt.session_id}`)).toBe('runner_internal');
    expect(logReferenceKind(`local://runs/${attempt.session_id}/logs`)).toBe('worker_local');
    expect(logReferenceKind('https://storage.googleapis.com/bucket/run.log')).toBe('google_storage');
  });

  it('maps task attempts to Runner IDs and omits log text unless explicitly requested', async () => {
    const { fetchImpl, calls } = mockFetch();
    const report = await inspectProductionTask({ taskId: 'ut-abcdefgh1234', accountId: 'a'.repeat(32), databaseId: 'd'.repeat(36), apiToken: 't'.repeat(32),
      runnerApiKey: 'r'.repeat(32), runnerProfileDelegation, fetchImpl });

    expect(report.attemptCount).toBe(1);
    expect(report.attempts[0]).toMatchObject({ controlPlaneAttemptId: 'cp-attempt-1', runnerRunId: attempt.session_id,
      runner: { routeMode: 'gha', result: { exitCode: 17, failure: { code: 'ENGINE_EXIT_NONZERO' } }, logAvailable: true,
        logEvents: [{ stream: 'stderr', messageAvailable: true }] } });
    expect(JSON.stringify(report)).not.toContain('sk-' + 'x'.repeat(30));
    expect(calls.some((call) => call.url.endsWith('/status'))).toBe(true);
    const statusCall = calls.find((call) => call.url.endsWith('/status'));
    const headers = new Headers(statusCall.init.headers);
    expect(headers.get('x-agent-profile-id')).toBe('profile-test');
    expect(headers.get('x-agent-profile-tenant')).toBe('trained-assist-production');
    const expiresAt = headers.get('x-agent-profile-exp');
    const { createHmac } = await import('node:crypto');
    expect(headers.get('x-agent-profile-sig')).toBe(createHmac('sha256', runnerProfileDelegation.secret)
      .update(`cp-production-runner\0trained-assist-production\0profile-test\0${expiresAt}`).digest('hex'));
    expect(calls.some((call) => call.url.startsWith('https://storage.googleapis.com/'))).toBe(false);
    const d1Call = calls.find((call) => call.url.includes('/d1/database/') && call.init?.method === 'POST');
    expect(JSON.parse(String(d1Call.init?.body)).params).toEqual(['ut-abcdefgh1234']);
  });

  it('maps GHA-backed attempts to their exact Actions run without reading task content', async () => {
    const { fetchImpl, calls } = mockFetch({ includeGatewayRun: true });
    const report = await inspectProductionTask({ taskId: 'ut-abcdefgh1234', accountId: 'a'.repeat(32), databaseId: 'd'.repeat(36), apiToken: 't'.repeat(32),
      runnerApiKey: 'r'.repeat(32), runnerProfileDelegation, fetchImpl });
    expect(report.attempts[0].runner.githubActionsRun).toEqual({
      repository: 'trained-assist/runner-ring', runId: 123456,
      url: 'https://github.com/trained-assist/runner-ring/actions/runs/123456',
      logArtifactName: `session-log-${attempt.session_id}`,
    });
    const gatewayQuery = calls.map((call) => call.init?.body).filter(Boolean).map((body) => JSON.parse(String(body)))
      .find((body) => body.sql?.includes('gateway_runs'));
    expect(gatewayQuery.params).toEqual(['ut-abcdefgh1234', attempt.session_id]);
    expect(gatewayQuery.sql).not.toContain('input');
  });

  it('reports an internal Runner reference as unavailable instead of treating the placeholder as a log', async () => {
    const { fetchImpl } = mockFetch({ logUrl: `worker-run:${attempt.session_id}` });
    const report = await inspectProductionTask({ taskId: 'ut-abcdefgh1234', accountId: 'a'.repeat(32), databaseId: 'd'.repeat(36), apiToken: 't'.repeat(32),
      runnerApiKey: 'r'.repeat(32), runnerProfileDelegation, fetchImpl });
    expect(report.attempts[0].runner).toMatchObject({ logReferenceKind: 'runner_internal', logAvailable: false });
  });

  it('includes redacted log text only when explicitly requested', async () => {
    const { fetchImpl } = mockFetch();
    const report = await inspectProductionTask({ taskId: 'ut-abcdefgh1234', accountId: 'a'.repeat(32), databaseId: 'd'.repeat(36), apiToken: 't'.repeat(32),
      runnerApiKey: 'r'.repeat(32), runnerProfileDelegation, includeLogs: true, fetchImpl });
    expect(report.includesRedactedLogText).toBe(true);
    expect(report.attempts[0]?.runner.logEvents[0]?.message).toContain('[REDACTED_API_KEY]');
    expect(report.attempts[0]?.runner.savedLog).toMatchObject({ fetched: true, host: 'storage.googleapis.com', httpStatus: 200 });
    expect(report.attempts[0]?.runner.savedLog.text).toContain('[REDACTED]');
    expect(report.attempts[0]?.runner.savedLog.text).toContain('exitCode=17');
    expect(report.attempts[0]?.runner.savedLog.text).not.toContain('Bearer ' + 'b'.repeat(32));
  });

  it('fetches bounded, redacted logs from the VM worker for VM-run attempts', async () => {
    const { fetchImpl, calls } = mockFetch({ engine: 'eu-vm-agent-run', logUrl: `local://runs/${attempt.session_id}/logs` });
    const report = await inspectProductionTask({ taskId: 'ut-abcdefgh1234', accountId: 'a'.repeat(32), databaseId: 'd'.repeat(36), apiToken: 't'.repeat(32),
      runnerApiKey: 'r'.repeat(32), runnerProfileDelegation, vmWorkerUrl: 'https://vm.example.test', vmWorkerToken: 'v'.repeat(32), includeLogs: true, fetchImpl });
    expect(report.attempts[0]?.runner.workerLog).toMatchObject({ fetched: true, httpStatus: 200, stdoutChars: 12, stderrChars: 24 });
    expect(report.attempts[0]?.runner.workerLog.text).toContain('[REDACTED_API_KEY]');
    expect(report.attempts[0]?.runner.workerLog.text).not.toContain('x'.repeat(30));
    const workerCall = calls.find((call) => call.url.includes('/logs?after=0'));
    expect(workerCall?.url).toContain(`/v1/runs/${attempt.session_id}/logs?after=0`);
    expect(new Headers(workerCall?.init.headers).get('authorization')).toBe(`Bearer ${'v'.repeat(32)}`);
  });

  it('returns a valid report when the task has no execution attempts', async () => {
    const { fetchImpl } = mockFetch({ includeAttempt: false });
    const report = await inspectProductionTask({ taskId: 'ut-abcdefgh1234', accountId: 'a'.repeat(32), databaseId: 'd'.repeat(36), apiToken: 't'.repeat(32),
      runnerApiKey: 'r'.repeat(32), runnerProfileDelegation, fetchImpl });
    expect(report).toEqual({ schemaVersion: 1, taskId: 'ut-abcdefgh1234', attemptCount: 0, includesRedactedLogText: false, attempts: [] });
  });
});
