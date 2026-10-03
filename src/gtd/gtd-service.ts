/**
 * GTD Manager (P23: «GTD opt-in и bounded control», #62, этап I07).
 *
 * Владелец durable progression ОДНОЙ явно зарегистрированной User Task. Границы —
 * PLAYBOOKS-VS-GETTING-THINGS-DONE-BOUNDARIES §5a/§9/§11:
 *
 *  1. **Opt-in.** Запись контроля создаётся только явной регистрацией
 *     (reason + критерии + дедлайн + caps). Наличие расписания, долгой работы,
 *     ошибки или плейбука контроль не создаёт: обычная задача и occurrence
 *     расписания остаются без gtdId (P22/AC-141 не меняются).
 *  2. **Одна запись на задачу.** UNIQUE(user_task_id) + детерминированный
 *     gtdId: вторая запись невозможна, поэтому исчерпание caps нельзя обойти
 *     «новой записью контроля» — повторная регистрация возвращает ту же
 *     (уже stopped) строку.
 *  3. **Один владелец продолжения.** continuationOwner='gtd' у managed work;
 *     решение о следующем шаге принимает только GTD (gtd_progressions,
 *     UNIQUE(gtd_id, step_id, attempt)), Output собственный follow-up не
 *     создаёт. У неконтролируемой задачи gtdId отсутствует и продолжение
 *     остаётся за Output.
 *  4. **Wait не держит токены.** Ожидание — строка gtd_records (state +
 *     next_trigger) и, для человека, уже существующая строка awaiting_inputs.
 *     Никакого живого процесса и никакого вызова движка: следующая попытка
 *     создаётся только после события (ответ/условие/таймер).
 *  5. **Caps завершают прогрессию.** Исчерпание попыток или дедлайна даёт
 *     stopped/blocked с причиной, а не новый контроль и не бесконечный retry.
 *  6. **Самоконтроль запрещён.** Запись не может контролировать себя или другую
 *     запись (CHECK в схеме + отказ сервиса).
 *
 * Решения детерминированы: критерии проверяются по структурированному
 * свидетельству исхода, LLM в цикл контроля не входит.
 */
import { logStructured } from '../logging/structured-log';
import { systemClock, type Clock } from '../schedule/virtual-clock';
import type { TaskStore } from '../taskstore';
import type { WorkflowPortApi } from '../workflow-port/workflow-port';
import {
  GTD_OPEN_STATES,
  deriveGtdId,
  evaluateCriteria,
  parseCriteria,
  type GtdCriterion,
  type GtdDecision,
  type GtdOutcomeRow,
  type GtdRecordRow,
  type GtdStepOutcome,
  type GtdTriggerKind,
  type RegisterGtdInput,
} from './types';
import { GtdStore } from './gtd-store';
import {
  GtdActiveRunError,
  GtdAlreadyRegisteredError,
  GtdOutcomeScopeError,
  GtdSelfSupervisionError,
  GtdUnknownRecordError,
} from './errors';

/** Запрос продолжения: единственное место, где GTD выдаёт новую попытку. */
export interface GtdContinuationRequest {
  gtdId: string;
  userTaskId: string;
  profileId: string;
  stepId: string;
  attempt: number;
  reason: string;
  instructions: string | null;
  /** Синтетический провайдер песочницы I07: что выдаст следующий шаг. */
  stepOutcome: GtdStepOutcome;
  /** Свидетельство по критериям следующего шага ({criterionId: true}). */
  criteria?: Record<string, unknown> | null;
}

export interface GtdContinuationResult {
  runId: string | null;
  generation: number;
  created: boolean;
}

export type GtdContinuationIssuer = (req: GtdContinuationRequest) => Promise<GtdContinuationResult>;

/**
 * Продолжение через существующий Workflow Port: НОВЫЙ runId, тот же
 * userTaskId, подъём поколения (прежняя попытка лишена прав) — явная семантика
 * продолжения из эпика M1 шаг 5, а не молчаливый повтор задачи.
 */
export function portResumeIssuer(port: WorkflowPortApi): GtdContinuationIssuer {
  return async (req) => {
    const { runId, generation } = await port.resume(req.userTaskId, {
      reason: `gtd_continuation:${req.reason}`,
      instructions: req.instructions ?? undefined,
      gtd: { gtdId: req.gtdId, stepId: req.stepId, attempt: req.attempt, stepOutcome: req.stepOutcome },
      criteria: req.criteria ?? null,
    });
    return { runId, generation, created: true };
  };
}

/** Шаг стабилен между попытками (§11): stepId выводится из номера попытки. */
export function stepIdForAttempt(attempt: number): string {
  return `step-${attempt}`;
}

export interface ReportOutcomeInput {
  gtdId: string;
  userTaskId: string;
  runId?: string | null;
  stepId: string;
  outcome: GtdStepOutcome;
  detail?: Record<string, unknown> | null;
  eventId?: number | null;
  idempotencyKey: string;
}

