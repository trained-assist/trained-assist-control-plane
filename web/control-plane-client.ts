/**
 * HTTP-адаптер web-слоя к control plane (M1, шаг 7).
 *
 * Правила тонкого клиента:
 *  - приём идемпотентен по `requestId` (C01): потерянный ответ лечится ПОВТОРОМ
 *    с тем же ключом, а не новой задачей;
 *  - журнал читается ПО КУРСОРУ (C02): `after=sequence`, ответ — страница с
 *    `nextCursor`; переподключение = продолжить с последнего курсора, а не
 *    перезапуск задачи;
 *  - автоматических повторов web НЕ делает: повтор с тем же ключом идемпотентен,
 *    но решение о повторе принимает владелец хода (страница/сценарий), иначе
 *    «помощь» клиента превращается в молчаливый rerun;
 *  - потеря связи — `unknown`, а не `failed` (P06): web показывает исход как
 *    неизвестный и предлагает явное продолжение, а не перезапуск;
 *  - ключ доступа — только из env и только в заголовок (никогда в лог/URL).
 */
import type {
  ArtifactBytes,
  ControlPlaneEvent,
  EventPage,
  EventTransport,
  IntakeReceipt,
  ResumeAck,
  SignalAck,
  StartAck,
  TaskStatusView,
} from './contract';
import { isTerminalTaskStatus } from './contract';
import type { WebConfig } from './config';
import { logWeb, type WebLogFields, type WebLogSink } from './log';

export interface ControlPlaneClientOptions {
  fetchImpl?: typeof fetch;
  logSink?: WebLogSink;
}

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const numOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);

/** Статусы из /status в терминальные попытки (unknown — НЕ терминальный). */
export class ControlPlaneClient {
  private readonly fetchImpl: typeof fetch;
  private readonly logSink: WebLogSink | undefined;
  /** Решение о транспорте, принятое один раз и зафиксированное в логе. */
  private transport: EventTransport | null = null;

  constructor(
    private readonly config: WebConfig,
    options: ControlPlaneClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.logSink = options.logSink;
  }

  get eventTransport(): EventTransport | null {
    return this.transport;
  }

  private log(fields: WebLogFields): void {
    logWeb(fields, this.logSink);
  }

