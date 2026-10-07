export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface HealthLogSource {
  id: string;
  kind: 'cloudflare' | 'github_actions' | 'https';
  url: string;
  scope: string;
  access: 'operator' | 'owner' | 'public';
  retention: string | null;
}

export interface HealthServiceDescriptor {
  serviceId: string;
  environment: string;
  region: string | null;
  repositoryUrl: string;
  contractVersion: 1;
  healthUrl: string;
  readinessUrl: string | null;
  deployedRevision: string | null;
  buildId: string | null;
  providerDeploymentId: string | null;
  deployedAt: string | null;
  logSources: HealthLogSource[];
}

export interface HealthObservation {
  status: HealthStatus;
  observedAt: string;
  expiresAt: string;
  latencyMs: number | null;
  reasonCodes: string[];
  checks: Array<{ id: string; status: HealthStatus; observedAt: string; reasonCode: string | null }>;
}

export interface HealthCatalogueEntry {
  descriptor: HealthServiceDescriptor;
  observation: HealthObservation;
}

const SERVICE_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const REVISION = /^[a-f0-9]{40,64}$/;
const MAX_HEALTH_RESPONSE_BYTES = 16_384;

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HEALTH_RESPONSE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HEALTH_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { return null; }
}

function safeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function parseHealthCatalogue(raw: string | undefined): HealthServiceDescriptor[] {
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('health catalogue config is invalid JSON'); }
  if (!Array.isArray(value) || value.length > 32) throw new Error('health catalogue must be an array of at most 32 services');
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`health catalogue entry ${index} is invalid`);
    const item = candidate as Record<string, unknown>;
    if (typeof item.serviceId !== 'string' || !SERVICE_ID.test(item.serviceId) || ids.has(item.serviceId)) throw new Error(`health catalogue entry ${index} has an invalid or duplicate serviceId`);
    ids.add(item.serviceId);
    if (typeof item.environment !== 'string' || item.environment.length > 40) throw new Error(`health catalogue entry ${index} has an invalid environment`);
    if (item.region !== null && typeof item.region !== 'string') throw new Error(`health catalogue entry ${index} has an invalid region`);
    if (!safeUrl(item.repositoryUrl) || !safeUrl(item.healthUrl)) throw new Error(`health catalogue entry ${index} has an invalid URL`);
    if (item.readinessUrl !== null && !safeUrl(item.readinessUrl)) throw new Error(`health catalogue entry ${index} has an invalid readinessUrl`);
    if (item.contractVersion !== 1) throw new Error(`health catalogue entry ${index} has an unsupported contractVersion`);
    for (const field of ['deployedRevision', 'buildId', 'providerDeploymentId', 'deployedAt'] as const) {
      if (item[field] !== null && typeof item[field] !== 'string') throw new Error(`health catalogue entry ${index} has an invalid ${field}`);
    }
    if (item.deployedRevision !== null && !REVISION.test(item.deployedRevision as string)) throw new Error(`health catalogue entry ${index} has an invalid deployedRevision`);
    if (!Array.isArray(item.logSources) || item.logSources.length > 16) throw new Error(`health catalogue entry ${index} has invalid logSources`);
    const logSources = item.logSources.map((rawSource) => {
      if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) throw new Error(`health catalogue entry ${index} has an invalid log source`);
      const source = rawSource as Record<string, unknown>;
      if (typeof source.id !== 'string' || !SERVICE_ID.test(source.id) || !safeUrl(source.url)
        || !['cloudflare', 'github_actions', 'https'].includes(String(source.kind))
        || typeof source.scope !== 'string' || source.scope.length > 100
        || !['operator', 'owner', 'public'].includes(String(source.access))
        || (source.retention !== null && typeof source.retention !== 'string')) throw new Error(`health catalogue entry ${index} has an invalid log source`);
      return source as unknown as HealthLogSource;
    });
    return { ...item, logSources } as unknown as HealthServiceDescriptor;
  });
}

