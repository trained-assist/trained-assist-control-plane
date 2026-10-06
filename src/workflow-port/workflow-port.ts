// Workflow Port (ARCHITECTURE §4.2) поверх Cloudflare Workflows + D1.
// Контрольная сторона: submit / signal / cancel / status / recover.
// Исполнительная сторона (step/sleep/waitFor) — step-ctx.ts; код плана не видит
// API движка. Логика перенесена из пилота pilots/p-db/cf-workflows/src/port.ts.
import type {
  AdmitTaskInput,
  ArtifactRow,
  AwaitingPurpose,
  DeliveryRow,
  CpStopTarget,
  RunAttemptRow,
  SignalSource,
  TaskStore,
} from '../taskstore';
import { AnswerRejectedError, isTerminalStatus } from '../taskstore';
import { logStructured } from '../logging/structured-log';
import type { ManagedGtdContext } from '../gtd/types';
import type { PlanParams } from './conversation-plan';
import type { CredentialCompletionRow, CredentialReadyEvent } from '../awaiting/credential-ready';
import { agentConversationInstructions, durableConversationContext } from '../router/communication-v1';
import { confirmedExternalStop, type ExternalStopOutcome, type ExternalStopPort, type NativeStopEvidence } from './external-stop';

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
  awaitingInputId?: string | null;
  idempotentRun?: boolean;
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
  nativeStops?: NativeStopEvidence[];
  nativeStopState?: 'pending' | 'rejected' | 'unknown';
}

export interface PortStatusResult {
  taskStore: Awaited<ReturnType<TaskStore['statusRow']>>;
  engine: unknown;
  runs: RunAttemptRow[];
  deliveries: DeliveryRow[];
  artifacts: ArtifactRow[];
  nativeStops: NativeStopEvidence[];
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
    private readonly credentialExecution?: { runnerEngine: string; runnerTimeoutSec: number; runnerPollSec: number },
    private readonly externalStop?: ExternalStopPort,
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

