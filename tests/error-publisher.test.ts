import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createErrorPublisher,
  getDroppedCount,
  getSpool,
  resolveErrorPublisher,
  setErrorPublisher,
  type C12ErrorEvent,
} from '../src/logging/error-publisher';
import { logError } from '../src/logging';
import { logStructured } from '../src/logging/structured-log';

const makeEvent = (over: Partial<C12ErrorEvent> = {}): C12ErrorEvent => ({
  schemaVersion: 1,
  eventId: 'E-1',
  occurredAt: '2026-10-07T00:00:00.000Z',
  source: { service: 'trained-assist-control-plane', release: 'sandbox', environment: 'sandbox' },
  scope: { kind: 'profile', tenantId: null, profileId: 'p-1' },
  correlation: { userTaskId: 'ut-1', runId: 'run-1', traceId: null },
  replyContext: { channel: null, destinationRef: null, status: 'not_applicable' },
  error: {
    code: 'run.failed',
    operation: 'run.failed',
    severity: 'error',
    retryable: true,
    outcome: 'failed',
    safeSummary: 'engine crashed',
    privateDetailsRef: null,
  },
  origin: { kind: 'application', incidentId: null, diagnosticDepth: 0 },
  ...over,
});

const lastCall = <T extends { mock: { calls: unknown[][] } }>(fetchMock: T): [string, RequestInit] =>
  fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];

afterEach(() => {
  vi.unstubAllGlobals();
  setErrorPublisher(null);
});

describe('error-publisher: публикация в Error Watcher', () => {
  it('POST /errors с ключом, scope и корректным C12 ErrorEvent', async () => {
    const fetchMock = vi.fn(async () => new Response('{"reasonCode":"EVENT_ACCEPTED"}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const publish = createErrorPublisher({ watcherUrl: 'https://watcher.test', watcherKey: 'wk-1', environment: 'sandbox' });

    await publish(makeEvent({ eventId: 'E-1' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe('https://watcher.test/errors');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeTruthy();
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-watcher-key']).toBe('wk-1');
    expect(headers['x-watcher-scopes']).toBe('error:write');
    const body = JSON.parse(String(init.body)) as C12ErrorEvent;
    expect(body).toEqual(makeEvent());
    expect(body.source).toEqual({ service: 'trained-assist-control-plane', release: 'sandbox', environment: 'sandbox' });
    expect(body.scope).toEqual({ kind: 'profile', tenantId: null, profileId: 'p-1' });
    expect(body.correlation).toEqual({ userTaskId: 'ut-1', runId: 'run-1', traceId: null });
    expect(body.replyContext.status).toBe('not_applicable');
    expect(body.error).toEqual(makeEvent().error);
    expect(body.origin).toEqual({ kind: 'application', incidentId: null, diagnosticDepth: 0 });
  });

  it('URL, уже оканчивающийся на /errors, используется без удвоения', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const publish = createErrorPublisher({
      watcherUrl: 'https://watcher.test/errors',
      watcherKey: 'wk-1',
      environment: 'sandbox',
    });

    await publish(makeEvent());

    const [url] = lastCall(fetchMock);
    expect(url).toBe('https://watcher.test/errors');
  });

  it('сбой fetch и не-2xx: dropped растёт, событие спулится, публикация не бросает', async () => {
    const publish = createErrorPublisher({ watcherUrl: 'https://watcher.test', watcherKey: 'wk-1', environment: 'sandbox' });
    const droppedBefore = getDroppedCount();
    const spoolBefore = getSpool().length;

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await expect(publish(makeEvent({ eventId: 'E-net-drop' }))).resolves.toBeUndefined();
    expect(getDroppedCount()).toBe(droppedBefore + 1);
    let spooled = getSpool();
    expect(spooled.length).toBe(spoolBefore + 1);
    expect(spooled.at(-1)?.eventId).toBe('E-net-drop');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 500 })));
    await expect(publish(makeEvent({ eventId: 'E-http-drop' }))).resolves.toBeUndefined();
    expect(getDroppedCount()).toBe(droppedBefore + 2);
    spooled = getSpool();
    expect(spooled.length).toBe(spoolBefore + 2);
    expect(spooled.at(-1)?.eventId).toBe('E-http-drop');
  });

  it('секреты в safeSummary и в полях события вымарываются до отправки', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const publish = createErrorPublisher({ watcherUrl: 'https://watcher.test', watcherKey: 'wk-1', environment: 'sandbox' });
    const event = {
      ...makeEvent({ eventId: 'E-redacted' }),
      error: {
        ...makeEvent().error,
        safeSummary: 'upstream 401, Bearer eyJhbGciOiJIUzI1Ni.abc123 token=supersecretvalue',
      },
      token: 'raw-secret-token',
    } as C12ErrorEvent;

    await publish(event);

    const [, init] = lastCall(fetchMock);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.token).toBe('[redacted]');
    const error = body.error as C12ErrorEvent['error'];
    expect(error.safeSummary).toContain('Bearer [redacted]');
    expect(error.safeSummary).toContain('[redacted]');
    expect(error.safeSummary).not.toContain('eyJhbGciOiJIUzI1Ni');
    expect(error.safeSummary).not.toContain('supersecretvalue');
    expect(error.code).toBe('run.failed');
  });
});

