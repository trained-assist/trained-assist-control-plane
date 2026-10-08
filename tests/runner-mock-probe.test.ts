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
      SANDBOX_RUNNER_MOCK_TEST_URL: TELEGRAM_UX_SANDBOX.runnerMockTestUrl,
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
    expect(submitCall.url).toBe(`${TELEGRAM_UX_SANDBOX.runnerMockTestUrl}/v1/runs`);
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
      SANDBOX_RUNNER_MOCK_TEST_URL: TELEGRAM_UX_SANDBOX.runnerMockTestUrl,
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

  it('refuses to send the mock credential when the configured endpoint is not the dedicated test route', async () => {
    const database = env.DB;
    const secret = 'sandbox-readiness-test-secret';
    await database.prepare(`INSERT OR REPLACE INTO admission_principals
      (principal_id, profile_id, scopes, enabled, created_at, updated_at)
      VALUES (?, ?, ?, 1, 1, 1)`).bind(TELEGRAM_UX_SANDBOX.principalId, TELEGRAM_UX_SANDBOX.principalId,
      JSON.stringify(['tasks:read'])).run();
    const fake = runnerFetch();
    const signature = await telegramUxPrincipalSignature(secret);
    const response = await worker.fetch(new Request('https://cp.test/internal/sandbox/runner-mock-probe', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-principal': TELEGRAM_UX_SANDBOX.principalId,
        'x-principal-sig': signature }, body: '{}',
    }), {
      DB: database, TASK_WORKFLOW: env.TASK_WORKFLOW, PRINCIPAL_SECRET_TELEGRAM_UX: secret,
      SANDBOX_RUNNER_MOCK_PROBE_ENABLED: 'true', PILOT_ENABLED: 'true',
      PILOT_COHORT_PROFILE_IDS: 'integration-telegram-ux-v1',
      SANDBOX_RUNNER_MOCK_TEST_URL: 'https://runner-sandbox.example/api',
      RUNNER_API_KEY_TELEGRAM_UX_MOCK_TEST: 'dedicated-mock-key',
    } as unknown as Env);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, reasonCode: 'sandbox_mock_runner_binding_unavailable',
      bindingIssue: 'runner_url_target_mismatch' });
    const missingKey = await worker.fetch(new Request('https://cp.test/internal/sandbox/runner-mock-probe', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-principal': TELEGRAM_UX_SANDBOX.principalId,
        'x-principal-sig': signature }, body: '{}',
    }), {
      DB: database, TASK_WORKFLOW: env.TASK_WORKFLOW, PRINCIPAL_SECRET_TELEGRAM_UX: secret,
      SANDBOX_RUNNER_MOCK_PROBE_ENABLED: 'true', PILOT_ENABLED: 'true',
      PILOT_COHORT_PROFILE_IDS: 'integration-telegram-ux-v1',
      SANDBOX_RUNNER_MOCK_TEST_URL: TELEGRAM_UX_SANDBOX.runnerMockTestUrl,
      RUNNER_API_KEY_TELEGRAM_UX_MOCK_TEST: undefined,
    } as unknown as Env);
    expect(missingKey.status).toBe(503);
    expect(await missingKey.json()).toMatchObject({ bindingIssue: 'mock_key_missing' });
    expect(fake.fetchMock).not.toHaveBeenCalled();
  });

  it('reports only an unauthenticated reachability result when the Runner fetch fails', async () => {
    const database = env.DB;
    const secret = 'sandbox-readiness-test-secret';
    await database.prepare(`INSERT OR REPLACE INTO admission_principals
      (principal_id, profile_id, scopes, enabled, created_at, updated_at)
      VALUES (?, ?, ?, 1, 1, 1)`).bind(TELEGRAM_UX_SANDBOX.principalId, TELEGRAM_UX_SANDBOX.principalId,
      JSON.stringify(['tasks:read'])).run();
    const fetchMock = vi.fn(async () => { throw new TypeError('outbound network failure'); });
    vi.stubGlobal('fetch', fetchMock);
    const signature = await telegramUxPrincipalSignature(secret);
    const response = await worker.fetch(new Request('https://cp.test/internal/sandbox/runner-mock-probe', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-principal': TELEGRAM_UX_SANDBOX.principalId,
        'x-principal-sig': signature }, body: '{}',
    }), {
      DB: database, TASK_WORKFLOW: env.TASK_WORKFLOW, PRINCIPAL_SECRET_TELEGRAM_UX: secret,
      SANDBOX_RUNNER_MOCK_PROBE_ENABLED: 'true', PILOT_ENABLED: 'true',
      PILOT_COHORT_PROFILE_IDS: 'integration-telegram-ux-v1',
      SANDBOX_RUNNER_MOCK_TEST_URL: TELEGRAM_UX_SANDBOX.runnerMockTestUrl,
      RUNNER_API_KEY_TELEGRAM_UX_MOCK_TEST: 'dedicated-mock-key',
    } as unknown as Env);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, reasonCode: 'sandbox_runner_mock_probe_failed',
      runnerReachability: { outcome: 'fetch_failed', httpStatus: null },
      sideEffects: { cpTaskCreated: false, workerOrModelCalled: false, runnerAdmissionMayBePersisted: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns a Runner error code without exposing its response message', async () => {
    const database = env.DB;
    const secret = 'sandbox-readiness-test-secret';
    await database.prepare(`INSERT OR REPLACE INTO admission_principals
      (principal_id, profile_id, scopes, enabled, created_at, updated_at)
      VALUES (?, ?, ?, 1, 1, 1)`).bind(TELEGRAM_UX_SANDBOX.principalId, TELEGRAM_UX_SANDBOX.principalId,
      JSON.stringify(['tasks:read'])).run();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/v1/capabilities')
      ? Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 })
      : Response.json({ error: { code: 'INVALID_REQUEST', message: 'secret-shaped private detail', details: {
        errors: ['request.limits.timeoutMs: expected a positive integer', 'private value: secret-shaped detail'],
      } } }, { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const signature = await telegramUxPrincipalSignature(secret);
    const response = await worker.fetch(new Request('https://cp.test/internal/sandbox/runner-mock-probe', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-principal': TELEGRAM_UX_SANDBOX.principalId,
        'x-principal-sig': signature }, body: '{}',
    }), {
      DB: database, TASK_WORKFLOW: env.TASK_WORKFLOW, PRINCIPAL_SECRET_TELEGRAM_UX: secret,
      SANDBOX_RUNNER_MOCK_PROBE_ENABLED: 'true', PILOT_ENABLED: 'true',
      PILOT_COHORT_PROFILE_IDS: 'integration-telegram-ux-v1',
      SANDBOX_RUNNER_MOCK_TEST_URL: TELEGRAM_UX_SANDBOX.runnerMockTestUrl,
      RUNNER_API_KEY_TELEGRAM_UX_MOCK_TEST: 'dedicated-mock-key',
    } as unknown as Env);

    const body = await response.text();
    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ runnerErrorCode: 'INVALID_REQUEST', runnerErrorFields: ['request.limits.timeoutMs'],
      runnerReachability: { outcome: 'reachable_auth_required', httpStatus: 401 } });
    expect(body).not.toContain('secret-shaped private detail');
    expect(body).not.toContain('private value');
  });
});
