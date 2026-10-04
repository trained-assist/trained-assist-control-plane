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
  AnswerConflictError,
  AnswerRejectedError,
  FencedError,
  TerminalStateError,
  TaskNotFoundError,
  TaskStoreError,
} from './errors';
import { kindForPurpose } from '../awaiting/purpose';
import {
  DEFAULT_PENDING_INPUT_DEADLINE_MS,
  DEFAULT_START_DEADLINE_MS,
  PREP_STATES,
  PRE_START_STAGES,
  TERMINAL_STATUS_SQL,
  isTerminalStatus,
  type ArtifactRow,
  type AwaitingInputRow,
  type DeliveryRow,
  type AwaitingKind,
  type AwaitingPurpose,
  type ConversationRow,
  type EventSource,
  type PendingInputRow,
  type WatchdogHealthRow,
  type StuckInputAlertRow,
  type PrepState,
  type PrincipalRow,
  type RunAttemptRow,
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
  /**
   * Верхняя граница ожидания старта; по умолчанию DEFAULT_START_DEADLINE_MS от
   * момента приёма. Принятый вход без такой границы — дефект (arch#132 R1/R2).
   */
  startDeadlineMs?: number;
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
  /** Причина блокировки задачи (P23: bounded stop контроля). */
  blockerReason?: string | null;
}

