import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeHealth, observeHealthCatalogue, parseHealthCatalogue } from '../src/diagnostics/health-catalogue';
import worker, { type Env } from '../src/index';
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import { signPrincipal } from '../src/auth/principal-auth';
import { TELEGRAM_UX_SANDBOX } from '../src/deployment/telegram-ux-sandbox';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const descriptor = (patch: Record<string, unknown> = {}) => ({
  serviceId: 'control-plane', environment: 'sandbox', region: null,
  repositoryUrl: 'https://github.com/trained-assist/trained-assist-control-plane', contractVersion: 1,
  healthUrl: 'https://cp.example.test/health', readinessUrl: 'https://cp.example.test/ready',
  deployedRevision: null, buildId: null, providerDeploymentId: null, deployedAt: null,
  logSources: [{ id: 'worker-logs', kind: 'cloudflare', url: 'https://dash.cloudflare.com/', scope: 'worker', access: 'operator', retention: null }],
  ...patch,
});

describe('health catalogue contract', () => {
  it('accepts trusted typed descriptors and leaves unstamped deployment evidence unknown', () => {
    const services = parseHealthCatalogue(JSON.stringify([descriptor()]));
    expect(services[0]?.deployedRevision).toBeNull();
    expect(services[0]?.logSources[0]?.kind).toBe('cloudflare');
  });

  it.each([
    [descriptor({ serviceId: '../other' }), /serviceId/],
    [descriptor({ healthUrl: 'http://cp.example.test/health' }), /URL/],
    [descriptor({ healthUrl: 'https://cp.example.test/health?url=http://internal' }), /URL/],
    [descriptor({ deployedRevision: 'main' }), /deployedRevision/],
    [descriptor({ logSources: [{ id: 'x', kind: 'cloudflare', url: 'javascript:alert(1)', scope: 'all', access: 'operator', retention: null }] }), /log source/],
  ])('rejects unsafe or unsupported descriptor fields', (item, error) => {
    expect(() => parseHealthCatalogue(JSON.stringify([item]))).toThrow(error);
  });

  it('bounds services and rejects duplicate identities', () => {
    expect(() => parseHealthCatalogue(JSON.stringify([descriptor(), descriptor()]))).toThrow(/duplicate/);
    const many = Array.from({ length: 33 }, (_, index) => descriptor({ serviceId: `service-${index}` }));
    expect(() => parseHealthCatalogue(JSON.stringify(many))).toThrow(/at most 32/);
  });

  it('marks failed, malformed and missing probes honestly without exposing response bodies', async () => {
    const item = parseHealthCatalogue(JSON.stringify([descriptor()]))[0]!;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: 'healthy' }))
      .mockResolvedValueOnce(Response.json({ error: 'sensitive internal details' }, { status: 503 }));
    const observation = await observeHealth(item, { timeoutMs: 100, now: 1_800_000_000_000, fetcher });
    expect(observation.status).toBe('unhealthy');
    expect(observation.reasonCodes).toContain('ready:http_server_error');
    expect(JSON.stringify(observation)).not.toContain('sensitive internal details');
    expect(observation.reasonCodes).toContain('deployed_revision_unknown');
  });

  it('reports probe timeout as unknown and never upgrades stale/unreachable data', async () => {
    const item = parseHealthCatalogue(JSON.stringify([descriptor({ readinessUrl: null })]))[0]!;
    const observation = await observeHealth(item, { timeoutMs: 100, fetcher: vi.fn(async () => { throw new DOMException('timeout', 'TimeoutError'); }) });
    expect(observation.status).toBe('unknown');
    expect(observation.checks[0]?.reasonCode).toBe('probe_timeout');
  });

  it('bounds health response bytes and rejects an unsupported success status', async () => {
    const item = parseHealthCatalogue(JSON.stringify([descriptor({ readinessUrl: null })]))[0]!;
    const oversized = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20_000)); controller.close(); } }));
    const tooLarge = await observeHealth(item, { timeoutMs: 100, fetcher: vi.fn(async () => oversized) });
    expect(tooLarge.status).toBe('unknown');
    expect(tooLarge.checks[0]?.reasonCode).toBe('invalid_health_response');
    const invalidStatus = await observeHealth(item, { timeoutMs: 100, fetcher: vi.fn(async () => Response.json({ status: 'ok' })) });
    expect(invalidStatus.status).toBe('unknown');
    expect(invalidStatus.checks[0]?.reasonCode).toBe('invalid_health_status');
  });

  it('bounds concurrent probes and the aggregate deadline', async () => {
    const items = parseHealthCatalogue(JSON.stringify(Array.from({ length: 6 }, (_, index) => descriptor({ serviceId: `bounded-${index}` }))));
    let active = 0;
    let maximum = 0;
    const fetcher = vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return Response.json({ status: 'healthy' });
    });
    const results = await observeHealthCatalogue(items, { timeoutMs: 1000, concurrency: 2, fetcher });
    expect(results).toHaveLength(6);
    expect(maximum).toBeLessThanOrEqual(2);
  });
});

