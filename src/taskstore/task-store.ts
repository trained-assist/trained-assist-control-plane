// Репозиторий Task Store (ARCHITECTURE §4.1, TASK-STORE-SCHEMA-V1 §5).
//
// Три правила, которые держит этот слой:
//  1. Текущий статус — колонка durable_tasks, история — строки task_events;
//     смена статуса и её событие пишутся ОДНОЙ D1-транзакцией (db.batch).
//  2. Generation fencing (INV-02): каждая запись от лица исполнителя идёт
//     `WHERE id = ? AND generation = ?`; при нуле строк — отказ FencedError,
//     событие fenced остаётся в журнале.
//  3. Терминальные статусы неизменяемы (issue #90): статусный апдейт идёт с
//     `AND status NOT IN ('done','failed','cancelled')`; поздняя запись
//     (например wait_timeout после done) даёт TerminalStateError, статус и
//     result_json не перезаписываются, отклонение фиксируется в task_events.
//
// Логика переиспользует pilots/p-db/cf-workflows/src/taskstore.ts (пилот P-DB,
// доказан на реальном Cloudflare), приведённую к схеме TASK-STORE-SCHEMA-V1 §6.

import {
  AlreadyOpenAwaitingError,
  FencedError,
  TerminalStateError,
  TaskNotFoundError,
  TaskStoreError,
} from './errors';
import {
  TERMINAL_STATUS_SQL,
  isTerminalStatus,
  type AwaitingInputRow,
  type AwaitingKind,
  type ConversationRow,
  type EventSource,
  type PrincipalRow,
  type SignalSource,
  type TaskEventKind,
  type TaskEventRow,
  type TaskRow,
  type TaskSignalRow,
  type TaskStage,
  type TaskStatus,
} from './types';

const NON_TERMINAL_SQL = `status NOT IN (${TERMINAL_STATUS_SQL})`;

export interface AdmitTaskInput {
  /** userTaskId (§5.1) — id строки durable_tasks. */
  id: string;
  profileId: string;
  goal: string;
  projectId?: string | null;
  conversationId?: string | null;
  audienceId?: string | null;
  destinationId?: string | null;
  /** Ключ идемпотентности приёма (C01 requestId); scope ключа = (profile_id, request_id). */
  requestId?: string | null;
  /** Сессия-источник (C01 sessionId) -> durable_tasks.origin_session_id. */
  sessionId?: string | null;
  /** receiptId квитанции; попадает в task_events.event_id (UNIQUE). */
  receiptId?: string | null;
  /** Хэш нормализованного payload: тот же requestId с другим payload = conflict. */
  envelopeHash?: string | null;
  /** Поля квитанции/envelope, которые пишутся в payload события task_accepted. */
  envelope?: Record<string, unknown> | null;
  userValue?: unknown;
  /** Заголовок диалога для conversations при создании разговора. */
  conversationTitle?: string | null;
  source?: EventSource;
}

/** Квитанция приёма (C01): durable acceptance, не запуск и не результат. */
export interface AcceptReceipt {
  receiptId: string;
  requestId: string | null;
  userTaskId: string;
  profileId: string;
  acceptedAt: number;
  envelopeHash: string | null;
  [key: string]: unknown;
}

export interface CommitOptions {
  /** Лексика kind (§5.2). По умолчанию task_status_changed при смене статуса, иначе step_done. */
  kind?: TaskEventKind;
  /** Имя шага воркфлоу (пишется в task_events.task_item_id). */
  step?: string | null;
  source?: EventSource;
  executionId?: string | null;
  status?: TaskStatus;
  stage?: TaskStage;
  /** Структурированный результат (§5.7) — JSON.stringify в result_json. */
  result?: unknown;
  payload?: unknown;
}

export interface OpenAwaitingInput {
  taskId: string;
  kind: AwaitingKind;
  question: string;
  /** Кто вправе ответить; формат значений задаёт контракт A3 (§5.6). */
  respondentScope: string;
  step?: string | null;
  runId?: string | null;
  schema?: unknown;
  checkpointRef?: string | null;
  deadlineAt?: number;
  generation?: number;
  source?: EventSource;
}

export interface AnswerAwaitingInput {
  taskId: string;
  answer: unknown;
  signalId?: number | null;
  generation?: number;
  step?: string | null;
  source?: EventSource;
}

interface StatePatch {
  status?: TaskStatus;
  stage?: TaskStage;
  result?: unknown;
  awaitingInputId?: string | null;
}

interface EventSpec {
  kind: TaskEventKind;
  step?: string | null;
  executionId?: string | null;
  source?: EventSource;
  statusAfter?: string | null;
  payload?: unknown;
}

export class TaskStore {
  constructor(private readonly db: D1Database) {}

  // ---------------------------------------------------------------- задачи

