/**
 * Adapter control plane → ai-agent-runner (Serverless Agent API).
 *
 * Контракт — SERVERLESS-AGENT-API.md и фактический HTTP API runner'а
 * (src/api/server.ts): POST /v1/runs, GET /v1/runs/{runId}/status|result|events|artifacts,
 * POST /v1/runs/{runId}/cancel; авторизация Bearer API key, идемпотентность —
 * заголовок Idempotency-Key. Ключ и URL приходят из env, в репозиторий не
 * попадают.
 *
 * Идемпотентность: ключ попытки СТАБИЛЕН и вычисляется ДО отправки из
 * (userTaskId, generation) — повтор доставки того же ключа возвращает тот же
 * receipt (deduplicated: true), второй Run не создаётся.
 */
import { RunnerArtifactManifestError, RunnerConflictError, RunnerNotFoundError, RunnerStaleGenerationError, RunnerUnavailableError } from './errors';
import type { RunSpec } from '../run-spec/run-spec';
import { toSubmitRequest } from '../run-spec/run-spec';

export interface RunnerSubmitInput {
  userTaskId: string;
  conversationId?: string | null;
  engineName?: string;
  inputText?: string | null;
  inputRefs?: string[];
  instructions?: string | null;
  idempotencyKey: string;
  timeoutMs?: number;
  /**
   * Готовый RunSpec от versioned mapping'а хоста (`src/run-spec`). Если задан —
   * тело submit собирается из него, а поля выше игнорируются: единственный
   * источник формы запроса — mapping, а не несколько мест в коде.
   */
  runSpec?: RunSpec | null;
}

export interface RunnerReceipt {
  requestId: string;
  userTaskId: string;
  runId: string;
  deduplicated: boolean;
}

export interface RunnerStatusView {
  answer?: string | null;
  requestId: string;
  userTaskId: string;
  conversationId: string;
  runId: string;
  ownerGeneration: number;
  state: string;
  cancelRequested: boolean;
  connectionLost: boolean;
  observedAt: string;
  sequence: number;
  fencing: { rejected: number };
}

export interface RunnerResult {
  runId: string;
  userTaskId: string;
  profileId: string;
  ownerGeneration: number;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  exitReason: string;
  exitCode: number | null;
  exitSignal: string | null;
  exitObserved: boolean;
  startedAt: string;
  finishedAt: string;
  failure?: { code: string; failureClass: string; safeSummary: string; retryable: boolean };
  usage: { status: 'unknown' } | { status: 'known'; usd: number };
  outputRefs: string[];
  persistence: 'pending' | 'persisted' | 'failed' | 'not_required';
  persistenceReason?: string;
  cleanup: 'pending' | 'completed' | 'failed';
  logPath: string;
  /** Fast captured engine answer; event extraction remains the compatibility fallback. */
  text?: string | null;
}

export interface RunnerEvent {
  eventId: string;
  runId: string;
  jobId: string;
  userTaskId: string;
  profileId: string;
  ownerGeneration: number;
  sequence: number;
  timestamp: string;
  type: string;
  payload?: unknown;
}

export interface RunnerEventsPage {
  runId: string;
  events: RunnerEvent[];
  cursor: number;
  hasMore: boolean;
  snapshot: { state: string; connectionLost: boolean; sequence: number; ownerGeneration: number };
}

export interface RunnerArtifact {
  artifactId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  storageKey: string;
  createdAt: string;
  runId: string;
  userTaskId: string;
  profileId: string;
}

