/**
 * Локальная песочница control plane для web-среза: реализует тот же HTTP-контракт
 * (`/intake`, `/receipt`, `/start`, `/signal`, `/status`, `/events`, `/resume`,
 * `/recover`, `/connection-lost`, `/artifact`) поверх памяти.
 *
 * Зачем он нужен при уже существующем control plane:
 *   1) тесты и сквозной прогон web не должны требовать деплоя и учётных данных
 *      (правила эпика: бесплатные движки, секреты только в SM);
 *   2) в песочнице можно воспроизвести управляемые сбои, которых нет в боевом
 *      API: оборванная доставка пробуждения, потерянный ответ после записи,
 *      рестарт процесса посреди ожидания, потеря связи с исполнителем.
 *
 * Ключевое свойство песочницы — РАЗДЕЛЕНИЕ durable-состояния и времени работы:
 * `durableState()` переживает `restart()`, а экземпляры плана — нет. Поэтому
 * «рестарт сервера посередине» здесь настоящий: после него план поднимается
 * заново и перечитывает журнал, а не продолжает с в памяти. Новую попытку при
 * этом никто не создаёт (нет rerun) — ровно то свойство, которое проверяет
 * сквозной сценарий шага 7.
 *
 * Лексика журнала и статусов — как в control plane (A2 §5, §6), чтобы проекция
 * web не знала, где она читает события.
 */

export type TaskStatus =
  | 'draft'
  | 'active'
  | 'paused'
  | 'blocked'
  | 'awaiting_input'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface FakeEventRow {
  id: number;
  event_id: string | null;
  user_task_id: string;
  task_item_id: string | null;
  execution_id: string | null;
  kind: string;
  status_before: string | null;
  status_after: string | null;
  generation: number | null;
  source: string;
  payload_json: string;
  created_at: number;
}

export interface FakeAwaitingRow {
  awaiting_input_id: string;
  user_task_id: string;
  run_id: string | null;
  kind: 'data' | 'choice' | 'approval';
  question: string;
  respondent_scope: string;
  status: 'open' | 'answered' | 'expired' | 'cancelled';
  created_at: number;
  deadline_at: number;
  answered_at: number | null;
  answer_json: string | null;
  generation: number;
  /** Попытка, чей экземпляр ответ был уже потреблён — для проверки «ровно один раз». */
  consumed_by_run: string | null;
}

export interface FakeSignalRow {
  id: number;
  user_task_id: string;
  step_key: string;
  idempotency_key: string;
  event_type: string;
  payload_json: string;
  generation: number | null;
  source: string;
  created_at: number;
  consumed_at: number | null;
  rejected_reason: string | null;
  /** Доставлено ли пробуждение экземпляру (обрыв доставки — отдельный сбой). */
  delivered: boolean;
}

export interface FakeRunRow {
  id: string;
  task_id: string;
  status: 'running' | 'unknown' | 'success' | 'failed' | 'interrupted' | 'cancelled' | 'waiting';
  generation: number;
  started_at: number;
  finished_at: number | null;
  error_class: string | null;
  result_json: string | null;
}

export interface FakeTaskRow {
  id: string;
  profile_id: string;
  goal: string;
  status: TaskStatus;
  stage: string | null;
  conversation_id: string | null;
  generation: number;
  revision: number;
  result_json: string | null;
  awaiting_input_id: string | null;
  delivery_state: string;
  created_at: number;
  updated_at: number;
  request_id: string | null;
  envelope_hash: string | null;
  run_started_count: number;
  answers_used: number;
  artifact_refs: string[];
}

export interface FakePrincipal {
  principal_id: string;
  profile_id: string;
  scopes: string[];
  enabled: boolean;
}

/** Durable-состояние песочницы: то, что переживает рестарт процесса. */
export interface FakeDurableState {
  version: 1;
  nextEventId: number;
  nextSignalId: number;
  nextRunSeq: number;
  nextAwaitingSeq: number;
  tasks: FakeTaskRow[];
  events: FakeEventRow[];
  signals: FakeSignalRow[];
  awaiting: FakeAwaitingRow[];
  runs: FakeRunRow[];
  principals: FakePrincipal[];
  artifacts: { taskId: string; ref: string; bytes: string; contentType: string; sha256: string; size: number }[];
}

/**
 * Управляемые сбои. Каждый срабатывает один раз и снимается после —
 * сценарий проверяет и сам сбой, и восстановление.
 */