export interface OpenAwaitingInput {
  taskId: string;
  /** Форма ответа (A2 §5.4). Если задан purpose, kind выводится из него. */
  kind?: AwaitingKind;
  /** Зачем спрашиваем: preference | missing_fact | credential | approval. */
  purpose?: AwaitingPurpose | null;
  question: string;
  /** Кто вправе ответить; формат значений задаёт контракт A3 (§5.6). */
  respondentScope: string;
  step?: string | null;
  runId?: string | null;
  /** Форма ответа/варианты; для choice — со стабильными option ID (#115). */
  schema?: unknown;
  checkpointRef?: string | null;
  deadlineAt?: number;
  generation?: number;
  source?: EventSource;
  /** Ссылки движка (#115): не идентичность, а корреляция с platform IDs. */
  engineRefs?: { sessionRef?: string | null; requestRef?: string | null; toolCallRef?: string | null } | null;
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
  /** Почему задача заблокирована (P23: bounded stop контроля). */
  blockerReason?: string | null;
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
             generation, created_at, updated_at, revision, start_deadline_at)
           VALUES(?,?,?,?,'active','queued',?,?,?,?,?,?,1,?,?,0,?)
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
          // Принято = «ещё не начато»: дедлайн старта обязателен уже на приёме
          // (arch#132 R1/R2). Сбрасывается в NULL в startRun().
          now + (input.startDeadlineMs ?? DEFAULT_START_DEADLINE_MS),
        ),
    );

    const taskInsertIndex = stmts.length - 1;
    const receiptPayload: Record<string, unknown> = {
      ...(input.envelope ?? {}),
      // C01: квитанция подтверждает durable acceptance, а не запуск/результат.
      durable: true,
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

  // ------------------------------------------------- поток событий (C02)

  /**
   * События задачи с курсором (C02: «внутренний event store сохраняет порядок по
   * task/session stream и поддерживает cursor/replay»). Курсор — task_events.id
   * (монотонный sequence); `after` — последний виденный sequence.
   */
  async eventsAfter(
    taskId: string,
    after: number | null,
    limit = 100,
  ): Promise<{ events: TaskEventRow[]; nextCursor: number | null; hasMore: boolean }> {
    const safeLimit = Math.min(Math.max(1, limit), 500);
    const res = await this.db
      .prepare(
        `SELECT * FROM task_events WHERE user_task_id = ? AND id > ? ORDER BY id LIMIT ?`,
      )
      .bind(taskId, after ?? 0, safeLimit)
      .all<TaskEventRow>();
    const events = res.results;
    const hasMore = events.length === safeLimit;
    return { events, nextCursor: events.length ? events[events.length - 1]!.id : after, hasMore };
  }

  /**
   * Продолжения, выданные Output (P17): ключ идемпотентности — decisionId.
   * Нужен, чтобы повторный запрос с тем же решением не создавал вторую работу.
   */
  async continuationEvents(
    userTaskId: string,
  ): Promise<Array<{ decisionId: string; jobRef: string; runId: string; generation: number }>> {
    const res = await this.db
      .prepare(`SELECT payload_json FROM task_events WHERE user_task_id = ? AND kind = 'continuation.created' ORDER BY id`)
      .bind(userTaskId)
      .all<{ payload_json: string }>();
    return res.results.map((row) => JSON.parse(row.payload_json) as { decisionId: string; jobRef: string; runId: string; generation: number });
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

  /**
   * Нетерминальные задачи ПРОФИЛЯ: снимок «своих» данных для быстрых ответов
   * (`/status`, «что сейчас в работе»). Чужие задачи не выдаются никогда
   * (PR-09): выборка ограничена владельцем из записи, а не глобальным списком.
   */
  async activeTasksByProfile(profileId: string, limit = 20): Promise<TaskRow[]> {
    const res = await this.db
      .prepare(
        `SELECT * FROM durable_tasks WHERE profile_id = ? AND ${NON_TERMINAL_SQL} ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(profileId, limit)
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

  // --------------------------------------------- попытки исполнения (runId)

  /**
   * Старт попытки: строка executions (status='running') + событие run_started.
   * Терминальной задаче попытку не начинаем.
   */
  async startRun(
    taskId: string,
    opts: { generation: number; engine?: string | null; sessionId?: string | null; leaseSec?: number } = { generation: 1 },
  ): Promise<RunAttemptRow> {
    const task = await this.requireTask(taskId);
    if (isTerminalStatus(task.status)) {
      throw new TaskStoreError(`cannot start run on terminal task ${taskId} (${task.status})`, taskId);
    }
    const now = Date.now();
    const runId = crypto.randomUUID();
    const leaseUntil = opts.leaseSec ? now + opts.leaseSec * 1000 : null;
    // Атомарная граница старта: попытка, событие и сброс дедлайна — ОДНА транзакция.
    //
    // До этого были три отдельных .run(). Падение между ними давало два дефекта:
    //   • попытка есть, события нет, дедлайн не сброшен → задача УЖЕ идёт, а
    //     watchdog видит «принято, но не начато» и алертит вечно (false stuck);
    //   • попытка и событие есть, дедлайн не сброшен → то же самое, но уже после
    //     успешного старта.
    // D1 batch — одна транзакция: либо всё, либо ничего.
    const payload = JSON.stringify({ runId, engine: opts.engine ?? null, sessionId: opts.sessionId ?? null, leaseUntil });
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO executions(id, task_id, session_id, engine, model, status, generation, started_at, last_heartbeat_at, lease_until)
           VALUES(?,?,?,?,?,'running',?,?,?,?)`,
        )
        .bind(runId, task.id, opts.sessionId ?? null, opts.engine ?? null, null, opts.generation, now, now, leaseUntil),
      this.db
        .prepare(
          `INSERT INTO task_events(user_task_id, execution_id, kind, generation, source, payload_json, created_at)
           VALUES(?,?,'run_started',?,'executor',?,?)`,
        )
        .bind(task.id, runId, opts.generation, payload, now),
      this.db
        .prepare(`UPDATE durable_tasks SET start_deadline_at = NULL, updated_at = ? WHERE id = ? AND start_deadline_at IS NOT NULL`)
        .bind(now, task.id),
    ]);
    return this.requireRun(runId);
  }

  /**
   * Детектор «принято, но не начато» (arch#132 R3).
   *
   * Живёт ВНЕ накопителя: единственные «часы» буфера — его собственный таймер, а
   * сломанный/не взведённый таймер и был причиной тишины в чате (tg-bot 2026-10-04).
   * Этот запрос — единственный способ узнать возраст самого старого принятого, но
   * не начатого входа; идёт по idx_tasks_start_deadline и сортируется по
   * дедлайну, то есть «самому старому — первым».
   *
   * Наблюдение, а не переход: у одного перехода ровно один владелец, и следующий
   * шаг решает не детектор.
   */
  async sweepStuckAccepted(now: number = Date.now(), limit = 50): Promise<TaskRow[]> {
    const res = await this.db
      .prepare(
        `SELECT * FROM durable_tasks
         WHERE start_deadline_at IS NOT NULL
           AND start_deadline_at < ?
           AND stage IN (${PRE_START_STAGES.map(() => '?').join(',')})
         ORDER BY start_deadline_at
         LIMIT ?`,
      )
      .bind(now, ...PRE_START_STAGES, limit)
      .all<TaskRow>();
    return res.results;
  }

  // ------------------------------------- принятый вход до запуска (arch#132 R9)

  /**
   * Регистрация пакета, принятого шлюзом, ДО создания задачи.
   *
   * `first_message_at` пишется только при первом приёме пакета: повторные вызовы
   * (новое сообщение в том же пакете) двигают лишь message_count/updated_at.
   * Иначе активный чат постоянно подставлял бы свежие сообщения, и возраст самого
   * старого непродвинувшегося ввода стал бы невидимым.
   */
  async recordPendingInput(input: {
    batchId: string;
    version: number;
    profileId: string;
    channel?: string | null;
    conversationId?: string | null;
    audienceId?: string | null;
    destinationId?: string | null;
    firstMessageAt: number;
    deadlineMs?: number;
  }): Promise<PendingInputRow> {
    const now = Date.now();
    const existing = await this.db
      .prepare('SELECT * FROM pending_inputs WHERE batch_id = ?')
      .bind(input.batchId)
      .first<PendingInputRow>();
    const firstMessageAt = existing?.first_message_at ?? input.firstMessageAt;
    const deadlineAt = existing?.deadline_at ?? (input.deadlineMs ? now + input.deadlineMs : null);
    const messageCount = (existing?.message_count ?? 0) + 1;
    await this.db
      .prepare(
        `INSERT INTO pending_inputs(
           batch_id, version, profile_id, channel, conversation_id, audience_id, destination_id,
           first_message_at, message_count, prep_state, deadline_at, user_task_id, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(batch_id) DO UPDATE SET
           message_count = excluded.message_count,
           prep_state = excluded.prep_state,
           deadline_at = COALESCE(pending_inputs.deadline_at, excluded.deadline_at),
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.batchId,
        input.version,
        input.profileId,
        input.channel ?? null,
        input.conversationId ?? null,
        input.audienceId ?? null,
        input.destinationId ?? null,
        firstMessageAt,
        messageCount,
        existing?.prep_state ?? 'collecting',
        deadlineAt,
        existing?.user_task_id ?? null,
        existing?.created_at ?? now,
        now,
      )
      .run();
    return this.requirePendingInput(input.batchId);
  }

  /** Состояние подготовки пакета (медиа, нормализация) до создания задачи. */
  async setPendingInputPrep(
    batchId: string,
    prepState: PrepState,
    opts: { deadlineMs?: number | null } = {},
  ): Promise<PendingInputRow> {
    const existing = await this.requirePendingInput(batchId);
    const deadlineAt =
      opts.deadlineMs === null ? null
      : opts.deadlineMs !== undefined ? Date.now() + opts.deadlineMs
      : existing.deadline_at;
    await this.db
      .prepare('UPDATE pending_inputs SET prep_state = ?, deadline_at = ?, updated_at = ? WHERE batch_id = ?')
      .bind(prepState, deadlineAt, Date.now(), batchId)
      .run();
    return this.requirePendingInput(batchId);
  }

  /** Связь пакета с задачей после admitTask (вход перестал быть «до запуска»). */
  async linkPendingInputToTask(batchId: string, userTaskId: string): Promise<PendingInputRow> {
    await this.db
      .prepare(`UPDATE pending_inputs SET user_task_id = ?, prep_state = 'admitted', updated_at = ? WHERE batch_id = ?`)
      .bind(userTaskId, Date.now(), batchId)
      .run();
    return this.requirePendingInput(batchId);
  }

  async requirePendingInput(batchId: string): Promise<PendingInputRow> {
    const row = await this.db
      .prepare('SELECT * FROM pending_inputs WHERE batch_id = ?')
      .bind(batchId)
      .first<PendingInputRow>();
    if (!row) throw new TaskStoreError(`pending input not found: ${batchId}`, batchId);
    return row;
  }

  // ------------------------------- операторские алерты: один инцидент = один алерт

  /**
   * Отметка «инцидент уже заалерчен». Считает, а не дублирует: повторные проходы
   * планировщика по тому же зависшему входу не плодят алерты, но инцидент виден
   * как накопленный count (arch#132, Приоритет 3).
   */
  async getAlertedAt(incidentId: string): Promise<number | null> {
    const row = await this.db
      .prepare('SELECT alerted_at FROM stuck_input_alerts WHERE incident_id = ?')
      .bind(incidentId)
      .first<{ alerted_at: number | null }>();
    return row?.alerted_at ?? null;
  }

  /** Каждое обнаружение инцидента: count растёт, но нового алерта не порождает. */
  async markAlertSeen(incidentId: string, now: number = Date.now()): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO stuck_input_alerts(incident_id, alerted_at, last_seen_at, count) VALUES(?,?,?,1)
         ON CONFLICT(incident_id) DO UPDATE SET count = count + 1, last_seen_at = ?`,
      )
      .bind(incidentId, now, now, now)
      .run();
  }

  /** Первое обнаружение: алерт уходит один раз (совместимость с markAlertSeen). */
  async setAlertedAt(incidentId: string, now: number = Date.now()): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO stuck_input_alerts(incident_id, alerted_at, count) VALUES(?,?,1)
         ON CONFLICT(incident_id) DO UPDATE SET count = count + 1, last_seen_at = ?`,
      )
      .bind(incidentId, now, now)
      .run();
  }

  /**
   * Отметка работоспособности планировщика. Пишется ТОЛЬКО после успешного
   * прохода: сбой не должен выглядеть как «всё в порядке» (arch#132 П3c).
   */
  async markWatchdogRun(r: {
    at: number; scanned: number; queued: number; delivered: number;
    skippedStale: number; alerts: number; oldestAgeMs: number | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO watchdog_health(id, last_run_at, scanned, queued, delivered, skipped_stale, alerts, oldest_age_ms)
         VALUES(1,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           last_run_at = excluded.last_run_at, scanned = excluded.scanned, queued = excluded.queued,
           delivered = excluded.delivered, skipped_stale = excluded.skipped_stale,
           alerts = excluded.alerts, oldest_age_ms = excluded.oldest_age_ms`,
      )
      .bind(r.at, r.scanned, r.queued, r.delivered, r.skippedStale, r.alerts, r.oldestAgeMs)
      .run();
  }

  /** Последняя отметка планировщика; null — он не отработал ни разу. */
  async lastWatchdogRun(): Promise<WatchdogHealthRow | null> {
    return this.db.prepare('SELECT * FROM watchdog_health WHERE id = 1').first<WatchdogHealthRow>();
  }

  async listStuckInputAlerts(limit = 50): Promise<StuckInputAlertRow[]> {
    const res = await this.db
      .prepare('SELECT * FROM stuck_input_alerts ORDER BY last_seen_at DESC LIMIT ?')
      .bind(limit)
      .all<StuckInputAlertRow>();
    return res.results;
  }

  /**
   * Детектор окна до admission: пакеты, у которых задачи ещё НЕТ (user_task_id IS
   * NULL) и дедлайн прошёл. Порядок по first_message_at — самый старый первым,
   * поэтому активный чат не может скрыть возраст самого старого ввода.
   */
  async sweepStuckPendingInputs(now: number = Date.now(), limit = 50): Promise<PendingInputRow[]> {
    const res = await this.db
      .prepare(
        `SELECT * FROM pending_inputs
         WHERE user_task_id IS NULL
           AND deadline_at IS NOT NULL
           AND deadline_at < ?
         ORDER BY first_message_at
         LIMIT ?`,
      )
      .bind(now, limit)
      .all<PendingInputRow>();
    return res.results;
  }

  /**
   * Попытка по её id ИЛИ по runId Runner'а (runId хранится в session_id:
   * строка executions — внутренняя, а runId приходит извне).
   */
  /** Привязать runId Runner'а к попытке (session_id): корреляция, не идентичность. */
  async attachRunnerRun(runId: string, runnerRunId: string, ownerGeneration?: number | null): Promise<void> {
    await this.db
      .prepare(`UPDATE executions SET session_id = ? WHERE id = ?`)
      .bind(runnerRunId, runId)
      .run();
    void ownerGeneration;
  }

  async getRun(runId: string): Promise<RunAttemptRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM executions WHERE id = ? OR session_id = ? ORDER BY started_at LIMIT 1`)
      .bind(runId, runId)
      .first<RunAttemptRow>();
    return row ?? null;
  }

  async requireRun(runId: string): Promise<RunAttemptRow> {
    const row = await this.getRun(runId);
    if (!row) throw new TaskStoreError(`run not found: ${runId}`);
    return row;
  }

  async listRuns(taskId: string): Promise<RunAttemptRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM executions WHERE task_id = ? ORDER BY started_at, id`)
      .bind(taskId)
      .all<RunAttemptRow>();
    return res.results;
  }

  /** Активная (running) попытка задачи — для cancel/stop. */
  async activeRun(taskId: string): Promise<RunAttemptRow | null> {
    const res = await this.db
      .prepare(`SELECT * FROM executions WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC, id DESC LIMIT 1`)
      .bind(taskId)
      .first<RunAttemptRow>();
    return res ?? null;
  }

  /** Heartbeat: продлевает lease. Не меняет статус попытки. */
  async heartbeat(runId: string, leaseSec = 600): Promise<RunAttemptRow> {
    const now = Date.now();
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE executions SET last_heartbeat_at = ?, lease_until = ? WHERE id = ? AND status = 'running'`)
        .bind(now, now + leaseSec * 1000, runId),
    ]);
    if (results[0]!.meta.changes !== 1) {
      const run = await this.getRun(runId);
      throw new TaskStoreError(`heartbeat rejected for run ${runId} (status=${run?.status ?? 'missing'})`);
    }
    return this.requireRun(runId);
  }

  /**
   * Потеря связи (ARCHITECTURE §4.6): попытка переходит в 'unknown' — исход
   * неизвестен, это НЕ 'failed'. Задача не меняется: ни timeout, ни истечение
   * lease сами по себе не запускают агента повторно.
   */
  async markConnectionLost(
    runId: string,
    reason = 'connection_lost',
    errorClass = 'connection_lost',
  ): Promise<RunAttemptRow> {
    const now = Date.now();
    // runId Runner'а хранится в session_id попытки (id строки — внутренний).
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE executions SET status = 'unknown', error_class = ?, error_text = ?
           WHERE (id = ? OR session_id = ?) AND status = 'running'`,
        )
        .bind(errorClass, reason, runId, runId),
    ]);
    if (results[0]!.meta.changes !== 1) {
      const run = await this.getRun(runId);
      throw new TaskStoreError(`connection_lost rejected for run ${runId} (status=${run?.status ?? 'missing'})`);
    }
    const task = await this.getTask((await this.requireRun(runId)).task_id);
    await this.logEvent({
      taskId: task?.id ?? '',
      kind: 'error',
      source: 'executor',
      payload: { class: errorClass, runId, reason, outcome: 'unknown' },
    });
    return this.requireRun(runId);
  }

  /**
   * Завершение попытки с исходом (success/failed/interrupted/cancelled).
   * Исход 'unknown' (connection_lost) — не завершение: попытка остаётся
   * незакрытой, см. markConnectionLost().
   */
  async finishRun(
    runId: string,
    outcome: 'success' | 'failed' | 'interrupted' | 'cancelled',
    opts: { errorClass?: string | null; errorText?: string | null; result?: unknown } = {},
  ): Promise<RunAttemptRow> {
    const now = Date.now();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE executions SET status = ?, finished_at = ?, error_class = ?, error_text = ?, result_json = ?
           WHERE id = ?`,
        )
        .bind(
          outcome,
          now,
          opts.errorClass ?? null,
          opts.errorText ?? null,
          opts.result === undefined ? null : JSON.stringify(opts.result),
          runId,
        ),
    ]);
    if (results[0]!.meta.changes !== 1) {
      const run = await this.getRun(runId);
      throw new TaskStoreError(`finish rejected for run ${runId} (status=${run?.status ?? 'missing'})`);
    }
    const run = await this.requireRun(runId);
    await this.logEvent({
      taskId: run.task_id,
      kind: 'run_finished',
      generation: run.generation,
      source: 'executor',
      payload: { runId, outcome, errorClass: opts.errorClass ?? null, reason: opts.errorText ?? null },
    });
    return run;
  }

  /**
   * Парковка попытки (P23, BOUNDARIES §9.4): шаг завершён корректным исходом
   * `waiting` — работа ждёт события (ответ человека, внешнее условие, таймер),
   * а не держит живой процесс. Живого движка и расхода токенов нет: следующая
   * попытка создаётся только после события (GTD/continuation adapter).
   */
  async parkRun(runId: string, opts: { reason: string; checkpointRef?: string | null } = { reason: 'waiting' }): Promise<RunAttemptRow> {
    const now = Date.now();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE executions SET status = 'waiting', finished_at = ?, error_class = ?, error_text = ?
           WHERE id = ? AND status = 'running'`,
        )
        .bind(now, opts.reason, opts.checkpointRef ?? null, runId),
    ]);
    if (results[0]!.meta.changes !== 1) {
      const run = await this.getRun(runId);
      throw new TaskStoreError(`park rejected for run ${runId} (status=${run?.status ?? 'missing'})`);
    }
    const run = await this.requireRun(runId);
    await this.logEvent({
      taskId: run.task_id,
      kind: 'run_finished',
      generation: run.generation,
      source: 'executor',
      payload: { runId, outcome: 'waiting', reason: opts.reason, checkpointRef: opts.checkpointRef ?? null },
    });
    return run;
  }

  /**
   * Возобновление задачи после потери связи (A3 §3.2.5): НОВЫЙ runId, тот же
   * userTaskId, поколение поднято — прежняя попытка лишена прав на запись.
   */
  async resumeRun(
    taskId: string,
    opts: {
      reason?: string;
      instructions?: string;
      engine?: string | null;
      sessionId?: string | null;
      leaseSec?: number;
      previousRunId?: string | null;
    } = {},
  ): Promise<{ run: RunAttemptRow; generation: number }> {
    const task = await this.requireTask(taskId);
    if (isTerminalStatus(task.status)) {
      throw new TaskStoreError(`cannot resume terminal task ${taskId} (${task.status})`, taskId);
    }
    const generation = await this.bumpGeneration(taskId, { reason: opts.reason ?? 'resume', source: 'gateway' });
    const run = await this.startRun(taskId, {
      generation,
      engine: opts.engine ?? null,
      sessionId: opts.sessionId ?? null,
      leaseSec: opts.leaseSec,
    });
    // Явная семантика продолжения: новый runId, тот же userTaskId, и перечень
    // доступных сохранённых данных (открытое ожидание, артефакты, результат).
    const available = await this.availableContinuationData(taskId);
    await this.logEvent({
      taskId,
      kind: 'run_started',
      generation,
      source: 'gateway',
      payload: {
        runId: run.id,
        resumed: true,
        reason: opts.reason ?? null,
        instructions: opts.instructions ?? null,
        previousRunId: opts.previousRunId ?? null,
        availableData: {
          awaitingInputId: available.awaitingInputId,
          awaitingStatus: available.awaitingStatus,
          awaitingPurpose: available.awaitingPurpose,
          artifacts: available.artifacts,
          hasResult: available.resultJson !== null,
        },
      },
    });
    return { run, generation };
  }

  /**
   * Истечение аренды — только СВОДКА кандидатов, без действий: ни timeout, ни
   * lease сами по себе не запускают агента повторно (ARCHITECTURE §4.6).
   * Перезапуск — отдельное решение (resumeRun).
   */
  async sweepExpiredLeases(now: number = Date.now()): Promise<RunAttemptRow[]> {
    const res = await this.db
      .prepare(
        `SELECT * FROM executions WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?
         ORDER BY lease_until`,
      )
      .bind(now)
      .all<RunAttemptRow>();
    return res.results;
  }

  // ------------------------------------------------- доставка (outbox, C02)

  /**
   * Постановка доставки в outbox (C02: доставка владеет состоянием, а не
   * вызовом Bot API из агента). Повтор того же logicalMessageId — no-op:
   * UNIQUE(user_task_id, logical_message_id). Проекция delivery_state на задаче
   * обновляется той же транзакцией (§5.0.2).
   */
  async queueDelivery(input: {
    taskId: string;
    logicalMessageId: string;
    channel: string;
    message: unknown;
    eventId?: number | null;
    conversationId?: string | null;
    audienceId?: string | null;
    destinationId?: string | null;
    nextAttemptAt?: number | null;
    source?: EventSource;
  }): Promise<{ delivery: DeliveryRow; queued: boolean }> {
    const now = Date.now();
    const deliveryId = crypto.randomUUID();
    const task = await this.requireTask(input.taskId);
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO deliveries(
             id, user_task_id, event_id, logical_message_id, conversation_id, audience_id, destination_id,
             channel, message_json, status, attempt, next_attempt_at, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,'pending',0,?,?,?)
           ON CONFLICT(user_task_id, logical_message_id) DO NOTHING`,
        )
        .bind(
          deliveryId,
          input.taskId,
          input.eventId ?? null,
          input.logicalMessageId,
          input.conversationId ?? task.conversation_id,
          input.audienceId ?? task.audience_id,
          input.destinationId ?? task.destination_id,
          input.channel,
          JSON.stringify(input.message ?? {}),
          input.nextAttemptAt ?? null,
          now,
          now,
        ),
      // Проекция доставки обновляется и на терминальной задаче: результат
      // доставляют ПОСЛЕ done (C02: исполнение и доставка — разные статусы).
      // Терминальный guard защищает status/result, а не delivery_state.
      //
      // Дедуп не должен УХУДШАТЬ подтверждённое состояние: повтор того же
      // logicalMessage_id не создаёт вторую доставку (changes === 0), но UPDATE
      // в этом же batch выполнялся всегда и возвращал задачу в 'pending' даже
      // после того, как та же доставка уже была accepted/delivered. Теперь
      // подтверждённые состояния не трогаются: повтор может только начать
      // доставку заново, но не отменять факт, что её уже приняли.
      this.db
        .prepare(
          `UPDATE durable_tasks SET delivery_state = 'pending', updated_at = ?, revision = revision + 1
           WHERE id = ? AND delivery_state IN ('not_required','pending','failed','unknown')`,
        )
        .bind(now, input.taskId),
    ]);

    const delivery =
      (await this.db
        .prepare(`SELECT * FROM deliveries WHERE user_task_id = ? AND logical_message_id = ?`)
        .bind(input.taskId, input.logicalMessageId)
        .first<DeliveryRow>()) ?? null;
    if (!delivery) throw new TaskStoreError(`delivery enqueue failed for ${input.logicalMessageId}`, input.taskId);

    if (results[0]!.meta.changes === 1) {
      await this.logEvent({
        taskId: input.taskId,
        kind: 'delivery_queued',
        generation: task.generation,
        source: input.source ?? 'output',
        payload: { deliveryId: delivery.id, logicalMessageId: input.logicalMessageId, channel: input.channel },
      });
      return { delivery, queued: true };
    }
    return { delivery, queued: false };
  }

  async listDeliveries(taskId: string): Promise<DeliveryRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM deliveries WHERE user_task_id = ? ORDER BY created_at, id`)
      .bind(taskId)
      .all<DeliveryRow>();
    return res.results;
  }

  /**
   * Забрать одну доставку из outbox (единственный владелец доставки): атомарно
   * переводит pending -> accepted и увеличивает attempt. Два владельца не могут
   * получить одну строку: UPDATE с подзапросом выполняется одним оператором.
   * Возврат null — работать нечего.
   */
  async claimDelivery(
    owner: string,
    opts: { channel?: string | null; taskId?: string | null; now?: number; leaseSec?: number } = {},
  ): Promise<DeliveryRow | null> {
    const now = opts.now ?? Date.now();
    const leaseUntil = opts.leaseSec ? now + opts.leaseSec * 1000 : null;
    const claimed = await this.db
      .prepare(
        `UPDATE deliveries SET status = 'accepted', attempt = attempt + 1, next_attempt_at = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM deliveries
           WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND (? IS NULL OR channel = ?)
             AND (? IS NULL OR user_task_id = ?)
           ORDER BY created_at, id LIMIT 1
         )
         RETURNING *`,
      )
      .bind(
        leaseUntil,
        now,
        now,
        opts.channel ?? null,
        opts.channel ?? null,
        opts.taskId ?? null,
        opts.taskId ?? null,
      )
      .first<DeliveryRow>();
    // Claim — внутренняя учётная запись владельца доставки, не событие канала:
    // в лексике A2 §5.2 и C02 такого события нет.
    if (!claimed) return null;
    void owner;
    return claimed;
  }

  /** Провайдер принял: status='delivered' + проекция delivery_state. */
  async confirmDelivery(deliveryId: string, opts: { providerMessageId?: string | null } = {}): Promise<DeliveryRow> {
    const now = Date.now();
    const delivery = await this.requireDelivery(deliveryId);
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE deliveries SET status = 'delivered', provider_message_id = ?, next_attempt_at = NULL, last_error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .bind(opts.providerMessageId ?? null, now, deliveryId),
      this.db
        .prepare(`UPDATE durable_tasks SET delivery_state = 'delivered', updated_at = ?, revision = revision + 1 WHERE id = ?`)
        .bind(now, delivery.user_task_id),
    ]);
    if (results[0]!.meta.changes !== 1) throw new TaskStoreError(`delivery confirm failed: ${deliveryId}`);
    await this.logEvent({
      taskId: delivery.user_task_id,
      kind: 'delivery_sent',
      source: 'output',
      payload: {
        deliveryId,
        providerMessageId: opts.providerMessageId ?? null,
        attempt: delivery.attempt,
      },
    });
    return this.requireDelivery(deliveryId);
  }

  /**
   * Провал отправки: bounded retry. Попытка исчерпана -> failed без нового
   * next_attempt_at. Повтор доставки трогает ТОЛЬКО строку deliveries:
   * задача, попытки и шаги не перезапускаются (шаг 6 эпика).
   */
  async failDelivery(
    deliveryId: string,
    opts: { error: string; retryAfterSec?: number; maxAttempts?: number } = { error: 'unknown' },
  ): Promise<DeliveryRow> {
    const now = Date.now();
    const delivery = await this.requireDelivery(deliveryId);
    const maxAttempts = opts.maxAttempts ?? 3;
    const exhausted = delivery.attempt >= maxAttempts;
    const nextAttemptAt = exhausted ? null : now + (opts.retryAfterSec ?? 60) * 1000;

    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE deliveries
           SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(exhausted ? 'failed' : 'pending', opts.error, nextAttemptAt, now, deliveryId),
      this.db
        .prepare(`UPDATE durable_tasks SET delivery_state = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`)
        .bind(exhausted ? 'failed' : 'pending', now, delivery.user_task_id),
    ]);
    if (results[0]!.meta.changes !== 1) throw new TaskStoreError(`delivery fail record failed: ${deliveryId}`);
    await this.logEvent({
      taskId: delivery.user_task_id,
      kind: 'delivery_failed',
      source: 'output',
      payload: {
        deliveryId,
        attempt: delivery.attempt,
        maxAttempts,
        exhausted,
        nextAttemptAt,
        reason: opts.error,
      },
    });
    return this.requireDelivery(deliveryId);
  }

  /**
   * Подтверждённая отмена подавляет технический retry доставки (C03: «Stop
   * suppresses technical retries включая outbox»). Артефакты при этом НЕ
   * трогаются: файлы переживают остановку (ARCHITECTURE §4.6).
   */
  async suppressPendingDeliveries(taskId: string, reason = 'suppressed_by_cancel'): Promise<number> {
    const now = Date.now();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE deliveries SET status = 'failed', last_error = ?, next_attempt_at = NULL, updated_at = ?
           WHERE user_task_id = ? AND status IN ('pending','accepted')`,
        )
        .bind(reason, now, taskId),
    ]);
    return results[0]!.meta.changes;
  }

  async requireDelivery(deliveryId: string): Promise<DeliveryRow> {
    const row = await this.db.prepare(`SELECT * FROM deliveries WHERE id = ?`).bind(deliveryId).first<DeliveryRow>();
    if (!row) throw new TaskStoreError(`delivery not found: ${deliveryId}`);
    return row;
  }

  // ------------------------------------------------------ артефакты

  /**
   * Ссылка на артефакт: байты в Artifact Storage, здесь только ссылка, владелец,
   * размер и контрольная сумма (ARCHITECTURE §4.1). Повторная запись той же
   * ссылки — no-op (UNIQUE). Отмена задачи артефакты не удаляет.
   */
  async recordArtifact(input: {
    taskId: string;
    kind: string;
    artifactRef: string;
    sizeBytes?: number | null;
    checksum?: string | null;
    runId?: string | null;
    generation?: number | null;
  }): Promise<{ artifact: ArtifactRow; created: boolean }> {
    const now = Date.now();
    const artifactId = crypto.randomUUID();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO task_artifacts(artifact_id, user_task_id, kind, artifact_ref, size_bytes, checksum, run_id, created_at)
           VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(user_task_id, artifact_ref) DO NOTHING`,
        )
        .bind(
          artifactId,
          input.taskId,
          input.kind,
          input.artifactRef,
          input.sizeBytes ?? null,
          input.checksum ?? null,
          input.runId ?? null,
          now,
        ),
    ]);
    const artifact = (await this.db
      .prepare(`SELECT * FROM task_artifacts WHERE user_task_id = ? AND artifact_ref = ?`)
      .bind(input.taskId, input.artifactRef)
      .first<ArtifactRow>()) ?? null;
    if (!artifact) throw new TaskStoreError(`artifact record failed: ${input.artifactRef}`, input.taskId);
    if (results[0]!.meta.changes === 1) {
      await this.logEvent({
        taskId: input.taskId,
        kind: 'result_ready',
        generation: input.generation ?? (await this.requireTask(input.taskId)).generation,
        source: 'output',
        payload: {
          artifactId: artifact.artifact_id,
          artifactRef: input.artifactRef,
          kind: input.kind,
          runId: input.runId ?? null,
        },
      });
      return { artifact, created: true };
    }
    return { artifact, created: false };
  }

  async listArtifacts(taskId: string): Promise<ArtifactRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM task_artifacts WHERE user_task_id = ? ORDER BY created_at, artifact_id`)
      .bind(taskId)
      .all<ArtifactRow>();
    return res.results;
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
      if (opts.blockerReason !== undefined) patch.blockerReason = opts.blockerReason;

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
           blocker_reason = CASE WHEN ? THEN ? ELSE blocker_reason END,
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
        flag(patch.blockerReason),
        patch.blockerReason ?? null,
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
   * Запрос на отмену (C03 «stop requested»): событие cancel_requested + подъём
   * поколения (fencing прежней попытки), но статус задачи НЕ меняется —
   * «requested» не выдаётся за «stopped».
   */
  async requestCancel(
    taskId: string,
    opts: { source?: EventSource; reason?: string } = {},
  ): Promise<{ requested: boolean; generation: number; status: TaskStatus }> {
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
      return { requested: false, generation: before.generation, status: before.status };
    }

    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE durable_tasks SET generation = generation + 1, updated_at = ?, revision = revision + 1
           WHERE id = ? AND ${NON_TERMINAL_SQL}`,
        )
        .bind(now, taskId),
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
      return { requested: false, generation: row.generation, status: row.status };
    }
    const after = await this.requireTask(taskId);
    await this.logEvent({
      taskId,
      kind: 'cancel_requested',
      statusBefore: before.status,
      statusAfter: null,
      generation: after.generation,
      source,
      payload: { reason: opts.reason ?? null, stopRequested: true },
    });
    return { requested: true, generation: after.generation, status: after.status };
  }

  /**
   * Подтверждение отмены (C03 «stopped»): процесс остановлен — только теперь
   * status='cancelled' + закрытие открытых ожиданий одной транзакцией.
   */
  async confirmCancel(
    taskId: string,
    opts: { source?: EventSource; reason?: string } = {},
  ): Promise<{ cancelled: boolean; generation?: number; status?: TaskStatus }> {
    const now = Date.now();
    const before = await this.getTask(taskId);
    if (!before) throw new TaskNotFoundError(taskId);
    const source = opts.source ?? 'gateway';

    if (isTerminalStatus(before.status)) {
      return { cancelled: false, generation: before.generation, status: before.status };
    }

    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE durable_tasks SET status = 'cancelled', updated_at = ?, revision = revision + 1
           WHERE id = ? AND ${NON_TERMINAL_SQL}`,
        )
        .bind(now, taskId),
      this.db
        .prepare(`UPDATE awaiting_inputs SET status = 'cancelled' WHERE user_task_id = ? AND status = 'open'`)
        .bind(taskId),
    ]);
    if (results[0]!.meta.changes !== 1) {
      const row = await this.requireTask(taskId);
      return { cancelled: false, generation: row.generation, status: row.status };
    }

    // Подтверждённая остановка подавляет retry доставки этой задачи (C03).
    const suppressed = await this.suppressPendingDeliveries(taskId);
    const after = await this.requireTask(taskId);
    await this.logEvent({
      taskId,
      kind: 'task_cancelled',
      statusBefore: before.status,
      statusAfter: 'cancelled',
      generation: after.generation,
      source,
      payload: {
        reason: opts.reason ?? null,
        closedAwaiting: true,
        stopConfirmed: true,
        deliveriesSuppressed: suppressed,
      },
    });
    return { cancelled: true, generation: after.generation, status: 'cancelled' };
  }

  /**
   * Отмена одной операцией (INV-08): запрос + подтверждение. Порт вызывает
   * requestCancel/confirmCancel раздельно, чтобы не выдавать requested за stopped.
   */
  async cancel(
    taskId: string,
    opts: { source?: EventSource; reason?: string } = {},
  ): Promise<{ cancelled: boolean; generation?: number; status?: TaskStatus }> {
    const requested = await this.requestCancel(taskId, opts);
    if (!requested.requested) {
      return { cancelled: false, generation: requested.generation, status: requested.status };
    }
    return this.confirmCancel(taskId, opts);
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
    const purpose = input.purpose ?? null;
    const kind = input.kind ?? kindForPurpose(purpose);

    const open = await this.getOpenAwaiting(input.taskId);
    if (open) throw new AlreadyOpenAwaitingError(input.taskId, open.awaiting_input_id);

    const awaitingInputId = crypto.randomUUID();
    const deadlineAt = input.deadlineAt ?? now + 24 * 3600 * 1000;
    const insert = this.db
      .prepare(
        `INSERT INTO awaiting_inputs(
           awaiting_input_id, user_task_id, task_item_id, run_id, kind, question, schema_json,
           respondent_scope, checkpoint_ref, status, created_at, deadline_at, generation, version,
           purpose, engine_session_ref, engine_request_ref, tool_call_ref)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
         WHERE EXISTS (SELECT 1 FROM durable_tasks WHERE id = ? AND generation = ? AND ${NON_TERMINAL_SQL})`,
      )
      .bind(
        awaitingInputId,
        input.taskId,
        input.step ?? null,
        input.runId ?? null,
        kind,
        input.question,
        input.schema === undefined ? null : JSON.stringify(input.schema),
        input.respondentScope,
        input.checkpointRef ?? null,
        'open',
        now,
        deadlineAt,
        generation,
        1,
        purpose,
        input.engineRefs?.sessionRef ?? null,
        input.engineRefs?.requestRef ?? null,
        input.engineRefs?.toolCallRef ?? null,
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
          payload: { question: input.question, kind, purpose, deadlineAt, engineRefs: input.engineRefs ?? null },
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

  /**
   * Ответ человека по ЯВНОМУ адресу ответа awaitingInputId (C01: одно ожидание
   * ответа, одноразовый идемпотентный ответ).
   *
   * Идемпотентность: ответ адресуется ключом идемпотентности канала (native id
   * реплики) и хранится в task_signals (UNIQUE(user_task_id, step_key,
   * idempotency_key)), поэтому:
   *  - повтор того же ключа = no-op и возвращает ПРЕЖНИЙ результат;
   *  - другой ключ на уже отвеченном ожидании = conflict (не «второй ответ»);
   *  - поздний ответ на expired/cancelled ожидание отклоняется и НЕ возобновляет
   *    задачу (#116: поздний callback после cancel не должен её будить).
   */
  async answerAwaitingById(input: {
    awaitingInputId: string;
    idempotencyKey: string;
    answer: unknown;
    source?: EventSource;
    step?: string | null;
  }): Promise<{
    applied: boolean;
    duplicate: boolean;
    awaitingInputId: string;
    taskId: string;
    answer: unknown;
    answeredAt: number | null;
    signalId: number | null;
  }> {
    const awaiting = await this.getAwaiting(input.awaitingInputId);
    if (!awaiting) throw new TaskStoreError(`awaiting input not found: ${input.awaitingInputId}`);

    // Повтор того же ключа: вернуть прежний результат, ничего не меняя.
    const previous = await this.db
      .prepare(
        `SELECT id FROM task_signals
         WHERE user_task_id = ? AND step_key = ? AND idempotency_key = ?`,
      )
      .bind(awaiting.user_task_id, input.awaitingInputId, input.idempotencyKey)
      .first<{ id: number }>();
    if (previous && awaiting.status === 'answered') {
      return {
        applied: false,
        duplicate: true,
        awaitingInputId: awaiting.awaiting_input_id,
        taskId: awaiting.user_task_id,
        answer: awaiting.answer_json === null ? null : JSON.parse(awaiting.answer_json),
        answeredAt: awaiting.answered_at,
        signalId: awaiting.answer_signal_id,
      };
    }
    if (awaiting.status === 'answered') {
      throw new AnswerConflictError(input.awaitingInputId, input.idempotencyKey);
    }
    if (awaiting.status !== 'open') {
      throw new AnswerRejectedError(input.awaitingInputId, awaiting.status);
    }

    // Сигнал ответа: durable экземпляр ответа (task_signals), дедуп по ключу
    // сообщения. Ключ идемпотентности — идентичность реплики, поэтому уже
    // записанный сигнал (например пришедший через Port /signal с пустым
    // step_key) ПЕРЕИСПОЛЬЗУЕТСЯ, а не дублируется второй строкой.
    const existing = await this.db
      .prepare(`SELECT * FROM task_signals WHERE user_task_id = ? AND idempotency_key = ? ORDER BY id LIMIT 1`)
      .bind(awaiting.user_task_id, input.idempotencyKey)
      .first<TaskSignalRow>();
    const signal =
      existing ??
      (
        await this.recordSignal({
          taskId: awaiting.user_task_id,
          stepKey: input.awaitingInputId,
          idempotencyKey: input.idempotencyKey,
          eventType: 'user_reply',
          payload: input.answer,
          source: 'web',
        })
      ).signal;

    const applied = await this.answerAwaiting({
      taskId: awaiting.user_task_id,
      answer: input.answer,
      signalId: signal.id,
      generation: (await this.requireTask(awaiting.user_task_id)).generation,
      step: input.step ?? awaiting.task_item_id,
      source: input.source ?? 'input',
    });

    // Сигнал-ответ помечается потреблённым: он стал ответом на этот адрес.
    // Отдельным оператором: ответ уже применён, и повторное чтение durable
    // состояния работает даже если эта отметка не прошла.
    await this.db
      .prepare(`UPDATE task_signals SET consumed_at = ?, consumed_by_execution = ? WHERE id = ? AND consumed_at IS NULL`)
      .bind(Date.now(), applied.awaitingInputId, signal.id)
      .run();

    const stored = await this.getAwaiting(applied.awaitingInputId);
    return {
      applied: true,
      duplicate: false,
      awaitingInputId: applied.awaitingInputId,
      taskId: awaiting.user_task_id,
      answer: input.answer,
      answeredAt: stored?.answered_at ?? Date.now(),
      signalId: signal.id,
    };
  }

  async getAwaiting(awaitingInputId: string): Promise<AwaitingInputRow | null> {
    return this.db
      .prepare(`SELECT * FROM awaiting_inputs WHERE awaiting_input_id = ?`)
      .bind(awaitingInputId)
      .first<AwaitingInputRow>();
  }

  /**
   * Durable-чтение ответа (истина для продолжения): ответ лежит в Task Store,
   * а не в памяти движка и не в единственной копии сигнала пробуждения (#116).
   */
  async readAnswer(awaitingInputId: string): Promise<{ answer: unknown; answeredAt: number; signalId: number | null } | null> {
    const row = await this.getAwaiting(awaitingInputId);
    if (!row || row.status !== 'answered' || row.answer_json === null) return null;
    return {
      answer: JSON.parse(row.answer_json),
      answeredAt: row.answered_at ?? 0,
      signalId: row.answer_signal_id,
    };
  }

  /**
   * Что продолжение может взять с собой: открытое ожидание, сохранённые
   * артефакты и последний результат задачи (эпик #109 шаг 5: «доступные
   * сохранённые данные»).
   */
  async availableContinuationData(taskId: string): Promise<{
    /** Открытое ожидание, если задача ждёт человека прямо сейчас. */
    awaitingInputId: string | null;
    awaitingStatus: string | null;
    awaitingPurpose: string | null;
    /** Последнее ожидание задачи в любом статусе: на него продолжает работа. */
    lastAwaitingInputId: string | null;
    lastAwaitingStatus: string | null;
    artifacts: string[];
    resultJson: string | null;
    revision: number;
  }> {
    const task = await this.requireTask(taskId);
    const open = await this.getOpenAwaiting(taskId);
    const artifacts = await this.listArtifacts(taskId);
    const last = await this.db
      .prepare(`SELECT awaiting_input_id, status FROM awaiting_inputs WHERE user_task_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(taskId)
      .first<{ awaiting_input_id: string; status: string }>();
    return {
      awaitingInputId: open?.awaiting_input_id ?? null,
      awaitingStatus: open?.status ?? null,
      awaitingPurpose: open?.purpose ?? null,
      lastAwaitingInputId: last?.awaiting_input_id ?? null,
      lastAwaitingStatus: last?.status ?? null,
      artifacts: artifacts.map((a) => a.artifact_ref),
      resultJson: task.result_json,
      revision: task.revision,
    };
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
