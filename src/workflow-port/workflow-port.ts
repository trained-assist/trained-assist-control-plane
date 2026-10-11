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
import { AnswerRejectedError, isTerminalStatus, UnresolvedRunError } from '../taskstore';
import { logStructured } from '../logging/structured-log';
import type { ManagedGtdContext } from '../gtd/types';
import type { PlanParams } from './conversation-plan';
import type { ExecutionContextManifest } from '../router/brief/execution-context';
import type { McpSpec } from '../run-spec/run-spec';
import type { CredentialCompletionRow, CredentialReadyEvent } from '../awaiting/credential-ready';
import { agentConversationInstructions, durableConversationContext } from '../router/communication-v1';
import { withWorkStyleInstructions } from '../output/communication-v1';
import { isRunnerRunId } from '../runner-adapter/run-id';
import { stableAttemptKey } from '../runner-adapter/runner-api-adapter';
import type { RouteResult } from '../router/service';
import { confirmedExternalStop, type ExternalStopOutcome, type ExternalStopPort, type NativeStopEvidence } from './external-stop';

function nativeStopEvidence(taskId: string, profileId: string, attemptId: string,
  outcome: Extract<ExternalStopOutcome, { state: 'stopped' }>): NativeStopEvidence {
  return { taskId, profileId, attemptId, runId: outcome.runnerStatus.runId,
    ownerGeneration: outcome.runnerStatus.ownerGeneration,
    state: outcome.runnerStatus.state as NativeStopEvidence['state'], exitObserved: false,
    runnerTerminalStatusObserved: true };
}

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