export interface FakeFaults {
  /** Ответ на сигнал теряется ПОСЛЕ durable-записи: web обязан повторить с тем же ключом. */
  loseSignalResponseOnce?: boolean;
  /** Ответ на сигнал теряется ДО записи: повтор с тем же ключом должен записать один раз. */
  dropSignalWriteOnce?: boolean;
  /** Ответ на приём теряется ПОСЛЕ записи квитанции (повтор = та же квитанция). */
  loseIntakeResponseOnce?: boolean;
  /** Доставка пробуждения обрывается: ответ сохранён, экземпляр не разбужен. */
  dropWakeDeliveryOnce?: boolean;
  /** Попытка теряет связь с исполнителем посреди работы (P06: unknown, не failed). */
  loseRunConnectionOnce?: boolean;
  /** HTTP-слой недоступен целиком (процесс упал) — web получит сетевую ошибку. */
  offlineOnce?: boolean;
}

export interface FakePlanOptions {
  /** Сколько уточнений задаёт план до терминального результата. */
  questionsBeforeDone: number;
  /** Вопросы по очереди; если не заданы — генерируются по номеру хода. */
  questions?: string[];
  /** Выпустить небольшой артефакт вместе с терминальным результатом. */
  artifactOnDone: boolean;
  waitTimeoutSec: number;
  /**
   * Хук песочницы: сколько уточнений задаёт план для конкретной задачи.
   * Нужен сквозному сценарию, где последнее сообщение не требует ответа.
   */
  questionsFor?: (task: FakeTaskRow) => number;
}

const DEFAULT_PLAN: FakePlanOptions = {
  questionsBeforeDone: 2,
  artifactOnDone: true,
  waitTimeoutSec: 3600,
};

const TERMINAL: readonly string[] = ['done', 'failed', 'cancelled'];
const DEFAULT_SCOPES = ['tasks:intake', 'tasks:read', 'tasks:signal', 'tasks:control'];

const isTerminal = (status: string): boolean => TERMINAL.includes(status);

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const base64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

/** Экземпляр плана: то, что теряется при рестарте процесса. */
interface FakeInstance {
  taskId: string;
  runId: string;
  generation: number;
  /** Фаза плана, восстанавливается из журнала при подъёме после рестарта. */
  phase: 'prepare' | 'awaiting' | 'evaluate' | 'finalize';
  awaitingId: string | null;
  /** Ответы, потреблённые этой попыткой (после рестарта берутся из журнала). */
  usedAnswers: number;
}

export interface FakeControlPlaneOptions {
  state?: FakeDurableState;
  plan?: Partial<FakePlanOptions>;
  faults?: FakeFaults;
  /** Мгновение времени (тесты фиксируют его, чтобы курсоры были детермированы). */
  now?: () => number;
  /** Фиксировать сетевые ответы (для отчётов e2e). */
  httpLog?: { method: string; path: string; status: number }[];
}

export class FakeControlPlane {
  private state: FakeDurableState;
  private readonly plan: FakePlanOptions;
  private faults: FakeFaults;
  private readonly instances = new Map<string, FakeInstance>();
  private readonly now: () => number;
  private readonly httpLog: { method: string; path: string; status: number }[] | undefined;
  /** Признак, что процесс «перезапустили»: для отчёта e2e. */
  restarts = 0;

  constructor(options: FakeControlPlaneOptions = {}) {
    this.plan = { ...DEFAULT_PLAN, ...options.plan };
    this.faults = { ...options.faults };
    this.now = options.now ?? (() => Date.now());
    this.httpLog = options.httpLog;
    this.state = options.state ?? emptyState();
  }

  // ---------------------------------------------------------------- состояние

  durableState(): FakeDurableState {
    return structuredClone(this.state);
  }

  /** Рестарт процесса: durable-состояние остаётся, экземпляны плана исчезают. */
  restart(): void {
    this.instances.clear();
    this.restarts += 1;
  }

  setFault(fault: keyof FakeFaults): void {
    this.faults = { ...this.faults, [fault]: true };
  }

  clearFault(fault: keyof FakeFaults): void {
    const next = { ...this.faults };
    delete next[fault];
    this.faults = next;
  }

  activeFaults(): string[] {
    return Object.entries(this.faults)
      .filter(([, on]) => on === true)
      .map(([name]) => name);
  }

  task(taskId: string): FakeTaskRow | undefined {
    return this.state.tasks.find((t) => t.id === taskId);
  }

  runs(taskId: string): FakeRunRow[] {
    return this.state.runs.filter((r) => r.task_id === taskId);
  }

  events(taskId: string): FakeEventRow[] {
    return this.state.events.filter((e) => e.user_task_id === taskId).sort((a, b) => a.id - b.id);
  }

  awaitingRows(taskId: string): FakeAwaitingRow[] {
    return this.state.awaiting.filter((a) => a.user_task_id === taskId);
  }

  /** Кто доставляет пробуждение экземпляру (control plane, не web). */
  hasInstance(taskId: string): boolean {
    return this.instances.has(taskId);
  }