export interface ReportOutcomeResult {
  outcomeId: string;
  accepted: boolean;
  duplicate: boolean;
  state: 'pending' | 'acked' | 'rejected' | 'quarantined';
  reason: string | null;
}

export interface AckItemReport {
  outcomeId: string;
  stepId: string;
  attempt: number;
  decision: GtdDecision;
  reason: string;
  continuationRunId: string | null;
  deferred: boolean;
}

export interface AckReport {
  gtdId: string;
  processed: AckItemReport[];
  deferred: number;
  errors: { outcomeId: string; reason: string }[];
}

export interface TickReport {
  now: number;
  checked: number;
  continued: number;
  completed: number;
  stopped: number;
  waiting: number;
  deferred: number;
  quarantined: number;
  errors: { gtdId: string; reason: string }[];
}

export interface GtdServiceDeps {
  store: GtdStore;
  tasks: TaskStore;
  port: WorkflowPortApi;
  clock?: Clock;
  issuer?: GtdContinuationIssuer;
}

const sha = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .slice(0, 10)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

export class GtdService {
  private readonly store: GtdStore;
  private readonly tasks: TaskStore;
  private readonly port: WorkflowPortApi;
  private readonly clock: Clock;
  private readonly issuer: GtdContinuationIssuer;

  constructor(deps: GtdServiceDeps) {
    this.store = deps.store;
    this.tasks = deps.tasks;
    this.port = deps.port;
    this.clock = deps.clock ?? systemClock;
    this.issuer = deps.issuer ?? portResumeIssuer(deps.port);
  }

  // ------------------------------------------------------------- регистрация

  /**
   * Явная регистрация задачи на контроль (opt-in). До запуска работы запись
   * уже durable: gtdId обязателен в Input → executor → Output → GTD outcome.
   */
  async register(input: RegisterGtdInput): Promise<{ record: GtdRecordRow; created: boolean }> {
    const now = this.clock.now();
    const requestId = input.requestId?.trim() ?? '';
    if (!requestId) throw new GtdAlreadyRegisteredError(input.userTaskId, 'request_id_required');
    const reason = input.reason?.trim() ?? '';
    if (!reason) throw new GtdAlreadyRegisteredError(input.userTaskId, 'registration_reason_required');
    if (!Array.isArray(input.criteria) || input.criteria.length === 0) {
      throw new GtdAlreadyRegisteredError(input.userTaskId, 'completion_criteria_required');
    }
    for (const c of input.criteria) {
      if (!c.id?.trim()) throw new GtdAlreadyRegisteredError(input.userTaskId, 'criterion_id_required');
    }
    if (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= now) {
      throw new GtdAlreadyRegisteredError(input.userTaskId, 'deadline_in_past');
    }
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new GtdAlreadyRegisteredError(input.userTaskId, 'max_attempts_out_of_range');
    }
    // Самоконтроль: запись не может контролировать себя или другую запись.
    if (input.supervisedByGtdId) throw new GtdSelfSupervisionError();

    const task = await this.tasks.getTask(input.userTaskId);
    if (!task) throw new GtdUnknownRecordError(input.userTaskId);
    if (task.profile_id !== input.profileId) throw new GtdOutcomeScopeError(input.userTaskId, input.profileId, task.profile_id);

    const gtdId = await deriveGtdId(input.profileId, input.userTaskId);
    const record: GtdRecordRow = {
      gtd_id: gtdId,
      profile_id: input.profileId,
      user_task_id: input.userTaskId,
      registration_reason: reason,
      criteria_json: JSON.stringify(input.criteria),
      continuation_owner: 'gtd',
      state: 'active',
      stop_reason: null,
      next_trigger_kind: input.nextCheckAt !== undefined ? 'timer' : null,
      next_trigger_ref: null,
      next_check_at: input.nextCheckAt ?? null,
      deadline_at: input.deadlineAt,
      max_attempts: maxAttempts,
      attempts: 0,
      current_step_id: stepIdForAttempt(1),
      control_generation: 1,
      supervised_by_gtd_id: null,
      last_outcome: null,
      created_at: now,
      updated_at: now,
      revision: 1,
    };

    const inserted = await this.store.insertRecord(record);
    if (inserted) {
      logStructured({
        event: 'gtd.registered',
        profileId: input.profileId,
        userTaskId: input.userTaskId,
        gtdId,
        requestId,
        reason: 'explicit_opt_in',
        registrationReason: reason,
        criteria: input.criteria.map((c) => c.id),
        continuationOwner: 'gtd',
        state: 'active',
        deadlineAt: input.deadlineAt,
        maxAttempts,
        nextCheckAt: record.next_check_at,
        supervisedByGtdId: null,
      });
      return { record, created: true };
    }