/** Cloudflare Workflow instance IDs are immutable and limited to 100 chars. */
export async function workflowInstanceIdForGeneration(taskId: string, generation: number): Promise<string> {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('invalid_workflow_generation');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(taskId));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `ta-wf-${hash}-g${generation.toString(36)}`;
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
  /** Trusted Output-built descriptor for the Telegram UX test profile. */
  mcpDescriptor?: McpSpec | null;
  executionContext?: ExecutionContextManifest | null;
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
    private readonly credentialExecution?: { runnerEngine: string; runnerTimeoutSec: number; runnerPollSec: number },
    private readonly externalStop?: ExternalStopPort,
  ) {}

  private async currentWorkflowInstanceId(taskId: string, generation: number): Promise<string> {
    // Legacy instances used taskId directly. Keep status/signal/recovery
    // compatible while all newly created generations receive a durable pin.
    return await this.store.workflowInstanceId(taskId, generation)
      ?? await this.latestWorkflowInstanceId(taskId, generation) ?? taskId;
  }

  private async latestWorkflowInstanceId(taskId: string, throughGeneration: number): Promise<string> {
    return (await this.store.latestWorkflowInstance(taskId, throughGeneration))?.instanceId ?? taskId;
  }

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
      mcpDescriptor: input.mcpDescriptor ?? null,
      executionContext: input.executionContext ?? null,
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
        const stale = runs.find((r) => (r.status === 'unknown' || r.status === 'interrupted')
          && r.generation >= task.generation);
        if (stale) {
          // A duplicate submit is not an explicit restart decision. The old
          // external process may still be running, so preserve this attempt
          // and require the caller to reconcile it or explicitly resume.
          throw new UnresolvedRunError(task.id, stale.status === 'unknown' ? 'unknown' : 'interrupted');
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
    const workflowId = await workflowInstanceIdForGeneration(task.id, task.generation);
    if (needInstance || input.idempotentRun) {
      try {
        let exists = false;
        if (input.idempotentRun) {
          try { await (await this.wf.get(await this.currentWorkflowInstanceId(task.id, task.generation))).status(); exists = true; } catch { exists = false; }
        }
        if (!exists) {
          await this.store.recordWorkflowInstance(task.id, task.generation, workflowId);
          await this.wf.create({ id: workflowId, params });
          instanceCreated = true;
        }
      } catch (e) {
        // Экземпляр уже существует (гонка или повтор) — берём прежний.
        try {
          await this.wf.get(await this.store.workflowInstanceId(task.id, task.generation) ?? workflowId);
        } catch {
          throw e;
        }
      }
    }

    return { taskId: task.id, instanceId: await this.currentWorkflowInstanceId(task.id, task.generation), created, instanceCreated, generation: task.generation, runId, pilotRoute: pilotRoute.route, pilotReason: pilotRoute.reason };
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
      const task = await this.store.requireTask(taskId);
      const instance = await this.wf.get(await this.currentWorkflowInstanceId(taskId, task.generation));
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
    const prior = await this.store.requireTask(taskId);
    const priorWorkflowId = await this.currentWorkflowInstanceId(taskId, prior.generation);
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

    const workflowTermination = await this.terminateWorkflow(priorWorkflowId);
    const active = await this.store.activeRun(taskId);
    let initialRuns = await this.rejectKnownPreAdmissionAttempts(taskId);
    const unsettled = initialRuns.filter(run => run.finished_at === null);
    const nativeAttempts = await this.nativeAttemptsNeedingStop(taskId, unsettled);
    const nativeStops: NativeStopEvidence[] = [];
    let nativeStopState: CancelResult['nativeStopState'];
    if (nativeAttempts.length > 0) {
      const task = await this.store.requireTask(taskId);
      let stopped = !!this.externalStop
        && nativeAttempts.every(attempt => ['running', 'unknown', 'waiting'].includes(attempt.status));
      try {
        for (const attempt of nativeAttempts) {
          const context = { taskId, profileId: task.profile_id, attemptId: attempt.id,
            runId: attempt.session_id, ownerGeneration: attempt.generation,
            idempotencyKey: await stableAttemptKey(taskId, attempt.generation), reason: opts.reason };
          const outcome = this.externalStop ? await this.externalStop.stop(context) : null;
          if (!outcome || !confirmedExternalStop(context, outcome)) stopped = false;
          if (!outcome || outcome.state === 'unknown' || outcome.state === 'rejected') nativeStopState = outcome?.state ?? 'unknown';
          else if (outcome.state === 'pending') nativeStopState = 'pending';
          else if (outcome.state === 'cancelled_before_admission' && context.runId === null) {
            const proof: NativeStopEvidence = { taskId, profileId: task.profile_id, attemptId: attempt.id, runId: null,
              ownerGeneration: attempt.generation, state: 'cancelled', exitObserved: false, preAdmissionCancellation: true };
            if (attempt.finished_at === null) await this.store.finishRun(attempt.id, 'cancelled', { errorText: opts.reason ?? 'cancelled_before_runner_admission' });
            await this.store.recordNativeStopEvidence(taskId, [proof]);
            nativeStops.push(proof);
          }
          else if (outcome.state === 'stopped' && context.runId !== null) {
            const proof = nativeStopEvidence(taskId, task.profile_id, attempt.id, outcome);
            if (attempt.finished_at === null) {
              const runOutcome = proof.state === 'succeeded' ? 'success' : proof.state;
              await this.store.finishRun(attempt.id, runOutcome, { errorText: opts.reason ?? 'native_stop_confirmed' });
            }
            await this.store.recordNativeStopEvidence(taskId, [proof]);
            nativeStops.push(proof);
          }
          else if (outcome.state === 'stopped' && context.runId === null) {
            const proof = nativeStopEvidence(taskId, task.profile_id, attempt.id, outcome);
            if (!await this.store.attachRunnerRun(attempt.id, proof.runId!, {
              ownerGeneration: attempt.generation, idempotencyKey: context.idempotencyKey!,
            }).then(() => true).catch(() => false)) stopped = false;
            else {
              if (attempt.finished_at === null) {
                const runOutcome = proof.state === 'succeeded' ? 'success' : proof.state;
                await this.store.finishRun(attempt.id, runOutcome, { errorText: opts.reason ?? 'native_stop_confirmed' });
              }
              await this.store.recordNativeStopEvidence(taskId, [proof]);
              nativeStops.push(proof);
            }
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
      const sameRunIdentities = currentRuns.length === initialRuns.length && initialRuns.every((initial) => {
        const currentRun = currentRuns.find((candidate) => candidate.id === initial.id);
        if (!currentRun || currentRun.generation !== initial.generation) return false;
        return currentRun.session_id === initial.session_id || initial.session_id === null
          && nativeStops.some((proof) => proof.attemptId === initial.id && proof.runId === currentRun.session_id);
      });
      if (current.generation !== requested.generation || !sameRunIdentities) {
        return { cancelled: false, generation: current.generation, status: current.status,
          stopConfirmed: false, nativeStops: await this.nativeStopEvidence(taskId), nativeStopState: 'unknown' };
      }
    }
    if (!workflowTermination.terminated) {
      await this.store.logEvent({
        taskId,
        kind: 'error',
        source: 'gateway',
        payload: { where: 'cancel.terminate', message: workflowTermination.error, stopRequested: true },
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
        const currentAttempt = await this.store.getRun(attempt.id);
        if (!currentAttempt || currentAttempt.finished_at !== null) continue;
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

  private async terminateWorkflow(workflowId: string): Promise<{ terminated: boolean; error: string | null }> {
    let instance: Awaited<ReturnType<Workflow['get']>> | null = null;
    try {
      instance = await this.wf.get(workflowId);
      let status: string | null = null;
      try { status = (await instance.status()).status; } catch { /* older Workflow doubles expose terminate only */ }
      if (status && ['terminated', 'complete', 'errored'].includes(status)) return { terminated: true, error: null };
      await instance.terminate();
      return { terminated: true, error: null };
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      try {
        instance ??= await this.wf.get(workflowId);
        const status = (await instance.status()).status;
        return { terminated: ['terminated', 'complete', 'errored'].includes(status), error: message };
      } catch { return { terminated: false, error: message }; }
    }
  }

  private async rejectKnownPreAdmissionAttempts(taskId: string): Promise<RunAttemptRow[]> {
    for (const attempt of await this.store.listRuns(taskId)) {
      if (attempt.finished_at !== null) continue;
      const failure = await this.store.runnerSubmitKnownPreAdmissionFailure(taskId, attempt.id);
      if (!failure) continue;
      await this.store.logEvent({ taskId, generation: attempt.generation, kind: 'progress',
        executionId: attempt.id, source: 'executor', payload: { event: 'runner_submit_rejected',
          attemptId: attempt.id, idempotencyKey: await stableAttemptKey(taskId, attempt.generation), reason: failure } });
      await this.store.finishRun(attempt.id, 'failed', { errorClass: 'runner_rejected', errorText: failure });
    }
    return this.store.listRuns(taskId);
  }

  private async nativeAttemptsNeedingStop(taskId: string, attempts: RunAttemptRow[]): Promise<RunAttemptRow[]> {
    const nativeAttempts: RunAttemptRow[] = [];
    for (const attempt of attempts) {
      if (attempt.session_id || await this.store.runnerSubmitMayHaveStarted(taskId, attempt.id)) nativeAttempts.push(attempt);
    }
    return nativeAttempts;
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
      const pinnedRunId = await this.store.pinnedRunnerRunId(target, attempt);
      let immediateStopProof: NativeStopEvidence | null = null;
      if (!pinnedRunId) {
        const run = await this.store.requireRun(attempt.attemptId);
        const submitStarted = await this.store.runnerSubmitMayHaveStarted(taskId, attempt.attemptId);
        if (!submitStarted && run.finished_at !== null) {
          continue;
        }
        // Fence admission even when CP did not persist runner_submit_started.
        // The event is written immediately before the side effect, but only a
        // Runner fence closes the cross-service race with a delayed submit.
        if (!this.externalStop) return unresolved;
        const context = { taskId, profileId: target.profileId, attemptId: attempt.attemptId,
          runId: null, ownerGeneration: attempt.ownerGeneration, idempotencyKey: attempt.idempotencyKey,
          reason: `cp_stop_window:${snapshotId}` };
        const outcome = await this.externalStop.stop(context);
        if (outcome.state === 'cancelled_before_admission' && confirmedExternalStop(context, outcome)) {
          if (!await this.store.finishCpStopAttempt(target, snapshotId, generation, attempt.attemptId, 'cancelled')) return unresolved;
          const observed: NativeStopEvidence = { taskId, profileId: target.profileId, attemptId: attempt.attemptId,
            runId: null, ownerGeneration: attempt.ownerGeneration, state: 'cancelled', exitObserved: false,
            preAdmissionCancellation: true };
          if (!await this.store.recordCpStopEvidence(target, snapshotId, generation, observed)) return unresolved;
          nativeStops.push(observed);
          continue;
        }
        if (outcome.state !== 'stopped' || !confirmedExternalStop(context, outcome)) {
          return { ...unresolved, nativeStopState: outcome.state === 'pending' ? 'pending' : 'unknown' };
        }
        immediateStopProof = nativeStopEvidence(taskId, target.profileId, attempt.attemptId, outcome);
        if (!await this.store.attachRunnerRun(attempt.attemptId, immediateStopProof.runId!,
          { ownerGeneration: attempt.ownerGeneration, idempotencyKey: attempt.idempotencyKey }).then(() => true).catch(() => false)) return unresolved;
      }
      const resolvedRunId = pinnedRunId ?? (await this.store.pinnedRunnerRunId(target, attempt));
      if (!resolvedRunId) return unresolved;
      const proof = known.find(value => value.attemptId === attempt.attemptId && value.runId === resolvedRunId
        && value.ownerGeneration === attempt.ownerGeneration && value.profileId === target.profileId);
      if (proof) {
        if (!await this.store.recordCpStopEvidence(target, snapshotId, generation, proof)) return unresolved;
        nativeStops.push(proof);
        continue;
      }
      if (immediateStopProof) {
        const state = immediateStopProof.state;
        if (!await this.store.finishCpStopAttempt(target, snapshotId, generation, attempt.attemptId,
          state === 'succeeded' ? 'success' : state, resolvedRunId)) return unresolved;
        if (!await matches()) return unresolved;
        if (!await this.store.recordCpStopEvidence(target, snapshotId, generation, immediateStopProof)) return unresolved;
        nativeStops.push(immediateStopProof);
        continue;
      }
      if (!this.externalStop || !await matches()) return unresolved;
      const context = { taskId, profileId: target.profileId, attemptId: attempt.attemptId,
        runId: resolvedRunId, ownerGeneration: attempt.ownerGeneration, idempotencyKey: attempt.idempotencyKey,
        reason: `cp_stop_window:${snapshotId}` };
      const outcome = await this.externalStop.stop(context);
      if (!confirmedExternalStop(context, outcome) || outcome.state !== 'stopped') {
        await this.store.logEvent({ taskId, kind: 'error', source: 'gateway', generation: target.taskGeneration,
          executionId: attempt.attemptId, payload: { where: 'cancel.pinned_external_stop',
            reasonCode: outcome.state === 'stopped' ? 'stop_result_unconfirmed'
              : ('diagnosticCode' in outcome ? outcome.diagnosticCode : undefined) ?? 'external_stop_unclassified' } });
        return { ...unresolved, nativeStopState: outcome.state === 'pending' ? 'pending' : 'unknown' };
      }
      if (!await matches()) return unresolved;
      const observed = nativeStopEvidence(taskId, target.profileId, attempt.attemptId, outcome);
      const state = observed.state;
      if (!await this.store.finishCpStopAttempt(target, snapshotId, generation, attempt.attemptId,
        state === 'succeeded' ? 'success' : state, resolvedRunId)) return unresolved;
      if (!await matches()) return unresolved;
      if (!await this.store.recordCpStopEvidence(target, snapshotId, generation, observed)) return unresolved;
      nativeStops.push(observed);
    }
    if (!await matches()) return unresolved;
    const quickAnswer = await this.quickAnswerStopEvidence(target, snapshotId, generation);
    if (quickAnswer === 'delivery_pending') return unresolved;
    const everyAttemptFencedBeforeAdmission = target.attempts.length > 0
      && target.attempts.every(attempt => nativeStops.some(proof => proof.attemptId === attempt.attemptId
        && proof.runId === null && proof.ownerGeneration === attempt.ownerGeneration
        && proof.state === 'cancelled' && proof.exitObserved === false && proof.preAdmissionCancellation === true));
    try {
      // A pinned generation uses its immutable Workflow ID. Legacy tasks may
      // still be inspected through taskId, but that mutable handle is never
      // terminated by a pinned stop.
      const workflowId = await this.store.workflowInstanceId(taskId, target.taskGeneration);
      const instance = await this.wf.get(workflowId ?? taskId);
      let workflowStatus = (await instance.status()).status;
      if (!['terminated', 'complete', 'errored'].includes(workflowStatus) && workflowId) {
        if (!await matches()) return unresolved;
        await instance.terminate();
        workflowStatus = (await instance.status()).status;
      }
      if (!['terminated', 'complete', 'errored'].includes(workflowStatus)) return unresolved;
      if (target.attempts.length === 0 && !await this.store.recordCpStopNoRunWorkflow(target, snapshotId, generation, workflowStatus)) return unresolved;
    } catch (error) {
      if ((quickAnswer !== 'quiescent' && !everyAttemptFencedBeforeAdmission)
        || !(error instanceof Error) || error.message !== 'instance.not_found') return unresolved;
    }
    if (quickAnswer === 'quiescent' && await this.quickAnswerStopEvidence(target, snapshotId, generation) !== 'quiescent') return unresolved;
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

  private async quickAnswerStopEvidence(target: CpStopTarget, snapshotId: string, generation: number): Promise<'not_quick' | 'delivery_pending' | 'quiescent'> {
    if (target.attempts.length !== 0 || generation !== target.taskGeneration
      || target.quickAnswerRoutingEventId !== `routing:${target.userTaskId}:${generation}`
      || !await this.store.cpStopTargetMatches(target, snapshotId, generation)) return 'not_quick';
    const task = await this.store.requireTask(target.userTaskId);
    if (task.status !== 'done' || !task.result_json) return 'not_quick';
    let result: { ok?: boolean; mode?: string; version?: string; answer?: string; quickAnswer?: { id?: string; version?: number } };
    try { result = JSON.parse(task.result_json); } catch { return 'not_quick'; }
    const selection = await this.store.routingSelection(target.userTaskId, generation) as RouteResult | null;
    if (!result || result.ok !== true || result.mode !== 'quick_answer' || result.version !== 'communication-v1'
      || typeof result.answer !== 'string' || !result.answer.trim() || result.quickAnswer?.version !== 1
      || !['system_health', 'catalog.brief'].includes(result.quickAnswer?.id ?? '')
      || !selection || selection.decision?.route !== 'deterministic' || selection.decision.needsExecutor !== false
      || typeof selection.decisionId !== 'string' || !selection.decisionId.trim()
      || selection.decision.outcome !== 'reply' || selection.workOrder !== null || selection.continuation !== null
      || selection.execution?.agentDispatchAttempts !== 0 || selection.execution.recipeCalls !== 0
      || selection.decision.capabilityId !== result.quickAnswer?.id
      || selection.decision.capabilityVersion !== result.quickAnswer?.version
      || selection.reply?.text !== result.answer) return 'not_quick';
    let outputCommit = false;
    for (const event of await this.store.history(target.userTaskId)) {
      let payload: { event?: string; decisionId?: string; capabilityId?: string; capabilityVersion?: number };
      try { payload = JSON.parse(event.payload_json); } catch { return 'not_quick'; }
      if (event.execution_id !== null || event.kind === 'run_started'
        || payload.event === 'runner_submit_started') return 'not_quick';
      if (event.kind === 'task_status_changed' && event.source === 'output' && event.generation === generation
        && event.status_after === 'done' && payload.decisionId === selection.decisionId
        && payload.capabilityId === result.quickAnswer?.id && payload.capabilityVersion === result.quickAnswer?.version) outputCommit = true;
    }
    if (!outputCommit) return 'not_quick';
    const deliveries = await this.store.listDeliveries(target.userTaskId);
    const settled = task.delivery_state === 'not_required' && deliveries.length === 0
      || task.delivery_state === 'delivered' && deliveries.length > 0
        && deliveries.every(delivery => delivery.status === 'delivered' && !!delivery.provider_message_id);
    if (!await this.store.cpStopTargetMatches(target, snapshotId, generation)) return 'not_quick';
    return settled ? 'quiescent' : 'delivery_pending';
  }

  async status(taskId: string): Promise<PortStatusResult> {
    const taskStore = await this.store.statusRow(taskId);
    let engine: unknown = null;
    try {
      const task = await this.store.requireTask(taskId);
      engine = await (await this.wf.get(await this.currentWorkflowInstanceId(taskId, task.generation))).status();
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
        const preAdmissionCancellation = proof?.runId === null && proof.preAdmissionCancellation === true
          && proof.state === 'cancelled' && proof.exitObserved === false;
        const runnerTerminalStatus = !!proof && proof.runId !== null && proof.runnerTerminalStatusObserved === true
          && proof.exitObserved === false;
        if (!proof || proof.taskId !== taskId || proof.profileId !== task.profile_id
          || !(proof.exitObserved === true || (proof.exitObserved === false && proof.preAdmissionRefusal === true && proof.state === 'failed') || preAdmissionCancellation || runnerTerminalStatus)
          || !['succeeded', 'failed', 'cancelled'].includes(proof.state)
          || (proof.runId !== null && !isRunnerRunId(proof.runId))
          || !runs.some(run => run.id === proof.attemptId && run.task_id === taskId && run.session_id === proof.runId
            && run.generation === proof.ownerGeneration && run.finished_at !== null
            && ['success', 'failed', 'cancelled'].includes(run.status))) continue;
        proofs.set(proof.attemptId, { taskId, profileId: task.profile_id, attemptId: proof.attemptId,
          runId: proof.runId, ownerGeneration: proof.ownerGeneration, state: proof.state, exitObserved: proof.exitObserved,
          ...(runnerTerminalStatus ? { runnerTerminalStatusObserved: true } : {}),
          ...(proof.preAdmissionRefusal === true ? { preAdmissionRefusal: true } : {}),
          ...(preAdmissionCancellation ? { preAdmissionCancellation: true } : {}) });
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
      let runnerRunId = run.session_id;
      if (!run.session_id) {
        if (!await this.store.runnerSubmitMayHaveStarted(taskId, run.id)) {
          if (run.finished_at === null) return { stopConfirmed: false, nativeStops: [...proofs.values()], nativeStopState: 'unknown' };
          continue;
        }
      }
      if (proofs.has(run.id)) continue;
      if (!this.externalStop) return { stopConfirmed: false, nativeStops: [...proofs.values()], nativeStopState: 'unknown' };
      const context = { taskId, profileId: task.profile_id, attemptId: run.id, runId: runnerRunId,
        ownerGeneration: run.generation, ...(!runnerRunId ? { idempotencyKey: await stableAttemptKey(taskId, run.generation) } : {}), reason };
      let outcome: ExternalStopOutcome;
      try { outcome = await this.externalStop.stop(context); }
      catch { return { stopConfirmed: false, nativeStops: [...proofs.values()], nativeStopState: 'unknown' }; }
      if (outcome.state === 'pending') return { stopConfirmed: false, nativeStops: [...proofs.values()], nativeStopState: 'pending' };
      if (outcome.state === 'cancelled_before_admission' && confirmedExternalStop(context, outcome)) {
        const proof: NativeStopEvidence = { taskId, profileId: task.profile_id, attemptId: run.id,
          runId: null, ownerGeneration: run.generation, state: 'cancelled', exitObserved: false, preAdmissionCancellation: true };
        if (run.finished_at === null) await this.store.finishRun(run.id, 'cancelled', { errorText: reason ?? 'cancelled_before_runner_admission' });
        await this.store.recordNativeStopEvidence(taskId, [proof]);
        proofs.set(run.id, proof);
        continue;
      }
      if (outcome.state !== 'stopped' || !confirmedExternalStop(context, outcome)) {
        return { stopConfirmed: false, nativeStops: [...proofs.values()],
          nativeStopState: outcome.state === 'rejected' ? 'rejected' : 'unknown' };
      }
      if (!runnerRunId) {
        const observed = nativeStopEvidence(taskId, context.profileId, run.id, outcome);
        await this.store.attachRunnerRun(run.id, observed.runId!,
          { ownerGeneration: run.generation, idempotencyKey: context.idempotencyKey! });
        runnerRunId = observed.runId;
      }
      const proof = nativeStopEvidence(taskId, task.profile_id, run.id, outcome);
      if (run.finished_at === null) {
        const runOutcome = proof.state === 'succeeded' ? 'success' : proof.state;
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
    const task = await this.store.requireTask(taskId);
    const instance = await this.wf.get(await this.currentWorkflowInstanceId(taskId, task.generation));
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
    const prior = await this.store.requireTask(taskId);
    const priorWorkflowId = await this.currentWorkflowInstanceId(taskId, prior.generation);
    const { run, generation } = await this.store.resumeRun(taskId, opts);
    if (opts.executionContext) {
      await this.store.logEvent({ taskId, kind: 'progress', generation, source: 'router',
        payload: { event: 'execution_context.attached', ...opts.executionContext } });
    }

    // Остановка прежнего экземпляра и запуск нового с новым поколением.
    // The prior generation has an immutable ID. The next one gets a new ID and
    // does not reuse/delete the previous instance identity.
    try {
      await (await this.wf.get(priorWorkflowId)).terminate();
    } catch (e) {
      await this.store.logEvent({
        taskId,
        kind: 'error',
        source: 'gateway',
        payload: { where: 'resume.terminate', message: String((e as Error)?.message ?? e) },
      });
    }
    try {
      await (await this.wf.get(priorWorkflowId)).delete();
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
    const workflowId = await workflowInstanceIdForGeneration(taskId, generation);
    await this.store.recordWorkflowInstance(taskId, generation, workflowId);
    await this.wf.create({
      id: workflowId,
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
      const instance = await this.wf.get(await this.currentWorkflowInstanceId(task.id, task.generation));
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
          instructions: withWorkStyleInstructions(instructions, task), awaitingInputId: record.awaiting_input_id, idempotentRun: true, ...execution });
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
        const task = await this.store.requireTask(t.id);
        const instance = await this.wf.get(await this.currentWorkflowInstanceId(t.id, task.generation));
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
