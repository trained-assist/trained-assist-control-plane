/**
 * Schedule service — карточка P22 «Schedule без обязательного GTD» (#61, этап I07).
 *
 * Четыре правила, ради которых модуль существует, и где каждое обеспечено:
 *
 *  1. **Occurrence ≠ control.** Срабатывание создаёт обычную задачу через Task
 *     Submission API (тот же путь, что у пользователя) и НЕ регистрирует запись
 *     контроля: `schedule_occurrences.gtd_id` остаётся NULL, terminal result не
 *     содержит gtdId. Никакого control loop: шаг плана не ждёт «следующего
 *     действия контроля», результат уходит в Output.
 *  2. **Dedup в БД.** UNIQUE(schedule_id, occurrence_key) + детерминированный
 *     userTaskId. Повторный tick, replay после краша или две гонки на одном
 *     моменте дают ОДНО occurrence и ОДНУ задачу.
 *  3. **Crash recovery вместо потери.** Occurrence с состоянием `due`/`failed` —
 *     это обещание, а не мусор: следующий tick доставляет его с теми же ключами.
 *     Попытки ограничены max_admit_attempts (никакого бесконечного retry).
 *  4. **Disable ≠ cancel.** Disable меняет только enabled у расписания. Ни
 *     occurrence, ни уже принятые задачи не трогаются — выключение запрещает
 *     будущие срабатывания (BOUNDARIES §7).
 *
 * Время — вход (Clock): песочница I07 гоняет hour/day waits на виртуальных
 * часах, без реального сна.
 */
import { logStructured } from '../logging/structured-log';
import { deriveUserTaskId } from '../intake/intake-service';
import type { WorkflowPortApi } from '../workflow-port/workflow-port';
import { assertTimezone, dueCronDates, InvalidScheduleError, nextCronDate, parseCron } from './cron';
import { ScheduleStore } from './schedule-store';
import { systemClock, type Clock } from './virtual-clock';
import {
  CATCH_UP_POLICIES,
  OVERLAP_POLICIES,
  deriveOccurrenceId,
  deriveScheduleId,
  occurrenceKeyOf,
  type CatchUpPolicy,
  type CreateScheduleInput,
  type CreateScheduleResult,
  type OccurrenceRow,
  type OverlapPolicy,
  type ScheduleRow,
} from './types';

/** Вход приёма задачи для occurrence (тот же контракт, что у пользователя). */
export interface OccurrenceSubmitInput {
  occurrenceId: string;
  scheduleId: string;
  occurrenceKey: string;
  /** Детерминирован от (profileId, occurrenceId) — повтор даёт тот же taskId. */
  userTaskId: string;
  requestId: string;
  receiptId: string;
  profileId: string;
  goal: string;
  projectId: string | null;
  conversationId: string | null;
  audienceId: string | null;
  destinationId: string | null;
  scheduledFor: number;
}

export interface OccurrenceSubmitResult {
  taskId: string;
  runId: string | null;
  created: boolean;
}

export type OccurrenceSubmitter = (input: OccurrenceSubmitInput) => Promise<OccurrenceSubmitResult>;

export interface TickReport {
  /** Виртуальное «сейчас», по которому считались срабатывания. */
  now: number;
  dueSchedules: number;
  admitted: number;
  deduplicated: number;
  skipped: number;
  failed: number;
  /** Доставлено после краша/ошибки приёма (тот же ключ, не второе срабатывание). */
  recovered: number;
  /** Срабатывания, пропущенные политикой catch-up. */
  misfires: number;
  errors: { scheduleId: string; occurrenceId: string | null; reason: string }[];
}

export interface ScheduleServiceDeps {
  store: ScheduleStore;
  submitter: OccurrenceSubmitter;
  clock?: Clock;
}

/**
 * Submitter поверх Workflow Port: обычная задача без уточнений (`autoRun`).
 * Путь ТОТ ЖЕ, что у задачи пользователя, — расписание не заводит отдельную
 * ветку исполнения и не обходит приём/квитанцию.
 */
