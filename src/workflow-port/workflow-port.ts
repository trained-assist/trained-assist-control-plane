// Workflow Port (ARCHITECTURE §4.2) поверх Cloudflare Workflows + D1.
// Контрольная сторона: submit / signal / cancel / status / recover.
// Исполнительная сторона (step/sleep/waitFor) — step-ctx.ts; код плана не видит
// API движка. Логика перенесена из пилота pilots/p-db/cf-workflows/src/port.ts.
import type {
  AdmitTaskInput,
  ArtifactRow,
  AwaitingPurpose,
  DeliveryRow,
  RunAttemptRow,
  SignalSource,
  TaskStore,
} from '../taskstore';
import { isTerminalStatus } from '../taskstore';
import { logStructured } from '../logging/structured-log';
import type { ManagedGtdContext } from '../gtd/types';
import type { PlanParams } from './conversation-plan';
import type { ExecutionContextManifest } from '../router/brief/execution-context';

function parsePilotRoute(userValue: string | null): { route: 'new-plane' | 'legacy'; reason: string } {
  if (!userValue) return { route: 'new-plane', reason: 'no_user_value' };
  try {
    const parsed = JSON.parse(userValue) as Record<string, unknown>;
    const route = parsed.pilotRoute as string | undefined;
    const reason = parsed.pilotReason as string | undefined;
    if (route === 'new-plane' || route === 'legacy') {
      return { route, reason: reason ?? 'unknown' };
    }
  } catch {
    return { route: 'new-plane', reason: 'unparseable_user_value' };
  }
  // Метки нет — решение по умолчанию принимает IntakeService (приёма задачи).
  // Порт только ЧЕСТУЕТ явному решению; молчаливый legacy здесь означал бы, что
  // прямой submit без маршрута тихо ничего не запускает.
  return { route: 'new-plane', reason: 'no_pilot_route' };
}

export interface SubmitInput extends AdmitTaskInput {
  /** Уже начатая попытка (например после resume) — не создавать вторую. */
  runId?: string | null;
  question?: string;
  waitTimeoutSec?: number;
  crashRunOnce?: boolean;
  /** Зачем спрашиваем человека: preference | missing_fact | credential | approval. */
  awaitingPurpose?: AwaitingPurpose | null;
  /** Варианты ответа (purpose=preference) со стабильными option ID (#115). */
  awaitingOptions?: { id: string; label: string }[] | null;
  /** Период durable-опроса ответа в ожидании. */
  waitPollSec?: number;
  /** Инструкции для попытки Runner'а и параметры опроса результата. */
  instructions?: string | null;
  runnerPollSec?: number;
  runnerTimeoutSec?: number;
  /** Движок попытки Runner'а (RunSpec.engine.name); по умолчанию opencode. */
  runnerEngine?: string;
  /**
   * Простая задача без уточнений (P22: occurrence расписания). План не открывает
   * ожидание человека: работа + terminal result, без control loop и без gtdId.
   */
  autoRun?: boolean;
  /**
   * Управляемая работа (P23): задача под контролем GTD. Запись контроля уже
   * durable (явная регистрация opt-in), gtdId обязателен в Input → executor →
   * Output → GTD outcome. План задачу не закрывает: продолжение выдаёт только
   * GTD — один владелец продолжения.
   */
  gtd?: ManagedGtdContext | null;
  /** Свидетельство по критериям завершения управляемой работы ({criterionId: true}). */
  criteria?: Record<string, unknown> | null;
  /** Ссылка на внешнее условие (synthetic CI provider I07) для управляемой работы. */
  conditionRef?: string | null;
}

export interface SubmitResult {
  taskId: string;
  instanceId: string;
  /** false = задача уже была принята (повтор submit = один запуск). */
  created: boolean;
  instanceCreated: boolean;
  generation: number;
  runId: string | null;
  /** Маршрутизация пилотом: 'new-plane' или 'legacy'. */
  pilotRoute: 'new-plane' | 'legacy';
  pilotReason: string;
}

export interface SignalResult {
  /** false: сигнал отклонён портом по статусу либо не доставлен движку. */
  delivered: boolean;
  signalId: number;
  /** true = повторная доставка того же ключа идемпотентности. */
  duplicate: boolean;
  reason?: string;
}