  /**
   * Приём задачи (P04/C01): строка диалога + строка задачи + событие
   * task_accepted с квитанцией (event_id = receiptId) ОДНОЙ D1-транзакцией.
   *
   * Идемпотентность: повтор с тем же userTaskId (или тем же (profile_id,
   * request_id) — UNIQUE idx_tasks_request) не создаёт вторую строку задачи и не
   * дублирует событие приёма: вставка события защищена NOT EXISTS по
   * kind='task_accepted'. Возвращается созданная задача и её квитанция.
   */
  async admitTask(input: AdmitTaskInput): Promise<{
    created: boolean;
    task: TaskRow;
    receipt: AcceptReceipt;
  }> {
    const now = Date.now();
    const stmts: D1PreparedStatement[] = [];

    if (input.conversationId) {
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO conversations(conversation_id, profile_id, project_id, audience_id, destination_id, title, created_at, updated_at)
             VALUES(?,?,?,?,?,?,?,?)
             ON CONFLICT(conversation_id) DO UPDATE SET updated_at = excluded.updated_at`,
          )
          .bind(
            input.conversationId,
            input.profileId,
            input.projectId ?? null,
            input.audienceId ?? null,
            input.destinationId ?? null,
            input.conversationTitle ?? null,
            now,
            now,
          ),
      );
    }

    stmts.push(
      this.db
        .prepare(
          `INSERT INTO durable_tasks(
             id, profile_id, project_id, goal, status, stage,
             conversation_id, audience_id, destination_id, request_id, origin_session_id, user_value,
             generation, created_at, updated_at, revision)
           VALUES(?,?,?,?,'active','queued',?,?,?,?,?,?,1,?,?,0)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          input.id,
          input.profileId,
          input.projectId ?? null,
          input.goal,
          input.conversationId ?? null,
          input.audienceId ?? null,
          input.destinationId ?? null,
          input.requestId ?? null,
          input.sessionId ?? null,
          input.userValue === undefined ? null : JSON.stringify(input.userValue),
          now,
          now,
        ),
    );

    const taskInsertIndex = stmts.length - 1;
    const receiptPayload: Record<string, unknown> = {
      ...(input.envelope ?? {}),
      receiptId: input.receiptId ?? null,
      requestId: input.requestId ?? null,
      envelopeHash: input.envelopeHash ?? null,
      acceptedAt: now,
      profileId: input.profileId,
      goal: input.goal,
    };

    // Квитанция пишется только вместе с первой строкой задачи: NOT EXISTS по
    // kind='task_accepted' делает повторный приём no-op в той же транзакции.
    stmts.push(
      this.db
        .prepare(
          `INSERT INTO task_events(event_id, user_task_id, kind, status_after, generation, source, payload_json, created_at)
           SELECT ?, ?,'task_accepted','active',1,?,?,?
           WHERE NOT EXISTS (SELECT 1 FROM task_events WHERE user_task_id = ? AND kind = 'task_accepted')`,
        )
        .bind(
          input.receiptId ?? null,
          input.id,
          input.source ?? 'input',
          JSON.stringify(receiptPayload),
          now,
          input.id,
        ),
    );