export function portSubmitter(port: WorkflowPortApi): OccurrenceSubmitter {
  return async (input) => {
    const result = await port.submit({
      id: input.userTaskId,
      profileId: input.profileId,
      goal: input.goal,
      projectId: input.projectId,
      conversationId: input.conversationId,
      audienceId: input.audienceId,
      destinationId: input.destinationId,
      requestId: input.requestId,
      receiptId: input.receiptId,
      source: 'cron',
      conversationTitle: null,
      envelope: {
        contractVersion: 1,
        origin: 'schedule',
        scheduleId: input.scheduleId,
        occurrenceId: input.occurrenceId,
        occurrenceKey: input.occurrenceKey,
        scheduledFor: input.scheduledFor,
      },
      userValue: {
        pilotRoute: 'new-plane',
        pilotReason: 'schedule_occurrence',
        origin: 'schedule',
        scheduleId: input.scheduleId,
        occurrenceId: input.occurrenceId,
        occurrenceKey: input.occurrenceKey,
        scheduledFor: input.scheduledFor,
        // Явный NULL: контроль не регистрировался (AC-141).
        gtdId: null,
      },
      // Задача расписания не задаёт уточнений: работа + терминальный результат
      // без ожидания человека и без control loop.
      autoRun: true,
    });
    return { taskId: result.taskId, runId: result.runId, created: result.created };
  };
}

const emptyReport = (now: number): TickReport => ({
  now,
  dueSchedules: 0,
  admitted: 0,
  deduplicated: 0,
  skipped: 0,
  failed: 0,
  recovered: 0,
  misfires: 0,
  errors: [],
});

export class ScheduleService {
  private readonly store: ScheduleStore;
  private readonly submitter: OccurrenceSubmitter;
  private readonly clock: Clock;

  constructor(deps: ScheduleServiceDeps) {
    this.store = deps.store;
    this.submitter = deps.submitter;
    this.clock = deps.clock ?? systemClock;
  }

  // -------------------------------------------------------------- создание

  async create(profileId: string, input: CreateScheduleInput): Promise<CreateScheduleResult> {
    const now = this.clock.now();
    const requestId = input.requestId?.trim() ?? '';
    if (!requestId) throw new InvalidScheduleError('requestId is required', 'requestId');
    const goal = input.goal?.trim() ?? '';
    if (!goal) throw new InvalidScheduleError('goal is required', 'goal');

    const cron = parseCron(input.cron);
    const timezone = assertTimezone(input.timezone);
    const overlapPolicy = input.overlapPolicy ?? 'skip';
    const catchUpPolicy = input.catchUpPolicy ?? 'coalesce';
    if (!(OVERLAP_POLICIES as readonly string[]).includes(overlapPolicy)) {
      throw new InvalidScheduleError(`overlapPolicy must be one of ${OVERLAP_POLICIES.join('|')}`, 'overlapPolicy');
    }
    if (!(CATCH_UP_POLICIES as readonly string[]).includes(catchUpPolicy)) {
      throw new InvalidScheduleError(`catchUpPolicy must be one of ${CATCH_UP_POLICIES.join('|')}`, 'catchUpPolicy');
    }
    const maxAdmitAttempts = input.maxAdmitAttempts ?? 5;
    if (!Number.isInteger(maxAdmitAttempts) || maxAdmitAttempts < 1 || maxAdmitAttempts > 10) {
      throw new InvalidScheduleError('maxAdmitAttempts must be 1..10', 'maxAdmitAttempts');
    }

    const scheduleId = await deriveScheduleId(profileId, requestId);
    const enabled = input.enabled ?? true;
    // Выключенное расписание не планирует срабатывание: после enable момент
    // считается заново от «сейчас» (никакого backlog из disabled-окна).
    const nextDueAt = enabled ? nextCronDate(cron, timezone, now) : null;

    const inserted = await this.store.insertSchedule({
      schedule_id: scheduleId,
      profile_id: profileId,
      cron_expr: cron.source,
      timezone,
      goal,
      project_id: input.projectId ?? null,
      conversation_id: input.conversationId ?? null,
      audience_id: input.audienceId ?? null,
      destination_id: input.destinationId ?? null,
      overlap_policy: overlapPolicy,
      catch_up_policy: catchUpPolicy,
      max_admit_attempts: maxAdmitAttempts,
      enabled: enabled ? 1 : 0,
      next_due_at: nextDueAt,
      created_at: now,
      updated_at: now,
      revision: 1,
    });

    const schedule = await this.store.getSchedule(scheduleId);
    if (!schedule) throw new Error(`schedule not readable after insert: ${scheduleId}`);
    const created = inserted;
    logStructured({
      event: created ? 'schedule.created' : 'schedule.duplicate',
      profileId,
      scheduleId,
      requestId,
      reason: created ? 'accepted' : 'same_request_id_same_schedule',
      cron: cron.source,
      timezone,
      overlapPolicy,
      catchUpPolicy,
      enabled: schedule.enabled === 1,
      nextDueAt: schedule.next_due_at,
      // AC-141: контроль не регистрируется, если его не просили явно.
      gtdId: null,
      controlRegistration: 'not_requested',
    });
    return { schedule, created };
  }