export interface CancelResult {
  cancelled: boolean;
  generation?: number;
  status?: string;
}

export interface PortStatusResult {
  taskStore: Awaited<ReturnType<TaskStore['statusRow']>>;
  engine: unknown;
  runs: RunAttemptRow[];
  deliveries: DeliveryRow[];
  artifacts: ArtifactRow[];
}

export interface WorkflowPortApi {
  submit(input: SubmitInput): Promise<SubmitResult>;
  signal(
    taskId: string,
    eventType: string,
    payload: unknown,
    opts?: { idempotencyKey?: string; source?: SignalSource },
  ): Promise<SignalResult>;
  cancel(taskId: string, opts?: { reason?: string }): Promise<CancelResult & { stopConfirmed: boolean }>;
  status(taskId: string): Promise<PortStatusResult>;
  /**
   * Явное продолжение: новый runId, тот же userTaskId, подъём поколения.
   * Используется и восстановлением после потери связи (эпик M1 шаг 5), и
   * GTD Manager'ом как единственным владельцем продолжения managed work (P23).
   */
  resume(
    taskId: string,
    opts?: {
      reason?: string;
      instructions?: string;
      executionContext?: ExecutionContextManifest;
      previousRunId?: string | null;
      /** Движок новой попытки (P17): продолжение fast path фиксирует терминального исполнителя. */
      engine?: string | null;
      awaitingPurpose?: AwaitingPurpose | null;
      awaitingOptions?: { id: string; label: string }[] | null;
      runnerPollSec?: number;
      runnerTimeoutSec?: number;
      /** Свидетельство по критериям завершения управляемой работы ({criterionId: true}). */
      criteria?: Record<string, unknown> | null;
      /** Ссылка на внешнее условие (synthetic CI provider I07). */
      conditionRef?: string | null;
      /** Управляемая работа (P23): контекст контроля для продолжения. */
      gtd?: ManagedGtdContext | null;
    },
  ): Promise<{ runId: string; generation: number }>;
}

export class CfWorkflowPort implements WorkflowPortApi {
  constructor(
    private readonly wf: Workflow,
    private readonly store: TaskStore,
  ) {}