    // Вторая запись для той же задачи невозможна (UNIQUE user_task_id):
    // возвращаем существующую — обойти caps новой записью нельзя.
    const existing = await this.store.getRecord(gtdId);
    if (!existing) throw new GtdUnknownRecordError(gtdId);
    const same =
      existing.registration_reason === reason &&
      existing.deadline_at === input.deadlineAt &&
      existing.max_attempts === maxAttempts;
    logStructured({
      event: 'gtd.registration.rejected',
      level: 'warn',
      profileId: input.profileId,
      userTaskId: input.userTaskId,
      gtdId,
      requestId,
      reason: same ? 'same_registration_idempotent' : existing.state === 'stopped' ? 'caps_exhausted_record_closed' : 'already_registered',
      existingState: existing.state,
      stopReason: existing.stop_reason,
      attempts: existing.attempts,
      maxAttempts: existing.max_attempts,
    });
    if (!same) throw new GtdAlreadyRegisteredError(input.userTaskId, 'already_registered');
    return { record: existing, created: false };
  }

  /** Host-проверка перед запуском managed work: gtdId не выбирается произвольно. */
  async requireManagedTask(gtdId: string, userTaskId: string): Promise<GtdRecordRow> {
    const record = await this.store.getRecord(gtdId);
    if (!record) throw new GtdUnknownRecordError(gtdId);
    if (record.user_task_id !== userTaskId) throw new GtdOutcomeScopeError(gtdId, record.user_task_id, userTaskId);
    if (!GTD_OPEN_STATES.includes(record.state as (typeof GTD_OPEN_STATES)[number])) {
      throw new GtdAlreadyRegisteredError(userTaskId, `control_record_${record.state}`);
    }
    return record;
  }

  // ------------------------------------------------------------------- inbox

  /**
   * Output → GTD: структурированный исход шага сохраняется в durable inbox ДО
   * решения GTD. Дедуп — по ключу идемпотентности исхода: повтор того же ключа
   * возвращает прежнюю строку и не создаёт вторую.
   */
  async reportOutcome(input: ReportOutcomeInput): Promise<ReportOutcomeResult> {
    const now = this.clock.now();
    const record = await this.store.getRecord(input.gtdId);
    if (!record) {
      // Contract error (§5a): неизвестный gtdId у managed outcome. Исход не
      // теряется и не превращается в тихий output-owned recovery — он остаётся
      // видимым как quarantined с явной причиной и требованием reconciliation.
      const outcomeId = `gtd-out-${await sha(`${input.gtdId} ${input.idempotencyKey}`)}`;
      await this.store.insertOutcome({
        outcome_id: outcomeId,
        gtd_id: input.gtdId,
        profile_id: '',
        user_task_id: input.userTaskId,
        run_id: input.runId ?? null,
        step_id: input.stepId,
        outcome: input.outcome,
        detail_json: input.detail === undefined ? null : JSON.stringify(input.detail),
        event_id: input.eventId ?? null,
        idempotency_key: input.idempotencyKey,
        state: 'quarantined',
        reason: 'unknown_control_record',
        attempt: null,
        created_at: now,
        updated_at: now,
        acked_at: now,
      });
      logStructured({
        event: 'gtd.outcome.quarantined',
        level: 'error',
        userTaskId: input.userTaskId,
        runId: input.runId ?? null,
        gtdId: input.gtdId,
        stepId: input.stepId,
        outcome: input.outcome,
        idempotencyKey: input.idempotencyKey,
        reason: 'unknown_control_record',
        reconciliationRequired: true,
        continuationOwner: 'gtd',
        note: 'managed outcome без записи контроля: тихий output-owned recovery запрещён',
      });
      throw new GtdUnknownRecordError(input.gtdId);
    }
    if (record.user_task_id !== input.userTaskId) {
      throw new GtdOutcomeScopeError(input.gtdId, record.user_task_id, input.userTaskId);
    }

    const existing = await this.store.outcomeByIdempotencyKey(input.gtdId, input.idempotencyKey);
    if (existing) {
      logStructured({
        event: 'gtd.outcome.duplicate',
        profileId: record.profile_id,
        userTaskId: input.userTaskId,
        runId: input.runId ?? null,
        gtdId: input.gtdId,
        stepId: input.stepId,
        outcome: input.outcome,
        idempotencyKey: input.idempotencyKey,
        reason: 'same_idempotency_key',
        state: existing.state,
      });
      return {
        outcomeId: existing.outcome_id,
        accepted: false,
        duplicate: true,
        state: existing.state,
        reason: existing.reason,
      };
    }

    const outcomeId = `gtd-out-${await sha(`${input.gtdId} ${input.idempotencyKey}`)}`;
    const inserted = await this.store.insertOutcome({
      outcome_id: outcomeId,
      gtd_id: input.gtdId,
      profile_id: record.profile_id,
      user_task_id: input.userTaskId,
      run_id: input.runId ?? null,
      step_id: input.stepId,
      outcome: input.outcome,
      detail_json: input.detail === undefined ? null : JSON.stringify(input.detail),
      event_id: input.eventId ?? null,
      idempotency_key: input.idempotencyKey,
      state: 'pending',
      reason: null,
      attempt: null,
      created_at: now,
      updated_at: now,
      acked_at: null,
    });
    if (!inserted) {
      const again = await this.store.outcomeByIdempotencyKey(input.gtdId, input.idempotencyKey);
      return {
        outcomeId: again?.outcome_id ?? outcomeId,
        accepted: false,
        duplicate: true,
        state: again?.state ?? 'pending',
        reason: again?.reason ?? null,
      };
    }
    logStructured({
      event: 'gtd.outcome.received',
      profileId: record.profile_id,
      userTaskId: input.userTaskId,
      runId: input.runId ?? null,
      gtdId: input.gtdId,
      stepId: input.stepId,
      outcome: input.outcome,
      eventId: input.eventId ?? null,
      idempotencyKey: input.idempotencyKey,
      inboxState: 'pending',
      continuationOwner: 'gtd',
    });
    return { outcomeId, accepted: true, duplicate: false, state: 'pending', reason: null };
  }

  // ------------------------------------------------------- ACK и прогрессия

  /**
   * Durable GTD ACK: обработать pending-исходы записи. На каждый исход —
   * ровно одно решение (gtd_progressions, UNIQUE(gtd_id, step_id, attempt)) и
   * не более одного продолжения. Повторный вызов по уже ack'нутому исходу
   * ничего не делает: состояние исхода — единственный дедуп.
   */
  async ack(gtdId: string): Promise<AckReport> {
    const now = this.clock.now();
    const report: AckReport = { gtdId, processed: [], deferred: 0, errors: [] };
    const pending = await this.store.pendingOutcomes(gtdId);
    for (const outcome of pending) {
      try {
        const item = await this.applyOutcome(outcome, now);
        if (item.deferred) report.deferred += 1;
        else report.processed.push(item);
      } catch (e) {
        const reason = String((e as Error)?.message ?? e);
        report.errors.push({ outcomeId: outcome.outcome_id, reason });
        logStructured({
          event: 'gtd.ack.failed',
          level: 'error',
          gtdId,
          userTaskId: outcome.user_task_id,
          outcomeId: outcome.outcome_id,
          stepId: outcome.step_id,
          reason: 'apply_failed',
          error: reason.slice(0, 200),
        });
      }
    }
    return report;
  }

  private async applyOutcome(outcome: GtdOutcomeRow, now: number): Promise<AckItemReport> {
    const record = await this.store.getRecord(outcome.gtd_id);
    if (!record) throw new GtdUnknownRecordError(outcome.gtd_id);
    const base = {
      outcomeId: outcome.outcome_id,
      stepId: outcome.step_id,
      // Номер решения по этому исходу (он же — номер попытки плана).
      attempt: record.attempts + 1,
      continuationRunId: null,
      deferred: false,
    };

    if (record.state !== 'active') {
      // Закрытая запись: поздний исход дополняет историю, но работу не возрождает.
      await this.store.ackOutcome(outcome.outcome_id, { state: 'rejected', reason: 'control_record_closed', attempt: base.attempt }, now);
      logStructured({
        event: 'gtd.outcome.rejected',
        level: 'warn',
        profileId: record.profile_id,
        userTaskId: outcome.user_task_id,
        gtdId: record.gtd_id,
        outcomeId: outcome.outcome_id,
        stepId: outcome.step_id,
        reason: 'control_record_closed',
        recordState: record.state,
        stopReason: record.stop_reason,
      });
      return { ...base, decision: 'reject', reason: 'control_record_closed' };
    }

    const detail = outcome.detail_json ? (JSON.parse(outcome.detail_json) as Record<string, unknown>) : {};
    const plan = this.decide(record, outcome.outcome, detail, now);

    if (plan.decision === 'continue') {
      // Живая попытка ещё идёт: исход не теряем и не прерываем её — оставляем
      // pending до завершения попытки (bounded, без второго продолжения).
      const active = await this.tasks.activeRun(outcome.user_task_id);
      if (active) {
        logStructured({
          event: 'gtd.outcome.deferred',
          profileId: record.profile_id,
          userTaskId: outcome.user_task_id,
          runId: active.id,
          gtdId: record.gtd_id,
          outcomeId: outcome.outcome_id,
          stepId: outcome.step_id,
          reason: 'active_run_in_progress',
        });
        return { ...base, decision: 'wait', reason: 'active_run_in_progress', deferred: true };
      }
    }

    // Номер решения по этому исходу и номер следующего шага. Решение N+1
    // относится к исходу шага N, поэтому продолжение — это уже шаг N+1: номера
    // шагов и попыток не наезжают друг на друга (важно для UNIQUE в схеме).
    const decisionAttempt = record.attempts + 1;
    const nextAttempt = decisionAttempt + 1;
    const nextStepId = stepIdForAttempt(nextAttempt);
    const progressionId = `gtd-pro-${await sha(`${record.gtd_id} ${outcome.step_id} ${decisionAttempt}`)}`;
    const inserted = await this.store.insertProgression({
      progression_id: progressionId,
      gtd_id: record.gtd_id,
      user_task_id: outcome.user_task_id,
      attempt: decisionAttempt,
      step_id: outcome.step_id,
      decision: plan.decision,
      reason: plan.reason,
      trigger_kind: plan.triggerKind ?? null,
      trigger_ref: plan.triggerRef ?? null,
      outcome_id: outcome.outcome_id,
      continuation_run_id: null,
      created_at: now,
    });
    if (!inserted) {
      // Решение для этого шага и попытки уже есть — второго продолжения нет.
      const existing = (await this.store.listProgressions(record.gtd_id)).find(
        (p) => p.step_id === outcome.step_id && p.attempt === decisionAttempt,
      );
      logStructured({
        event: 'gtd.decision.deduplicated',
        profileId: record.profile_id,
        userTaskId: outcome.user_task_id,
        gtdId: record.gtd_id,
        outcomeId: outcome.outcome_id,
        stepId: outcome.step_id,
        attempt: decisionAttempt,
        reason: 'progression_already_recorded',
        decision: existing?.decision ?? null,
        continuationRunId: existing?.continuation_run_id ?? null,
      });
      return {
        ...base,
        decision: (existing?.decision ?? 'reject') as GtdDecision,
        reason: 'progression_already_recorded',
        continuationRunId: existing?.continuation_run_id ?? null,
      };
    }

    let continuationRunId: string | null = null;
    if (plan.decision === 'continue') {
      const issued = await this.issuer({
        gtdId: record.gtd_id,
        userTaskId: outcome.user_task_id,
        profileId: record.profile_id,
        stepId: nextStepId,
        attempt: nextAttempt,
        reason: plan.reason,
        instructions: `Продолжение контроля ${record.gtd_id}: ${plan.reason}`,
        stepOutcome: (detail.nextStepOutcome as GtdStepOutcome) ?? 'succeeded',
      });
      continuationRunId = issued.runId;
      await this.store.setProgressionRun(progressionId, continuationRunId);
    }

    await this.store.ackOutcome(
      outcome.outcome_id,
      { state: 'acked', reason: plan.reason, attempt: decisionAttempt },
      now,
    );

    if (plan.decision === 'continue') {
      await this.store.updateRecord(
        record.gtd_id,
        { state: 'active', attempts: decisionAttempt, current_step_id: nextStepId, next_trigger_kind: 'timer', next_check_at: now, last_outcome: outcome.outcome },
        now,
      );
    } else if (plan.decision === 'wait') {
      await this.store.updateRecord(
        record.gtd_id,
        {
          state: plan.triggerKind === 'input' ? 'awaiting_user' : 'waiting_condition',
          attempts: decisionAttempt,
          current_step_id: nextStepId,
          next_trigger_kind: plan.triggerKind ?? null,
          next_trigger_ref: plan.triggerRef ?? null,
          next_check_at: now,
          last_outcome: outcome.outcome,
        },
        now,
      );
    } else if (plan.decision === 'complete') {
      await this.store.updateRecord(record.gtd_id, { state: 'completed', attempts: decisionAttempt, last_outcome: outcome.outcome }, now);
      await this.closeTask(outcome.user_task_id, 'done', {
        ok: true,
        gtdId: record.gtd_id,
        continuationOwner: 'gtd',
        completedBy: 'gtd',
        criteria: plan.criteria?.satisfied ?? [],
        stepId: outcome.step_id,
        attempt: decisionAttempt,
        reason: plan.reason,
      });
    } else {
      await this.store.updateRecord(
        record.gtd_id,
        { state: 'stopped', stop_reason: plan.reason, attempts: decisionAttempt, last_outcome: outcome.outcome },
        now,
      );
      await this.closeTask(outcome.user_task_id, 'blocked', {
        ok: false,
        gtdId: record.gtd_id,
        continuationOwner: 'gtd',
        stoppedBy: 'gtd',
        stopReason: plan.reason,
        stepId: outcome.step_id,
        attempt: decisionAttempt,
        criteria: plan.criteria?.missing ?? [],
      });
    }

    logStructured({
      event: 'gtd.decision',
      profileId: record.profile_id,
      userTaskId: outcome.user_task_id,
      runId: outcome.run_id ?? null,
      gtdId: record.gtd_id,
      outcomeId: outcome.outcome_id,
      stepId: outcome.step_id,
      attempt: decisionAttempt,
      decision: plan.decision,
      reason: plan.reason,
      continuationOwner: 'gtd',
      continuationRunId,
      continuationCreated: continuationRunId !== null,
      criteria: plan.criteria ? { met: plan.criteria.met, satisfied: plan.criteria.satisfied, missing: plan.criteria.missing } : null,
      triggerKind: plan.triggerKind ?? null,
      triggerRef: plan.triggerRef ?? null,
      recordState: plan.decision === 'continue' ? 'active' : plan.decision === 'wait' ? (plan.triggerKind === 'input' ? 'awaiting_user' : 'waiting_condition') : plan.decision,
      ack: true,
    });
    return { ...base, decision: plan.decision, reason: plan.reason, continuationRunId };
  }

  /** Детерминированное решение по исходу: без LLM, по структурированным фактам. */
  private decide(
    record: GtdRecordRow,
    outcome: GtdStepOutcome,
    detail: Record<string, unknown>,
    now: number,
  ): {
    decision: GtdDecision;
    reason: string;
    triggerKind?: GtdTriggerKind;
    triggerRef?: string | null;
    criteria?: { met: boolean; satisfied: string[]; missing: string[] };
  } {
    if (outcome === 'awaiting_user') {
      const ref = typeof detail.awaitingInputId === 'string' ? detail.awaitingInputId : null;
      return { decision: 'wait', reason: 'awaiting_user_input', triggerKind: 'input', triggerRef: ref };
    }
    if (outcome === 'awaiting_condition') {
      const ref = typeof detail.conditionRef === 'string' ? detail.conditionRef : null;
      return { decision: 'wait', reason: 'awaiting_external_condition', triggerKind: 'condition', triggerRef: ref };
    }
    if (outcome === 'succeeded') {
      const criteria = evaluateCriteria(parseCriteria(record), detail.criteria as Record<string, unknown> | undefined);
      if (criteria.met) return { decision: 'complete', reason: 'criteria_met', criteria };
      if (record.attempts + 1 >= record.max_attempts) {
        return { decision: 'stop', reason: 'attempt_cap_exhausted', criteria };
      }
      if (now >= record.deadline_at) return { decision: 'stop', reason: 'deadline_exceeded', criteria };
      return { decision: 'continue', reason: 'criteria_not_met', criteria };
    }
    // failed
    if (record.attempts + 1 >= record.max_attempts) return { decision: 'stop', reason: 'attempt_cap_exhausted' };
    if (now >= record.deadline_at) return { decision: 'stop', reason: 'deadline_exceeded' };
    return { decision: 'continue', reason: 'step_failed_retry' };
  }

  // ------------------------------------------------------------------- тик

  /**
   * Проход контроля на момент `now` (виртуальные часы песочницы I07). Тик
   * читает только строки и выдаёт продолжение только по событию: ожидание не
   * будит движок и не расходует токены.
   */
  async tick(opts: { now?: number; profileId?: string } = {}): Promise<TickReport> {
    const now = opts.now ?? this.clock.now();
    const report: TickReport = {
      now,
      checked: 0,
      continued: 0,
      completed: 0,
      stopped: 0,
      waiting: 0,
      deferred: 0,
      quarantined: 0,
      errors: [],
    };
    logStructured({ event: 'gtd.tick.started', reason: 'scan', now, profileId: opts.profileId ?? null });

    for (const record of await this.store.dueRecords(now, opts.profileId)) {
      report.checked += 1;
      try {
        const outcome = await this.applyTrigger(record, now);
        if (outcome.decision === 'continue') report.continued += 1;
        else if (outcome.decision === 'complete') report.completed += 1;
        else if (outcome.decision === 'stop') report.stopped += 1;
        else if (outcome.deferred) report.deferred += 1;
        else report.waiting += 1;
      } catch (e) {
        const reason = String((e as Error)?.message ?? e);
        report.errors.push({ gtdId: record.gtd_id, reason });
        logStructured({
          event: 'gtd.tick.failed',
          level: 'error',
          profileId: record.profile_id,
          userTaskId: record.user_task_id,
          gtdId: record.gtd_id,
          reason: 'apply_failed',
          error: reason.slice(0, 200),
        });
      }
    }

    logStructured({
      event: 'gtd.tick.finished',
      reason: report.errors.length ? 'completed_with_errors' : 'completed',
      now,
      profileId: opts.profileId ?? null,
      checked: report.checked,
      continued: report.continued,
      completed: report.completed,
      stopped: report.stopped,
      waiting: report.waiting,
      deferred: report.deferred,
      quarantined: report.quarantined,
      errors: report.errors.length,
    });
    return report;
  }

  private async applyTrigger(record: GtdRecordRow, now: number): Promise<{ decision: GtdDecision; reason: string; deferred: boolean }> {
    // Дедлайн контроля важнее любого ожидания: bounded stop, а не вечное ожидание.
    if (now >= record.deadline_at) {
      await this.stop(record, 'deadline_exceeded', now);
      return { decision: 'stop', reason: 'deadline_exceeded', deferred: false };
    }

    if (record.state === 'awaiting_user') {
      const ref = record.next_trigger_ref;
      if (!ref) {
        await this.stop(record, 'awaiting_input_lost', now);
        return { decision: 'stop', reason: 'awaiting_input_lost', deferred: false };
      }
      const answer = await this.tasks.readAnswer(ref);
      if (answer !== null) {
        await this.continueAfterWait(record, 'input_received', now);
        return { decision: 'continue', reason: 'input_received', deferred: false };
      }
      logStructured({
        event: 'gtd.wait',
        profileId: record.profile_id,
        userTaskId: record.user_task_id,
        gtdId: record.gtd_id,
        reason: 'awaiting_user_input',
        triggerKind: 'input',
        triggerRef: ref,
        continuationOwner: 'gtd',
        note: 'wait не держит живой процесс: токены не расходуются',
      });
      return { decision: 'wait', reason: 'awaiting_user_input', deferred: false };
    }

    if (record.state === 'waiting_condition') {
      const ref = record.next_trigger_ref;
      if (!ref) {
        await this.stop(record, 'condition_ref_lost', now);
        return { decision: 'stop', reason: 'condition_ref_lost', deferred: false };
      }
      const condition = await this.store.getCondition(ref);
      if (!condition) {
        logStructured({
          event: 'gtd.wait',
          profileId: record.profile_id,
          userTaskId: record.user_task_id,
          gtdId: record.gtd_id,
          reason: 'awaiting_external_condition',
          triggerKind: 'condition',
          triggerRef: ref,
          continuationOwner: 'gtd',
          note: 'wait не держит живой процесс: токены не расходуются',
        });
        return { decision: 'wait', reason: 'awaiting_external_condition', deferred: false };
      }
      if (condition.conclusion === 'success') {
        await this.continueAfterWait(record, 'condition_satisfied', now);
        return { decision: 'continue', reason: 'condition_satisfied', deferred: false };
      }
      if (condition.conclusion === 'failure') {
        if (record.attempts + 1 >= record.max_attempts) {
          await this.stop(record, 'attempt_cap_exhausted', now);
          return { decision: 'stop', reason: 'attempt_cap_exhausted', deferred: false };
        }
        await this.continueAfterWait(record, 'gate_failed_retry', now);
        return { decision: 'continue', reason: 'gate_failed_retry', deferred: false };
      }
      logStructured({
        event: 'gtd.wait',
        profileId: record.profile_id,
        userTaskId: record.user_task_id,
        gtdId: record.gtd_id,
        reason: 'condition_neutral',
        triggerKind: 'condition',
        triggerRef: ref,
        continuationOwner: 'gtd',
      });
      return { decision: 'wait', reason: 'condition_neutral', deferred: false };
    }

    // active + наступила плановая проверка: следующий шаг выдаёт только GTD.
    const active = await this.tasks.activeRun(record.user_task_id);
    if (active) {
      logStructured({
        event: 'gtd.wait',
        profileId: record.profile_id,
        userTaskId: record.user_task_id,
        runId: active.id,
        gtdId: record.gtd_id,
        reason: 'active_run_in_progress',
        continuationOwner: 'gtd',
      });
      return { decision: 'wait', reason: 'active_run_in_progress', deferred: true };
    }
    await this.continueAfterWait(record, 'scheduled_check', now);
    return { decision: 'continue', reason: 'scheduled_check', deferred: false };
  }

  private async continueAfterWait(record: GtdRecordRow, reason: string, now: number): Promise<void> {
    // Решение по событию (ответ/условие/таймер) относится к шагу, который ждал
    // (current_step_id), и к счётчику решений на момент события. Решение по
    // ИСХОДУ этого шага получит следующий номер — поэтому UNIQUE(gtd_id, step_id,
    // attempt) в схеме не даёт ни одному шагу двух разных продолжений.
    const stepId = record.current_step_id ?? stepIdForAttempt(record.attempts + 1);
    const attempt = record.attempts;
    const planAttempt = attempt + 1;
    const progressionId = `gtd-pro-${await sha(`${record.gtd_id} ${stepId} ${attempt}`)}`;
    const inserted = await this.store.insertProgression({
      progression_id: progressionId,
      gtd_id: record.gtd_id,
      user_task_id: record.user_task_id,
      attempt,
      step_id: stepId,
      decision: 'continue',
      reason,
      trigger_kind: record.next_trigger_kind,
      trigger_ref: record.next_trigger_ref,
      outcome_id: null,
      continuation_run_id: null,
      created_at: now,
    });
    if (!inserted) return;
    const issued = await this.issuer({
      gtdId: record.gtd_id,
      userTaskId: record.user_task_id,
      profileId: record.profile_id,
      stepId,
      attempt: planAttempt,
      reason,
      instructions: `Продолжение контроля ${record.gtd_id}: ${reason}`,
      stepOutcome: 'succeeded',
    });
    await this.store.setProgressionRun(progressionId, issued.runId);
    await this.store.updateRecord(
      record.gtd_id,
      { state: 'active', attempts: attempt, current_step_id: stepId, next_trigger_kind: 'timer', next_check_at: now, stop_reason: null },
      now,
    );
    logStructured({
      event: 'gtd.decision',
      profileId: record.profile_id,
      userTaskId: record.user_task_id,
      gtdId: record.gtd_id,
      stepId,
      attempt,
      decision: 'continue',
      reason,
      continuationOwner: 'gtd',
      continuationRunId: issued.runId,
      continuationCreated: issued.runId !== null,
      triggerKind: record.next_trigger_kind,
      triggerRef: record.next_trigger_ref,
      recordState: 'active',
      ack: true,
    });
  }

  private async stop(record: GtdRecordRow, reason: string, now: number): Promise<void> {
    await this.store.updateRecord(record.gtd_id, { state: 'stopped', stop_reason: reason }, now);
    await this.closeTask(record.user_task_id, 'blocked', {
      ok: false,
      gtdId: record.gtd_id,
      continuationOwner: 'gtd',
      stoppedBy: 'gtd',
      stopReason: reason,
    });
    logStructured({
      event: 'gtd.stopped',
      level: 'warn',
      profileId: record.profile_id,
      userTaskId: record.user_task_id,
      gtdId: record.gtd_id,
      reason,
      attempts: record.attempts,
      maxAttempts: record.max_attempts,
      deadlineAt: record.deadline_at,
      continuationOwner: 'gtd',
      note: 'caps завершают прогрессию: новая запись контроля не выдаётся',
    });
  }

  // ---------------------------------------------------------------- утилиты

  /**
   * Закрытие задачи по решению GTD. Терминальный статус — только от контроля:
   * Output сам задачу не закрывает (один владелец продолжения).
   */
  private async closeTask(
    userTaskId: string,
    status: 'done' | 'blocked',
    result: Record<string, unknown>,
  ): Promise<void> {
    const task = await this.tasks.requireTask(userTaskId);
    const open = await this.tasks.getOpenAwaiting(userTaskId);
    if (open) {
      await this.tasks.expireAwaiting({
        taskId: userTaskId,
        nextStatus: status,
        generation: task.generation,
        step: 'gtd',
        reason: 'control_closed',
      });
    }
    await this.tasks.commit(userTaskId, task.generation, {
      status,
      stage: status === 'done' ? 'finished' : 'evaluating',
      result,
      kind: 'task_status_changed',
      source: 'watcher',
      step: 'gtd',
      payload: { gtdId: result.gtdId, continuationOwner: 'gtd', stoppedBy: result.stoppedBy ?? null },
      blockerReason: status === 'blocked' ? String(result.stopReason ?? 'control_stopped') : undefined,
    });
  }

  /** Отмена контроля (§7): закрывает запись и отзывает исполнение. */
  async cancel(gtdId: string, opts: { reason?: string } = {}): Promise<GtdRecordRow> {
    const now = this.clock.now();
    const record = await this.store.getRecord(gtdId);
    if (!record) throw new GtdUnknownRecordError(gtdId);
    const cancelled = await this.port.cancel(record.user_task_id, { reason: opts.reason ?? 'control_cancelled' });
    const updated = await this.store.updateRecord(
      record.gtd_id,
      { state: 'cancelled', stop_reason: opts.reason ?? 'control_cancelled' },
      now,
    );
    logStructured({
      event: 'gtd.cancelled',
      profileId: record.profile_id,
      userTaskId: record.user_task_id,
      gtdId,
      reason: opts.reason ?? 'control_cancelled',
      taskCancelled: cancelled.cancelled,
      stopConfirmed: cancelled.stopConfirmed,
      continuationOwner: 'gtd',
    });
    return updated ?? record;
  }

  /** Синтетический CI-провайдер песочницы I07: внешнее условие закрывается отчётом. */
  async reportCondition(
    conditionRef: string,
    input: { gtdId: string; conclusion: 'success' | 'failure' | 'neutral'; reportRef?: string | null; source?: string | null },
  ): Promise<{ condition: unknown; created: boolean }> {
    const now = this.clock.now();
    const record = await this.store.getRecord(input.gtdId);
    if (!record) throw new GtdUnknownRecordError(input.gtdId);
    const created = await this.store.insertCondition({
      condition_ref: conditionRef,
      gtd_id: record.gtd_id,
      user_task_id: record.user_task_id,
      conclusion: input.conclusion,
      report_ref: input.reportRef ?? null,
      source: input.source ?? 'synthetic-ci',
      created_at: now,
    });
    logStructured({
      event: 'gtd.condition.reported',
      profileId: record.profile_id,
      userTaskId: record.user_task_id,
      gtdId: record.gtd_id,
      conditionRef,
      conclusion: input.conclusion,
      reportRef: input.reportRef ?? null,
      source: input.source ?? 'synthetic-ci',
      reason: 'external_condition',
    });
    return { condition: { conditionRef, conclusion: input.conclusion }, created };
  }

  async get(gtdId: string) {
    const record = await this.store.getRecord(gtdId);
    if (!record) return null;
    return {
      record,
      criteria: parseCriteria(record),
      progressions: await this.store.listProgressions(gtdId),
      outcomes: await this.store.listOutcomes(gtdId),
    };
  }

  list(profileId?: string): Promise<GtdRecordRow[]> {
    return this.store.listRecords(profileId);
  }
}
