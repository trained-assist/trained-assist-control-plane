/**
 * Разговор (conversation) как единица работы web-слоя: одна conversation —
 * последовательность сообщений пользователя и ходов задач.
 *
 * Что здесь принципиально:
 *  - **Источник истины — control plane.** Локально web держит только durable-индекс
 *    разговора (для sandbox — память/KV) и курсоры чтения. Всё остальное
 *    восстанавливается replay'ом журнала по курсору, поэтому рестарт web или
 *    control plane не теряет и не перезапускает ничего.
 *  - **Ключи идемпотентности детерминированы от номера сообщения**
 *    (`web:<conversation>:m<N>`): повтор отправки (двойной клик, F5, потерянный
 *    ответ) даёт ту же квитанцию и тот же сигнал, а не новую задачу и не второе
 *    пробуждение.
 *  - **Никакого автоматического rerun.** Потеря связи (`unknown`) показывается
 *    как «исход неизвестен», продолжение — только явным действием.
 */
import type { ControlPlaneEvent, TaskStatusView } from './contract';
import { hasUnknownOutcome, isTerminalTaskStatus } from './contract';
import type { ControlPlaneClient } from './control-plane-client';
import { ControlPlaneError } from './control-plane-client';
import { logWeb, type WebLogSink } from './log';

/** Ключ идемпотентности сообщения (он же `requestId` приёма C01). */
export const messageKey = (conversationId: string, seq: number): string => `web:${conversationId}:m${seq}`;

export interface TurnIndexEntry {
  seq: number;
  /** Разговор, которому принадлежит сообщение. */
  conversationId: string;
  kind: 'new' | 'answer';
  /** Ключ идемпотентности сообщения. */
  requestId: string;
  /** Для kind=new — задача; для kind=answer — задача, у которой открыто ожидание. */
  userTaskId: string;
  text: string;
  createdAt: number;
}

export interface ConversationIndex {
  conversationId: string;
  profileId: string;
  turns: TurnIndexEntry[];
  /** Последний прочитанный курсор по каждой задаче (ускорение reconnect). */
  cursors: Record<string, number>;
}

/**
 * Хранилище индекса. В Worker это KV-биндинг, в тестах — память; интерфейс
 * намеренно узкий, чтобы durable-состояние web-слоя не разрослось.
 */
export interface TurnIndexStore {
  load(conversationId: string): Promise<ConversationIndex | null>;
  save(index: ConversationIndex): Promise<void>;
}

export class MemoryTurnIndexStore implements TurnIndexStore {
  private readonly data = new Map<string, ConversationIndex>();

  async load(conversationId: string): Promise<ConversationIndex | null> {
    const found = this.data.get(conversationId);
    return found ? structuredClone(found) : null;
  }

  async save(index: ConversationIndex): Promise<void> {
    this.data.set(index.conversationId, structuredClone(index));
  }

  /** Снимок/восстановление — имитация перезапуска процесса web при живом KV. */
  snapshot(): ConversationIndex[] {
    return [...this.data.values()].map((v) => structuredClone(v));
  }

  restore(items: ConversationIndex[]): void {
    this.data.clear();
    for (const item of items) this.data.set(item.conversationId, structuredClone(item));
  }
}

export interface AwaitingTurn {
  seq: number;
  userTaskId: string;
  awaitingId: string;
  question: string;
  /** Номер следующего сообщения-ответа (детерминированный ключ). */
  answerSeq: number;
}

export interface TurnView {
  seq: number;
  kind: 'new' | 'answer';
  userTaskId: string;
  text: string;
  createdAt: number;
  status: string;
  stage: string | null;
  cursor: number;
  runIds: string[];
  currentRunId: string | null;
  generation: number;
  runStartedCount: number;
  answersUsed: number;
  awaiting: { id: string; question: string; consumedByRun: string | null; answeredAt: number | null } | null;
  terminal: 'done' | 'failed' | 'cancelled' | null;
  result: unknown;
  artifacts: { ref: string; url: string }[];
  /** Попытка в `unknown`: исход потерян, задача не failed (P06). */
  unknownOutcome: boolean;
  /** Оборванная доставка пробуждения — сигнал сохранён, экземпляр не проснулся. */
  wakeDeliveryInterrupted: boolean;
  /** Поздние записи, отклонённые терминальным guard'ом (#90). */
  lateWritesRejected: number;
  /** Сколько раз прежняя попытка была отозвана fencing'ом (подъём поколения). */
  fenced: number;
  /** Ключи принятых сигналов — по ним видно, что дубль не создал второй сигнал. */
  signalKeys: string[];
}