  /**
   * Идемпотентный запуск: строка задачи создаётся с ON CONFLICT DO NOTHING,
   * экземпляр — по id задачи. Повтор submit возвращает тот же экземпляр и
   * created=false: второй запуск плана невозможен.
   * Ответ возвращается сразу после постановки в очередь (ранний ответ) —
   * план дальше живёт асинхронно.
   */
  async submit(input: SubmitInput): Promise<SubmitResult> {
    const { created, task } = await this.store.admitTask(input);
    const pilotRoute = parsePilotRoute(task.user_value);

    // Повторный submit на терминальной задаче: тот же экземпляр, новой попытки
    // и второго Run нет — возвращаем сохранённую квитанцию, а не ошибку.
    // Иначе клиент, потерявший ответ после done, получал 500 вместо квитанции.
    if (isTerminalStatus(task.status)) {
      const runs = await this.store.listRuns(task.id);
      logStructured({
        event: 'submit.duplicate_terminal',
        profileId: input.profileId,
        userTaskId: task.id,
        reason: 'task_already_terminal',
        status: task.status,
        runId: runs.at(-1)?.id ?? null,
      });
      return {
        taskId: task.id,
        instanceId: task.id,
        created: false,
        instanceCreated: false,
        generation: task.generation,
        runId: runs.at(-1)?.id ?? null,
        pilotRoute: pilotRoute.route,
        pilotReason: pilotRoute.reason,
      };
    }

    // Пилотный гейт: cohort — только новые задачи. Legacy-задачи не запускаются
    // на новом plane вообще; возвращаем маршрут, чтобы вызывающий знал.
    if (pilotRoute.route === 'legacy') {
      logStructured({
        event: 'pilot.route_legacy',
        level: 'info',
        profileId: input.profileId,
        userTaskId: task.id,
        pilotRoute: 'legacy',
        pilotReason: pilotRoute.reason,
      });
      return {
        taskId: task.id,
        instanceId: task.id,
        created,
        instanceCreated: false,
        generation: task.generation,
        runId: null,
        pilotRoute: 'legacy',
        pilotReason: pilotRoute.reason,
      };
    }

    const params: PlanParams = {
      taskId: task.id,
      generation: task.generation,
      profileId: input.profileId,
      question: input.question,
      waitTimeoutSec: input.waitTimeoutSec,
      crashRunOnce: input.crashRunOnce,
      awaitingPurpose: input.awaitingPurpose ?? null,
      awaitingOptions: input.awaitingOptions ?? null,
      waitPollSec: input.waitPollSec,
      autoRun: input.autoRun,
      gtd: input.gtd ?? null,
      criteria: input.criteria ?? null,
      conditionRef: input.conditionRef ?? null,
      // adapter в params НЕ кладём: секрет не должен сериализоваться в движок;
      // план строит его из env (deps) в TaskWorkflow.
      goal: task.goal,
      instructions: input.instructions ?? null,
      runnerPollSec: input.runnerPollSec,
      runnerTimeoutSec: input.runnerTimeoutSec,
      runnerEngine: input.runnerEngine,
    };

    // Экземпляр создаём, если задача новая или события старта попытки ещё не было.
    const needInstance = created || !(await this.store.hasEvent(task.id, 'run_started'));

    // Попытка исполнения (runId): явная (после resume) -> активная -> новая.
    // Если прежняя попытка осталась в unknown/interrupted, новую начинаем только
    // после подъёма поколения — старая попытка лишена прав на запись.
    let runId = input.runId ?? null;
    if (!runId) {
      const runs = await this.store.listRuns(task.id);
      runId = runs.find((r) => r.status === 'running')?.id ?? null;
      if (!runId) {
        const stale = runs.find((r) => r.status === 'unknown' || r.status === 'interrupted');
        if (stale) {
          await this.store.bumpGeneration(task.id, {
            reason: `new attempt after ${stale.status}`,
            source: 'gateway',
          });
        }
        const run = await this.store.startRun(task.id, {
          generation: (await this.store.requireTask(task.id)).generation,
          engine: 'cloudflare-workflows',
          // session_id заполнит план, привязав runId настоящего Runner'а.
          sessionId: null,
        });
        runId = run.id;
      }
    }
    params.runId = runId;

    // Единственная гарантия «один запуск» — состояние в Task Store (событие
    // run_started), а не поведение create на разных платформах (в miniflare
    // повторный create не бросает ошибку, в проде бросает).
    let instanceCreated = false;
    if (needInstance) {
      try {
        await this.wf.create({ id: task.id, params });
        instanceCreated = true;
      } catch (e) {
        // Экземпляр уже существует (гонка или повтор) — берём прежний.
        try {
          await this.wf.get(task.id);
        } catch {
          throw e;
        }
      }
    }

    return { taskId: task.id, instanceId: task.id, created, instanceCreated, generation: task.generation, runId, pilotRoute: pilotRoute.route, pilotReason: pilotRoute.reason };
  }

  /**
   * Доставить сигнал ожидающему экземпляру.
   * Дедуп — в task_signals (UNIQUE userTaskId/step/ключ): дубль не создаёт
   * вторую строку, но движку событие уходит повторно — безвредно, waitForEvent
   * берёт первое. Сигнал в терминальную задачу отклоняется Портом по статусу
   * (§5.3): строка сохраняется с rejected_reason, экземпляр не будится.
   */
  async signal(
    taskId: string,
    eventType: string,
    payload: unknown,
    opts: { idempotencyKey?: string; source?: SignalSource } = {},
  ): Promise<SignalResult> {
    const source = opts.source ?? 'web';
    const idempotencyKey = opts.idempotencyKey ?? `${source}:${crypto.randomUUID()}`;
    const { inserted, signal } = await this.store.recordSignal({
      taskId,
      idempotencyKey,
      eventType,
      payload,
      source,
    });

    if (signal.rejected_reason) {
      return { delivered: false, signalId: signal.id, duplicate: !inserted, reason: signal.rejected_reason };
    }

    try {
      const instance = await this.wf.get(taskId);
      await instance.sendEvent({ type: eventType, payload });
      return { delivered: true, signalId: signal.id, duplicate: !inserted };
    } catch (e) {
      return {
        delivered: false,
        signalId: signal.id,
        duplicate: !inserted,
        reason: `engine: ${String((e as Error)?.message ?? e)}`,
      };
    }
  }