  // ------------------------------------------------------- enable / disable

  /**
   * Выключение расписания: запрет БУДУЩИХ срабатываний. Уже принятые задачи не
   * отменяются (AC-140) — в логе видно, сколько occurrence осталось в работе.
   */
  async disable(scheduleId: string): Promise<ScheduleRow> {
    const now = this.clock.now();
    const before = await this.store.getSchedule(scheduleId);
    if (!before) throw new InvalidScheduleError(`schedule not found: ${scheduleId}`, 'scheduleId');
    const inFlight = await this.store.countUnfinishedOccurrences(scheduleId);
    const schedule = await this.store.setEnabled(scheduleId, false, now);
    if (!schedule) throw new InvalidScheduleError(`schedule not found: ${scheduleId}`, 'scheduleId');
    logStructured({
      event: 'schedule.disabled',
      profileId: before.profile_id,
      scheduleId,
      reason: 'future_occurrences_only',
      inFlightOccurrences: inFlight,
      acceptedTasksCancelled: 0,
      note: 'disable != cancel: принятые occurrence продолжаются',
    });
    return schedule;
  }

  /** Включение: ближайшее будущее срабатывание считается от «сейчас». */
  async enable(scheduleId: string): Promise<ScheduleRow> {
    const now = this.clock.now();
    const before = await this.store.getSchedule(scheduleId);
    if (!before) throw new InvalidScheduleError(`schedule not found: ${scheduleId}`, 'scheduleId');
    const cron = parseCron(before.cron_expr);
    const missed = before.next_due_at !== null ? dueCronDates(cron, before.timezone, before.next_due_at, now).length : 0;
    const nextDueAt = nextCronDate(cron, before.timezone, now);
    await this.store.setNextDue(scheduleId, nextDueAt, now);
    const schedule = await this.store.setEnabled(scheduleId, true, now);
    if (!schedule) throw new InvalidScheduleError(`schedule not found: ${scheduleId}`, 'scheduleId');
    logStructured({
      event: 'schedule.enabled',
      profileId: before.profile_id,
      scheduleId,
      reason: 'future_occurrences_resumed',
      nextDueAt,
      skippedMissed: missed,
    });
    return schedule;
  }

  async get(scheduleId: string): Promise<ScheduleRow | null> {
    return this.store.getSchedule(scheduleId);
  }

  async list(profileId?: string): Promise<ScheduleRow[]> {
    return this.store.listSchedules(profileId);
  }

  async occurrences(scheduleId: string, limit = 100): Promise<OccurrenceRow[]> {
    return this.store.listOccurrences(scheduleId, limit);
  }

  // ------------------------------------------------------------------- tick

