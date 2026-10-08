import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index';
import { env } from './env';
import { TELEGRAM_UX_SANDBOX, isSandboxReadinessEndpointMissing, telegramUxPrincipalSignature, validateSandboxBuildSha, validateTelegramUxSandboxConfig } from '../src/deployment/telegram-ux-sandbox';

const config = {
  name: TELEGRAM_UX_SANDBOX.workerName,
  workers_dev: true,
  d1_databases: [{ database_name: TELEGRAM_UX_SANDBOX.databaseName, database_id: TELEGRAM_UX_SANDBOX.databaseId }],
  workflows: [{ name: TELEGRAM_UX_SANDBOX.workflowName }],
  vars: { SANDBOX_RUNNER_MOCK_PROBE_ENABLED: 'true', SANDBOX_RUNNER_MOCK_TEST_URL: TELEGRAM_UX_SANDBOX.runnerMockTestUrl },
  services: [
    { binding: 'COMMUNICATION_SERVICE', service: 'trained-assist-communication-v1-sandbox' },
    { binding: 'REGISTRY_MCP_HOST_SERVICE', service: 'trained-assist-mcp-host-test-160' },
    { binding: 'INGRESS_BUFFER', service: 'trained-assist-ingress-buffer-sandbox' },
  ],
};

describe('Telegram UX sandbox deploy guard', () => {
  it('pins sandbox deployment evidence to a full git commit SHA', () => {
    expect(validateSandboxBuildSha('A'.repeat(40))).toBe('a'.repeat(40));
    for (const invalid of ['', 'main', 'a'.repeat(39), 'g'.repeat(40)]) {
      expect(() => validateSandboxBuildSha(invalid)).toThrow('sandbox_build_sha_invalid');
    }
  });

  it('recognizes both 404 and the exact legacy response for an undeployed readiness endpoint', () => {
    expect(isSandboxReadinessEndpointMissing(404, { error: 'not found' })).toBe(true);
    expect(isSandboxReadinessEndpointMissing(400, { error: 'taskId is required' })).toBe(true);
    expect(isSandboxReadinessEndpointMissing(400, { error: 'invalid request' })).toBe(false);
    expect(isSandboxReadinessEndpointMissing(401, { error: 'taskId is required' })).toBe(false);
    expect(isSandboxReadinessEndpointMissing(200, { ok: true })).toBe(false);
  });

  it('accepts only the pinned sandbox Worker, D1 and Workflow', () => {
    expect(validateTelegramUxSandboxConfig(config)).toBe(true);
  });

  it('refuses a non-sandbox Worker target', () => {
    expect(() => validateTelegramUxSandboxConfig({ ...config, name: 'trained-assist-control-plane' }))
      .toThrow('sandbox_worker_mismatch');
  });

  it('refuses a different or shared D1 database', () => {
    const wrongDatabase = { ...config, d1_databases: [{ ...config.d1_databases[0], database_id: 'other' }] };
    expect(() => validateTelegramUxSandboxConfig(wrongDatabase)).toThrow('sandbox_database_mismatch');
  });

  it('refuses service bindings outside the reviewed sandbox', () => {
    const wrongService = { ...config, services: [{ binding: 'COMMUNICATION_SERVICE', service: 'production' }] };
    expect(() => validateTelegramUxSandboxConfig(wrongService)).toThrow('sandbox_service_binding_mismatch');
  });

  it('refuses a deployment config without the explicit sandbox mock-probe gate', () => {
    expect(() => validateTelegramUxSandboxConfig({ ...config, vars: {} }))
      .toThrow('sandbox_mock_probe_gate_mismatch');
  });

  it('refuses a mock Runner URL outside the pinned API sandbox target', () => {
    expect(() => validateTelegramUxSandboxConfig({ ...config, vars: {
      ...config.vars, SANDBOX_RUNNER_MOCK_TEST_URL: 'https://other.example/runner-mcp-test',
    } })).toThrow('sandbox_mock_runner_url_mismatch');
  });

  it('derives the same HMAC signature for the configured principal deterministically', async () => {
    expect(await telegramUxPrincipalSignature('sandbox-secret'))
      .toBe('40ee8b265a654c6867c1edd325ba0f05fc7bb624b34840cef15c8cbff1a5c1f7');
  });

  it('readiness is gated, authenticated, scoped and blocks when the sandbox profile has active work', async () => {
    const database = env.DB;
    const workflow = env.TASK_WORKFLOW;
    const secret = 'sandbox-readiness-test-secret';
    const baseEnv = { DB: database, TASK_WORKFLOW: workflow,
      PRINCIPAL_SECRET_TELEGRAM_UX: secret, SANDBOX_READINESS_ENABLED: 'true' } as unknown as Env;
    const signedRequest = async (targetEnv: Env, path = '/internal/sandbox/readiness', signedSecret = secret) => {
      const signature = await telegramUxPrincipalSignature(signedSecret);
      return worker.fetch(new Request(`https://cp.test${path}`, { headers: {
        'x-principal': TELEGRAM_UX_SANDBOX.principalId, 'x-principal-sig': signature,
      } }), targetEnv);
    };

    const gated = await signedRequest({ ...baseEnv, SANDBOX_READINESS_ENABLED: undefined });
    expect(gated.status).toBe(404);
    const unauthorized = await worker.fetch(new Request('https://cp.test/internal/sandbox/readiness'), baseEnv);
    expect(unauthorized.status).toBe(401);

    await database.prepare(`INSERT OR REPLACE INTO admission_principals
      (principal_id, profile_id, scopes, enabled, created_at, updated_at)
      VALUES (?, ?, ?, 1, 1, 1)`).bind(TELEGRAM_UX_SANDBOX.principalId, TELEGRAM_UX_SANDBOX.principalId,
      JSON.stringify(['tasks:intake', 'tasks:read'])).run();
    const ready = await signedRequest(baseEnv);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, nonterminalTaskCount: 0, check: 'authenticated_sandbox_readiness' });

    const activeTask = `ut-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    await database.prepare(`INSERT INTO durable_tasks (id, profile_id, goal, status, created_at, updated_at)
      VALUES (?, ?, 'readiness fixture', 'active', 1, 1)`).bind(activeTask, TELEGRAM_UX_SANDBOX.principalId).run();
    try {
      const blocked = await signedRequest(baseEnv);
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ ok: false, reasonCode: 'sandbox_lane_has_nonterminal_task' });
    } finally {
      await database.prepare('DELETE FROM durable_tasks WHERE id = ?').bind(activeTask).run();
      await database.prepare('DELETE FROM admission_principals WHERE principal_id = ?').bind(TELEGRAM_UX_SANDBOX.principalId).run();
    }
  });
});