    const results = await this.db.batch(stmts);
    const created = results[taskInsertIndex]!.meta.changes === 1;
    const task = await this.requireTask(input.id);
    const storedReceipt = await this.acceptReceipt(task.id);
    return {
      created,
      task,
      receipt: storedReceipt ?? this.receiptFromPayload(task.id, input.profileId, receiptPayload),
    };
  }

  private receiptFromPayload(userTaskId: string, profileId: string, payload: Record<string, unknown>): AcceptReceipt {
    return {
      receiptId: String(payload.receiptId ?? ''),
      requestId: (payload.requestId as string | null) ?? null,
      userTaskId,
      profileId,
      acceptedAt: Number(payload.acceptedAt ?? Date.now()),
      envelopeHash: (payload.envelopeHash as string | null) ?? null,
      ...payload,
    };
  }

  /** Сохранённая квитанция приёма задачи (первое событие task_accepted). */
  async acceptReceipt(userTaskId: string): Promise<AcceptReceipt | null> {
    const row = await this.db
      .prepare(
        `SELECT event_id, generation, created_at, payload_json FROM task_events
         WHERE user_task_id = ? AND kind = 'task_accepted' ORDER BY id LIMIT 1`,
      )
      .bind(userTaskId)
      .first<{ event_id: string | null; generation: number | null; created_at: number; payload_json: string }>();
    if (!row) return null;
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const task = await this.getTask(userTaskId);
    return {
      receiptId: row.event_id ?? String(payload.receiptId ?? ''),
      requestId: (payload.requestId as string | null) ?? null,
      userTaskId,
      profileId: task?.profile_id ?? String(payload.profileId ?? ''),
      acceptedAt: row.created_at,
      envelopeHash: (payload.envelopeHash as string | null) ?? null,
      ...payload,
    };
  }

  async getTask(taskId: string): Promise<TaskRow | null> {
    return this.db.prepare(`SELECT * FROM durable_tasks WHERE id = ?`).bind(taskId).first<TaskRow>();
  }

  async requireTask(taskId: string): Promise<TaskRow> {
    const row = await this.getTask(taskId);
    if (!row) throw new TaskNotFoundError(taskId);
    return row;
  }

  async tasksByConversation(conversationId: string): Promise<TaskRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM durable_tasks WHERE conversation_id = ? ORDER BY created_at`)
      .bind(conversationId)
      .all<TaskRow>();
    return res.results;
  }

  /** Задачи, которые ещё не в терминальном статусе (для recover/status). */
  async unfinishedTasks(): Promise<{ id: string }[]> {
    const res = await this.db
      .prepare(`SELECT id FROM durable_tasks WHERE status NOT IN (${TERMINAL_STATUS_SQL})`)
      .all<{ id: string }>();
    return res.results;
  }

  async getConversation(conversationId: string): Promise<ConversationRow | null> {
    return this.db.prepare(`SELECT * FROM conversations WHERE conversation_id = ?`).bind(conversationId).first();
  }

  // -------------------------------------------------- принципалы приёма

  /**
   * Регистр принципалов приёма (P04/C13): identity + профиль + scope.
   * Секреты здесь не хранятся — проверка credential вне зоны control plane.
   */
  async upsertPrincipal(p: {
    principalId: string;
    profileId: string;
    scopes: string[];
    enabled?: boolean;
  }): Promise<PrincipalRow> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO admission_principals(principal_id, profile_id, scopes, enabled, created_at, updated_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(principal_id) DO UPDATE SET
           profile_id = excluded.profile_id,
           scopes = excluded.scopes,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .bind(p.principalId, p.profileId, JSON.stringify(p.scopes), p.enabled === false ? 0 : 1, now, now)
      .run();
    const row = await this.getPrincipal(p.principalId);
    if (!row) throw new TaskStoreError(`principal upsert failed: ${p.principalId}`);
    return row;
  }

  async getPrincipal(principalId: string): Promise<PrincipalRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM admission_principals WHERE principal_id = ?`)
      .bind(principalId)
      .first<{ principal_id: string; profile_id: string; scopes: string; enabled: number; created_at: number; updated_at: number }>();
    if (!row) return null;
    return {
      principalId: row.principal_id,
      profileId: row.profile_id,
      scopes: JSON.parse(row.scopes) as string[],
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ------------------------------------------------------------ события

  /**
   * Безусловная запись события в журнал (отклонения и факты вне переходов).
   * Вызывается только после того, как решение уже принято: журнал — свидетель,
   * он не должен быть отвергнут guard'ом, который его породил.
   */
  async logEvent(e: {
    taskId: string;
    kind: TaskEventKind;
    step?: string | null;
    executionId?: string | null;
    statusBefore?: string | null;
    statusAfter?: string | null;
    generation?: number | null;
    source?: EventSource;
    payload?: unknown;
    at?: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO task_events(user_task_id, task_item_id, execution_id, kind, status_before, status_after, generation, source, payload_json, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        e.taskId,
        e.step ?? null,
        e.executionId ?? null,
        e.kind,
        e.statusBefore ?? null,
        e.statusAfter ?? null,
        e.generation ?? null,
        e.source ?? 'executor',
        e.payload === undefined ? '{}' : JSON.stringify(e.payload),
        e.at ?? Date.now(),
      )
      .run();
  }

  async history(taskId: string): Promise<TaskEventRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM task_events WHERE user_task_id = ? ORDER BY id`)
      .bind(taskId)
      .all<TaskEventRow>();
    return res.results;
  }

  /** Есть ли событие такого типа (идемпотентность внешних операций, например run_started). */
  async hasEvent(taskId: string, kind: TaskEventKind): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS present FROM task_events WHERE user_task_id = ? AND kind = ? LIMIT 1`)
      .bind(taskId, kind)
      .first<{ present: number }>();
    return row !== null;
  }

  // ----------------------------------------------------------- переходы

  /**
   * Атомарный переход: статус/stage/result/проекция + событие в одной транзакции.
   *
   * @param generation поколение записавшего (ownerGeneration исполнителя);
   *   запись с устаревшим поколением отклоняется (FencedError).
   * @throws TerminalStateError попытка изменить done/failed/cancelled.
   * @throws FencedError запись с устаревшим generation.
   */
  async commit(taskId: string, generation: number, opts: CommitOptions = {}): Promise<{ at: number }> {
    const wantsState =
      opts.status !== undefined || opts.stage !== undefined || opts.result !== undefined;
    const kind: TaskEventKind = opts.kind ?? (opts.status !== undefined ? 'task_status_changed' : 'step_done');
    const event: EventSpec = {
      kind,
      step: opts.step ?? null,
      executionId: opts.executionId ?? null,
      source: opts.source ?? 'executor',
      statusAfter: opts.status ?? null,
      payload: opts.payload,
    };

    if (wantsState) {
      const patch: StatePatch = {};
      if (opts.status !== undefined) patch.status = opts.status;
      if (opts.stage !== undefined) patch.stage = opts.stage;
      if (opts.result !== undefined) patch.result = opts.result;

      const extra: D1PreparedStatement[] = [];
      if (patch.status !== undefined && isTerminalStatus(patch.status)) {
        // Терминальный статус закрывает открытое ожидание и снимает его проекцию
        // той же транзакцией: на терминальной задаче открытого awaiting быть не
        // может (§5.0.2), а stage выходит из waiting_input.
        if (patch.awaitingInputId === undefined) patch.awaitingInputId = null;
        if (patch.stage === undefined) patch.stage = 'finished';
        extra.push(
          this.db
            .prepare(
              `UPDATE awaiting_inputs SET status = 'cancelled'
               WHERE user_task_id = ? AND status = 'open'
                 AND EXISTS (SELECT 1 FROM durable_tasks WHERE id = ? AND generation = ? AND ${NON_TERMINAL_SQL})`,
            )
            .bind(taskId, taskId, generation),
        );
      }
      return this.runTransition(taskId, generation, patch, event, extra);
    }

    // Чистое событие: терминальная задача его принимает (доказательство),
    // fencing по generation действует.
    const now = Date.now();
    const results = await this.db.batch([
      this.eventStatement({ taskId, generation, event, statusBefore: null, now, nonTerminal: false }),
    ]);
    if (results[0]!.meta.changes !== 1) {
      await this.rejectTransition(taskId, generation, event, {});
    }
    return { at: now };
  }

  private async runTransition(
    taskId: string,
    generation: number,
    patch: StatePatch,
    event: EventSpec,
    extraStatements: D1PreparedStatement[] = [],
  ): Promise<{ at: number }> {
    const now = Date.now();
    const before = await this.getTask(taskId);
    if (!before) throw new TaskNotFoundError(taskId);

    // Порядок statements важен: guard каждого условия должен читать состояние
    // ДО перехода. Если писать статус первым, переход в терминальный статус
    // сделал бы guard'ы последующих условий (событие перехода, закрытие
    // awaiting) ложно неуспешными — поэтому статусный апдейт идёт последним.
    const updateIndex = extraStatements.length + 1;
    const results = await this.db.batch([
      ...extraStatements,
      this.eventStatement({ taskId, generation, event, statusBefore: before.status, now, nonTerminal: true }),
      this.stateUpdateStatement({ taskId, generation, patch, now }),
    ]);

    if (results[updateIndex]!.meta.changes !== 1) {
      await this.rejectTransition(taskId, generation, event, patch);
    }
    return { at: now };
  }

  /**
   * Классификация отклонённого перехода после факта (row мог измениться между
   * batch и чтением — классификация постфактум, сам отказ уже сделан SQL- guard'ом).
   */
  private async rejectTransition(
    taskId: string,
    attemptedGeneration: number,
    event: EventSpec,
    patch: StatePatch,
  ): Promise<never> {
    const row = await this.getTask(taskId);
    if (!row) throw new TaskNotFoundError(taskId);
    const source = event.source ?? 'executor';

    if (row.generation !== attemptedGeneration) {
      await this.logEvent({
        taskId,
        kind: 'fenced',
        step: event.step ?? null,
        generation: attemptedGeneration,
        source,
        payload: {
          action: event.kind,
          attemptedGeneration,
          currentGeneration: row.generation,
          attemptedStatus: patch.status ?? null,
        },
      });
      throw new FencedError(taskId, attemptedGeneration, row.generation);
    }

    if (isTerminalStatus(row.status)) {
      // Отклонённая попытка видна в журнале: status_after = NULL (не переход).
      await this.logEvent({
        taskId,
        kind: 'task_status_changed',
        step: event.step ?? null,
        statusBefore: row.status,
        statusAfter: null,
        generation: attemptedGeneration,
        source,
        payload: {
          rejected: 'terminal_state',
          attempted: patch.status ?? null,
          action: event.kind,
          keepResult: true,
        },
      });
      throw new TerminalStateError(taskId, row.status, patch.status);
    }

    throw new TaskStoreError(`transition rejected for task ${taskId}`, taskId);
  }

  private stateUpdateStatement(args: {
    taskId: string;
    generation: number;
    patch: StatePatch;
    now: number;
  }): D1PreparedStatement {
    const { taskId, generation, patch, now } = args;
    const flag = (v: unknown): number => (v === undefined ? 0 : 1);
    return this.db
      .prepare(
        `UPDATE durable_tasks SET
           status = CASE WHEN ? THEN ? ELSE status END,
           stage = CASE WHEN ? THEN ? ELSE stage END,
           result_json = CASE WHEN ? THEN ? ELSE result_json END,
           awaiting_input_id = CASE WHEN ? THEN ? ELSE awaiting_input_id END,
           updated_at = ?,
           revision = revision + 1
         WHERE id = ? AND generation = ? AND ${NON_TERMINAL_SQL}`,
      )
      .bind(
        flag(patch.status),
        patch.status ?? null,
        flag(patch.stage),
        patch.stage ?? null,
        flag(patch.result),
        patch.result === undefined ? null : JSON.stringify(patch.result),
        flag(patch.awaitingInputId),
        patch.awaitingInputId ?? null,
        now,
        taskId,
        generation,
      );
  }

  private eventStatement(args: {
    taskId: string;
    generation: number;
    event: EventSpec;
    statusBefore: string | null;
    now: number;
    nonTerminal: boolean;
  }): D1PreparedStatement {
    const { taskId, generation, event, statusBefore, now, nonTerminal } = args;
    const guard = nonTerminal
      ? `EXISTS (SELECT 1 FROM durable_tasks WHERE id = ? AND generation = ? AND ${NON_TERMINAL_SQL})`
      : `EXISTS (SELECT 1 FROM durable_tasks WHERE id = ? AND generation = ?)`;
    return this.db
      .prepare(
        `INSERT INTO task_events(user_task_id, task_item_id, execution_id, kind, status_before, status_after, generation, source, payload_json, created_at)
         SELECT ?,?,?,?,?,?,?,?,?,?
         WHERE ${guard}`,
      )
      .bind(
        taskId,
        event.step ?? null,
        event.executionId ?? null,
        event.kind,
        statusBefore,
        event.statusAfter ?? null,
        generation,
        event.source ?? 'executor',
        event.payload === undefined ? '{}' : JSON.stringify(event.payload),
        now,
        taskId,
        generation,
      );
  }

  // ------------------------------------------------- поколение и отмена

  /**
   * Новое поколение записавшего (lease истёк, ручное возобновление).
   * Терминальной задаче поколение не поднимается.
   */
  async bumpGeneration(taskId: string, opts: { status?: TaskStatus; source?: EventSource; reason?: string } = {}): Promise<number> {
    const now = Date.now();
    const before = await this.requireTask(taskId);
    if (isTerminalStatus(before.status)) {
      throw new TerminalStateError(taskId, before.status, opts.status);
    }
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE durable_tasks SET generation = generation + 1, status = COALESCE(?, status), updated_at = ?, revision = revision + 1
           WHERE id = ? AND ${NON_TERMINAL_SQL}`,
        )
        .bind(opts.status ?? null, now, taskId),
    ]);
    if (results[0]!.meta.changes !== 1) {
      const row = await this.requireTask(taskId);
      throw new TerminalStateError(taskId, row.status, opts.status);
    }
    const after = await this.requireTask(taskId);
    await this.logEvent({
      taskId,
      kind: 'task_status_changed',
      statusBefore: before.status,
      statusAfter: after.status,
      generation: after.generation,
      source: opts.source ?? 'gateway',
      payload: { generationBumped: true, reason: opts.reason ?? null, from: before.generation },
    });
    return after.generation;
  }

  /**
   * Отмена (INV-08): status='cancelled' + generation+1 + закрытие открытых
   * ожиданий одной транзакцией. Записи in-flight исполнителей с прежним
   * поколением отклоняются дальше (fencing).
   */
  async cancel(
    taskId: string,
    opts: { source?: EventSource; reason?: string } = {},
  ): Promise<{ cancelled: boolean; generation?: number; status?: TaskStatus }> {
    const now = Date.now();
    const before = await this.getTask(taskId);
    if (!before) throw new TaskNotFoundError(taskId);
    const source = opts.source ?? 'gateway';

    if (isTerminalStatus(before.status)) {
      await this.logEvent({
        taskId,
        kind: 'cancel_requested',
        statusBefore: before.status,
        generation: before.generation,
        source,
        payload: { rejected: 'terminal_state', status: before.status },
      });
      return { cancelled: false, status: before.status };
    }

    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE durable_tasks SET generation = generation + 1, status = 'cancelled', updated_at = ?, revision = revision + 1
           WHERE id = ? AND ${NON_TERMINAL_SQL}`,
        )
        .bind(now, taskId),
      this.db
        .prepare(`UPDATE awaiting_inputs SET status = 'cancelled' WHERE user_task_id = ? AND status = 'open'`)
        .bind(taskId),
    ]);

    if (results[0]!.meta.changes !== 1) {
      const row = await this.requireTask(taskId);
      await this.logEvent({
        taskId,
        kind: 'cancel_requested',
        statusBefore: row.status,
        generation: row.generation,
        source,
        payload: { rejected: 'terminal_state', status: row.status },
      });
      return { cancelled: false, status: row.status };
    }

    const after = await this.requireTask(taskId);
    await this.logEvent({
      taskId,
      kind: 'task_cancelled',
      statusBefore: before.status,
      statusAfter: 'cancelled',
      generation: after.generation,
      source,
      payload: { reason: opts.reason ?? null, closedAwaiting: true },
    });
    return { cancelled: true, generation: after.generation, status: 'cancelled' };
  }

  // ------------------------------------------------------------ сигналы

  /**
   * Приём сигнала с дедупликацией: идентичность = (userTaskId, step_key,
   * idempotency_key) — UNIQUE в схеме (§5.3). Повтор = no-op, возврат прежней
   * строки. Сигнал, пришедший в терминальную задачу, сохраняется строкой с
   * rejected_reason (отклонение видно, а не молчит).
   */
  async recordSignal(input: {
    taskId: string;
    idempotencyKey: string;
    eventType: string;
    payload?: unknown;
    stepKey?: string;
    source?: SignalSource;
    generation?: number | null;
  }): Promise<{ inserted: boolean; signal: TaskSignalRow }> {
    const now = Date.now();
    const stepKey = input.stepKey ?? '';
    const stmt = this.db
      .prepare(
        `INSERT INTO task_signals(user_task_id, step_key, idempotency_key, event_type, payload_json, generation, source, created_at, rejected_reason)
         SELECT ?,?,?,?,?,?,?,?,
                CASE WHEN (SELECT t.status FROM durable_tasks t WHERE t.id = ?) IN (${TERMINAL_STATUS_SQL})
                     THEN 'terminal_state' ELSE NULL END
         WHERE EXISTS (SELECT 1 FROM durable_tasks t WHERE t.id = ?)
         ON CONFLICT(user_task_id, step_key, idempotency_key) DO NOTHING`,
      )
      .bind(
        input.taskId,
        stepKey,
        input.idempotencyKey,
        input.eventType,
        input.payload === undefined ? '{}' : JSON.stringify(input.payload),
        input.generation ?? null,
        input.source ?? 'api',
        now,
        input.taskId,
        input.taskId,
      );
    const results = await this.db.batch([stmt]);
    const inserted = results[0]!.meta.changes === 1;

    const signal = await this.db
      .prepare(`SELECT * FROM task_signals WHERE user_task_id = ? AND step_key = ? AND idempotency_key = ?`)
      .bind(input.taskId, stepKey, input.idempotencyKey)
      .first<TaskSignalRow>();
    if (!signal) throw new TaskNotFoundError(input.taskId);

    if (inserted) {
      const task = await this.requireTask(input.taskId);
      await this.logEvent({
        taskId: input.taskId,
        kind: signal.rejected_reason ? 'signal_rejected' : 'signal_received',
        generation: task.generation,
        source: 'input',
        payload: {
          eventType: input.eventType,
          idempotencyKey: input.idempotencyKey,
          stepKey,
          signalId: signal.id,
          rejectedReason: signal.rejected_reason,
        },
      });
    }
    return { inserted, signal };
  }

  /**
   * Потерять первый неизрасходованный сигнал типа eventType (hot-path запрос
   * §5.3) и пометить его потреблённым. Ранний сигнал до парковки (step_key='')
   * находится здесь же — T4 «ранний сигнал потерян» закрыт буфером в БД.
   */
  async takeSignal(
    taskId: string,
    eventType: string,
    opts: { step?: string | null; executionId?: string | null; source?: EventSource } = {},
  ): Promise<TaskSignalRow | null> {
    const now = Date.now();
    const consumed = await this.db
      .prepare(
        `UPDATE task_signals SET consumed_at = ?, consumed_by_execution = ?
         WHERE id = (SELECT id FROM task_signals
                     WHERE user_task_id = ? AND event_type = ? AND consumed_at IS NULL
                     ORDER BY id LIMIT 1)
         RETURNING *`,
      )
      .bind(now, opts.executionId ?? null, taskId, eventType)
      .first<TaskSignalRow>();
    if (!consumed) return null;

    const task = await this.requireTask(taskId);
    await this.logEvent({
      taskId,
      kind: 'step_woken',
      step: opts.step ?? null,
      executionId: opts.executionId ?? null,
      generation: task.generation,
      source: opts.source ?? 'executor',
      payload: { eventType, signalId: consumed.id, stepKey: consumed.step_key },
    });
    return consumed;
  }

  /** Первый неизрасходованный сигнал без потребления (буфер раннего ответа). */
  async peekSignal(taskId: string, eventType: string): Promise<TaskSignalRow | null> {
    return this.db
      .prepare(
        `SELECT * FROM task_signals
         WHERE user_task_id = ? AND event_type = ? AND consumed_at IS NULL
         ORDER BY id LIMIT 1`,
      )
      .bind(taskId, eventType)
      .first<TaskSignalRow>();
  }

  async pendingSignals(taskId: string): Promise<TaskSignalRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM task_signals WHERE user_task_id = ? AND consumed_at IS NULL ORDER BY id`)
      .bind(taskId)
      .all<TaskSignalRow>();
    return res.results;
  }

  async listSignals(taskId: string): Promise<TaskSignalRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM task_signals WHERE user_task_id = ? ORDER BY id`)
      .bind(taskId)
      .all<TaskSignalRow>();
    return res.results;
  }

  // ------------------------------------------------------ awaiting input

  /**
   * Открыть ожидание ответа: строка awaiting_inputs + проекция на задачу
   * (awaiting_input_id, status='awaiting_input', stage='waiting_input') + событие
   * awaiting_opened — одна транзакция (§5.0.2).
   */
  async openAwaiting(input: OpenAwaitingInput): Promise<{ awaitingInputId: string }> {
    const now = Date.now();
    const task = await this.requireTask(input.taskId);
    const generation = input.generation ?? task.generation;

    const open = await this.getOpenAwaiting(input.taskId);
    if (open) throw new AlreadyOpenAwaitingError(input.taskId, open.awaiting_input_id);

    const awaitingInputId = crypto.randomUUID();
    const deadlineAt = input.deadlineAt ?? now + 24 * 3600 * 1000;
    const insert = this.db
      .prepare(
        `INSERT INTO awaiting_inputs(
           awaiting_input_id, user_task_id, task_item_id, run_id, kind, question, schema_json,
           respondent_scope, checkpoint_ref, status, created_at, deadline_at, generation, version)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?
         WHERE EXISTS (SELECT 1 FROM durable_tasks WHERE id = ? AND generation = ? AND ${NON_TERMINAL_SQL})`,
      )
      .bind(
        awaitingInputId,
        input.taskId,
        input.step ?? null,
        input.runId ?? null,
        input.kind,
        input.question,
        input.schema === undefined ? null : JSON.stringify(input.schema),
        input.respondentScope,
        input.checkpointRef ?? null,
        'open',
        now,
        deadlineAt,
        generation,
        1,
        input.taskId,
        generation,
      );

    try {
      await this.runTransition(
        input.taskId,
        generation,
        { status: 'awaiting_input', stage: 'waiting_input', awaitingInputId },
        {
          kind: 'awaiting_opened',
          step: input.step ?? null,
          source: input.source ?? 'input',
          statusAfter: 'awaiting_input',
          payload: { question: input.question, kind: input.kind, deadlineAt },
        },
        [insert],
      );
    } catch (e) {
      if (/UNIQUE constraint failed: awaiting_inputs/.test(String((e as Error)?.message ?? e))) {
        const row = await this.getOpenAwaiting(input.taskId);
        throw new AlreadyOpenAwaitingError(input.taskId, row?.awaiting_input_id ?? awaitingInputId);
      }
      throw e;
    }
    return { awaitingInputId };
  }

  /**
   * Закрыть ожидание ответом: строка awaiting_inputs + снятие проекции + возврат
   * статуса задачи — одна транзакция.
   */
  async answerAwaiting(input: AnswerAwaitingInput): Promise<{ awaitingInputId: string }> {
    const now = Date.now();
    const generation = input.generation ?? (await this.requireTask(input.taskId)).generation;
    const open = await this.getOpenAwaiting(input.taskId);
    if (!open) throw new TaskStoreError(`no open awaiting input for task ${input.taskId}`, input.taskId);

    const close = this.db
      .prepare(
        `UPDATE awaiting_inputs
         SET status = 'answered', answered_at = ?, answer_json = ?, answer_signal_id = ?
         WHERE awaiting_input_id = ? AND user_task_id = ? AND status = 'open'
           AND EXISTS (SELECT 1 FROM durable_tasks WHERE id = ? AND generation = ? AND ${NON_TERMINAL_SQL})`,
      )
      .bind(
        now,
        JSON.stringify(input.answer),
        input.signalId ?? null,
        open.awaiting_input_id,
        input.taskId,
        input.taskId,
        generation,
      );

    await this.runTransition(
      input.taskId,
      generation,
      { status: 'active', stage: 'running', awaitingInputId: null },
      {
        kind: 'awaiting_answered',
        step: input.step ?? null,
        source: input.source ?? 'input',
        statusAfter: 'active',
        payload: { awaitingInputId: open.awaiting_input_id, answer: input.answer },
      },
      [close],
    );
    return { awaitingInputId: open.awaiting_input_id };
  }

  /**
   * Истечение ожидания (дедлайн прошёл): строка закрывается как expired,
   * проекция снимается, статус задачи меняет вызывающий (nextStatus).
   */
  async expireAwaiting(input: {
    taskId: string;
    nextStatus: TaskStatus;
    generation?: number;
    step?: string | null;
    source?: EventSource;
    reason?: string;
  }): Promise<{ awaitingInputId: string }> {
    const now = Date.now();
    const generation = input.generation ?? (await this.requireTask(input.taskId)).generation;
    const open = await this.getOpenAwaiting(input.taskId);
    if (!open) throw new TaskStoreError(`no open awaiting input for task ${input.taskId}`, input.taskId);

    const close = this.db
      .prepare(
        `UPDATE awaiting_inputs SET status = 'expired', answered_at = ?
         WHERE awaiting_input_id = ? AND user_task_id = ? AND status = 'open'
           AND EXISTS (SELECT 1 FROM durable_tasks WHERE id = ? AND generation = ? AND ${NON_TERMINAL_SQL})`,
      )
      .bind(now, open.awaiting_input_id, input.taskId, input.taskId, generation);

    const patch: StatePatch = { status: input.nextStatus, awaitingInputId: null };
    if (isTerminalStatus(input.nextStatus)) patch.stage = 'finished';

    await this.runTransition(
      input.taskId,
      generation,
      patch,
      {
        kind: 'awaiting_expired',
        step: input.step ?? null,
        source: input.source ?? 'executor',
        statusAfter: input.nextStatus,
        payload: { awaitingInputId: open.awaiting_input_id, reason: input.reason ?? null },
      },
      [close],
    );
    return { awaitingInputId: open.awaiting_input_id };
  }

  async getOpenAwaiting(taskId: string): Promise<AwaitingInputRow | null> {
    return this.db
      .prepare(`SELECT * FROM awaiting_inputs WHERE user_task_id = ? AND status = 'open'`)
      .bind(taskId)
      .first<AwaitingInputRow>();
  }

  async listAwaiting(taskId: string): Promise<AwaitingInputRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM awaiting_inputs WHERE user_task_id = ? ORDER BY created_at`)
      .bind(taskId)
      .all<AwaitingInputRow>();
    return res.results;
  }

  // ------------------------------------------------------------- отчёты

  /** Приёмочный запрос §6.1: статус + история + сигналы + ожидание одним SQL. */
  static readonly STATUS_SQL = `
    SELECT t.id, t.status, t.stage, t.generation, t.revision, t.result_json, t.conversation_id,
           t.awaiting_input_id, t.delivery_state, t.updated_at,
      (SELECT json_group_array(json_object('id', e.id, 'kind', e.kind, 'step', e.task_item_id,
                                            'before', e.status_before, 'after', e.status_after,
                                            'gen', e.generation, 'payload', e.payload_json, 'at', e.created_at))
         FROM (SELECT * FROM task_events WHERE user_task_id = t.id ORDER BY id) e) AS history,
      (SELECT json_group_array(json_object('id', s.id, 'step', s.step_key, 'type', s.event_type,
                                            'consumed', s.consumed_at, 'rejected', s.rejected_reason,
                                            'payload', s.payload_json))
         FROM (SELECT * FROM task_signals WHERE user_task_id = t.id ORDER BY id) s) AS signals,
      (SELECT json_object('id', a.awaiting_input_id, 'status', a.status, 'deadline', a.deadline_at)
         FROM awaiting_inputs a WHERE a.user_task_id = t.id ORDER BY a.created_at DESC LIMIT 1) AS awaiting
    FROM durable_tasks t WHERE t.id = ?`;

  async statusRow(taskId: string): Promise<{
    id: string;
    status: TaskStatus;
    stage: TaskStage | null;
    generation: number;
    revision: number;
    result: unknown;
    conversation_id: string | null;
    awaiting_input_id: string | null;
    delivery_state: string;
    updated_at: number;
    history: unknown[];
    signals: unknown[];
    awaiting: Record<string, unknown> | null;
  } | null> {
    const row = await this.db.prepare(TaskStore.STATUS_SQL).bind(taskId).first<{
      id: string;
      status: TaskStatus;
      stage: TaskStage | null;
      generation: number;
      revision: number;
      result_json: string | null;
      conversation_id: string | null;
      awaiting_input_id: string | null;
      delivery_state: string;
      updated_at: number;
      history: string | null;
      signals: string | null;
      awaiting: string | null;
    }>();
    if (!row) return null;
    const parse = (v: string | null, fallback: unknown) => (v == null ? fallback : JSON.parse(v));
    return {
      id: row.id,
      status: row.status,
      stage: row.stage,
      generation: row.generation,
      revision: row.revision,
      result: parse(row.result_json, null),
      conversation_id: row.conversation_id,
      awaiting_input_id: row.awaiting_input_id,
      delivery_state: row.delivery_state,
      updated_at: row.updated_at,
      history: parse(row.history, []),
      signals: parse(row.signals, []),
      awaiting: parse(row.awaiting, null) as Record<string, unknown> | null,
    };
  }
}