export interface ConversationView {
  conversationId: string;
  profileId: string;
  /** Каким транспортом прочитан журнал: курсор C02 или fallback /status. */
  transport: string | null;
  turns: TurnView[];
  awaiting: AwaitingTurn | null;
  unknownOutcomeTurns: TurnView[];
  artifacts: { seq: number; userTaskId: string; ref: string; url: string }[];
  nextSeq: number;
  transportNote?: string;
}

export interface SendResult {
  seq: number;
  requestId: string;
  userTaskId: string;
  receiptId: string;
  /** true — приём был повтором: вернулась прежняя квитанция (C01). */
  duplicate: boolean;
  /** false — задача уже была терминальной (перезапуск не создаётся). */
  started: boolean;
  view: ConversationView;
}

export interface AnswerResult {
  seq: number;
  requestId: string;
  userTaskId: string;
  delivered: boolean;
  duplicate: boolean;
  view: ConversationView;
}

export interface ContinuationResult {
  seq: number;
  userTaskId: string;
  runId: string;
  generation: number;
  view: ConversationView;
}

export class ConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`conversation ${conversationId} is unknown to this web sandbox`);
    this.name = 'ConversationNotFoundError';
  }
}

export class NoAwaitingInputError extends Error {
  constructor(conversationId: string) {
    super(`conversation ${conversationId} has no open awaiting input`);
    this.name = 'NoAwaitingInputError';
  }
}

export interface ConversationSessionOptions {
  conversationId: string;
  profileId: string;
  store: TurnIndexStore;
  logSink?: WebLogSink;
  /** Максимум сообщений в разговоре (защита от бесконечного цикла в песочнице). */
  maxTurns?: number;
}

const TERMINAL_META = { done: 'done', failed: 'failed', cancelled: 'cancelled' } as const;

export class ConversationSession {
  private index: ConversationIndex | null = null;
  /** Проекции по задачам: накапливаются в рамках сессии, пересобираются с нуля после рестарта. */
  private readonly projections = new Map<string, TaskProjection>();
  private readonly store: TurnIndexStore;
  private readonly maxTurns: number;

  constructor(
    private readonly client: ControlPlaneClient,
    private readonly options: ConversationSessionOptions,
  ) {
    this.store = options.store;
    this.maxTurns = options.maxTurns ?? 64;
  }

  private log(fields: Parameters<typeof logWeb>[0]): void {
    logWeb(fields, this.options.logSink);
  }

  private async requireIndex(): Promise<ConversationIndex> {
    if (this.index) return this.index;
    const stored = await this.store.load(this.options.conversationId);
    if (!stored) throw new ConversationNotFoundError(this.options.conversationId);
    this.index = stored;
    return stored;
  }

  /**
   * Создать разговор: пустой durable-индекс. Задач здесь ещё нет — первое
   * сообщение пользователя принимается через `sendMessage`.
   */
  async create(): Promise<ConversationView> {
    const index: ConversationIndex = {
      conversationId: this.options.conversationId,
      profileId: this.options.profileId,
      turns: [],
      cursors: {},
    };
    await this.store.save(index);
    this.index = index;
    this.log({ event: 'web.conversation.created', conversationId: index.conversationId, profileId: index.profileId });
    return this.refresh();
  }

  /** Открыть разговор: индекс из durable-хранилища + replay журнала по курсору. */
  async open(): Promise<ConversationView> {
    await this.requireIndex();
    return this.refresh();
  }