  /**
   * Отмена (INV-08/C03): «stop requested» и «stopped» — разные состояния.
   * Сначала запрос (cancel_requested + fencing), потом остановка движка;
   * статус cancelled ставится только после подтверждения остановки. Если
   * остановка не удалась — задача остаётся не-терминальной, виден cancel_requested.
   */
  async cancel(taskId: string, opts: { reason?: string } = {}): Promise<CancelResult & { stopConfirmed: boolean }> {
    const requested = await this.store.requestCancel(taskId, { reason: opts.reason });
    if (!requested.requested) {
      return { cancelled: false, generation: requested.generation, status: requested.status, stopConfirmed: false };
    }

    let terminated = false;
    let terminateError: string | null = null;
    try {
      const instance = await this.wf.get(taskId);
      await instance.terminate();
      terminated = true;
    } catch (e) {
      terminateError = String((e as Error)?.message ?? e);
    }

    if (!terminated) {
      await this.store.logEvent({
        taskId,
        kind: 'error',
        source: 'gateway',
        payload: { where: 'cancel.terminate', message: terminateError, stopRequested: true },
      });
      return { cancelled: false, generation: requested.generation, status: requested.status, stopConfirmed: false };
    }

    const confirmed = await this.store.confirmCancel(taskId, { reason: opts.reason });
    // Активная попытка завершается как отменённая пользователем.
    const active = await this.store.activeRun(taskId);
    if (active) await this.store.finishRun(active.id, 'cancelled', { errorText: opts.reason ?? null });
    return {
      cancelled: confirmed.cancelled,
      generation: confirmed.generation,
      status: confirmed.status,
      stopConfirmed: confirmed.cancelled,
    };
  }

  async status(taskId: string): Promise<PortStatusResult> {
    const taskStore = await this.store.statusRow(taskId);
    let engine: unknown = null;
    try {
      engine = await (await this.wf.get(taskId)).status();
    } catch (e) {
      engine = { error: String((e as Error)?.message ?? e) };
    }
    // Только чтение: status не запускает агента и не меняет состояние (P05).
    const runs = await this.store.listRuns(taskId);
    const deliveries = await this.store.listDeliveries(taskId);
    const artifacts = await this.store.listArtifacts(taskId);
    return { taskStore, engine, runs, deliveries, artifacts };
  }

  /**
   * Replay без rerun (P05/P06, ARCHITECTURE §4.6): перезапуск экземпляра с
   * сохранением кэша шагов — выполненные шаги не пересчитываются, побочные
   * эффекты не повторяются. fromStep — шаг, с которого начать (кэш шагов до
   * него сохраняется).
   */
  async replay(taskId: string, opts: { fromStep?: string } = {}): Promise<{ restarted: boolean }> {
    const instance = await this.wf.get(taskId);
    await instance.restart(opts.fromStep ? { from: { name: opts.fromStep } } : undefined);
    return { restarted: true };
  }