  /** URL с санитайзом: query-параметры контролируются, токены в URL не идут. */
  private url(pathname: string, query: Record<string, string | number | null | undefined> = {}): string {
    const url = new URL(`${this.config.controlPlaneUrl}${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private headers(): Headers {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.set('x-principal', this.config.principalId);
    if (this.config.apiKey) headers.set('authorization', `Bearer ${this.config.apiKey}`);
    return headers;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    pathname: string,
    opts: { body?: unknown; query?: Record<string, string | number | null | undefined>; signal?: AbortSignal } = {},
  ): Promise<{ status: number; value: T }> {
    const url = this.url(pathname, opts.query);
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const res = await this.fetchImpl(url, {
      method,
      headers: this.headers(),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal,
    });
    const text = await res.text();
    const value = text ? safeJson(text) : null;
    if (!res.ok) {
      throw new ControlPlaneError(res.status, `control plane ${method} ${pathname} -> ${res.status}`, value);
    }
    return { status: res.status, value: value as T };
  }

  /** Приём задачи (C01). Повтор с тем же `requestId` = та же квитанция. */
  async intake(input: {
    requestId: string;
    text: string;
    conversationId?: string | null;
    waitTimeoutSec?: number | null;
    artifactRefs?: string[];
  }): Promise<IntakeReceipt> {
    const body = {
      contractVersion: 1,
      requestId: input.requestId,
      profileId: this.config.profileId,
      conversationRef: input.conversationId ?? null,
      sessionId: this.config.sessionId,
      inputItems: [{ text: input.text, artifactRefs: input.artifactRefs ?? [] }],
      waitTimeoutSec: input.waitTimeoutSec ?? null,
    };
    const { status, value } = await this.request<Record<string, unknown>>('POST', '/intake', { body });
    // Квитанция без `durable=true` — нарушение C01: web не proceeds на
    // несохранённую задачу (иначе «принято» окажется потерянным).
    if (value['durable'] !== true) throw new ControlPlaneError(502, 'intake receipt is not durable', value);
    const receipt: IntakeReceipt = {
      receiptId: String(value['receiptId'] ?? ''),
      requestId: str(value['requestId']),
      userTaskId: String(value['userTaskId'] ?? ''),
      profileId: String(value['profileId'] ?? this.config.profileId),
      acceptedAt: numOrNull(value['acceptedAt']) ?? Date.now(),
      durable: true,
      duplicate: value['duplicate'] === true || status === 200,
    };
    if (!receipt.userTaskId) throw new ControlPlaneError(500, 'intake returned no userTaskId', value);
    this.log({
      event: receipt.duplicate ? 'web.intake.duplicate' : 'web.intake.accepted',
      profileId: this.config.profileId,
      userTaskId: receipt.userTaskId,
      requestId: receipt.requestId,
      receiptId: receipt.receiptId,
      reason: receipt.duplicate ? 'idempotent_replay' : 'accepted',
    });
    return receipt;
  }

  async receipt(userTaskId: string): Promise<Record<string, unknown> | null> {
    try {
      const { value } = await this.request<Record<string, unknown>>('GET', '/receipt', { query: { taskId: userTaskId } });
      return value;
    } catch (e) {
      if (e instanceof ControlPlaneError && e.status === 404) return null;
      throw e;
    }
  }

  /** Запуск принятой задачи: повтор = тот же экземпляр, второй запуск невозможен. */
  async start(
    userTaskId: string,
    opts: { question?: string | null; waitTimeoutSec?: number | null; crashRunOnce?: boolean } = {},
  ): Promise<StartAck> {
    const { value } = await this.request<Record<string, unknown>>('POST', '/start', {
      body: {
        taskId: userTaskId,
        profileId: this.config.profileId,
        goal: userTaskId,
        question: opts.question ?? null,
        waitTimeoutSec: opts.waitTimeoutSec ?? null,
        crashRunOnce: opts.crashRunOnce ?? false,
      },
    });
    const ack: StartAck = {
      taskId: str(value['taskId']) ?? userTaskId,
      instanceId: str(value['instanceId']) ?? userTaskId,
      created: value['created'] === true,
      instanceCreated: value['instanceCreated'] === true,
      generation: numOrNull(value['generation']) ?? 0,
      runId: str(value['runId']),
    };
    this.log({
      event: 'web.run.start',
      profileId: this.config.profileId,
      userTaskId: userTaskId,
      runId: ack.runId,
      reason: ack.instanceCreated ? 'instance_created' : 'already_started',
      generation: ack.generation,
    });
    return ack;
  }

  /**
   * Сигнал (ответ человека в ожидании). Ключ идемпотентности обязателен:
   * двойной клик, F5 и повтор после потери ответа дают один сигнал.
   */
  async signal(
    userTaskId: string,
    input: { type: string; payload: Record<string, unknown>; idempotencyKey: string; source?: string },
  ): Promise<SignalAck> {
    const { value } = await this.request<Record<string, unknown>>('POST', '/signal', {
      body: {
        taskId: userTaskId,
        type: input.type,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        source: input.source ?? 'web',
      },
    });
    const ack: SignalAck = {
      delivered: value['delivered'] === true,
      signalId: numOrNull(value['signalId']) ?? 0,
      duplicate: value['duplicate'] === true,
      reason: str(value['reason']) ?? undefined,
    };
    this.log({
      event: ack.delivered ? 'web.signal.delivered' : 'web.signal.not_delivered',
      profileId: this.config.profileId,
      userTaskId: userTaskId,
      requestId: input.idempotencyKey,
      reason: ack.reason ?? (ack.duplicate ? 'idempotent_replay' : 'delivered'),
      duplicate: ack.duplicate,
    });
    return ack;
  }

  /** Статус — только чтение (P05): ни шага, ни rerun. */
  async status(userTaskId: string): Promise<TaskStatusView> {
    const { value } = await this.request<Record<string, unknown>>('POST', '/status', { body: { taskId: userTaskId } });
    const row = asObject(value['taskStore']);
    const runs = Array.isArray(value['runs']) ? (value['runs'] as Record<string, unknown>[]) : [];
    return {
      id: str(row['id']) ?? userTaskId,
      status: str(row['status']) ?? 'unknown',
      stage: str(row['stage']),
      generation: numOrNull(row['generation']) ?? 0,
      revision: numOrNull(row['revision']) ?? 0,
      result: row['result'] ?? null,
      conversation_id: str(row['conversation_id']),
      delivery_state: str(row['delivery_state']),
      awaiting: parseAwaiting(row['awaiting']),
      runs: runs.map((r) => ({
        id: String(r['id'] ?? ''),
        status: str(r['status']) ?? 'unknown',
        generation: numOrNull(r['generation']) ?? 0,
        started_at: numOrNull(r['started_at']),
        finished_at: numOrNull(r['finished_at']),
        error_class: str(r['error_class']),
        lease_until: numOrNull(r['lease_until']),
      })),
      updated_at: numOrNull(row['updated_at']),
    };
  }

  /**
   * Страница журнала ПОСЛЕ курсора. Основной путь — C02 `/events?after=`.
   * Если эндпоинта ещё нет (control plane без шага 4) — та же таблица событий
   * читается из истории `/status`, курсор = `task_events.id` оттуда же.
   */
  async events(userTaskId: string, after: number | null, limit = 200): Promise<EventPage> {
    if (this.config.eventTransport === 'status-history') return this.eventsFromStatus(userTaskId, after, limit);
    try {
      const { value } = await this.request<Record<string, unknown>>('GET', '/events', {
        query: { taskId: userTaskId, after: after ?? 0, limit },
      });
      const page = parseEventPage(value);
      this.noteTransport('events-endpoint', null);
      return page;
    } catch (e) {
      const unavailable = e instanceof ControlPlaneError && (e.status === 404 || e.status === 405);
      if (!unavailable || this.config.eventTransport === 'events-endpoint') throw e;
      this.noteTransport('status-history', `events_endpoint_${e instanceof ControlPlaneError ? e.status : 'error'}`);
      return this.eventsFromStatus(userTaskId, after, limit);
    }
  }

  private noteTransport(transport: EventTransport, reason: string | null): void {
    if (this.transport === transport) return;
    this.transport = transport;
    this.log({ event: 'web.events.transport', profileId: this.config.profileId, transport, reason });
  }

  /**
   * Fallback-чтение журнала: `POST /status` отдаёт ту же самую таблицу событий
   * (`history`), включая монотонный `id` — он и есть курсор.
   */
  private async eventsFromStatus(userTaskId: string, after: number | null, limit: number): Promise<EventPage> {
    const { value } = await this.request<Record<string, unknown>>('POST', '/status', { body: { taskId: userTaskId } });
    const row = asObject(value['taskStore']);
    const history = Array.isArray(row['history']) ? (row['history'] as Record<string, unknown>[]) : [];
    const events = history
      .map((e) => toC02Event(e))
      .filter((e) => e.sequence > (after ?? 0))
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit);
    const last = events.at(-1)?.sequence ?? after;
    this.noteTransport('status-history', this.transport === 'status-history' ? null : 'fallback_enabled');
    return { events, nextCursor: last, hasMore: false };
  }

  /**
   * Явное продолжение после потери связи (P06/A3 §3.2.5): новый runId,
   * generation+1. Web вызывает это ТОЛЬКО по явному действию пользователя.
   */
  async resume(userTaskId: string, opts: { reason: string; instructions?: string }): Promise<ResumeAck> {
    const { value } = await this.request<Record<string, unknown>>('POST', '/resume', {
      body: { taskId: userTaskId, reason: opts.reason, instructions: opts.instructions },
    });
    const ack: ResumeAck = { runId: str(value['runId']) ?? '', generation: numOrNull(value['generation']) ?? 0 };
    this.log({
      event: 'web.run.resumed',
      profileId: this.config.profileId,
      userTaskId: userTaskId,
      runId: ack.runId,
      reason: opts.reason,
      generation: ack.generation,
    });
    return ack;
  }

  /** Разбудить прерванные экземпляры после рестарта control plane (`/recover`). */
  async recover(): Promise<unknown> {
    const { value } = await this.request<unknown>('POST', '/recover', { body: {} });
    return value;
  }

  /** Потеря связи с исполнителем: попытка `unknown`, задача не меняется. */
  async markConnectionLost(runId: string, reason = 'connection_lost'): Promise<Record<string, unknown>> {
    const { value } = await this.request<Record<string, unknown>>('POST', '/connection-lost', {
      body: { runId, reason },
    });
    this.log({ event: 'web.run.connection_lost', runId, reason });
    return value;
  }

  /**
   * Байты артефакта. Control plane отдаёт ссылку/хэш/размер (шаг 4); конкретный
   * источник байтов — отдельная договорённость (Runner/GCS), поэтому 404/501
   * web показывает честно: ссылка есть, байты в этой сборке недоступны.
   */
  async artifact(userTaskId: string, ref: string): Promise<ArtifactBytes> {
    const { value } = await this.request<Record<string, unknown>>('GET', '/artifact', {
      query: { taskId: userTaskId, ref },
    });
    const body = value['bodyBase64'];
    const bytes = typeof body === 'string' ? base64ToBytes(body) : new Uint8Array();
    return {
      ref: str(value['ref']) ?? ref,
      sizeBytes: numOrNull(value['sizeBytes']),
      sha256: str(value['sha256']),
      contentType: str(value['contentType']),
      body: bytes,
    };
  }

  /** Живая ли контр plane: дешёвая проверка аутентификации и конфигурации. */
  async health(): Promise<Record<string, unknown>> {
    const { value } = await this.request<Record<string, unknown>>('GET', '/');
    return value;
  }
}

/** Терминальный статус задачи — сигнал web «показывать результат и стоп». */
export function terminalOf(status: TaskStatusView): boolean {
  return isTerminalTaskStatus(status.status);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 400) };
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseAwaiting(value: unknown): TaskStatusView['awaiting'] {
  const row = asObject(value);
  const id = str(row['id']);
  if (!id) return null;
  return {
    id,
    status: str(row['status']) ?? 'open',
    deadline: numOrNull(row['deadline']),
    question: str(row['question']),
  };
}

function parseEventPage(value: Record<string, unknown>): EventPage {
  const raw = Array.isArray(value['events']) ? (value['events'] as Record<string, unknown>[]) : [];
  return {
    events: raw.map((e) => normalizeC02Event(e)),
    nextCursor: numOrNull(value['nextCursor']),
    hasMore: value['hasMore'] === true,
  };
}

/** Событие из `/events` — уже в C02-виде; недостающие поля добираем из kind. */
function normalizeC02Event(raw: Record<string, unknown>): ControlPlaneEvent {
  return {
    eventId: str(raw['eventId']),
    sequence: numOrNull(raw['sequence']) ?? 0,
    userTaskId: str(raw['userTaskId']) ?? '',
    runId: str(raw['runId']),
    type: str(raw['type']) ?? str(raw['kind']) ?? 'progress',
    occurredAt: numOrNull(raw['occurredAt']) ?? 0,
    payload: asObject(raw['payload']),
    artifactRefs: Array.isArray(raw['artifactRefs']) ? (raw['artifactRefs'] as string[]) : [],
    kind: str(raw['kind']) ?? str(raw['type']) ?? 'progress',
  };
}

/**
 * Событие из истории `/status` приводится к тому же конверту C02, чтобы
 * проекция разговора не знала, каким транспортом прочитаны события.
 * Лексика kind→type повторяет control plane (src/events/c02-event-envelope.ts).
 */
const C02_TYPE_BY_KIND: Record<string, string> = {
  task_accepted: 'accepted',
  run_started: 'started',
  run_finished: 'progress',
  awaiting_opened: 'waiting',
  awaiting_answered: 'progress',
  awaiting_expired: 'progress',
  signal_received: 'progress',
  signal_rejected: 'progress',
  step_woken: 'progress',
  step_started: 'progress',
  step_done: 'progress',
  step_failed: 'attempt_failed',
  result_ready: 'result_ready',
  task_cancelled: 'stopped',
  cancel_requested: 'progress',
  fenced: 'progress',
  error: 'progress',
};

const C02_TYPE_BY_STATUS_AFTER: Record<string, string> = {
  done: 'result_ready',
  failed: 'task_failed',
  cancelled: 'stopped',
};

function toC02Event(raw: Record<string, unknown>): ControlPlaneEvent {
  const payloadJson = raw['payload'];
  let payload: Record<string, unknown> = {};
  if (typeof payloadJson === 'string' && payloadJson) {
    try {
      payload = asObject(JSON.parse(payloadJson));
    } catch {
      payload = {};
    }
  } else {
    payload = asObject(payloadJson);
  }
  const statusAfter = str(raw['after']);
  const kind = str(raw['kind']) ?? 'progress';
  return {
    eventId: null,
    sequence: numOrNull(raw['id']) ?? 0,
    userTaskId: '',
    runId: str(payload['runId']),
    type: C02_TYPE_BY_KIND[kind] ?? (statusAfter ? (C02_TYPE_BY_STATUS_AFTER[statusAfter] ?? 'progress') : 'progress'),
    occurredAt: numOrNull(raw['at']) ?? 0,
    payload: { ...payload, step: str(raw['step']) },
    artifactRefs: Array.isArray(payload['artifactRefs']) ? (payload['artifactRefs'] as string[]) : [],
    kind,
  };
}