import { describe, expect, it } from 'vitest';
import { inspectProductionTask, redactDiagnosticText } from '../scripts/inspect-production-task.mjs';

const attempt = { id: 'cp-attempt-1', session_id: `run_${'a'.repeat(24)}`, engine: 'azure-cloud', status: 'failed', generation: 2,
  started_at: 1_797_500_000_000, finished_at: 1_797_500_010_000, error_class: 'ENGINE_EXIT_NONZERO' };

function mockFetch({ includeAttempt = true } = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/d1/database/')) return Response.json({ success: true, result: [{ success: true, results: includeAttempt ? [attempt] : [] }] });
    if (url.endsWith('/status')) return Response.json({ state: 'failed', engine: 'azure-cloud', routeMode: 'gha', workerStartPhase: 'ready', workerStartAttempts: 1 });
    if (url.endsWith('/result')) return Response.json({ outcome: 'failed', exitReason: 'agent_exited_nonzero', exitCode: 17, exitSignal: null,
      exitObserved: true, failure: { code: 'ENGINE_EXIT_NONZERO', failureClass: 'engine_failure', safeSummary: 'Agent process exited with code 17', retryable: false } });
    if (url.includes('/events?')) return Response.json({ events: [{ sequence: 7, timestamp: '2026-10-16T00:00:00Z', type: 'log', payload: { stream: 'stderr', message: 'token=sk-' + 'x'.repeat(30) } }], resetRequired: false });
    if (url.endsWith('/artifacts')) return Response.json({ artifacts: [], logUrl: 'https://storage.example/private?sig=secret' });
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

  it('maps task attempts to Runner IDs and omits log text unless explicitly requested', async () => {
    const { fetchImpl, calls } = mockFetch();
    const report = await inspectProductionTask({ taskId: 'ut-abcdefgh1234', accountId: 'a'.repeat(32), databaseId: 'd'.repeat(36), apiToken: 't'.repeat(32),
      runnerApiKey: 'r'.repeat(32), fetchImpl });

    expect(report.attemptCount).toBe(1);
    expect(report.attempts[0]).toMatchObject({ controlPlaneAttemptId: 'cp-attempt-1', runnerRunId: attempt.session_id,
      runner: { routeMode: 'gha', result: { exitCode: 17, failure: { code: 'ENGINE_EXIT_NONZERO' } }, logAvailable: true,
        logEvents: [{ stream: 'stderr', messageAvailable: true }] } });
    expect(JSON.stringify(report)).not.toContain('sk-' + 'x'.repeat(30));
    expect(calls.some((call) => call.url.endsWith('/status'))).toBe(true);
    const d1Call = calls.find((call) => call.url.includes('/d1/database/'));
    expect(JSON.parse(String(d1Call.init?.body)).params).toEqual(['ut-abcdefgh1234']);
  });

  it('includes redacted log text only when explicitly requested', async () => {
    const { fetchImpl } = mockFetch();
    const report = await inspectProductionTask({ taskId: 'ut-abcdefgh1234', accountId: 'a'.repeat(32), databaseId: 'd'.repeat(36), apiToken: 't'.repeat(32),
      runnerApiKey: 'r'.repeat(32), includeLogs: true, fetchImpl });
    expect(report.includesRedactedLogText).toBe(true);
    expect(report.attempts[0]?.runner.logEvents[0]?.message).toContain('[REDACTED_API_KEY]');
  });

  it('returns a valid report when the task has no execution attempts', async () => {
    const { fetchImpl } = mockFetch({ includeAttempt: false });
    const report = await inspectProductionTask({ taskId: 'ut-abcdefgh1234', accountId: 'a'.repeat(32), databaseId: 'd'.repeat(36), apiToken: 't'.repeat(32),
      runnerApiKey: 'r'.repeat(32), fetchImpl });
    expect(report).toEqual({ schemaVersion: 1, taskId: 'ut-abcdefgh1234', attemptCount: 0, includesRedactedLogText: false, attempts: [] });
  });
});