  /**
   * Возобновление после потери связи (A3 §3.2.5): НОВЫЙ runId, тот же
   * userTaskId, поколение поднято — прежняя попытка лишена прав на запись.
   */
  async resume(
    taskId: string,
    opts: {
      reason?: string;
      instructions?: string;
      executionContext?: ExecutionContextManifest;
      previousRunId?: string | null;
      awaitingPurpose?: AwaitingPurpose | null;
      awaitingOptions?: { id: string; label: string }[] | null;
      runnerPollSec?: number;
      runnerTimeoutSec?: number;
      /** Движок новой попытки (P17): продолжение fast path фиксирует терминального исполнителя. */
      engine?: string | null;
      /** Свидетельство по критериям завершения управляемой работы ({criterionId: true}). */
      criteria?: Record<string, unknown> | null;
      /** Ссылка на внешнее условие (synthetic CI provider I07). */
      conditionRef?: string | null;
      /** Управляемая работа (P23): контекст контроля для продолжения. */
      gtd?: ManagedGtdContext | null;
    } = {},
  ): Promise<{ runId: string; generation: number }> {
    // Сначала Task Store: новый runId + подъём поколения (старая попытка лишена
    // прав), затем остановка прежнего экземпляра и запуск нового с новым
    // поколением (A3 §3.2.5: сверка и отзыв прав прежнего процесса до нового
    // запуска).
    const { run, generation } = await this.store.resumeRun(taskId, opts);
    if (opts.executionContext) {
      await this.store.logEvent({
        taskId,
        kind: 'progress',
        generation,
        source: 'router',
        payload: { event: 'execution_context.attached', ...opts.executionContext },
      });
    }

    // Остановка прежнего экземпляра и запуск нового с новым поколением.
    // terminate и delete — РАЗНЫЕ шаги: упавший/завершённый экземпляр нельзя
    // terminate (бросает), но можно delete; иначе create упадёт already_exists.
    try {
      await (await this.wf.get(taskId)).terminate();
    } catch (e) {
      await this.store.logEvent({
        taskId,
        kind: 'error',
        source: 'gateway',
        payload: { where: 'resume.terminate', message: String((e as Error)?.message ?? e) },
      });
    }
    try {
      await (await this.wf.get(taskId)).delete();
    } catch (e) {
      await this.store.logEvent({
        taskId,
        kind: 'error',
        source: 'gateway',
        payload: { where: 'resume.delete', message: String((e as Error)?.message ?? e) },
      });
    }

    const task = await this.store.requireTask(taskId);
    // Продолжение получает адрес последнего ожидания: если ответ уже durable —
    // план идёт сразу к результату, если ожидание открыто — продолжает ждать.
    const available = await this.store.availableContinuationData(taskId);
    await this.wf.create({
      id: taskId,
      params: {
        taskId,
        generation,
        profileId: task.profile_id,
        runId: run.id,
        awaitingInputId: available.lastAwaitingInputId,
        awaitingPurpose: opts.awaitingPurpose ?? available.awaitingPurpose ?? null,
        awaitingOptions: opts.awaitingOptions ?? null,
        criteria: opts.criteria ?? null,
        conditionRef: opts.conditionRef ?? null,
        gtd: opts.gtd ?? null,
        question: opts.instructions ? `Продолжить после обрыва: ${opts.instructions}` : undefined,
        goal: task.goal,
        instructions: opts.instructions ?? null,
        executionContext: opts.executionContext ?? null,
        runnerPollSec: opts.runnerPollSec,
        runnerTimeoutSec: opts.runnerTimeoutSec,
      },
    });
    return { runId: run.id, generation };
  }

  /** Потеря связи с исполнителем: попытка -> 'unknown' (не 'failed'), задача не меняется. */
  async markConnectionLost(runId: string, reason = 'connection_lost'): Promise<RunAttemptRow> {
    return this.store.markConnectionLost(runId, reason);
  }

  /** Heartbeat попытки: продлевает lease, статус не меняет. */
  async heartbeat(runId: string, leaseSec?: number): Promise<RunAttemptRow> {
    return this.store.heartbeat(runId, leaseSec);
  }

  /**
   * LOCAL-EMULATOR WORKAROUND (взят из пилота): движок miniflare держит таймеры
   * в памяти и не перезапускает убитый экземпляр сам; пробуждение даёт
   * no-op событие __wake для каждой незавершённой задачи. На Cloudflare
   * перезапуск прерванных экземпляров делает платформа.
   */
  async recover(): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const t of await this.store.unfinishedTasks()) {
      try {
        const instance = await this.wf.get(t.id);
        const engineStatus = (await instance.status()).status;
        if (['running', 'waiting', 'queued'].includes(engineStatus)) {
          await instance.sendEvent({ type: '__wake', payload: null });
        }
        out.push({ id: t.id, engineStatus });
      } catch (e) {
        out.push({ id: t.id, error: String((e as Error)?.message ?? e) });
      }
    }
    return out;
  }
}
