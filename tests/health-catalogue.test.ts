import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeHealth, observeHealthCatalogue, parseHealthCatalogue } from '../src/diagnostics/health-catalogue';
import worker, { type Env } from '../src/index';
import { env } from './env';

afterEach(() => vi.unstubAllGlobals());

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
  const bindings = { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, HEALTH_DIAGNOSTICS_TOKEN: token,
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
