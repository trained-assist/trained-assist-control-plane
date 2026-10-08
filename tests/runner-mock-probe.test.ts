import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { env } from './env';
import { TELEGRAM_UX_SANDBOX, telegramUxPrincipalSignature } from '../src/deployment/telegram-ux-sandbox';

const runId = 'run-sandbox-mock-probe-v1';

function runnerFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/runs')) return Response.json({ requestId: 'req-mock-probe', userTaskId: 'sandbox-bootstrap-runner-mock-probe-v1', runId, deduplicated: calls.length > 1 });
    if (url.endsWith(`/v1/runs/${runId}/status`)) return Response.json({ runId, userTaskId: 'sandbox-bootstrap-runner-mock-probe-v1', state: 'succeeded', answer: 'pong' });
    if (url.endsWith(`/v1/runs/${runId}/result`)) return Response.json({ runId, userTaskId: 'sandbox-bootstrap-runner-mock-probe-v1', outcome: 'succeeded', text: 'pong', persistence: 'not_required', cleanup: 'completed' });
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

describe('sandbox CP to Runner mock-test probe', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await env.DB.prepare('DELETE FROM admission_principals WHERE principal_id = ?')
      .bind(TELEGRAM_UX_SANDBOX.principalId).run();
  });

  it('checks a deterministic pong with the dedicated binding and creates no CP task', async () => {
    const database = env.DB;
    const secret = 'sandbox-readiness-test-secret';
    const baseEnv = { DB: database, TASK_WORKFLOW: env.TASK_WORKFLOW,
      PRINCIPAL_SECRET_TELEGRAM_UX: secret,
      SANDBOX_RUNNER_MOCK_PROBE_ENABLED: 'true',
      PILOT_ENABLED: 'true', PILOT_COHORT_PROFILE_IDS: 'integration-telegram-ux-v1',
      RUNNER_API_URL_TELEGRAM_UX_MOCK_TEST: 'https://runner-sandbox.example/runner-mcp-test',
      RUNNER_API_KEY_TELEGRAM_UX_MOCK_TEST: 'dedicated-mock-key',
    } as unknown as Env;
    await database.prepare(`INSERT OR REPLACE INTO admission_principals
      (principal_id, profile_id, scopes, enabled, created_at, updated_at)
      VALUES (?, ?, ?, 1, 1, 1)`).bind(TELEGRAM_UX_SANDBOX.principalId, TELEGRAM_UX_SANDBOX.principalId,
      JSON.stringify(['tasks:intake', 'tasks:read'])).run();
    const before = await database.prepare('SELECT count(*) AS total FROM durable_tasks').first<{ total: number }>();
    const fake = runnerFetch();
    const signature = await telegramUxPrincipalSignature(secret);
    const response = await worker.fetch(new Request('https://cp.test/internal/sandbox/runner-mock-probe', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-principal': TELEGRAM_UX_SANDBOX.principalId,
        'x-principal-sig': signature }, body: '{}',
    }), baseEnv);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, check: 'authenticated_runner_mock_test',
      runId, runnerState: 'succeeded', answer: 'pong', runnerOutcome: 'succeeded',
      sideEffects: { cpTaskCreated: false, workerOrModelCalled: false, runnerAdmissionPersisted: true } });
    expect(fake.calls).toHaveLength(3);
    const submitCall = fake.calls[0]!;
    expect(submitCall.url).toBe('https://runner-sandbox.example/runner-mcp-test/v1/runs');
    expect(new Headers(submitCall.init?.headers).get('authorization')).toBe('Bearer dedicated-mock-key');
    expect(new Headers(submitCall.init?.headers).get('idempotency-key')).toBe('sandbox-bootstrap-runner-mock-probe-v1');
    expect(JSON.parse(String(submitCall.init?.body))).toMatchObject({
      engine: { name: 'mock-test' }, userTaskId: 'sandbox-bootstrap-runner-mock-probe-v1',
    });
    const after = await database.prepare('SELECT count(*) AS total FROM durable_tasks').first<{ total: number }>();
    expect(after?.total).toBe(before?.total);
  });

  it('is disabled unless explicitly enabled and authenticates the fixed sandbox principal before Runner access', async () => {
    const database = env.DB;
    const secret = 'sandbox-readiness-test-secret';
    const fake = runnerFetch();
    const baseEnv = { DB: database, TASK_WORKFLOW: env.TASK_WORKFLOW,
      PRINCIPAL_SECRET_TELEGRAM_UX: secret,
      PILOT_ENABLED: 'true', PILOT_COHORT_PROFILE_IDS: 'integration-telegram-ux-v1',
      RUNNER_API_URL_TELEGRAM_UX_MOCK_TEST: 'https://runner-sandbox.example/runner-mcp-test',
      RUNNER_API_KEY_TELEGRAM_UX_MOCK_TEST: 'dedicated-mock-key',
    } as unknown as Env;
    const body = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
    const disabled = await worker.fetch(new Request('https://cp.test/internal/sandbox/runner-mock-probe', body), baseEnv);
    expect(disabled.status).toBe(404);
    const unauthorized = await worker.fetch(new Request('https://cp.test/internal/sandbox/runner-mock-probe', body), {
      ...baseEnv, SANDBOX_RUNNER_MOCK_PROBE_ENABLED: 'true',
    } as unknown as Env);
    expect(unauthorized.status).toBe(401);
    const productionGuard = await worker.fetch(new Request('https://cp.test/internal/sandbox/runner-mock-probe', body), {
      ...baseEnv, SANDBOX_RUNNER_MOCK_PROBE_ENABLED: 'true', PREVIEW_ONLY: 'true', PILOT_ENABLED: 'false',
    } as unknown as Env);
    expect(productionGuard.status).toBe(404);
    expect(fake.fetchMock).not.toHaveBeenCalled();
  });
});
