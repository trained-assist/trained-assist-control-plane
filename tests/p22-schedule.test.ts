/**
 * Приёмка P22 — «Schedule без обязательного GTD» (#61, этап I07).
 *
 * Песочница: реальная D1 + реальный Workflow Port (miniflare), время —
 * ВИРТУАЛЬНЫЕ часы (без реального сна: hour/day waits не ждут часов).
 *
 * Сценарии:
 *  1. обычный hourly task → Output: terminal result БЕЗ gtdId, без ожидания
 *     человека и без control loop (AC-141);
 *  2. crash replay не создаёт второй occurrence: крэш после claim до submit +
 *     недвинутый курсор расписания → дедуп на уровне БД, задача одна (AC-140);
 *  3. disable расписания НЕ отменяет уже принятую задачу; после enable
 *     расписание считает ближайшее будущее срабатывание (AC-140);
 *  4. overlap_policy=skip не даёт backlog: перекрывающееся срабатывание
 *     пропущено с причиной, allow — пропускает;
 *  5. catch-up: coalesce = одно срабатывание на окно, skip = ничего; счётчик
 *     misfires; курсор после окна всегда уезжает вперёд;
 *  6. timezone/DST считаются в зоне расписания; несуществующее локальное время
 *     срабатыванием не считается;
 *  7. ошибки запусков видны в логах (profileId/scheduleId/occurrenceKey/причина),
 *     а попытки приёма ограничены (никакого бесконечного retry);
 *  8. успешный запуск логирует occurrence, ключи и gtdId=NULL (AC-149).
 */
import { describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../src/taskstore';
import { CfWorkflowPort, PLAN_VERSION } from '../src/workflow-port';
import {
  InvalidScheduleError,
  ScheduleService,
  ScheduleStore,
  VirtualClock,
  nextCronDate,
  occurrenceKeyOf,
  parseCron,
  portSubmitter,
  type OccurrenceSubmitter,
} from '../src/schedule';
import { env } from './env';

/** 2026-03-10T09:30:00Z = 12:30 Europe/Moscow (UTC+3). */
const T0 = Date.parse('2026-03-10T09:30:00Z');
const T10 = Date.parse('2026-03-10T10:00:00Z');
const HOUR = 3_600_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pollUntil = async <T>(label: string, fn: () => Promise<T | null | undefined>, timeoutMs = 30_000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(50);
  }
};

/** Песочница расписания: реальный порт и D1, время — виртуальные часы. */
const setup = (profileId: string, submitter?: OccurrenceSubmitter) => {
  const store = new TaskStore(env.DB);
  const port = new CfWorkflowPort(env.TASK_WORKFLOW, store);
  const schedules = new ScheduleStore(env.DB);
  const clock = new VirtualClock(T0);
  const real = portSubmitter(port);
  const service = new ScheduleService({ store: schedules, submitter: submitter ?? real, clock });
  /** tick на виртуальных часах: двигаем время и запускаем проход. */
  const tickAt = async (at: number) => {
    clock.set(at);
    return service.tick({ profileId });
  };
  return { store, port, schedules, clock, real, service, profileId, tickAt };
};

const tasksOfOccurrence = async (store: TaskStore, occurrenceId: string): Promise<string[]> => {
  const rows = await env.DB.prepare(`SELECT id FROM durable_tasks WHERE request_id = ?`)
    .bind(occurrenceId)
    .all<{ id: string }>();
  return rows.results.map((r) => r.id);
};