  /**
   * Один проход планировщика на момент `now` (по умолчанию — часы сервиса).
   * Идемпотентен: повтор на том же моменте не создаёт ни второго occurrence, ни
   * второй задачи (AC-140 «crash replay не создаёт второй occurrence»).
   *
   * profileId ограничивает проход профилем вызывающего (HTTP-слой): расписание
   * одного профиля не запускается по команде другого.
   */
  async tick(opts: { now?: number; profileId?: string; recoveryLimit?: number } = {}): Promise<TickReport> {
    const now = opts.now ?? this.clock.now();
    const report = emptyReport(now);
    logStructured({
      event: 'schedule.tick.started',
      reason: 'scan',
      now,
      profileId: opts.profileId ?? null,
    });

    // 1) Восстановление: occurrence, созданные, но не доставленные (краш/ошибка
    //    приёма). Ключи те же -> дедуп срабатывает на уровне БД.
    for (const occ of await this.store.unadmittedOccurrences(opts.recoveryLimit ?? 50, opts.profileId)) {
      const outcome = await this.deliver(occ, now, 'recovery');
      report[outcome.kind] += 1;
    }

    // 2) Новые срабатывания.
    const due = await this.store.dueSchedules(now, opts.profileId);
    report.dueSchedules = due.length;
    for (const schedule of due) {
      let cron;
      try {
        cron = parseCron(schedule.cron_expr);
      } catch (e) {
        const reason = `invalid_cron:${String((e as Error).message ?? e)}`;
        report.errors.push({ scheduleId: schedule.schedule_id, occurrenceId: null, reason });
        logStructured({
          event: 'schedule.tick.failed',
          level: 'error',
          profileId: schedule.profile_id,
          scheduleId: schedule.schedule_id,
          reason,
        });
        continue;
      }

      const dueAt = schedule.next_due_at ?? now;
      const window = dueCronDates(cron, schedule.timezone, dueAt, now);
      if (window.length === 0) continue;

      // Catch-up: окно просроченных срабатываний НЕ превращается в пачку задач.
      let selected = window;
      if (window.length > 1) {
        if (schedule.catch_up_policy === 'coalesce') {
          selected = [window[window.length - 1]!];
          report.misfires += window.length - 1;
          logStructured({
            event: 'schedule.misfire.coalesced',
            profileId: schedule.profile_id,
            scheduleId: schedule.schedule_id,
            reason: 'catch_up_coalesce',
            missed: window.length - 1,
            selectedFor: new Date(selected[0]!).toISOString(),
          });
        } else {
          selected = [];
          report.misfires += window.length;
          logStructured({
            event: 'schedule.misfire.skipped',
            profileId: schedule.profile_id,
            scheduleId: schedule.schedule_id,
            reason: 'catch_up_skip',
            missed: window.length,
          });
        }
      }

      for (const scheduledFor of selected) {
        await this.claim(schedule, scheduledFor, now, report);
      }

      // Курсор расписания двигаем до следующего срабатывания ПОСЛЕ окна — даже
      // если приём упал: попытка приёма у occurrence своя, ретрай ограничен.
      const nextAfterWindow = nextCronDate(cron, schedule.timezone, window[window.length - 1]!);
      await this.store.setNextDue(schedule.schedule_id, nextAfterWindow, now);
    }

    logStructured({
      event: 'schedule.tick.finished',
      reason: report.errors.length ? 'completed_with_errors' : 'completed',
      now,
      profileId: opts.profileId ?? null,
      dueSchedules: report.dueSchedules,
      admitted: report.admitted,
      recovered: report.recovered,
      deduplicated: report.deduplicated,
      skipped: report.skipped,
      failed: report.failed,
      misfires: report.misfires,
      errors: report.errors.length,
    });
    return report;
  }

  /**
   * Забрать occurrence для момента: durable-вставка с UNIQUE(schedule_id,
   * occurrence_key). Второй претендент на тот же момент получает тот же ключ и
   * ту же (несуществующую для него) задачу — то есть ничего.
   */
  private async claim(
    schedule: ScheduleRow,
    scheduledFor: number,
    now: number,
    report: TickReport,
  ): Promise<'admitted' | 'deduplicated' | 'skipped' | 'failed'> {
    const occurrenceKey = occurrenceKeyOf(scheduledFor);
    const occurrenceId = await deriveOccurrenceId(schedule.schedule_id, scheduledFor);
    const userTaskId = await deriveUserTaskId(schedule.profile_id, occurrenceId);

    const inserted = await this.store.insertOccurrence({
      occurrence_id: occurrenceId,
      schedule_id: schedule.schedule_id,
      profile_id: schedule.profile_id,
      occurrence_key: occurrenceKey,
      scheduled_for: scheduledFor,
      state: 'due',
      reason: 'claimed',
      user_task_id: userTaskId,
      run_id: null,
      gtd_id: null,
      attempts: 0,
      created_at: now,
      updated_at: now,
    });

    if (!inserted) {
      // Уже есть: replay после краша, вторая гонка или повтор tick на том же
      // моменте. Второго срабатывания не создаём.
      report.deduplicated += 1;
      const existing = await this.store.getOccurrence(schedule.schedule_id, occurrenceKey);
      logStructured({
        event: 'schedule.occurrence.deduplicated',
        profileId: schedule.profile_id,
        scheduleId: schedule.schedule_id,
        occurrenceId,
        occurrenceKey,
        userTaskId: existing?.user_task_id ?? userTaskId,
        state: existing?.state ?? null,
        reason: 'occurrence_key_exists',
      });
      return 'deduplicated';
    }

    // Overlap: предыдущая задача ещё не терминальна — новое срабатывание
    // пропускаем (backlog не растёт). Пропуск виден в логах и в occurrence.
    if (schedule.overlap_policy === 'skip' && (await this.store.hasUnfinishedOccurrence(schedule.schedule_id, occurrenceId))) {
      await this.store.markOccurrence(occurrenceId, { state: 'skipped', reason: 'overlap_policy_skip' }, now);
      report.skipped += 1;
      logStructured({
        event: 'schedule.occurrence.skipped',
        profileId: schedule.profile_id,
        scheduleId: schedule.schedule_id,
        occurrenceId,
        occurrenceKey,
        userTaskId,
        reason: 'overlap_policy_skip',
        overlapPolicy: 'skip',
      });
      return 'skipped';
    }

    const occ = await this.store.getOccurrenceById(occurrenceId);
    if (!occ) return 'failed';
    const outcome = await this.deliver(occ, now, 'scheduled');
    report[outcome.kind] += 1;
    return outcome.kind === 'recovered' ? 'admitted' : outcome.kind;
  }