  // ------------------------------------------------------------------ HTTP

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as never, init);
    const url = new URL(request.url);
    if (this.consumeFault('offlineOnce')) throw new TypeError('fetch failed: control plane unreachable (injected)');
    try {
      const response = await this.route(request, url);
      this.httpLog?.push({ method: request.method, path: url.pathname, status: response.status });
      return response;
    } catch (e) {
      if (e instanceof HttpError) {
        this.httpLog?.push({ method: request.method, path: url.pathname, status: e.status });
        return json({ error: e.message, name: e.name }, e.status);
      }
      this.httpLog?.push({ method: request.method, path: url.pathname, status: 0 });
      throw e;
    }
  };

  private async route(request: Request, url: URL): Promise<Response> {
    const body = request.method === 'POST' ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
    const taskId = (body['taskId'] as string | undefined) ?? url.searchParams.get('taskId') ?? '';

    if (url.pathname === '/') return json({ service: 'fake-control-plane', endpoints: this.endpoints() });
    if (url.pathname === '/intake') return await this.intake(request, body);
    if (url.pathname === '/receipt') {
      const receipt = this.state.events.find((e) => e.kind === 'task_accepted' && e.user_task_id === taskId);
      if (!receipt) return json({ error: 'receipt not found' }, 404);
      const payload = parse(receipt.payload_json);
      return json({
        receiptId: receipt.event_id,
        requestId: payload['requestId'] ?? null,
        userTaskId: taskId,
        profileId: payload['profileId'] ?? '',
        acceptedAt: receipt.created_at,
        durable: true,
      });
    }
    if (url.pathname === '/events') {
      this.authorize(request, taskId, 'tasks:read');
      const after = Number(url.searchParams.get('after') ?? '0');
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') ?? '100')), 500);
      const rows = this.events(taskId).filter((e) => e.id > after).slice(0, limit);
      return json({
        events: rows.map((row) => c02Envelope(row)),
        nextCursor: rows.length ? rows[rows.length - 1]!.id : after,
        hasMore: rows.length === limit,
      });
    }
    if (url.pathname === '/artifact') {
      const ref = url.searchParams.get('ref') ?? '';
      const found = this.state.artifacts.find((a) => a.taskId === taskId && a.ref === ref);
      if (!found) return json({ error: 'artifact not found' }, 404);
      return json({
        ref: found.ref,
        sizeBytes: found.size,
        sha256: found.sha256,
        contentType: found.contentType,
        bodyBase64: found.bytes,
      });
    }
    if (url.pathname === '/start') return this.start(request, body, taskId);
    if (url.pathname === '/signal') return this.signal(request, body, taskId);
    if (url.pathname === '/cancel') return this.cancel(request, taskId, body);
    if (url.pathname === '/status') return this.status(request, taskId);
    if (url.pathname === '/resume') return this.resume(request, taskId, body);
    if (url.pathname === '/connection-lost') return this.connectionLost(body);
    if (url.pathname === '/recover') return this.recover();
    return json({ error: 'not found' }, 404);
  }

  private endpoints(): string[] {
    return [
      '/intake',
      '/receipt',
      '/start',
      '/signal',
      '/status',
      '/events',
      '/resume',
      '/recover',
      '/connection-lost',
      '/artifact',
    ];
  }

  private consumeFault(fault: keyof FakeFaults): boolean {
    if (this.faults[fault] !== true) return false;
    this.clearFault(fault);
    return true;
  }

  private authorize(request: Request, taskId: string, scope: string): FakeTaskRow {
    const principalId = request.headers.get('x-principal') ?? '';
    const principal = this.state.principals.find((p) => p.principal_id === principalId);
    if (!principal || !principal.enabled) throw httpError(401, 'unauthorized');
    if (taskId) {
      const task = this.state.tasks.find((t) => t.id === taskId);
      if (!task) throw httpError(404, 'task not found');
      if (task.profile_id !== principal.profile_id) throw httpError(403, 'profile_mismatch');
    }
    if (!principal.scopes.includes(scope)) throw httpError(403, 'scope_missing');
    return this.state.tasks.find((t) => t.id === taskId)!;
  }

  private principalFor(request: Request): FakePrincipal {
    const principalId = request.headers.get('x-principal') ?? '';
    const principal = this.state.principals.find((p) => p.principal_id === principalId);
    if (!principal || !principal.enabled) throw httpError(401, 'unauthorized');
    return principal;
  }

  // ------------------------------------------------------------------ приём

  private async intake(request: Request, body: Record<string, unknown>): Promise<Response> {
    const principal = this.principalFor(request);
    const profileId = String(body['profileId'] ?? '');
    if (profileId !== principal.profile_id) throw httpError(403, 'profile_mismatch');
    if (!principal.scopes.includes('tasks:intake')) throw httpError(403, 'scope_missing');

    const requestId = String(body['requestId'] ?? '').trim();
    if (!requestId) throw httpError(400, 'requestId is required');
    const envelopeHash = await sha256Hex(canonical(significant(body)));
    const existing = this.state.tasks.find((t) => t.request_id === requestId && t.profile_id === profileId);
    if (existing) {
      if (existing.envelope_hash !== envelopeHash) throw httpError(409, 'idempotency_conflict');
      const receipt = this.state.events.find((e) => e.kind === 'task_accepted' && e.user_task_id === existing.id);
      return json(
        {
          receiptId: receipt?.event_id ?? `rcpt-${existing.id}`,
          requestId,
          userTaskId: existing.id,
          profileId,
          acceptedAt: existing.created_at,
          durable: true,
          duplicate: true,
        },
        200,
      );
    }

    const items = Array.isArray(body['inputItems']) ? (body['inputItems'] as Record<string, unknown>[]) : [];
    const goal = items.map((i) => String(i['text'] ?? '')).filter(Boolean).join('\n').trim();
    if (!goal) throw httpError(400, 'inputItems must not be empty');

    const conversationRef = typeof body['conversationRef'] === 'string' ? body['conversationRef'] : null;
    const taskId = `ut-${requestId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48)}-${hash6(requestId)}`;
    const at = this.now();
    const task: FakeTaskRow = {
      id: taskId,
      profile_id: profileId,
      goal,
      status: 'draft',
      stage: null,
      conversation_id: conversationRef,
      generation: 1,
      revision: 0,
      result_json: null,
      awaiting_input_id: null,
      delivery_state: 'none',
      created_at: at,
      updated_at: at,
      request_id: requestId,
      envelope_hash: envelopeHash,
      run_started_count: 0,
      answers_used: 0,
      artifact_refs: [],
    };
    this.state.tasks.push(task);
    const receiptId = `rcpt-${taskId}`;
    this.log(task, {
      kind: 'task_accepted',
      eventId: receiptId,
      generation: task.generation,
      statusAfter: 'draft',
      payload: { requestId, profileId, conversationRef, receiptId, envelopeHash, acceptedAt: at },
    });

    // Потерянный ответ после записи: web обязан повторить и получить эту же квитанцию.
    if (this.consumeFault('loseIntakeResponseOnce')) throw new TypeError('fetch failed: intake response lost (injected)');

    return json(
      {
        receiptId,
        requestId,
        userTaskId: taskId,
        profileId,
        acceptedAt: at,
        durable: true,
        duplicate: false,
      },
      201,
    );
  }

  // ------------------------------------------------------------------ запуск

  private start(request: Request, body: Record<string, unknown>, taskId: string): Response {
    const task = this.authorize(request, taskId, 'tasks:intake');
    if (isTerminal(task.status)) throw httpError(409, 'terminal_state');
    const alreadyStarted = task.run_started_count > 0;
    let runId = alreadyStarted ? (this.runs(taskId).find((r) => r.status === 'running')?.id ?? null) : null;
    if (!runId) {
      runId = this.newRun(task);
      task.run_started_count += 1;
      this.log(task, {
        kind: 'run_started',
        runId,
        generation: task.generation,
        statusAfter: task.status,
        payload: { runId, generation: task.generation, engine: 'fake-plan' },
      });
    }
    this.instances.set(taskId, {
      taskId,
      runId,
      generation: task.generation,
      phase: 'prepare',
      awaitingId: null,
      usedAnswers: 0,
    });
    this.advance(taskId);
    return json({
      taskId,
      instanceId: taskId,
      created: false,
      instanceCreated: !alreadyStarted,
      generation: task.generation,
      runId,
    });
  }

  // ---------------------------------------------------------------- сигналы

  private signal(request: Request, body: Record<string, unknown>, taskId: string): Response {
    const task = this.authorize(request, taskId, 'tasks:signal');
    const idempotencyKey = String(body['idempotencyKey'] ?? '').trim() || `web:${crypto.randomUUID()}`;
    const eventType = String(body['type'] ?? 'user_reply');
    const payload = body['payload'] ?? {};
    const source = String(body['source'] ?? 'web');

    const existing = this.state.signals.find(
      (s) => s.user_task_id === taskId && s.idempotency_key === idempotencyKey && s.step_key === 'wait',
    );
    if (existing) {
      // Дубль ключа: новой строки нет, но доставка повторяется безвредно —
      // waitForEvent берёт первое событие, план перечитывает durable-состояние.
      const wake = this.deliverWake(task, existing);
      return json({ delivered: wake, signalId: existing.id, duplicate: true, reason: existing.rejected_reason ?? undefined });
    }

    if (isTerminal(task.status)) {
      const row: FakeSignalRow = {
        id: this.state.nextSignalId++,
        user_task_id: taskId,
        step_key: 'wait',
        idempotency_key: idempotencyKey,
        event_type: eventType,
        payload_json: JSON.stringify(payload),
        generation: task.generation,
        source,
        created_at: this.now(),
        consumed_at: null,
        rejected_reason: 'terminal_state',
        delivered: false,
      };
      this.state.signals.push(row);
      this.log(task, { kind: 'signal_rejected', payload: { reason: 'terminal_state', source } });
      return json({ delivered: false, signalId: row.id, duplicate: false, reason: 'terminal_state' });
    }

    if (this.consumeFault('dropSignalWriteOnce')) throw new TypeError('fetch failed: signal write lost (injected)');

    const row: FakeSignalRow = {
      id: this.state.nextSignalId++,
      user_task_id: taskId,
      step_key: 'wait',
      idempotency_key: idempotencyKey,
      event_type: eventType,
      payload_json: JSON.stringify(payload),
      generation: task.generation,
      source,
      created_at: this.now(),
      consumed_at: null,
      rejected_reason: null,
      delivered: false,
    };
    this.state.signals.push(row);
    this.log(task, {
      kind: 'signal_received',
      payload: { source, step: 'wait', idempotencyKey, signalId: row.id, eventType },
    });

    if (this.consumeFault('loseSignalResponseOnce')) throw new TypeError('fetch failed: signal response lost (injected)');

    const delivered = this.deliverWake(task, row);
    return json({ delivered, signalId: row.id, duplicate: false });
  }

  /**
   * Доставка пробуждения. Обрыв доставки — управляемый сбой #116: ответ уже
   * в task_signals, но экземпляр не проснулся. Ничего не теряется: повтор с
   * тем же ключом (или `/recover`) доставляет сохранённый ответ.
   */
  private deliverWake(task: FakeTaskRow, signal: FakeSignalRow): boolean {
    if (this.consumeFault('dropWakeDeliveryOnce')) {
      this.log(task, { kind: 'error', payload: { where: 'signal.wake', reason: 'delivery_interrupted', signalId: signal.id } });
      return false;
    }
    if (!this.instances.has(task.id)) {
      // Экземпляр потерян (рестарт процесса): ответ сохранён, разбудит recover.
      this.log(task, { kind: 'error', payload: { where: 'signal.wake', reason: 'instance_missing', signalId: signal.id } });
      return false;
    }
    signal.delivered = true;
    this.advance(task.id);
    return true;
  }

  // -------------------------------------------------------------- план/статус

  /** Один шаг плана. Каждый вход — из durable-состояния, не из памяти процесса. */
  private advance(taskId: string): void {
    const task = this.state.tasks.find((t) => t.id === taskId);
    const instance = this.instances.get(taskId);
    if (!task || !instance || isTerminal(task.status)) return;

    if (instance.phase === 'prepare') {
      this.commit(task, {
        kind: 'step_done',
        step: 'prepare',
        statusAfter: 'active',
        stage: 'running',
        payload: { version: 'fake-plan-v1' },
      });
      instance.phase = 'awaiting';
      this.advance(taskId);
      return;
    }

    if (instance.phase === 'awaiting') {
      const open = this.awaitingRows(taskId).find((a) => a.status === 'open');
      if (open) {
        instance.awaitingId = open.awaiting_input_id;
        // Ответ мог прийти и быть сохранён, пока экземпляр спал (или был потерян):
        // сохранённый сигнал — источник истины, а не доставленное событие.
        const answered = this.consumeAnswer(task, instance);
        if (!answered) return; // парк: ждём ответа человека
      }
      instance.phase = 'evaluate';
      this.advance(taskId);
      return;
    }

    if (instance.phase === 'evaluate') {
      const questions = this.plan.questionsFor?.(task) ?? this.plan.questionsBeforeDone;
      if (task.answers_used < questions) {
        instance.phase = 'awaiting';
        this.openAwaiting(task, instance);
        return;
      }
      instance.phase = 'finalize';
      this.advance(taskId);
      return;
    }

    if (instance.phase === 'finalize') {
      void this.finalize(task, instance);
    }
  }

  private openAwaiting(task: FakeTaskRow, instance: FakeInstance): void {
    const open = this.awaitingRows(task.id).find((a) => a.status === 'open');
    if (open) {
      // Повтор шага: ожидание уже открыто — прежний адрес ответа (тот же id).
      instance.awaitingId = open.awaiting_input_id;
      return;
    }
    const question = this.plan.questions?.[task.answers_used] ?? `Уточнение ${task.answers_used + 1}: продолжить?`;
    const row: FakeAwaitingRow = {
      awaiting_input_id: `aw-${this.state.nextAwaitingSeq++}-${hash6(task.id)}`,
      user_task_id: task.id,
      run_id: instance.runId,
      kind: 'data',
      question,
      respondent_scope: task.profile_id,
      status: 'open',
      created_at: this.now(),
      deadline_at: this.now() + this.plan.waitTimeoutSec * 1000,
      answered_at: null,
      answer_json: null,
      generation: task.generation,
      consumed_by_run: null,
    };
    this.state.awaiting.push(row);
    task.awaiting_input_id = row.awaiting_input_id;
    this.commit(task, {
      kind: 'awaiting_opened',
      step: 'wait',
      statusAfter: 'awaiting_input',
      stage: 'waiting_input',
      runId: instance.runId,
      payload: { awaitingInputId: row.awaiting_input_id, question, runId: instance.runId, kind: row.kind },
    });
  }

  /**
   * Потребление ответа: сохранённый сигнал + открытое ожидание ->
   * `awaiting_answered`. Повторное пробуждение уже закрытое ожидание не
   * закрывает снова (ответ расходуется ровно один раз).
   */
  private consumeAnswer(task: FakeTaskRow, instance: FakeInstance): boolean {
    const open = this.awaitingRows(task.id).find((a) => a.status === 'open');
    if (!open) return true;
    const signal = this.state.signals.find(
      (s) => s.user_task_id === task.id && s.event_type === 'user_reply' && s.consumed_at === null,
    );
    if (!signal) return false; // ответа ещё нет — ждём дальше

    signal.consumed_at = this.now();
    open.status = 'answered';
    open.answered_at = this.now();
    open.answer_json = signal.payload_json;
    open.consumed_by_run = instance.runId;
    task.answers_used += 1;
    task.awaiting_input_id = null;
    instance.usedAnswers += 1;
    const run = this.state.runs.find((r) => r.id === instance.runId);
    if (run && run.status === 'waiting') run.status = 'running';
    this.commit(task, {
      kind: 'step_woken',
      step: 'wait',
      runId: instance.runId,
      payload: { signalId: signal.id, awaitingInputId: open.awaiting_input_id },
    });
    this.commit(task, {
      kind: 'awaiting_answered',
      step: 'wait',
      runId: instance.runId,
      payload: {
        awaitingInputId: open.awaiting_input_id,
        signalId: signal.id,
        consumedByRun: instance.runId,
        turn: task.answers_used,
      },
    });
    return true;
  }

  private async finalize(task: FakeTaskRow, instance: FakeInstance): Promise<void> {
    const artifactRefs: string[] = [];
    if (this.plan.artifactOnDone) {
      const ref = `art-${hash6(`${task.id}:${task.answers_used}`)}`;
      const body = [
        `conversation task: ${task.id}`,
        `run: ${instance.runId}`,
        `answers used: ${task.answers_used}`,
        `status: done`,
        '',
        'result: песочница web-среза, шаг 7 M1',
      ].join('\n');
      this.state.artifacts.push({
        taskId: task.id,
        ref,
        bytes: base64(body),
        contentType: 'text/plain; charset=utf-8',
        sha256: await sha256Hex(body),
        size: new TextEncoder().encode(body).length,
      });
      artifactRefs.push(ref);
      task.artifact_refs.push(ref);
    }
    const result = { ok: true, answersUsed: task.answers_used, runId: instance.runId, version: 'fake-plan-v1' };
    task.result_json = JSON.stringify(result);
    const run = this.state.runs.find((r) => r.id === instance.runId);
    if (run) {
      run.status = 'success';
      run.finished_at = this.now();
      run.result_json = task.result_json;
    }
    this.commit(task, {
      kind: 'result_ready',
      step: 'finalize',
      runId: instance.runId,
      payload: { result, artifactRefs, runId: instance.runId },
    });
    this.commit(task, {
      kind: 'task_status_changed',
      step: 'finalize',
      statusBefore: task.status,
      statusAfter: 'done',
      stage: 'finished',
      runId: instance.runId,
      payload: { result, artifactRefs, runId: instance.runId, reason: 'plan_finished' },
    });
    this.instances.delete(task.id);
  }

  // --------------------------------------------------------- статус/восстановление

  private status(request: Request, taskId: string): Response {
    const task = this.authorize(request, taskId, 'tasks:read');
    const history = this.events(taskId).map((e) => ({
      id: e.id,
      kind: e.kind,
      step: e.task_item_id,
      before: e.status_before,
      after: e.status_after,
      gen: e.generation,
      payload: e.payload_json,
      at: e.created_at,
    }));
    const signals = this.state.signals
      .filter((s) => s.user_task_id === taskId)
      .map((s) => ({
        id: s.id,
        step: s.step_key,
        type: s.event_type,
        consumed: s.consumed_at,
        rejected: s.rejected_reason,
        payload: s.payload_json,
      }));
    const latest = [...this.awaitingRows(taskId)].sort((a, b) => b.created_at - a.created_at)[0];
    return json({
      taskStore: {
        id: task.id,
        status: task.status,
        stage: task.stage,
        generation: task.generation,
        revision: task.revision,
        result: task.result_json ? parse(task.result_json) : null,
        conversation_id: task.conversation_id,
        awaiting_input_id: task.awaiting_input_id,
        delivery_state: task.delivery_state,
        updated_at: task.updated_at,
        history,
        signals,
        awaiting: latest
          ? { id: latest.awaiting_input_id, status: latest.status, deadline: latest.deadline_at, question: latest.question }
          : null,
      },
      runs: this.runs(taskId),
      engine: {
        status: this.instances.has(taskId) ? (task.status === 'awaiting_input' ? 'waiting' : 'running') : 'complete',
        restarts: this.restarts,
      },
    });
  }

  private cancel(request: Request, taskId: string, body: Record<string, unknown>): Response {
    const task = this.authorize(request, taskId, 'tasks:control');
    if (isTerminal(task.status)) return json({ cancelled: false, status: task.status, stopConfirmed: false });
    this.commit(task, {
      kind: 'cancel_requested',
      payload: { reason: String(body['reason'] ?? 'user_cancel') },
    });
    this.instances.delete(taskId);
    const run = this.state.runs.find((r) => r.task_id === taskId && r.status !== 'success' && r.finished_at === null);
    if (run) {
      run.status = 'cancelled';
      run.finished_at = this.now();
    }
    this.commit(task, {
      kind: 'task_cancelled',
      statusBefore: task.status,
      statusAfter: 'cancelled',
      stage: 'finished',
      payload: { reason: String(body['reason'] ?? 'user_cancel'), stopConfirmed: true },
    });
    return json({ cancelled: true, generation: task.generation, status: 'cancelled', stopConfirmed: true });
  }

  /** Явное продолжение: НОВЫЙ runId и generation+1; прежняя попытка лишена прав. */
  private resume(request: Request, taskId: string, body: Record<string, unknown>): Response {
    const task = this.authorize(request, taskId, 'tasks:control');
    if (isTerminal(task.status)) throw httpError(409, 'terminal_state');
    const stale = this.runs(taskId).find((r) => r.finished_at === null);
    if (stale) {
      stale.status = 'interrupted';
      stale.finished_at = this.now();
      stale.error_class = 'generation_superseded';
    }
    this.commit(task, {
      kind: 'fenced',
      generation: task.generation,
      payload: { reason: 'resume_generation_bump', supersededRunId: stale?.id ?? null },
    });
    task.generation += 1;
    task.revision += 1;
    task.updated_at = this.now();
    const runId = this.newRun(task, 'resume');
    this.log(task, {
      kind: 'run_started',
      runId,
      generation: task.generation,
      statusAfter: task.status,
      payload: { runId, generation: task.generation, continuation: 'explicit_resume', reason: String(body['reason'] ?? '') },
    });
    const open = this.awaitingRows(taskId).find((a) => a.status === 'open');
    const usedAnswers = this.awaitingRows(taskId).filter((a) => a.status === 'answered').length;
    this.instances.set(taskId, {
      taskId,
      runId,
      generation: task.generation,
      phase: open ? 'awaiting' : usedAnswers > 0 ? 'evaluate' : 'prepare',
      awaitingId: open?.awaiting_input_id ?? null,
      usedAnswers,
    });
    this.advance(taskId);
    return json({ runId, generation: task.generation });
  }

  /** Потеря связи с исполнителем: попытка `unknown`, задача не меняется. */
  private connectionLost(body: Record<string, unknown>): Response {
    const runId = String(body['runId'] ?? '');
    const run = this.state.runs.find((r) => r.id === runId);
    if (!run) return json({ error: 'run not found' }, 404);
    const task = this.state.tasks.find((t) => t.id === run.task_id)!;
    if (isTerminal(task.status)) return json({ runId: run.id, status: run.status, taskId: task.id });
    run.status = 'unknown';
    run.error_class = String(body['reason'] ?? 'connection_lost');
    this.instances.delete(task.id);
    this.log(task, {
      kind: 'error',
      runId,
      payload: { where: 'run.connection_lost', reason: run.error_class, outcome: 'unknown' },
    });
    return json({ runId: run.id, status: run.status, errorClass: run.error_class, taskId: task.id });
  }

  /**
   * Подъём прерванных экземплянов после рестарта процесса. Тот же runId и то же
   * поколение: новая попытка не создаётся (нет rerun), позиция плана
   * восстанавливается из durable-журнала и сохранённых сигналов.
   */
  private recover(): Response {
    const out: unknown[] = [];
    for (const task of this.state.tasks) {
      if (isTerminal(task.status)) continue;
      const run = this.runs(task.id).find((r) => r.finished_at === null);
      if (!run || !this.instances.has(task.id)) {
        if (!run) continue;
        const open = this.awaitingRows(task.id).find((a) => a.status === 'open');
        const answered = this.awaitingRows(task.id).filter((a) => a.status === 'answered').length;
        this.instances.set(task.id, {
          taskId: task.id,
          runId: run.id,
          generation: task.generation,
          phase: open ? 'awaiting' : answered > 0 ? 'evaluate' : 'prepare',
          awaitingId: open?.awaiting_input_id ?? null,
          usedAnswers: answered,
        });
        if (run.status === 'running') run.status = 'waiting';
        this.log(task, {
          kind: 'step_woken',
          runId: run.id,
          generation: task.generation,
          payload: { reason: 'instance_rehydrated', runId: run.id, restarts: this.restarts, rerun: false },
        });
        this.advance(task.id);
      }
      out.push({ id: task.id, runId: run?.id ?? null, engineStatus: this.instances.has(task.id) ? 'running' : 'complete' });
    }
    return json(out);
  }

  // ----------------------------------------------------------------- журнал

  private newRun(task: FakeTaskRow, cause = 'start'): string {
    const id = `run-${String(this.state.nextRunSeq++).padStart(4, '0')}-${hash6(`${task.id}:${this.state.nextRunSeq}`)}`;
    this.state.runs.push({
      id,
      task_id: task.id,
      status: 'running',
      generation: task.generation,
      started_at: this.now(),
      finished_at: null,
      error_class: null,
      result_json: null,
    });
    return id;
  }

  /** Запись события + (если задано) смена состояния — как в Task Store. */
  private commit(
    task: FakeTaskRow,
    event: {
      kind: string;
      step?: string | null;
      statusBefore?: string | null;
      statusAfter?: string | null;
      stage?: string | null;
      runId?: string | null;
      generation?: number | null;
      payload?: Record<string, unknown>;
      eventId?: string | null;
    },
  ): FakeEventRow {
    const row: FakeEventRow = {
      id: this.state.nextEventId++,
      event_id: event.eventId ?? null,
      user_task_id: task.id,
      task_item_id: event.step ?? null,
      execution_id: event.runId ?? null,
      kind: event.kind,
      status_before: event.statusBefore ?? (event.statusAfter ? task.status : null),
      status_after: event.statusAfter ?? null,
      generation: event.generation ?? task.generation,
      source: 'executor',
      payload_json: JSON.stringify({ ...(event.payload ?? {}), runId: event.runId ?? undefined }),
      created_at: this.now(),
    };
    this.state.events.push(row);
    if (event.statusAfter) {
      // Терминальные состояния неизменяемы (guard #90).
      if (isTerminal(task.status) && task.status !== event.statusAfter) {
        this.state.events.push({
          ...row,
          id: this.state.nextEventId++,
          status_after: null,
          payload_json: JSON.stringify({ rejected: 'terminal_state', kind: event.kind }),
        });
        return row;
      }
      task.status = event.statusAfter as TaskStatus;
      task.revision += 1;
      task.updated_at = this.now();
    }
    if (event.stage) task.stage = event.stage;
    return row;
  }

  private log(
    task: FakeTaskRow,
    event: {
      kind: string;
      step?: string | null;
      statusAfter?: string | null;
      stage?: string | null;
      runId?: string | null;
      generation?: number | null;
      payload?: Record<string, unknown>;
      eventId?: string | null;
    },
  ): FakeEventRow {
    return this.commit(task, event);
  }
}