describe('logStructured: опубликация через publishError', () => {
  it('level:error с publisher строит и передаёт C12 ErrorEvent', async () => {
    const seen: C12ErrorEvent[] = [];
    logStructured(
      {
        event: 'run.connection_lost',
        level: 'error',
        reason: 'gateway timeout',
        profileId: 'p-7',
        userTaskId: 'ut-7',
        runId: 'run-7',
        eventId: 'E-7',
      },
      async (event) => {
        seen.push(event);
      },
    );

    expect(seen).toHaveLength(1);
    const event = seen[0]!;
    expect(event.eventId).toBe('E-7');
    expect(event.schemaVersion).toBe(1);
    expect(event.source.service).toBe('trained-assist-control-plane');
    expect(event.source.environment).toBe('sandbox');
    expect(event.scope).toEqual({ kind: 'profile', tenantId: null, profileId: 'p-7' });
    expect(event.correlation).toEqual({ userTaskId: 'ut-7', runId: 'run-7', traceId: null });
    expect(event.replyContext).toEqual({ channel: null, destinationRef: null, status: 'not_applicable' });
    expect(event.error).toEqual({
      code: 'run.connection_lost',
      operation: 'run.connection_lost',
      severity: 'error',
      retryable: true,
      outcome: 'failed',
      safeSummary: 'gateway timeout',
      privateDetailsRef: null,
    });
    expect(event.origin).toEqual({ kind: 'application', incidentId: null, diagnosticDepth: 0 });
  });

  it('без profileId scope.kind = platform, eventId генерируется', async () => {
    const seen: C12ErrorEvent[] = [];
    logStructured({ event: 'intake.watchdog_scheduler_stale', level: 'error', reason: 'scheduler_not_running' }, async (event) => {
      seen.push(event);
    });

    expect(seen).toHaveLength(1);
    const event = seen[0]!;
    expect(event.scope).toEqual({ kind: 'platform', tenantId: null, profileId: null });
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.error.safeSummary).toBe('scheduler_not_running');
  });

  it('level:warn с publisher НЕ публикует', async () => {
    const seen: C12ErrorEvent[] = [];
    logStructured({ event: 'awaiting.answer_rejected', level: 'warn', reason: 'answer_conflict' }, async (event) => {
      seen.push(event);
    });
    expect(seen).toHaveLength(0);
  });

  it('без publisher error-событие просто логируется', () => {
    expect(() => logStructured({ event: 'intake.conflict', level: 'error', reason: 'duplicate' })).not.toThrow();
  });

  it('logError публикует через активный publisher, level по умолчанию error', async () => {
    const seen: C12ErrorEvent[] = [];
    setErrorPublisher(async (event) => {
      seen.push(event);
    });
    logError({ event: 'task.event_error', reason: 'journal_error', profileId: 'p-9', userTaskId: 'ut-9' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.error.code).toBe('task.event_error');
    expect(seen[0]!.error.safeSummary).toBe('journal_error');
    expect(seen[0]!.scope.kind).toBe('profile');
  });
});

describe('resolveErrorPublisher', () => {
  it('null без пары URL+ключ, функция с настроенной парой', () => {
    expect(resolveErrorPublisher({})).toBeNull();
    expect(resolveErrorPublisher({ ERROR_WATCHER_URL: 'https://watcher.test' })).toBeNull();
    expect(resolveErrorPublisher({ ERROR_WATCHER_KEY: 'wk-1' })).toBeNull();
    expect(
      resolveErrorPublisher({ ERROR_WATCHER_URL: 'https://watcher.test', ERROR_WATCHER_KEY: 'wk-1' }),
    ).toBeTypeOf('function');
  });
});