describe('Control Plane diagnostics routes', () => {
  const token = 'diagnostics-test-token';
  const serviceId = `health-fixture-${crypto.randomUUID()}`;
  const catalogue = JSON.stringify([descriptor({ serviceId, healthUrl: 'https://health.invalid/live', readinessUrl: null })]);
  const bindings = { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, BUILD_SHA: 'test-build-sha', HEALTH_DIAGNOSTICS_TOKEN: token,
    HEALTH_CATALOGUE_JSON: catalogue, HEALTH_CACHE_TTL_MS: '1000', HEALTH_PROBE_TIMEOUT_MS: '100' } as unknown as Env;

  it('keeps liveness public and minimal', async () => {
    const response = await worker.fetch(new Request('https://cp.test/health'), bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ service: 'trained-assist-control-plane', status: 'healthy' });
  });

  it('exposes unauthenticated /healthz as liveness only', async () => {
    const response = await worker.fetch(new Request('https://cp.test/healthz'), bindings);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ service: 'trained-assist-control-plane', status: 'healthy', check: 'liveness' });
    expect(body).toHaveProperty('buildSha', 'test-build-sha');
    expect(body).not.toHaveProperty('ready');
  });

  it('requires diagnostics auth and returns only trusted configured catalogue entries', async () => {
    const denied = await worker.fetch(new Request('https://cp.test/internal/health/catalogue'), bindings);
    expect(denied.status).toBe(401);
    const response = await worker.fetch(new Request('https://cp.test/internal/health/catalogue', {
      headers: { authorization: `Bearer ${token}` },
    }), bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ contractVersion: 1, services: [{ serviceId, deployedRevision: null }] });
  });

  it('returns timeout as unknown and serves a short-lived cached summary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timeout', 'TimeoutError'); }));
    const request = () => worker.fetch(new Request('https://cp.test/internal/health/summary', {
      headers: { authorization: `Bearer ${token}` },
    }), bindings);
    const first = await request();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'unknown', cached: false, services: [{ observation: { status: 'unknown' } }] });
    const second = await request();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: 'unknown', cached: true });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const stale = await request();
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ status: 'unknown', cached: true, stale: true, reasonCodes: expect.arrayContaining(['stale_cache_served']) });
  });
});