export async function observeHealth(
  descriptor: HealthServiceDescriptor,
  options: { timeoutMs: number; now?: number; deadlineAt?: number; fetcher?: typeof fetch },
): Promise<HealthObservation> {
  const now = options.now ?? Date.now();
  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + options.timeoutMs).toISOString();
  const fetcher = options.fetcher ?? fetch;
  const checks: HealthObservation['checks'] = [];
  const started = performance.now();
  let status: HealthStatus = 'unknown';
  const reasonCodes: string[] = [];
  const targets = [{ id: 'live', url: descriptor.healthUrl }, ...(descriptor.readinessUrl ? [{ id: 'ready', url: descriptor.readinessUrl }] : [])];
  for (const target of targets) {
    const checkTime = new Date().toISOString();
    const remainingMs = options.deadlineAt === undefined ? options.timeoutMs : Math.min(options.timeoutMs, options.deadlineAt - Date.now());
    if (remainingMs <= 0) {
      checks.push({ id: target.id, status: 'unknown', observedAt: checkTime, reasonCode: 'aggregate_deadline_exceeded' });
      reasonCodes.push(`${target.id}:aggregate_deadline_exceeded`);
      continue;
    }
    try {
      const response = await fetcher(target.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(remainingMs) });
      let checkStatus: HealthStatus = response.ok ? 'healthy' : response.status >= 500 ? 'unhealthy' : 'degraded';
      let reasonCode: string | null = response.ok ? null : response.status >= 300 && response.status < 400
        ? 'redirect_refused' : response.status >= 500 ? 'http_server_error' : 'http_not_ok';
      if (response.ok) {
        const body: unknown = await boundedJson(response);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          checkStatus = 'unknown';
          reasonCode = 'invalid_health_response';
        } else {
          const declared = (body as Record<string, unknown>).status;
          if (declared === 'healthy' || declared === 'degraded' || declared === 'unhealthy' || declared === 'unknown') checkStatus = declared;
          else if (declared !== undefined) { checkStatus = 'unknown'; reasonCode = 'invalid_health_status'; }
        }
      }
      checks.push({ id: target.id, status: checkStatus, observedAt: checkTime, reasonCode });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      checks.push({ id: target.id, status: 'unknown', observedAt: checkTime, reasonCode: timedOut ? 'probe_timeout' : 'probe_unreachable' });
    }
  }
  const statuses = checks.map((check) => check.status);
  status = statuses.includes('unhealthy') ? 'unhealthy'
    : statuses.includes('unknown') ? 'unknown'
      : statuses.includes('degraded') ? 'degraded' : 'healthy';
  for (const check of checks) if (check.reasonCode) reasonCodes.push(`${check.id}:${check.reasonCode}`);
  if (!descriptor.deployedRevision) reasonCodes.push('deployed_revision_unknown');
  return { status, observedAt, expiresAt, latencyMs: Math.max(0, Math.round(performance.now() - started)), reasonCodes, checks };
}

export async function observeHealthCatalogue(
  descriptors: HealthServiceDescriptor[],
  options: { timeoutMs: number; now?: number; fetcher?: typeof fetch; concurrency?: number },
): Promise<HealthCatalogueEntry[]> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  const deadline = (options.now ?? Date.now()) + options.timeoutMs;
  const entries = new Array<HealthCatalogueEntry>(descriptors.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= descriptors.length) return;
      const remainingMs = Math.max(0, deadline - Date.now());
      const descriptor = descriptors[index]!;
      const observation = remainingMs > 0
        ? await observeHealth(descriptor, { ...options, deadlineAt: deadline, timeoutMs: Math.min(options.timeoutMs, remainingMs) })
        : {
          status: 'unknown' as const,
          observedAt: new Date().toISOString(),
          expiresAt: new Date(deadline).toISOString(),
          latencyMs: null,
          reasonCodes: ['aggregate_deadline_exceeded'],
          checks: [{ id: 'aggregate', status: 'unknown' as const, observedAt: new Date().toISOString(), reasonCode: 'aggregate_deadline_exceeded' }],
        };
      entries[index] = { descriptor, observation };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, descriptors.length) }, worker));
  return entries;
}