  /**
   * Новое сообщение пользователя: приём (C01) + запуск принятой задачи.
   * Повтор того же `seq` = та же квитанция и никакого второго запуска.
   */
  async sendMessage(text: string, seq?: number): Promise<SendResult> {
    const index = await this.requireIndex();
    // seq задан — повторная отправка той же формы: ключ тот же, квитанция та же.
    const target = seq ?? index.turns.length + 1;
    if (target > this.maxTurns) throw new Error(`conversation ${index.conversationId} reached maxTurns=${this.maxTurns}`);
    const existing = index.turns.find((t) => t.seq === target);
    const requestId = existing?.requestId ?? messageKey(index.conversationId, target);
    const receipt = await this.client.intake({ requestId, text, conversationId: index.conversationId });

    // Старт идемпотентен (экземпляр по id задачи), поэтому его повторяют и при
    // повторе приёма: ответ мог потеряться между квитанцией и запуском.
    const started = await this.startOrKeepTerminal(receipt.userTaskId, text);
    if (!existing) {
      index.turns.push({
        seq: target,
        conversationId: index.conversationId,
        kind: 'new',
        requestId,
        userTaskId: receipt.userTaskId,
        text,
        createdAt: receipt.acceptedAt,
      });
      await this.store.save(index);
    }
    this.log({
      event: receipt.duplicate ? 'web.conversation.message_duplicate' : 'web.conversation.message',
      conversationId: index.conversationId,
      userTaskId: receipt.userTaskId,
      requestId,
      reason: receipt.duplicate ? 'idempotent_replay' : started ? 'started' : 'already_terminal',
      started,
    });
    return {
      seq: target,
      requestId,
      userTaskId: receipt.userTaskId,
      receiptId: receipt.receiptId,
      duplicate: receipt.duplicate,
      started,
      view: await this.refresh(),
    };
  }

  /**
   * Ответ человеку в открытом ожидании. Ключ детерминирован номером сообщения,
   * поэтому двойная отправка не создаёт второй сигнал и не будит план дважды.
   */
  async answer(text: string, seq?: number): Promise<AnswerResult> {
    const index = await this.requireIndex();
    const awaiting = (await this.refresh()).awaiting;
    if (!awaiting) throw new NoAwaitingInputError(index.conversationId);
    // seq задан — повторная отправка той же формы ответа: ключ сигнала тот же.
    const target = seq ?? index.turns.length + 1;
    const requestId = messageKey(index.conversationId, target);
    const ack = await this.client.signal(awaiting.userTaskId, {
      type: 'user_reply',
      payload: { answer: text },
      idempotencyKey: requestId,
    });
    const existing = index.turns.find((t) => t.seq === target);
    if (!existing) {
      index.turns.push({
        seq: target,
        conversationId: index.conversationId,
        kind: 'answer',
        requestId,
        userTaskId: awaiting.userTaskId,
        text,
        createdAt: Date.now(),
      });
      await this.store.save(index);
    }
    this.log({
      event: 'web.conversation.answer',
      conversationId: index.conversationId,
      userTaskId: awaiting.userTaskId,
      requestId,
      reason: ack.duplicate ? 'idempotent_replay' : (ack.reason ?? (ack.delivered ? 'delivered' : 'not_delivered')),
    });
    return {
      seq: target,
      requestId,
      userTaskId: awaiting.userTaskId,
      delivered: ack.delivered,
      duplicate: ack.duplicate,
      view: await this.refresh(),
    };
  }

  /**
   * Явное продолжение после потери связи: НОВЫЙ runId, generation+1. Вызывает
   * только пользователь; автоматического rerun в web нет by design.
   */
  async continueUnknown(seq: number, instructions?: string): Promise<ContinuationResult> {
    const index = await this.requireIndex();
    const turn = index.turns.find((t) => t.seq === seq);
    if (!turn) throw new ConversationNotFoundError(`${index.conversationId}#${seq}`);
    const ack = await this.client.resume(turn.userTaskId, {
      reason: 'explicit_user_continuation',
      instructions,
    });
    this.log({
      event: 'web.conversation.continuation',
      conversationId: index.conversationId,
      userTaskId: turn.userTaskId,
      runId: ack.runId,
      reason: 'explicit_user_continuation',
      generation: ack.generation,
    });
    return { seq, userTaskId: turn.userTaskId, runId: ack.runId, generation: ack.generation, view: await this.refresh() };
  }

  /** Перезапуск прерванных экземпляров control plane (после рестарта процесса). */
  async recover(): Promise<unknown> {
    return this.client.recover();
  }