  /**
   * Доставить occurrence: принять задачу (идемпотентно) и записать runId.
   * Ошибка приёма НЕ теряет occurrence — она остаётся в очереди восстановления,
   * но попытки ограничены (никакого бесконечного retry).
   */
  private async deliver(
    occ: OccurrenceRow,
    now: number,
    phase: 'scheduled' | 'recovery',
  ): Promise<{ kind: 'admitted' | 'failed' | 'recovered' | 'skipped' }> {
    const schedule = await this.store.getSchedule(occ.schedule_id);
    if (!schedule) {
      logStructured({
        event: 'schedule.occurrence.failed',
        level: 'error',
        profileId: occ.profile_id,
        scheduleId: occ.schedule_id,
        occurrenceId: occ.occurrence_id,
        occurrenceKey: occ.occurrence_key,
        reason: 'schedule_missing',
      });
      return { kind: 'failed' };
    }

    if (occ.attempts >= schedule.max_admit_attempts) {
      const updated = await this.store.markOccurrence(
        occ.occurrence_id,
        { state: 'failed', reason: 'admit_attempts_exhausted' },
        now,
      );
      logStructured({
        event: 'schedule.occurrence.failed',
        level: 'error',
        profileId: occ.profile_id,
        userTaskId: occ.user_task_id,
        scheduleId: occ.schedule_id,
        occurrenceId: occ.occurrence_id,
        occurrenceKey: occ.occurrence_key,
        attempts: occ.attempts,
        maxAdmitAttempts: schedule.max_admit_attempts,
        reason: 'admit_attempts_exhausted',
        state: updated?.state ?? 'failed',
      });
      return { kind: 'failed' };
    }

    const userTaskId = occ.user_task_id ?? (await deriveUserTaskId(occ.profile_id, occ.occurrence_id));
    try {
      const result = await this.submitter({
        occurrenceId: occ.occurrence_id,
        scheduleId: occ.schedule_id,
        occurrenceKey: occ.occurrence_key,
        userTaskId,
        requestId: occ.occurrence_id,
        receiptId: `rcpt-${occ.occurrence_id}`,
        profileId: occ.profile_id,
        goal: schedule.goal,
        projectId: schedule.project_id,
        conversationId: schedule.conversation_id,
        audienceId: schedule.audience_id,
        destinationId: schedule.destination_id,
        scheduledFor: occ.scheduled_for,
      });
      const updated = await this.store.markOccurrence(
        occ.occurrence_id,
        {
          state: 'admitted',
          reason: phase === 'recovery' ? 'recovered_after_crash' : 'submitted',
          userTaskId: result.taskId,
          runId: result.runId,
          bumpAttempts: true,
        },
        now,
      );
      logStructured({
        event: 'schedule.occurrence.admitted',
        profileId: occ.profile_id,
        userTaskId: result.taskId,
        runId: result.runId,
        scheduleId: occ.schedule_id,
        occurrenceId: occ.occurrence_id,
        occurrenceKey: occ.occurrence_key,
        scheduledFor: occ.scheduled_for,
        attempts: updated?.attempts ?? occ.attempts + 1,
        state: updated?.state ?? 'admitted',
        reason: phase === 'recovery' ? 'recovered_after_crash' : 'submitted',
        taskCreated: result.created,
        // AC-141/AC-149: контроль не регистрировался — gtdId отсутствует.
        gtdId: updated?.gtd_id ?? null,
        controlRegistration: 'not_requested',
      });
      return { kind: phase === 'recovery' ? 'recovered' : 'admitted' };
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      const failed = await this.store.markOccurrence(
        occ.occurrence_id,
        { state: 'failed', reason: `submit_failed:${message.slice(0, 160)}`, bumpAttempts: true },
        now,
      );
      logStructured({
        event: 'schedule.occurrence.failed',
        level: 'error',
        profileId: occ.profile_id,
        userTaskId,
        scheduleId: occ.schedule_id,
        occurrenceId: occ.occurrence_id,
        occurrenceKey: occ.occurrence_key,
        attempts: failed?.attempts ?? occ.attempts + 1,
        maxAdmitAttempts: schedule.max_admit_attempts,
        reason: 'submit_failed',
        error: message.slice(0, 200),
      });
      return { kind: 'failed' };
    }
  }
}