// ------------------------------------------------------------------ утилиты

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const httpError = (status: number, message: string): HttpError => new HttpError(status, message);

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value, null, 1), { status, headers: { 'content-type': 'application/json' } });

const parse = (value: string): Record<string, unknown> => {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const significant = (envelope: Record<string, unknown>): Record<string, unknown> => {
  const { requestId: _requestId, ...rest } = envelope;
  return rest;
};

const hash6 = (value: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 6);
};

/** Конверт C02 поверх строки журнала (совпадает с control plane). */
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

const c02Envelope = (row: FakeEventRow): Record<string, unknown> => {
  const payload = parse(row.payload_json);
  const type =
    C02_TYPE_BY_KIND[row.kind] ??
    (row.status_after ? C02_TYPE_BY_STATUS_AFTER[row.status_after] : undefined) ??
    'progress';
  return {
    eventId: row.event_id,
    sequence: row.id,
    userTaskId: row.user_task_id,
    runId: typeof payload['runId'] === 'string' ? payload['runId'] : null,
    type,
    occurredAt: row.created_at,
    payload,
    artifactRefs: Array.isArray(payload['artifactRefs']) ? payload['artifactRefs'] : [],
    kind: row.kind,
  };
};

export function emptyState(): FakeDurableState {
  return {
    version: 1,
    nextEventId: 1,
    nextSignalId: 1,
    nextRunSeq: 1,
    nextAwaitingSeq: 1,
    tasks: [],
    events: [],
    signals: [],
    awaiting: [],
    runs: [],
    principals: [{ principal_id: 'sandbox-web', profile_id: 'profile-web-sandbox', scopes: [...DEFAULT_SCOPES], enabled: true }],
    artifacts: [],
  };
}

/** sha256 строки в hex — синхронно нельзя, поэтому общий помощник для тестов. */
export async function sha256(text: string): Promise<string> {
  return sha256Hex(text);
}

export async function newRunId(seed: string): Promise<string> {
  return `run-${(await sha256Hex(seed)).slice(0, 8)}`;
}