  /**
   * Обновить вид: по каждой задаче — страницы журнала после курсора, затем
   * read-only статус. Ни одного шага плана, ни одного rerun.
   */
  async refresh(): Promise<ConversationView> {
    const index = await this.requireIndex();
    const turns: TurnView[] = [];
    for (const entry of index.turns) {
      // Холодная сессия (рестарт web или первый запрос) пересобирает вид с нуля:
      // журнал читается целиком, курсор — только оптимизация тёплой сессии.
      const cold = !this.projections.has(entry.userTaskId);
      const projection = this.projectionFor(entry.userTaskId);
      let page = await this.client.events(entry.userTaskId, cold ? 0 : (index.cursors[entry.userTaskId] ?? 0));
      while (true) {
        projection.apply(page.events);
        if (!page.hasMore) break;
        page = await this.client.events(entry.userTaskId, page.nextCursor ?? projection.cursor);
      }
      const status = await this.client.status(entry.userTaskId);
      projection.applyStatus(status);
      index.cursors[entry.userTaskId] = projection.cursor;
      turns.push(projection.view(entry, this.client.eventTransport));
    }
    await this.store.save(index);

    const awaiting = awaitingTurnOf(index.turns, turns);
    const artifacts = turns.flatMap((t) =>
      t.artifacts.map((a) => ({ seq: t.seq, userTaskId: t.userTaskId, ref: a.ref, url: a.url })),
    );
    const unknownOutcomeTurns = turns.filter((t) => t.unknownOutcome);
    return {
      conversationId: index.conversationId,
      profileId: index.profileId,
      transport: this.client.eventTransport,
      turns,
      awaiting,
      unknownOutcomeTurns,
      artifacts,
      nextSeq: index.turns.length + 1,
      transportNote:
        this.client.eventTransport === 'status-history'
          ? 'журнал прочитан через /status (C02 /events недоступен в этой сборке control plane)'
          : undefined,
    };
  }

  /** Открытое ожидание разговора из уже посчитанной проекции. */
  async currentAwaiting(): Promise<AwaitingTurn | null> {
    const index = await this.requireIndex();
    const view = await this.refresh();
    return view.awaiting ?? awaitingTurnOf(index.turns, view.turns);
  }

  /** Проекция задачи: накапливает события; холодный старт — с курсора 0. */
  private projectionFor(userTaskId: string): TaskProjection {
    const existing = this.projections.get(userTaskId);
    if (existing) return existing;
    const created = new TaskProjection(userTaskId, 0);
    this.projections.set(userTaskId, created);
    return created;
  }

  private async startOrKeepTerminal(userTaskId: string, goal: string): Promise<boolean> {
    try {
      const ack = await this.client.start(userTaskId, { question: `Уточнение по задаче: ${goal.slice(0, 120)}` });
      return ack.instanceCreated || ack.runId !== null;
    } catch (e) {
      // Терминальная задача перезапускается только явным новым сообщением.
      if (e instanceof ControlPlaneError && e.status === 409) {
        this.log({
          event: 'web.conversation.start_skipped',
          userTaskId,
          reason: 'terminal_state',
        });
        return false;
      }
      throw e;
    }
  }
}

/**
 * Проекция журнала одной задачи: чистая свёртка событий C02. Один и тот же код
 * работает при первом открытии страницы и при reconnect после рестарта —
 * различается только стартовый курсор.
 */
class TaskProjection {
  private status = 'draft';
  private stage: string | null = null;
  private generation = 0;
  private runIds: string[] = [];
  private currentRunId: string | null = null;
  private runStartedCount = 0;
  private answersUsed = 0;
  private terminal: 'done' | 'failed' | 'cancelled' | null = null;
  private result: unknown = null;
  private artifactRefs: string[] = [];
  private lateWritesRejected = 0;
  private wakeInterrupted = false;
  private signalKeys: string[] = [];
  private runsUnknown = false;
  private fencedCount = 0;
  openAwaiting: { id: string; question: string; consumedByRun: string | null; answeredAt: number | null } | null = null;

  constructor(
    private readonly userTaskId: string,
    public cursor: number,
  ) {}