    const awaiting = input.awaitingInputId ? await this.store.getAwaiting(input.awaitingInputId) : await this.store.getOpenAwaiting(task.id);
    if (input.awaitingPurpose === 'credential' && awaiting?.purpose !== 'credential') {
      throw new AnswerRejectedError(task.id, 'registered_credential_wait_required');
    }
    const params: PlanParams = {
      taskId: task.id,
      awaitingInputId: input.awaitingInputId ?? (awaiting?.purpose === 'credential' ? awaiting.awaiting_input_id : null),
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
          idempotent: input.idempotentRun,
        });
        runId = run.id;
      }
    }
    params.runId = runId;

    // Единственная гарантия «один запуск» — состояние в Task Store (событие
    // run_started), а не поведение create на разных платформах (в miniflare
    // повторный create не бросает ошибку, в проде бросает).
    let instanceCreated = false;
    if (needInstance || input.idempotentRun) {
      try {
        let exists = false;
        if (input.idempotentRun) {
          try { await (await this.wf.get(task.id)).status(); exists = true; } catch { exists = false; }
        }
        if (!exists) {
          await this.wf.create({ id: task.id, params });
          instanceCreated = true;
        }
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
    const awaiting = await this.store.getOpenAwaiting(taskId);
    if (awaiting?.purpose === 'credential') {
      return { delivered: false, signalId: 0, duplicate: false, reason: 'verified_credential_event_required' };
    }
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
  async cancel(taskId: string, opts: { reason?: string; stopPin?: { target: CpStopTarget; snapshotId: string } } = {}): Promise<CancelResult & { stopConfirmed: boolean }> {
    if (opts.stopPin) return this.cancelPinned(taskId, opts.stopPin);
    const requested = await this.store.requestCancel(taskId, { reason: opts.reason });
    if (!requested.requested) {
      const verified = await this.verifyTerminalNativeStops(taskId, opts.reason);
      const stopConfirmed = isTerminalStatus(requested.status ?? '') && verified.stopConfirmed;
      if (requested.status === 'cancelled' && stopConfirmed) await this.store.confirmCancel(taskId, {
        expectedGeneration: requested.generation, reason: opts.reason, nativeStops: verified.nativeStops,
      });
      return { cancelled: requested.status === 'cancelled' && stopConfirmed, generation: requested.generation,
        status: requested.status, stopConfirmed, nativeStops: verified.nativeStops,
        ...(verified.nativeStopState ? { nativeStopState: verified.nativeStopState } : {}) };
    }

    let terminated = false;
    let terminateError: string | null = null;
    let instance: Awaited<ReturnType<Workflow['get']>> | null = null;
    try {
      instance = await this.wf.get(taskId);
      let beforeTerminate: string | null = null;
      try { beforeTerminate = (await instance.status()).status; } catch { /* older Workflow test doubles expose terminate only */ }
      if (beforeTerminate && ['terminated', 'complete', 'errored'].includes(beforeTerminate)) terminated = true;
      else { await instance.terminate(); terminated = true; }
    } catch (e) {
      terminateError = String((e as Error)?.message ?? e);
      try {
        instance ??= await this.wf.get(taskId);
        const engineStatus = (await instance.status()).status;
        terminated = ['terminated', 'complete', 'errored'].includes(engineStatus);
      } catch { /* a failed terminate without terminal workflow evidence stays unresolved */ }
    }

    const active = await this.store.activeRun(taskId);
    const initialRuns = await this.store.listRuns(taskId);
    const unsettled = initialRuns.filter(run => run.finished_at === null);
    const nativeAttempts: RunAttemptRow[] = [];
    for (const attempt of unsettled) {
      if (attempt.session_id || await this.store.runnerSubmitMayHaveStarted(taskId, attempt.id)) nativeAttempts.push(attempt);
    }
    const nativeStops: NativeStopEvidence[] = [];
    let nativeStopState: CancelResult['nativeStopState'];
    if (nativeAttempts.length > 0) {
      const task = await this.store.requireTask(taskId);
      let stopped = !!this.externalStop
        && nativeAttempts.every(attempt => ['running', 'unknown', 'waiting'].includes(attempt.status));
      try {
        for (const attempt of nativeAttempts) {
          const context = { taskId, profileId: task.profile_id, attemptId: attempt.id,
            runId: attempt.session_id, ownerGeneration: attempt.generation, reason: opts.reason };
          const outcome = this.externalStop ? await this.externalStop.stop(context) : null;
          if (!outcome || !confirmedExternalStop(context, outcome)) stopped = false;
          if (!outcome || outcome.state === 'unknown' || outcome.state === 'rejected') nativeStopState = outcome?.state ?? 'unknown';
          else if (outcome.state === 'pending') nativeStopState = 'pending';
          else if (outcome.state === 'stopped' && context.runId !== null) {
            const proof: NativeStopEvidence = { taskId, profileId: task.profile_id, attemptId: attempt.id, runId: context.runId,
              ownerGeneration: attempt.generation, state: outcome.result.outcome, exitObserved: true };
            if (attempt.finished_at === null) {
              const runOutcome = outcome.result.outcome === 'succeeded' ? 'success' : outcome.result.outcome;
              await this.store.finishRun(attempt.id, runOutcome, { errorText: opts.reason ?? 'native_stop_confirmed' });
            }
            await this.store.recordNativeStopEvidence(taskId, [proof]);
            nativeStops.push(proof);
          }
        }
      } catch { stopped = false; }
      if (!stopped) {
        await this.store.logEvent({ taskId, kind: 'error', source: 'gateway',
          payload: { where: 'cancel.external_stop', stopRequested: true, stopConfirmed: false } });
        return { cancelled: false, generation: requested.generation, status: requested.status,
          stopConfirmed: false, nativeStops: await this.nativeStopEvidence(taskId), nativeStopState: nativeStopState ?? 'unknown' };
      }
      const current = await this.store.requireTask(taskId);
      const currentRuns = await this.store.listRuns(taskId);
      if (current.generation !== requested.generation || JSON.stringify(currentRuns.map(run => [run.id, run.session_id, run.generation]))
        !== JSON.stringify(initialRuns.map(run => [run.id, run.session_id, run.generation]))) {
        return { cancelled: false, generation: current.generation, status: current.status,
          stopConfirmed: false, nativeStops: await this.nativeStopEvidence(taskId), nativeStopState: 'unknown' };
      }
    }
    if (!terminated) {
      await this.store.logEvent({
        taskId,
        kind: 'error',
        source: 'gateway',
        payload: { where: 'cancel.terminate', message: terminateError, stopRequested: true },
      });
      return { cancelled: false, generation: requested.generation, status: requested.status,
        stopConfirmed: false, nativeStops: await this.nativeStopEvidence(taskId), nativeStopState: nativeStopState ?? 'unknown' };
    }
    const allNativeStops = await this.nativeStopEvidence(taskId);
    const confirmed = await this.store.confirmCancel(taskId, { reason: opts.reason, expectedGeneration: requested.generation,
      nativeStops: allNativeStops.length ? allNativeStops : nativeStops });
    // Активная попытка завершается как отменённая пользователем.
    if (confirmed.cancelled) {
      for (const attempt of this.externalStop ? unsettled : active ? [active] : []) {
        if (attempt.finished_at !== null) continue;
        await this.store.finishRun(attempt.id, 'cancelled', { errorText: opts.reason ?? null });
      }
    }
    return {
      cancelled: confirmed.cancelled,
      generation: confirmed.generation,
      status: confirmed.status,
      stopConfirmed: confirmed.cancelled,
      nativeStops: await this.nativeStopEvidence(taskId),
      ...(nativeStopState && !confirmed.cancelled ? { nativeStopState } : {}),
    };
  }

  private async cancelPinned(taskId: string, pin: { target: CpStopTarget; snapshotId: string }): Promise<CancelResult & { stopConfirmed: boolean }> {
    const unresolved: CancelResult & { stopConfirmed: boolean } = {
      cancelled: false, stopConfirmed: false, nativeStopState: 'unknown',
    };
    const { target, snapshotId } = pin;
    if (target.userTaskId !== taskId) return unresolved;
    const generation = await this.store.claimCpStopTarget(target, snapshotId);
    if (generation === null) return unresolved;
    const matches = () => this.store.cpStopTargetMatches(target, snapshotId, generation);
    const nativeStops: NativeStopEvidence[] = [];
    const known = await this.nativeStopEvidence(taskId);
    for (const attempt of target.attempts) {
      if (!await matches()) return unresolved;
      if (!attempt.runId) {
        const run = await this.store.requireRun(attempt.attemptId);
        if (run.finished_at === null || await this.store.runnerSubmitMayHaveStarted(taskId, attempt.attemptId)) return unresolved;
        continue;
      }
      const proof = known.find(value => value.attemptId === attempt.attemptId && value.runId === attempt.runId
        && value.ownerGeneration === attempt.ownerGeneration && value.profileId === target.profileId);
      if (proof) { nativeStops.push(proof); continue; }
      if (!this.externalStop || !await matches()) return unresolved;
      const context = { taskId, profileId: target.profileId, attemptId: attempt.attemptId,
        runId: attempt.runId, ownerGeneration: attempt.ownerGeneration, reason: `cp_stop_window:${snapshotId}` };
      const outcome = await this.externalStop.stop(context);
      if (!confirmedExternalStop(context, outcome) || outcome.state !== 'stopped') {
        return { ...unresolved, nativeStopState: outcome.state === 'pending' ? 'pending' : 'unknown' };
      }
      if (!await matches()) return unresolved;
      const state = outcome.result.outcome;
      if (!await this.store.finishCpStopAttempt(target, snapshotId, generation, attempt.attemptId,
        state === 'succeeded' ? 'success' : state)) return unresolved;
      if (!await matches()) return unresolved;
      const observed: NativeStopEvidence = { taskId, profileId: target.profileId,
        attemptId: attempt.attemptId, runId: attempt.runId, ownerGeneration: attempt.ownerGeneration,
        state, exitObserved: true };
      if (!await this.store.recordCpStopEvidence(target, snapshotId, generation, observed)) return unresolved;
      nativeStops.push(observed);
    }
    if (!await matches()) return unresolved;
    try {
      const instance = await this.wf.get(taskId);
      if (!['terminated', 'complete', 'errored'].includes((await instance.status()).status)) return unresolved;
    } catch { return unresolved; }
    if (!await matches()) return unresolved;
    const task = await this.store.requireTask(taskId);
    if (!await matches()) return unresolved;
    if (task.status === 'cancelled') {
      await this.store.confirmCancel(taskId, { expectedGeneration: generation,
        reason: `cp_stop_window:${snapshotId}`, nativeStops, stopPin: pin });
      if (!await matches()) return unresolved;
    }
    if (isTerminalStatus(task.status)) return { cancelled: task.status === 'cancelled', stopConfirmed: true,
      generation, status: task.status, nativeStops };
    const result = await this.store.confirmCancel(taskId, { expectedGeneration: generation,
      reason: `cp_stop_window:${snapshotId}`, nativeStops, stopPin: pin });
    return { ...result, cancelled: result.cancelled, stopConfirmed: result.cancelled, nativeStops };
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
    return { taskStore, engine, runs, deliveries, artifacts, nativeStops: await this.nativeStopEvidence(taskId) };
  }

  private async nativeStopEvidence(taskId: string): Promise<NativeStopEvidence[]> {
    const task = await this.store.requireTask(taskId);
    const runs = await this.store.listRuns(taskId);
    const proofs = new Map<string, NativeStopEvidence>();
    for (const event of await this.store.history(taskId)) {
      if (event.source !== 'gateway') continue;
      let payload: { event?: string; nativeStops?: unknown };
      try { payload = JSON.parse(event.payload_json) as typeof payload; } catch { continue; }
      const cancellationEvidence = event.kind === 'task_cancelled' && event.generation === task.generation;
      const terminalEvidence = event.kind === 'progress' && event.generation === task.generation
        && payload.event === 'native_stop.confirmed';
      if (!cancellationEvidence && !terminalEvidence) continue;
      if (!Array.isArray(payload?.nativeStops)) continue;
      for (const value of payload.nativeStops) {
        const proof = value as NativeStopEvidence | null;
        if (!proof || proof.taskId !== taskId || proof.profileId !== task.profile_id || proof.exitObserved !== true
          || !['succeeded', 'failed', 'cancelled'].includes(proof.state)
          || !/^run_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(proof.runId)
          || !runs.some(run => run.id === proof.attemptId && run.task_id === taskId && run.session_id === proof.runId
            && run.generation === proof.ownerGeneration && run.finished_at !== null
            && ['success', 'failed', 'cancelled'].includes(run.status))) continue;
        proofs.set(proof.attemptId, { taskId, profileId: task.profile_id, attemptId: proof.attemptId,
          runId: proof.runId, ownerGeneration: proof.ownerGeneration, state: proof.state, exitObserved: true });
      }
    }
    return [...proofs.values()];
  }

  private async verifyTerminalNativeStops(taskId: string, reason?: string): Promise<{
    stopConfirmed: boolean;
    nativeStops: NativeStopEvidence[];
    nativeStopState?: CancelResult['nativeStopState'];
  }> {
    const task = await this.store.requireTask(taskId);
    const runs = await this.store.listRuns(taskId);
    if (runs.length === 0) return { stopConfirmed: true, nativeStops: [] };

    const proofs = new Map((await this.nativeStopEvidence(taskId)).map(proof => [proof.attemptId, proof]));
    for (const run of runs) {
      if (!run.session_id) {
        if (await this.store.runnerSubmitMayHaveStarted(taskId, run.id) || run.finished_at === null) {
          return { stopConfirmed: false, nativeStops: [...proofs.values()], nativeStopState: 'unknown' };
        }
        continue;
      }
      if (proofs.has(run.id)) continue;
      if (!this.externalStop) return { stopConfirmed: false, nativeStops: [...proofs.values()], nativeStopState: 'unknown' };
      const context = { taskId, profileId: task.profile_id, attemptId: run.id, runId: run.session_id,
        ownerGeneration: run.generation, reason };
      let outcome: ExternalStopOutcome;
      try { outcome = await this.externalStop.stop(context); }
      catch { return { stopConfirmed: false, nativeStops: [...proofs.values()], nativeStopState: 'unknown' }; }
      if (outcome.state === 'pending') return { stopConfirmed: false, nativeStops: [...proofs.values()], nativeStopState: 'pending' };
      if (outcome.state !== 'stopped' || !confirmedExternalStop(context, outcome)) {
        return { stopConfirmed: false, nativeStops: [...proofs.values()],
          nativeStopState: outcome.state === 'rejected' ? 'rejected' : 'unknown' };
      }
      const proof: NativeStopEvidence = { taskId, profileId: task.profile_id, attemptId: run.id,
        runId: run.session_id, ownerGeneration: run.generation, state: outcome.result.outcome, exitObserved: true };
      if (run.finished_at === null) {
        const runOutcome = outcome.result.outcome === 'succeeded' ? 'success' : outcome.result.outcome;
        await this.store.finishRun(run.id, runOutcome, { errorText: reason ?? 'terminal_runner_reconciled' });
      }
      await this.store.recordNativeStopEvidence(taskId, [proof]);
      proofs.set(run.id, proof);
    }
    const freshRuns = await this.store.listRuns(taskId);
    let complete = true;
    for (const run of freshRuns) {
      if (run.finished_at === null) { complete = false; break; }
      if (!run.session_id && await this.store.runnerSubmitMayHaveStarted(taskId, run.id)) { complete = false; break; }
      if (run.session_id && !proofs.has(run.id)) { complete = false; break; }
    }
    return { stopConfirmed: complete, nativeStops: [...proofs.values()],
      ...(complete ? {} : { nativeStopState: 'unknown' as const }) };
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
  async completeCredential(input: CredentialReadyEvent): Promise<{ duplicate: boolean; delivered: boolean; awaitingInputId: string }> {
    const result = await this.store.completeCredentialAwaiting(input);
    const delivered = result.record.continuation_status === 'woken'
      || await this.dispatchCredentialContinuation(result.record);
    return { duplicate: result.duplicate, delivered, awaitingInputId: input.awaitingInputId };
  }

  private async dispatchCredentialContinuation(record: CredentialCompletionRow): Promise<boolean> {
    const task = await this.store.requireTask(record.user_task_id);
    const awaiting = await this.store.getAwaiting(record.awaiting_input_id);
    if (task.generation !== record.generation || isTerminalStatus(task.status)
      || task.profile_id !== record.profile_id || awaiting?.status !== 'answered'
      || awaiting.generation !== record.generation || awaiting.version !== record.wait_version
      || (task.awaiting_input_id !== null && task.awaiting_input_id !== record.awaiting_input_id)) {
      await this.store.markCredentialContinuation(record, 'stale');
      return false;
    }
    try {
      const instance = await this.wf.get(task.id);
      const status = (await instance.status()).status;
      if (!['running', 'waiting', 'queued'].includes(status)) return false;
      await instance.sendEvent({ type: 'credential_ready', payload: { awaitingInputId: record.awaiting_input_id } });
      await this.store.markCredentialContinuation(record, 'woken');
      return true;
    } catch {
      if ((await this.store.listRuns(task.id)).length > 0) return false;
      const execution = this.credentialExecution;
      if (!execution?.runnerEngine.trim() || !Number.isFinite(execution.runnerTimeoutSec)
        || execution.runnerTimeoutSec <= 0 || !Number.isFinite(execution.runnerPollSec)
        || execution.runnerPollSec <= 0) return false;
      try {
        const selection = await this.store.routingSelection(task.id, task.generation) as { agentInstructions?: unknown } | null;
        const instructions = typeof selection?.agentInstructions === 'string' && selection.agentInstructions.trim()
          ? selection.agentInstructions
          : agentConversationInstructions({ text: task.goal,
            originalInput: task.user_value ? JSON.parse(task.user_value) : undefined,
            durableContext: await durableConversationContext(this.store, task) });
        await this.submit({ id: task.id, profileId: task.profile_id, goal: task.goal,
          instructions, awaitingInputId: record.awaiting_input_id, idempotentRun: true, ...execution });
        await this.store.markCredentialContinuation(record, 'woken');
        return true;
      } catch {
        return false;
      }
    }
  }

  async recoverCredentialContinuations(): Promise<void> {
    for (const record of await this.store.pendingCredentialContinuations()) {
      await this.dispatchCredentialContinuation(record);
    }
  }

  async recover(): Promise<unknown[]> {
    await this.recoverCredentialContinuations();
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
