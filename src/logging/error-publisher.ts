/**
 * Публикация C12 ErrorEvent в Error Watcher (POST /errors, push intake с
 * x-watcher-key + x-watcher-scopes: error:write). Публикация не блокирует
 * пользовательский путь: сбой транспорта уходит в локальный spool со счётчиком
 * dropped, наружу исключение не пробрасывается.
 */

export interface C12ErrorEvent {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  source: { service: string; release: string; environment: string };
  scope: { kind: 'profile' | 'platform'; tenantId?: string | null; profileId?: string | null };
  correlation: { userTaskId?: string | null; runId?: string | null; traceId?: string | null };
  replyContext: { channel?: string | null; destinationRef?: string | null; status: string };
  error: {
    code: string;
    operation: string;
    severity: 'error' | 'warning' | 'info';
    retryable: boolean;
    outcome: 'failed' | 'unknown' | 'resolved';
    safeSummary: string;
    privateDetailsRef?: string | null;
  };
  origin: { kind: string; incidentId?: string | null; diagnosticDepth: number };
}

export type PublishErrorFn = (event: C12ErrorEvent) => Promise<void>;

export interface ErrorPublisherOptions {
  watcherUrl: string;
  watcherKey: string;
  environment: string;
}

export interface ErrorPublisherEnv {
  ERROR_WATCHER_URL?: string;
  ERROR_WATCHER_KEY?: string;
}

const SERVICE = 'trained-assist-control-plane';
const WATCHER_SCOPES = 'error:write';
const PUBLISH_TIMEOUT_MS = 5000;
const SPOOL_MAX_ENTRIES = 100;

/** Имена полей, значение которых никогда не уходит наружу. */
const SENSITIVE_KEYS = new Set([
  'apikey',
  'authorization',
  'auth',
  'cookie',
  'password',
  'secret',
  'token',
  'credential',
  'bindingvalue',
  'privatekey',
  'private',
  'x-principal-secret',
  'answer',
  'text',
  'payload',
]);

const SECRET_PATTERNS: RegExp[] = [
  /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9]{8,}\b/g,
  /\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s"']+/gi,
];

let spool: C12ErrorEvent[] = [];
let droppedCount = 0;
let activePublisher: PublishErrorFn | null = null;

export function getDroppedCount(): number {
  return droppedCount;
}

export function getSpool(): C12ErrorEvent[] {
  return [...spool];
}

/** Активный publisher процесса; его использует logError без передачи в каждый вызов. */
export function setErrorPublisher(publisher: PublishErrorFn | null): void {
  activePublisher = publisher;
}

export function activeErrorPublisher(): PublishErrorFn | null {
  return activePublisher;
}

/** Конфигурация из env воркера: без пары URL+ключ публикация выключена. */
export function resolveErrorPublisher(env: ErrorPublisherEnv): PublishErrorFn | null {
  const watcherUrl = env.ERROR_WATCHER_URL?.trim();
  const watcherKey = env.ERROR_WATCHER_KEY?.trim();
  if (!watcherUrl || !watcherKey) return null;
  return createErrorPublisher({ watcherUrl, watcherKey, environment: 'sandbox' });
}

export function createErrorPublisher(options: ErrorPublisherOptions): PublishErrorFn {
  const endpoint = toEndpoint(options.watcherUrl);
  return async (event) => {
    let payload = event;
    try {
      payload = redactEvent({
        ...event,
        source: { ...event.source, service: SERVICE, environment: options.environment },
      });
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-watcher-key': options.watcherKey,
          'x-watcher-scopes': WATCHER_SCOPES,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      });
      if (response.ok) return;
    } catch {
      // Сеть/timeout/несериализуемое тело — событие уходит в spool ниже.
    }
    spoolEvent(payload);
  };
}

function toEndpoint(watcherUrl: string): string {
  const base = watcherUrl.replace(/\/+$/, '');
  return base.endsWith('/errors') ? base : `${base}/errors`;
}

function spoolEvent(event: C12ErrorEvent): void {
  spool.push(event);
  if (spool.length > SPOOL_MAX_ENTRIES) spool.shift();
  droppedCount += 1;
}

function redactEvent(event: C12ErrorEvent): C12ErrorEvent {
  return redactValue(event) as C12ErrorEvent;
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[redacted]' : redactValue(entry);
    }
    return out;
  }
  return value;
}

function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === 'string' ? `${prefix}[redacted]` : '[redacted]',
    );
  }
  return out;
}
