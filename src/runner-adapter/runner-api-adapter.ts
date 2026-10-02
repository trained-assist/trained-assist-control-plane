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
import { RunnerConflictError, RunnerNotFoundError, RunnerStaleGenerationError, RunnerUnavailableError } from './errors';

export interface RunnerSubmitInput {
  userTaskId: string;
  conversationId?: string | null;
  engineName?: string;
  inputText?: string | null;
  inputRefs?: string[];
  instructions?: string | null;
  idempotencyKey: string;
  timeoutMs?: number;
}

export interface RunnerReceipt {
  requestId: string;
  userTaskId: string;
  runId: string;
  deduplicated: boolean;
}

export interface RunnerStatusView {
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
  persistence: 'pending' | 'persisted' | 'failed';
  cleanup: 'pending' | 'completed' | 'failed';
  logPath: string;
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

export class RunnerApiAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Вызов fetch с привязкой к globalThis: в Workers глобальный fetch требует
   * правильного `this`, иначе `Illegal invocation` (поймано живым прогоном).
   */
  private doFetch(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl.call(globalThis, url, init) as Promise<Response>;
  }

  private async request<T>(method: string, path: string, opts: { body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
        },
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
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      const code = err?.code ?? `HTTP_${res.status}`;
      const message = err?.message ?? text;
      if (res.status === 404 || code === 'NOT_FOUND') throw new RunnerNotFoundError(message);
      if (code === 'STALE_OWNER_GENERATION') throw new RunnerStaleGenerationError(message);
      if (res.status >= 500 || res.status === 429) throw new RunnerUnavailableError(`${code}: ${message}`);
      throw new RunnerConflictError(`${code}: ${message}`);
    }
    return json as T;
  }

  async submit(input: RunnerSubmitInput): Promise<RunnerReceipt> {
    return this.request<RunnerReceipt>('POST', '/v1/runs', {
      idempotencyKey: input.idempotencyKey,
      body: {
        userTaskId: input.userTaskId,
        conversationId: input.conversationId ?? null,
        engine: { name: input.engineName ?? 'opencode', adapterVersion: '1' },
        input: { text: input.inputText ?? null, refs: input.inputRefs ?? [] },
        envAllowlist: [],
        limits: { timeoutMs: input.timeoutMs ?? 300000 },
        instructions: input.instructions ?? null,
      },
    });
  }

  async status(runId: string): Promise<RunnerStatusView> {
    return this.request<RunnerStatusView>('GET', `/v1/runs/${runId}/status`);
  }

  async result(runId: string): Promise<RunnerResult> {
    return this.request<RunnerResult>('GET', `/v1/runs/${runId}/result`);
  }

  async events(runId: string, cursor = 0, limit = 500): Promise<RunnerEventsPage> {
    return this.request<RunnerEventsPage>('GET', `/v1/runs/${runId}/events?cursor=${cursor}&limit=${limit}`);
  }

  async artifacts(runId: string): Promise<RunnerArtifact[]> {
    const res = await this.request<{ artifacts: RunnerArtifact[] }>('GET', `/v1/runs/${runId}/artifacts`);
    return res.artifacts;
  }

  async cancel(runId: string, opts: { ownerGeneration?: number; reason?: string } = {}): Promise<{ status: string; reason?: string; state?: string }> {
    return this.request('POST', `/v1/runs/${runId}/cancel`, { body: { ownerGeneration: opts.ownerGeneration, reason: opts.reason } });
  }
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