export interface RunnerArtifactSummary {
  ref: string;
  artifactId?: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

export function runnerArtifactRef(manifest: unknown): string {
  if (!manifest || typeof manifest !== 'object') throw new RunnerArtifactManifestError();
  const fields = manifest as Record<string, unknown>;
  const ref = fields.ref ?? (fields.storageKey || fields.artifactId || fields.url);
  if (typeof ref !== 'string' || !ref.trim() || ref !== ref.trim()) throw new RunnerArtifactManifestError();
  return ref;
}

export interface DelegatedProfile { profileId: string; principalId: string; tenantId: string; secret: string }

export class RunnerApiAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly engineSelection: 'caller' | 'agent_api' = 'caller',
    private readonly delegatedProfile?: DelegatedProfile,
  ) {}

  /**
   * Вызов fetch с привязкой к globalThis: в Workers глобальный fetch требует
   * правильного `this`, иначе `Illegal invocation` (поймано живым прогоном).
   */
  private doFetch(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl.call(globalThis, url, init) as Promise<Response>;
  }

  private async request<T>(method: string, path: string, opts: { body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<T> {
    let res: Response;
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      };
      if (this.delegatedProfile) {
        const expiresAt = String(Date.now() + 60_000);
        const message = `${this.delegatedProfile.principalId}\0${this.delegatedProfile.tenantId}\0${this.delegatedProfile.profileId}\0${expiresAt}`;
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.delegatedProfile.secret),
          { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
        headers['x-agent-profile-id'] = this.delegatedProfile.profileId;
        headers['x-agent-profile-tenant'] = this.delegatedProfile.tenantId;
        headers['x-agent-profile-exp'] = expiresAt;
        headers['x-agent-profile-sig'] = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      }
      res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
    } catch (e) {
      throw new RunnerUnavailableError(`runner unreachable: ${String((e as Error)?.message ?? e)}`, e);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: { errors?: unknown } } } | null)?.error;
      const code = err?.code ?? `HTTP_${res.status}`;
      const message = err?.message ?? text;
      if (res.status === 404 || code === 'NOT_FOUND') throw new RunnerNotFoundError(message, res.status);
      if (code === 'STALE_OWNER_GENERATION') throw new RunnerStaleGenerationError(message);
      if (res.status >= 500 || res.status === 429) throw new RunnerUnavailableError(`${code}: ${message}`, undefined, res.status);
      const fieldPaths = Array.isArray(err?.details?.errors)
        ? err.details.errors.flatMap((entry) => {
          if (typeof entry !== 'string') return [];
          const path = entry.split(':', 1)[0]?.trim();
          return path && /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*|\[\d+\])*$/.test(path) ? [path] : [];
        })
        : [];
      throw new RunnerConflictError(`${code}: ${message}`, { apiCode: code, fieldPaths: [...new Set(fieldPaths)].slice(0, 20), statusCode: res.status });
    }
    return json as T;
  }

  /**
   * Тело submit — РОВНО контракт Serverless Agent API (проверено живым прогоном
   * против Runner'а на песочной VM): `userTaskId`, `engine`, `limits` и
   * `envAllowlist`; необязательные поля ПРОПУСКАЮТСЯ, а не передаются как null —
   * Runner отвергает `conversationId: null` / `instructions: null` (400
   * INVALID_REQUEST: expected non-empty string). Текст задачи едет в
   * `input.inlinePrompt` (поля `text` в контракте нет: секреты в контракт не
   * попадают), ссылки — объектами `{ref}`.
   *
   * Если передан `runSpec` (versioned mapping хста), тело — он: форма запроса
   * определяется одним местом, а не набором полей адаптера.
   */
  async submit(input: RunnerSubmitInput): Promise<RunnerReceipt> {
    if (input.runSpec) {
      // Тело — проекция RunSpec на ключи, которые принимает POST /v1/runs.
      // Полный RunSpec туда не уходит: checkKeys отклоняет неизвестные поля.
      return this.request<RunnerReceipt>('POST', '/v1/runs', {
        idempotencyKey: input.idempotencyKey,
        body: toSubmitRequest(input.runSpec, { engineSelection: this.engineSelection }),
      });
    }
    const prompt = input.inputText?.trim();
    const refs = (input.inputRefs ?? []).map((ref) => ({ ref }));
    const instructions = input.instructions?.trim();
    return this.request<RunnerReceipt>('POST', '/v1/runs', {
      idempotencyKey: input.idempotencyKey,
      body: {
        userTaskId: input.userTaskId,
        ...(this.engineSelection === 'agent_api' ? {} : { engine: { name: input.engineName ?? 'opencode', adapterVersion: '1' } }),
        envAllowlist: [],
        limits: { timeoutMs: input.timeoutMs ?? 300000 },
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(prompt || refs.length ? { input: { ...(prompt ? { inlinePrompt: prompt } : {}), ...(refs.length ? { refs } : {}) } } : {}),
        ...(instructions ? { instructions } : {}),
      },
    });
  }

  async status(runId: string, signal?: AbortSignal): Promise<RunnerStatusView> {
    return this.request<RunnerStatusView>('GET', `/v1/runs/${runId}/status`, { signal });
  }

  async result(runId: string): Promise<RunnerResult> {
    return this.request<RunnerResult>('GET', `/v1/runs/${runId}/result`);
  }

  async events(runId: string, cursor = 0, limit = 500): Promise<RunnerEventsPage> {
    return this.request<RunnerEventsPage>('GET', `/v1/runs/${runId}/events?cursor=${cursor}&limit=${limit}`);
  }

  async artifacts(runId: string): Promise<RunnerArtifactSummary[]> {
    const res = await this.request<{ artifacts: Array<RunnerArtifact | { path: string; name: string; mime: string; size: number; sha256: string; url: string }> }>('GET', `/v1/runs/${runId}/artifacts`);
    if (!Array.isArray(res?.artifacts)) throw new RunnerArtifactManifestError();
    return res.artifacts.map(manifest => ({ ...manifest, ref: runnerArtifactRef(manifest) }));
  }

  /**
   * Манифест одного артефакта (`GET /v1/artifacts/{id}/meta`) — для read-only
   * проксирования байтов наружу: ключ Runner'а остаётся в binding воркера.
   */
  async artifactMeta(artifactId: string): Promise<RunnerArtifact> {
    return this.request<RunnerArtifact>('GET', `/v1/artifacts/${artifactId}/meta`);
  }

  /** Байты артефакта (`GET /v1/artifacts/{id}`) — только чтение, ключ в binding. */
  async artifactBytes(artifactId: string): Promise<{ body: Uint8Array; artifact: RunnerArtifact }> {
    const res = await this.doFetch(`${this.baseUrl}/v1/artifacts/${artifactId}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new RunnerConflictError(`artifact ${artifactId}: HTTP_${res.status}: ${text}`);
    }
    const body = new Uint8Array(await res.arrayBuffer());
    const artifact = await this.artifactMeta(artifactId);
    return { body, artifact };
  }

  async cancel(runId: string, opts: { ownerGeneration?: number; reason?: string } = {}): Promise<{ status: string; reason?: string; state?: string }> {
    return this.request('POST', `/v1/runs/${runId}/cancel`, { body: { ownerGeneration: opts.ownerGeneration, reason: opts.reason } });
  }
}

/**
 * Adapter из env рантайма: URL/ключ приходят только из окружения (bindings
 * Workers), в репозиторий и в params Workflow не попадают — секрет не должен
 * сериализоваться в движок.
 */
export function runnerAdapterOf(env: {
  RUNNER_API_URL?: string;
  RUNNER_API_KEY?: string;
  RUNNER_API_ENGINE_SELECTION?: string;
  RUNNER_PROFILE_DELEGATION_SECRET?: string;
  RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID?: string;
  RUNNER_PROFILE_DELEGATION_TENANT_ID?: string;
  RUNNER_PROFILE_DELEGATED_ID?: string;
  RUNNER_API_FETCH?: typeof fetch;
}): RunnerApiAdapter | null {
  const selection = env.RUNNER_API_ENGINE_SELECTION ?? 'caller';
  if (selection !== 'caller' && selection !== 'agent_api') {
    throw new Error('RUNNER_API_ENGINE_SELECTION must be caller or agent_api');
  }
  const hasDelegation = Boolean(env.RUNNER_PROFILE_DELEGATION_SECRET || env.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID
    || env.RUNNER_PROFILE_DELEGATION_TENANT_ID || env.RUNNER_PROFILE_DELEGATED_ID);
  const delegationValues = [env.RUNNER_PROFILE_DELEGATION_SECRET, env.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID,
    env.RUNNER_PROFILE_DELEGATION_TENANT_ID, env.RUNNER_PROFILE_DELEGATED_ID];
  if (hasDelegation && delegationValues.some(value => !value?.trim())) {
    throw new Error('Runner profile delegation requires secret, principal, tenant, and profile');
  }
  const delegatedProfile = hasDelegation ? {
    profileId: env.RUNNER_PROFILE_DELEGATED_ID!, principalId: env.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID!,
    tenantId: env.RUNNER_PROFILE_DELEGATION_TENANT_ID!, secret: env.RUNNER_PROFILE_DELEGATION_SECRET!,
  } : undefined;
  return env.RUNNER_API_URL && env.RUNNER_API_KEY
    ? new RunnerApiAdapter(env.RUNNER_API_URL, env.RUNNER_API_KEY, env.RUNNER_API_FETCH ?? fetch, selection, delegatedProfile)
    : null;
}

/** Стабильный ключ попытки: вычисляется ДО отправки из (userTaskId, generation). */
export async function stableAttemptKey(userTaskId: string, generation: number): Promise<string> {
  // WebCrypto: доступен и в Workers, и в Node 20+. require('node:crypto') в
  // бандле Workers не работает (Dynamic require is not supported).
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${userTaskId}:${generation}`));
  const hex = [...new Uint8Array(digest)]
    .slice(0, 10)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `run-${hex}`;
}