  apply(events: ControlPlaneEvent[]): void {
    for (const event of events) {
      this.cursor = Math.max(this.cursor, event.sequence);
      if (event.payload['rejected'] === 'terminal_state') {
        this.lateWritesRejected += 1;
        continue;
      }
      const runId = event.runId ?? str(event.payload['runId']);
      switch (event.kind) {
        case 'run_started':
          this.runStartedCount += 1;
          if (runId) {
            this.runIds.push(runId);
            this.currentRunId = runId;
          }
          break;
        case 'fenced':
          // Подъём поколения виден в статусе; в журнале — сам факт отзыва прав.
          this.fencedCount += 1;
          break;
        case 'awaiting_opened':
          this.openAwaiting = {
            id: str(event.payload['awaitingInputId']) ?? '',
            question: str(event.payload['question']) ?? '',
            consumedByRun: null,
            answeredAt: null,
          };
          break;
        case 'awaiting_answered': {
          const id = str(event.payload['awaitingInputId']);
          if (this.openAwaiting && (id === null || id === this.openAwaiting.id)) {
            this.openAwaiting.consumedByRun = str(event.payload['consumedByRun']);
            this.openAwaiting.answeredAt = event.occurredAt;
          }
          this.answersUsed += 1;
          break;
        }
        case 'signal_received': {
          const key = str(event.payload['idempotencyKey']);
          if (key && !this.signalKeys.includes(key)) this.signalKeys.push(key);
          break;
        }
        case 'signal_rejected':
          this.signalKeys.push(`rejected:${event.sequence}`);
          break;
        case 'result_ready':
          this.result = event.payload['result'] ?? this.result;
          this.artifactRefs.push(...(event.artifactRefs ?? []));
          break;
        case 'task_status_changed':
        case 'task_cancelled': {
          const after = str(event.payload['statusAfter']) ?? statusAfterOf(event);
          if (after && after in TERMINAL_META) this.terminal = TERMINAL_META[after as keyof typeof TERMINAL_META];
          break;
        }
        case 'error':
          if (str(event.payload['where']) === 'signal.wake') this.wakeInterrupted = true;
          break;
        default:
          break;
      }
      if (event.type === 'task_failed' && !this.terminal) this.terminal = 'failed';
      if (event.type === 'stopped' && !this.terminal) this.terminal = 'cancelled';
    }
  }

  applyStatus(status: TaskStatusView): void {
    this.status = status.status;
    this.stage = status.stage;
    this.generation = status.generation;
    this.result = status.result ?? this.result;
    if (isTerminalTaskStatus(status.status) && !this.terminal) {
      this.terminal = status.status as 'done' | 'failed' | 'cancelled';
    }
    this.runsUnknown = hasUnknownOutcome(status);
  }

  view(entry: TurnIndexEntry, transport: string | null): TurnView {
    const artifacts = [...new Set(this.artifactRefs)].map((ref) => ({
      ref,
      url: artifactPath(entry.conversationId, entry.userTaskId, ref),
    }));
    return {
      seq: entry.seq,
      kind: entry.kind,
      userTaskId: entry.userTaskId,
      text: entry.text,
      createdAt: entry.createdAt,
      status: this.status,
      stage: this.stage,
      cursor: this.cursor,
      runIds: this.runIds,
      currentRunId: this.currentRunId,
      generation: this.generation,
      runStartedCount: this.runStartedCount,
      answersUsed: this.answersUsed,
      awaiting: this.openAwaiting
        ? {
            id: this.openAwaiting.id,
            question: this.openAwaiting.question,
            consumedByRun: this.openAwaiting.consumedByRun,
            answeredAt: this.openAwaiting.answeredAt,
          }
        : null,
      terminal: this.terminal,
      result: this.result,
      artifacts,
      unknownOutcome: this.runsUnknown,
      wakeDeliveryInterrupted: this.wakeInterrupted,
      lateWritesRejected: this.lateWritesRejected,
      fenced: this.fencedCount,
      signalKeys: this.signalKeys,
    };
  }
}

/**
 * Открытое ожидание = последняя задача-реплика, у которой `awaiting_opened`
 * есть, а `awaiting_answered` ещё не было. Ответ расходует его ровно один раз.
 */
const awaitingTurnOf = (entries: TurnIndexEntry[], turns: TurnView[]): AwaitingTurn | null => {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    const entry = entries.find((e) => e.seq === turn.seq)!;
    if (entry.kind !== 'new') continue;
    if (turn.awaiting && turn.awaiting.consumedByRun === null) {
      return {
        seq: turn.seq,
        userTaskId: turn.userTaskId,
        awaitingId: turn.awaiting.id,
        question: turn.awaiting.question,
        answerSeq: entries.length + 1,
      };
    }
  }
  return null;
};

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const statusAfterOf = (event: ControlPlaneEvent): string | null => {
  const after = event.payload['statusAfter'];
  return typeof after === 'string' ? after : null;
};

/** Путь артефакта через web-слой: байты отдаёт control plane, web их проксирует. */
export const artifactPath = (conversationId: string, userTaskId: string, ref: string): string =>
  `/web/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(ref)}`;

export { ConversationSession as default };