describe('profile-scoped Runner readiness route', () => {
  const profileId = 'integration-telegram-ux-v1';
  const principalId = profileId;
  const secret = 'profile-runner-health-test-secret';
  const runnerUrl = 'https://runner.example.test/runner-mcp-test';
  const bindings = {
    DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW,
    PRINCIPAL_SECRET_TELEGRAM_UX: secret,
    RUNNER_API_URL: runnerUrl,
    RUNNER_API_KEY_TELEGRAM_UX: 'scoped-runner-key',
    RUNNER_API_KEY: 'different-global-key',
    RUN_SPEC_PROFILE_OVERRIDES: JSON.stringify({ [profileId]: { policy: 'generic_text_v1', runnerKeyBinding: 'RUNNER_API_KEY_TELEGRAM_UX',
      hostMcpBinding: 'registry-mcp-test-160-read' } }),
    MCP_TEST_AUTH_TOKEN: 'host-discovery-test-token',
  } as unknown as Env;

  async function request(scopes = ['tasks:read'], signatureSecret = secret, targetBindings = bindings) {
    await new TaskStore(bindings.DB).upsertPrincipal({ principalId, profileId, scopes });
    return worker.fetch(new Request('https://cp.test/internal/runner/profile-health', {
      headers: {
        'x-principal': principalId,
        'x-principal-sig': await signPrincipal(principalId, signatureSecret),
      },
    }), targetBindings);
  }

  it('requires signed identity and tasks:read before probing the Runner', async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetcher);
    const deniedSignature = await request(['tasks:read'], 'wrong-secret');
    expect(deniedSignature.status).toBe(401);
    const deniedScope = await request([]);
    expect(deniedScope.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the durable profile scoped key for a read-only status probe and caches briefly', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestedUrl = new URL(String(input));
      expect(requestedUrl.origin).toBe(new URL(runnerUrl).origin);
      expect(requestedUrl.pathname).toMatch(/^\/runner-mcp-test\/v1\/runs\/run_[0-9a-f]{64}_[0-9a-f]{24}\/status$/);
      expect(init?.method).toBe('GET');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer scoped-runner-key');
      return Response.json({ error: { code: 'NOT_FOUND', message: 'probe run is absent' } }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);
    const first = await request();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ profileId, runnerApi: 'reachable', reasonCode: null, cached: false });
    const second = await request();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ profileId, runnerApi: 'reachable', cached: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports rejected credentials without exposing Runner response text', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11_000);
    const targetBindings = bindings;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'UNAUTHORIZED', message: 'secret diagnostic text' } }, { status: 401 })));
    const response = await request(['tasks:read'], secret, targetBindings);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ runnerApi: 'rejected', reasonCode: 'runner_rejected' });
    expect(JSON.stringify(body)).not.toContain('secret diagnostic text');
  });

  it('logs sanitized upstream host, status, and duration without URL path or response details', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30_000);
    const privateUrl = 'https://runner.example.test/private/base?token=private-url-token';
    const targetBindings = { ...bindings, RUNNER_API_URL: privateUrl } as unknown as Env;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      error: { code: 'UPSTREAM_DOWN', message: 'private response detail' },
    }, { status: 503 })));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const response = await request(['tasks:read'], secret, targetBindings);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('runner_unavailable');
    expect(body).not.toContain('runner.example.test');
    expect(body).not.toContain('private-url-token');

    const serialized = log.mock.calls.map(([value]) => String(value)).find(value => value.includes('runner.profile_health_probe'));
    expect(serialized).toBeDefined();
    const event = JSON.parse(serialized!) as Record<string, unknown>;
    expect(event).toMatchObject({
      event: 'runner.profile_health_probe', profileId, runnerApi: 'unreachable',
      reason: 'runner_unavailable', upstreamHost: new URL(privateUrl).hostname, upstreamStatusCode: 503,
      timedOut: false,
    });
    expect(event.durationMs).toEqual(expect.any(Number));
    expect(String(event.durationMs)).not.toBe('');
    expect(serialized).not.toContain('/runner-mcp-test');
    expect(serialized).not.toContain('/private/base');
    expect(serialized).not.toContain('private-url-token');
    expect(serialized).not.toContain('private response detail');
    expect(serialized).not.toContain('scoped-runner-key');
  });

  it('reports only boolean binding readiness when the trusted Runner URL is missing', async () => {
    const targetBindings = { ...bindings, RUNNER_API_URL: undefined } as unknown as Env;
    const response = await request(['tasks:read'], secret, targetBindings);
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, any>;
    expect(body).toEqual({
      error: 'runner not configured', reasonCode: 'runner_not_configured',
      readiness: {
        runnerUrlConfigured: false,
        profileRunnerUrlBindingConfigured: false,
        scopedRunnerKeyConfigured: true,
        scopedRunnerKeyDistinctFromGlobal: true,
        profileMappingConfigured: true,
        requiredMcpAuthConfigured: true,
      },
    });
    expect(JSON.stringify(body)).not.toContain(runnerUrl);
    expect(JSON.stringify(body)).not.toContain('scoped-runner-key');
    expect(JSON.stringify(body)).not.toContain('host-discovery-test-token');
  });
});