describe('P22 — расписание без обязательного GTD (AC-140/AC-141)', () => {
  it('1. обычный hourly task → Output: terminal result без gtdId, без ожидания человека (AC-141)', async () => {
    const { store, service, schedules, clock, profileId, tickAt } = setup('profile-p22-hourly');

    const created = await service.create(profileId, {
      requestId: 'sched-hourly-1',
      cron: '0 * * * *',
      timezone: 'Europe/Moscow',
      goal: 'hourly cold search',
    });
    expect(created.created).toBe(true);
    // 09:30Z = 12:30 МСК -> ближайшее срабатывание 13:00 МСК = 10:00Z.
    expect(created.schedule.next_due_at).toBe(T10);
    expect(created.schedule.enabled).toBe(1);

    const report = await tickAt(T10);
    expect(report.admitted).toBe(1);
    expect(report.failed).toBe(0);

    const occurrences = await service.occurrences(created.schedule.schedule_id);
    expect(occurrences).toHaveLength(1);
    const occurrence = occurrences[0]!;
    expect(occurrence.state).toBe('admitted');
    expect(occurrence.occurrence_key).toBe('2026-03-10T10:00:00Z');
    expect(occurrence.gtd_id).toBeNull();
    const taskId = occurrence.user_task_id!;
    expect(taskId).toBeTruthy();

    const done = await pollUntil('done', async () => {
      const row = await store.getTask(taskId);
      return row && row.status === 'done' ? row : null;
    });
    expect(done.stage).toBe('finished');

    // Терминальный результат: обычный результат Output, записи контроля нет.
    const result = JSON.parse(done.result_json!) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('auto');
    expect(result.version).toBe(PLAN_VERSION);
    expect(Object.keys(result)).not.toContain('gtdId');

    // Control loop не начинался: ни ожидания человека, ни сигналов GTD.
    expect(await store.listAwaiting(taskId)).toHaveLength(0);
    const kinds = (await store.history(taskId)).map((e) => e.kind);
    expect(kinds).not.toContain('awaiting_opened');
    expect(kinds).not.toContain('signal_received');
    expect(kinds).toContain('task_accepted');

    // Попытка завершена успехом; gtd_id у occurrence остался NULL.
    const runs = await store.listRuns(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('success');

    // Курсор расписания уехал на следующее срабатывание; часы не двигались сами.
    const after = await schedules.getSchedule(created.schedule.schedule_id);
    expect(after?.next_due_at).toBe(T10 + HOUR);
    expect((await service.occurrences(created.schedule.schedule_id)).every((o) => o.gtd_id === null)).toBe(true);
    expect(clock.now()).toBe(T10);
  });

  it('2. crash replay не создаёт второй occurrence (AC-140)', async () => {
    const { store, schedules, real, profileId } = setup('profile-p22-replay');
    let calls = 0;
    // Управляемый сбой: падаем ПОСЛЕ того, как occurrence уже записан в БД.
    const crashing: OccurrenceSubmitter = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error('injected crash: control plane умер между claim и submit');
      return real(input);
    };
    const flakyClock = new VirtualClock(T0);
    const flaky = new ScheduleService({ store: schedules, submitter: crashing, clock: flakyClock });
    const tickFlakyAt = async (at: number) => {
      flakyClock.set(at);
      return flaky.tick({ profileId });
    };

    const reader = new ScheduleService({ store: schedules, submitter: real, clock: new VirtualClock(T0) });
    const { schedule } = await reader.create(profileId, {
      requestId: 'sched-replay-1',
      cron: '0 * * * *',
      timezone: 'UTC',
      goal: 'replay-safe task',
    });

    const first = await tickFlakyAt(T10);
    expect(first.failed).toBe(1);
    const claimed = await reader.occurrences(schedule.schedule_id);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.state).toBe('failed');
    expect(await tasksOfOccurrence(store, claimed[0]!.occurrence_id)).toHaveLength(0);

    // Крэш случился ДО сдвига курсора: next_due_at остался на том же моменте.
    await schedules.setNextDue(schedule.schedule_id, T10, T0);

    const second = await tickFlakyAt(T10);
    // Восстановление доставило occurrence, повторный проход по моменту — дедуп.
    expect(second.recovered).toBe(1);
    expect(second.deduplicated).toBe(1);
    expect(second.admitted).toBe(0);

    const occurrences = await reader.occurrences(schedule.schedule_id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.state).toBe('admitted');
    expect(occurrences[0]!.attempts).toBe(2);
    const taskId = occurrences[0]!.user_task_id!;
    expect(await tasksOfOccurrence(store, occurrences[0]!.occurrence_id)).toEqual([taskId]);
    expect(await store.listRuns(taskId)).toHaveLength(1);

    // Третий проход на том же моменте — тоже без второго срабатывания.
    const third = await tickFlakyAt(T10);
    expect(third.admitted + third.deduplicated + third.recovered + third.failed).toBe(0);
    expect(await reader.occurrences(schedule.schedule_id)).toHaveLength(1);

    await pollUntil('done', async () => {
      const row = await store.getTask(taskId);
      return row && row.status === 'done' ? row : null;
    });
  });

  it('3. disable расписания не отменяет уже принятую задачу (AC-140)', async () => {
    const { store, service, profileId, tickAt } = setup('profile-p22-disable');
    const { schedule } = await service.create(profileId, {
      requestId: 'sched-disable-1',
      cron: '0 * * * *',
      timezone: 'UTC',
      goal: 'hourly report',
    });

    await tickAt(T10);
    const [occurrence] = await service.occurrences(schedule.schedule_id);
    const taskId = occurrence!.user_task_id!;

    // Выключаем, не дожидаясь результата: disable — это про будущие срабатывания.
    const disabled = await service.disable(schedule.schedule_id);
    expect(disabled.enabled).toBe(0);

    const done = await pollUntil('done', async () => {
      const row = await store.getTask(taskId);
      return row && row.status === 'done' ? row : null;
    });
    expect(done.status).toBe('done');

    const kinds = (await store.history(taskId)).map((e) => e.kind);
    expect(kinds).not.toContain('cancel_requested');
    expect(kinds).not.toContain('task_cancelled');

    // Будущий час не создаёт occurrence: расписание выключено.
    const nextHour = await tickAt(T10 + HOUR);
    expect(nextHour.admitted).toBe(0);
    expect(nextHour.dueSchedules).toBe(0);
    expect(await service.occurrences(schedule.schedule_id)).toHaveLength(1);

    // enable считает БЛИЖАЙШЕЕ БУДУЩЕЕ срабатывание, а не отыгрывает окно.
    const enabled = await service.enable(schedule.schedule_id);
    expect(enabled.enabled).toBe(1);
    expect(enabled.next_due_at).toBe(T10 + 2 * HOUR);

    await tickAt(T10 + 2 * HOUR);
    const occurrences = await service.occurrences(schedule.schedule_id);
    expect(occurrences).toHaveLength(2);
    expect(occurrences[1]!.occurrence_key).toBe(occurrenceKeyOf(T10 + 2 * HOUR));
    expect(occurrences[1]!.user_task_id).not.toBe(taskId);
  });

  it('4. overlap_policy=skip не даёт расти backlog, allow — перекрывает', async () => {
    const { store, port, schedules, profileId } = setup('profile-p22-overlap');
    // Песочница перекрытия: задача принята, но исполнитель НЕ запускается, поэтому
    // предыдущая occurrence остаётся нетерминальной (как долгий hourly task).
    const admitOnly: OccurrenceSubmitter = async (input) => {
      const res = await port.submit({
        id: input.userTaskId,
        profileId: input.profileId,
        goal: input.goal,
        requestId: input.requestId,
        receiptId: input.receiptId,
        source: 'cron',
      });
      return { taskId: res.taskId, runId: res.runId, created: res.created };
    };
    const clock = new VirtualClock(T0);
    const service = new ScheduleService({ store: schedules, submitter: admitOnly, clock });

    const skip = await service.create(profileId, {
      requestId: 'sched-overlap-skip',
      cron: '0 * * * *',
      timezone: 'UTC',
      goal: 'long task (skip)',
      overlapPolicy: 'skip',
    });
    const allow = await service.create(profileId, {
      requestId: 'sched-overlap-allow',
      cron: '0 * * * *',
      timezone: 'UTC',
      goal: 'long task (allow)',
      overlapPolicy: 'allow',
    });

    clock.set(T10);
    await service.tick({ profileId });
    clock.set(T10 + HOUR);
    const report = await service.tick({ profileId });

    const skipOccurrences = await service.occurrences(skip.schedule.schedule_id);
    expect(skipOccurrences.map((o) => o.state)).toEqual(['admitted', 'skipped']);
    expect(skipOccurrences[1]!.reason).toBe('overlap_policy_skip');
    expect((await service.occurrences(allow.schedule.schedule_id)).map((o) => o.state)).toEqual(['admitted', 'admitted']);
    expect(report.admitted).toBe(1);
    expect(report.skipped).toBe(1);

    // Пропущенное срабатывание не создаёт задачу.
    expect(await tasksOfOccurrence(store, skipOccurrences[1]!.occurrence_id)).toHaveLength(0);

    // Как только первая задача терминальна, следующее срабатывание проходит.
    await store.commit(skipOccurrences[0]!.user_task_id!, 1, {
      status: 'done',
      stage: 'finished',
      kind: 'step_done',
      step: 'finalize',
      result: { ok: true, mode: 'auto', version: PLAN_VERSION },
    });
    clock.set(T10 + 2 * HOUR);
    await service.tick({ profileId });
    expect((await service.occurrences(skip.schedule.schedule_id)).map((o) => o.state)).toEqual([
      'admitted',
      'skipped',
      'admitted',
    ]);
  });

  it('5. catch-up: coalesce = одно срабатывание на окно, skip = ничего + misfires', async () => {
    const { service } = setup('profile-p22-catchup-coalesce');
    const skipAll = setup('profile-p22-catchup-skip');

    const coalesce = await service.create('profile-p22-catchup-coalesce', {
      requestId: 'sched-catchup-coalesce',
      cron: '0 * * * *',
      timezone: 'UTC',
      goal: 'hourly digest',
      catchUpPolicy: 'coalesce',
      // Перекрытие здесь не проверяется (тест 4), а мешало бы: задача 14:00
      // ещё выполняется, и следующее срабатывание ушло бы в overlap-skip.
      overlapPolicy: 'allow',
    });
    await skipAll.service.create('profile-p22-catchup-skip', {
      requestId: 'sched-catchup-skip',
      cron: '0 * * * *',
      timezone: 'UTC',
      goal: 'hourly digest (skip)',
      catchUpPolicy: 'skip',
    });

    // Tick пропустил 4 часа: окно 10:00..14:00 UTC.
    const report = await service.tick({ now: Date.parse('2026-03-10T14:05:00Z'), profileId: 'profile-p22-catchup-coalesce' });
    expect(report.admitted).toBe(1);
    expect(report.misfires).toBe(4);

    const coalesced = await service.occurrences(coalesce.schedule.schedule_id);
    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]!.occurrence_key).toBe('2026-03-10T14:00:00Z');
    expect(coalesced[0]!.gtd_id).toBeNull();

    // Тот же момент для skip: ничего не выполняется, но окно учтено.
    const skipped = await skipAll.service.tick({ now: Date.parse('2026-03-10T14:05:00Z'), profileId: 'profile-p22-catchup-skip' });
    expect(skipped.admitted).toBe(0);
    expect(skipped.misfires).toBe(5);
    expect(await skipAll.service.occurrences((await skipAll.service.list('profile-p22-catchup-skip'))[0]!.schedule_id)).toHaveLength(0);

    // Курсор после окна — вперёд, поэтому следующий tick не отыгрывает пачку.
    expect((await service.get(coalesce.schedule.schedule_id))?.next_due_at).toBe(Date.parse('2026-03-10T15:00:00Z'));
    const next = await service.tick({ now: Date.parse('2026-03-10T15:05:00Z'), profileId: 'profile-p22-catchup-coalesce' });
    expect(next.misfires).toBe(0);
    expect(next.admitted).toBe(1);
    expect(await service.occurrences(coalesce.schedule.schedule_id)).toHaveLength(2);
  });

  it('6. cron считается в зоне расписания, несуществующее локальное время пропускается', () => {
    const utc = (ms: number) => new Date(ms).toISOString();
    // 09:00 Europe/Moscow (UTC+3) = 06:00Z; 09:00 Asia/Kolkata (UTC+5:30) = 03:30Z.
    // Один и тот же cron в разных зонах — разные моменты.
    expect(utc(nextCronDate(parseCron('0 9 * * *'), 'Europe/Moscow', T0)!)).toBe('2026-03-11T06:00:00.000Z');
    expect(utc(nextCronDate(parseCron('0 9 * * *'), 'Asia/Kolkata', T0)!)).toBe('2026-03-11T03:30:00.000Z');
    // Получасовая зона двигает и «с полчаса»: 09:30 МСК = 06:30Z, 09:30 Kolkata = 04:00Z.
    expect(utc(nextCronDate(parseCron('30 9 * * *'), 'Europe/Moscow', T0)!)).toBe('2026-03-11T06:30:00.000Z');
    expect(utc(nextCronDate(parseCron('30 9 * * *'), 'Asia/Kolkata', T0)!)).toBe('2026-03-11T04:00:00.000Z');
    // «Каждый час» в целых зонах совпадает с границей часа UTC: 12:30 МСК -> 13:00 МСК.
    expect(nextCronDate(parseCron('0 * * * *'), 'Europe/Moscow', T0)).toBe(T10);

    // Переход на летнее время (America/New_York): 2026-03-08 02:30 не существует,
    // поэтому 02:30 берётся на следующий день (02:30 EDT = 06:30Z).
    expect(utc(nextCronDate(parseCron('30 2 * * *'), 'America/New_York', Date.parse('2026-03-08T00:00:00Z'))!)).toBe(
      '2026-03-09T06:30:00.000Z',
    );
    // Обратный переход (2026-11-01): 01:30 встречается дважды, берётся первый.
    expect(utc(nextCronDate(parseCron('30 1 * * *'), 'America/New_York', Date.parse('2026-10-31T12:00:00Z'))!)).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    // Каждые 15 минут и поле дня недели.
    expect(utc(nextCronDate(parseCron('*/15 * * * *'), 'UTC', Date.parse('2026-03-10T09:30:05Z'))!)).toBe(
      '2026-03-10T09:45:00.000Z',
    );
    expect(utc(nextCronDate(parseCron('0 8 * * 1'), 'UTC', T0)!)).toBe('2026-03-16T08:00:00.000Z');

    // Мусор отвергается, а не трактуется молча.
    expect(() => parseCron('0 * *')).toThrow(InvalidScheduleError);
    expect(() => parseCron('99 * * * *')).toThrow(InvalidScheduleError);
    expect(() => parseCron('0 0 * * 9')).toThrow(InvalidScheduleError);
    expect(() => nextCronDate(parseCron('0 9 * * *'), 'Mars/Olympus', T0)).toThrow(InvalidScheduleError);
  });

  it('7. ошибка запуска видна в логах, попытки приёма ограничены', async () => {
    let calls = 0;
    const failing: OccurrenceSubmitter = async () => {
      calls += 1;
      throw new Error('injected: runner недоступен');
    };
    const { service, profileId, tickAt } = setup('profile-p22-logs', failing);

    const { schedule } = await service.create(profileId, {
      requestId: 'sched-logs-1',
      cron: '0 * * * *',
      timezone: 'UTC',
      goal: 'hourly check',
      maxAdmitAttempts: 2,
    });

    const lines: Record<string, unknown>[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      try {
        lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
      } catch {
        /* неструктурная строка — не наш лог */
      }
    });
    try {
      expect((await tickAt(T10)).failed).toBe(1);
    } finally {
      spy.mockRestore();
    }

    const failure = lines.find((l) => l.event === 'schedule.occurrence.failed');
    expect(failure).toBeDefined();
    expect(failure!.level).toBe('error');
    expect(failure!.profileId).toBe(profileId);
    expect(failure!.scheduleId).toBe(schedule.schedule_id);
    expect(failure!.occurrenceKey).toBe('2026-03-10T10:00:00Z');
    expect(failure!.reason).toBe('submit_failed');
    expect(String(failure!.error)).toContain('runner недоступен');
    expect(failure!.attempts).toBe(1);
    expect(failure!.maxAdmitAttempts).toBe(2);

    // Вторая попытка разрешена, третья — уже за лимитом: дальше приёма нет.
    expect((await tickAt(T10 + 5 * 60_000)).failed).toBe(1);
    expect(calls).toBe(2);
    expect((await tickAt(T10 + 10 * 60_000)).failed).toBe(1);
    const occ = (await service.occurrences(schedule.schedule_id))[0]!;
    expect(occ.state).toBe('failed');
    expect(occ.reason).toBe('admit_attempts_exhausted');
    expect(occ.attempts).toBe(2);

    // Никакого бесконечного retry: лимит исчерпан, новых попыток приёма нет.
    expect((await tickAt(T10 + 15 * 60_000)).failed).toBe(1);
    expect(calls).toBe(2);
  });

  it('8. успешный запуск логирует occurrence, ключи и gtdId=NULL (AC-149)', async () => {
    const { service, profileId, tickAt } = setup('profile-p22-logs-ok');
    const { schedule } = await service.create(profileId, {
      requestId: 'sched-logs-ok-1',
      cron: '0 * * * *',
      timezone: 'UTC',
      goal: 'hourly check',
    });

    const lines: Record<string, unknown>[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      try {
        lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
      } catch {
        /* не наш лог */
      }
    });
    try {
      await tickAt(T10);
    } finally {
      spy.mockRestore();
    }

    const admitted = lines.find((l) => l.event === 'schedule.occurrence.admitted');
    expect(admitted).toBeDefined();
    expect(admitted!.profileId).toBe(profileId);
    expect(admitted!.scheduleId).toBe(schedule.schedule_id);
    expect(admitted!.occurrenceId).toBeTruthy();
    expect(admitted!.occurrenceKey).toBe('2026-03-10T10:00:00Z');
    expect(admitted!.userTaskId).toBeTruthy();
    expect(admitted!.runId).toBeTruthy();
    // GTD только opt-in: в логе явный NULL, а не «возможно, где-то есть».
    expect(admitted!.gtdId).toBeNull();
    expect(admitted!.controlRegistration).toBe('not_requested');

    // В логах только ключи: ни текста задачи пользователя, ни секретов.
    const text = lines.map((l) => JSON.stringify(l)).join('\n');
    expect(text).not.toContain('RUNNER_API_KEY');
    expect(text).not.toContain('Bearer ');
    expect(text).not.toContain('hourly check');
  });
});
