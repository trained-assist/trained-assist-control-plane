/**
 * Приёмка P23 — «GTD opt-in и bounded control» (#62, этап I07, AC-142).
 *
 * Песочница: реальная D1 + реальный Workflow Port (miniflare), время —
 * ВИРТУАЛЬНЫЕ часы (hour/day waits без реального сна), внешний гейт/CI —
 * synthetic provider (SANDBOX · I07). Никакого LLM: решения GTD
 * детерминированы по структурированному исходу шага.
 *
 * Сценарии:
 *  1. GTD только opt-in: обычная задача и occurrence расписания остаются без
 *     записи контроля; ровно одна явная managed task получает gtdId, и он
 *     детерминирован (AC-142 «одна задача получает G; остальные нет»);
 *  2. регистрация отклоняется (нет причины/критериев/дедлайна), самоконтроль
 *     (GTD, контролирующий GTD) не создаётся;
 *  3. CI/критерии: unmet criteria → ровно ОДНО продолжение (один owner),
 *     повторный ACK второго не даёт; met criteria → complete, задача done;
 *  4. wait по внешнему условию: без живой попытки, тики ничего не создают
 *     (wait не держит токены), условие «упало» → один следующий шаг;
 *  5. wait по вводу человека: durable awaiting + парковка попытки, ответ →
 *     ровно одно продолжение с новым runId и тем же userTaskId;
 *  6. caps завершают прогрессию: attempt cap и deadline → stopped/blocked,
 *     новая попытка и новая запись контроля не обходят лимит;
 *  7. неизвестный gtdId у managed outcome — карантин и явный статус, а не тихий
 *     output-owned recovery (§5a);
 *  8. логи: gtdId/opt-in, registration reason, wait/deadline/ACK, ключи
 *     событий и причины перехода; без секретов и текста задачи.
 */
import { describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../src/taskstore';
import { CfWorkflowPort } from '../src/workflow-port';
import { deriveUserTaskId } from '../src/intake/intake-service';
import { ScheduleService, ScheduleStore, VirtualClock, portSubmitter } from '../src/schedule';
import {
  GtdAlreadyRegisteredError,
  GtdSelfSupervisionError,
  GtdService,
  GtdStore,
  GtdUnknownRecordError,
  portResumeIssuer,
  stepIdForAttempt,
  type GtdStepOutcome,
  type ManagedGtdContext,
} from '../src/gtd';
import { env } from './env';

const T0 = Date.parse('2026-05-04T09:00:00Z');
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

/** Сценарий следующих шагов: synthetic provider (SANDBOX · I07). */
interface ScriptedStep {
  outcome: GtdStepOutcome;
  criteria?: Record<string, unknown> | null;
  conditionRef?: string | null;
}

const setup = (profileId: string) => {
  const store = new TaskStore(env.DB);
  const port = new CfWorkflowPort(env.TASK_WORKFLOW, store);
  const gtdStore = new GtdStore(env.DB);
  const clock = new VirtualClock(T0);
  const real = portResumeIssuer(port);
  const script: ScriptedStep[] = [];
  let issued = 0;
  // Синтетический провайдер: сценарий шагов задаёт тест, а не модель.
  const issuer = (req: Parameters<typeof real>[0]) => {
    const next = script[issued] ?? { outcome: 'succeeded' as GtdStepOutcome };
    issued += 1;
    return real({ ...req, stepOutcome: next.outcome, criteria: next.criteria ?? null });
  };
  const gtd = new GtdService({ store: gtdStore, tasks: store, port, clock, issuer });
  return { store, port, gtd, gtdStore, clock, profileId, script, issued: () => issued };
};

const admit = async (store: TaskStore, profileId: string, requestId: string, goal: string) => {
  const id = await deriveUserTaskId(profileId, requestId);
  const { task } = await store.admitTask({
    id,
    profileId,
    goal,
    requestId,
    receiptId: `rcpt-${requestId}`,
    source: 'input',
  });
  return task;
};

/** Запуск managed-шага: тот же порт, что у обычной задачи, но с gtd-контекстом. */
const startManaged = async (
  ctx: ReturnType<typeof setup>,
  taskId: string,
  gtdId: string,
  opts: { stepOutcome?: GtdStepOutcome; attempt?: number; criteria?: Record<string, unknown> | null; conditionRef?: string | null } = {},
) => {
  const gtdContext: ManagedGtdContext = {
    gtdId,
    stepId: stepIdForAttempt(opts.attempt ?? 1),
    attempt: opts.attempt ?? 1,
    stepOutcome: opts.stepOutcome ?? 'succeeded',
  };
  return ctx.port.submit({
    id: taskId,
    profileId: ctx.profileId,
    goal: 'managed work',
    requestId: `req-${taskId}-${opts.attempt ?? 1}`,
    receiptId: `rcpt-${taskId}-${opts.attempt ?? 1}`,
    source: 'input',
    gtd: gtdContext,
    criteria: opts.criteria ?? null,
    conditionRef: opts.conditionRef ?? null,
  });
};

/** Попытка завершилась и исход лежит в inbox — можно принимать решение GTD. */
const settle = async (ctx: ReturnType<typeof setup>, gtdId: string, taskId: string) => {
  return pollUntil('inbox pending + no active run', async () => {
    const pending = await ctx.gtdStore.pendingOutcomes(gtdId);
    const active = await ctx.store.activeRun(taskId);
    return !active && pending.length > 0 ? pending : null;
  });
};

const recordCount = async (profileId?: string): Promise<number> => {
  const row = profileId
    ? await env.DB.prepare(`SELECT COUNT(*) AS n FROM gtd_records WHERE profile_id = ?`).bind(profileId).first<{ n: number }>()
    : await env.DB.prepare(`SELECT COUNT(*) AS n FROM gtd_records`).first<{ n: number }>();
  return Number(row?.n ?? 0);
};

describe('P23 — GTD opt-in и bounded control (AC-142)', () => {
  it('1. GTD только opt-in: одна явная managed task получает G, остальные — нет', async () => {
    const ctx = setup('profile-p23-optin');

    // 1.1 Обычная задача без регистрации: контроля нет вообще.
    const before = await recordCount();
    const plain = await admit(ctx.store, ctx.profileId, 'req-p23-plain', 'разовый вопрос без контроля');
    await ctx.port.submit({
      id: plain.id,
      profileId: ctx.profileId,
      goal: plain.goal,
      requestId: plain.request_id!,
      receiptId: 'rcpt-plain',
      source: 'input',
      autoRun: true,
    });
    const plainDone = await pollUntil('plain done', async () => {
      const row = await ctx.store.getTask(plain.id);
      return row && row.status === 'done' ? row : null;
    });
    const plainResult = JSON.parse(plainDone.result_json!) as Record<string, unknown>;
    expect(plainResult).not.toHaveProperty('gtdId');
    expect(plainResult.continuationOwner).toBe('output');
    expect(await recordCount()).toBe(before);

    // 1.2 Occurrence расписания (P22) контроля тоже не создаёт — AC-141 не меняется.
    const schedules = new ScheduleStore(env.DB);
    const scheduleService = new ScheduleService({
      store: schedules,
      submitter: portSubmitter(ctx.port),
      clock: ctx.clock,
    });
    const { schedule } = await scheduleService.create(ctx.profileId, {
      requestId: 'req-p23-schedule',
      cron: '0 * * * *',
      timezone: 'UTC',
      goal: 'hourly cold search',
    });
    await scheduleService.tick({ now: Date.parse('2026-05-04T10:00:00Z'), profileId: ctx.profileId });
    const occurrences = await scheduleService.occurrences(schedule.schedule_id);
    expect(occurrences[0]!.gtd_id).toBeNull();
    expect(await recordCount()).toBe(before);

    // 1.3 Ровно одна явная регистрация -> одна запись контроля, детерминированный gtdId.
    const managedTask = await admit(ctx.store, ctx.profileId, 'req-p23-managed', 'доведи до конца и проверь CI');
    const registration = {
      requestId: 'reg-p23-1',
      profileId: ctx.profileId,
      userTaskId: managedTask.id,
      reason: 'дождаться CI и проверить интеграцию',
      criteria: [{ id: 'ci-gate', description: 'зелёный required check', required: true }],
      deadlineAt: T0 + 4 * HOUR,
      maxAttempts: 3,
    };
    const first = await ctx.gtd.register(registration);
    expect(first.created).toBe(true);
    expect(first.record.gtd_id).toMatch(/^gtd-[0-9a-f]{20}$/);
    expect(first.record.continuation_owner).toBe('gtd');
    expect(first.record.state).toBe('active');
    expect(await recordCount()).toBe(before + 1);

    // Повтор той же регистрации — тот же gtdId и никакой второй записи.
    const again = await ctx.gtd.register(registration);
    expect(again.created).toBe(false);
    expect(again.record.gtd_id).toBe(first.record.gtd_id);
    expect(await recordCount()).toBe(before + 1);

    // Host-проверка перед запуском: чужой gtdId задаче не подходит.
    await expect(ctx.gtd.requireManagedTask(first.record.gtd_id, plain.id)).rejects.toThrow(/does not belong/);

    // Задача, на которой gtdId есть, запускается только как managed.
    await startManaged(ctx, managedTask.id, first.record.gtd_id, { criteria: { 'ci-gate': true } });
    const view = await pollUntil('managed outcome', async () => {
      const v = await ctx.gtd.get(first.record.gtd_id);
      return v && v.outcomes.length > 0 ? v : null;
    });
    const task = await ctx.store.getTask(managedTask.id);
    const result = JSON.parse(task!.result_json!) as Record<string, unknown>;
    expect(result.gtdId).toBe(first.record.gtd_id);
    expect(result.continuationOwner).toBe('gtd');
    expect(view.record.gtd_id).toBe(first.record.gtd_id);
    // Ни у occurrence, ни у обычной задачи записи контроля нет.
    expect((await ctx.gtd.list(ctx.profileId)).map((r) => r.user_task_id)).toEqual([managedTask.id]);
  });

  it('2. регистрация отклоняется; самоконтроль (GTD над GTD) не создаётся', async () => {
    const ctx = setup('profile-p23-register');
    const task = await admit(ctx.store, ctx.profileId, 'req-p23-guard', 'работа под контролем');
    const base = {
      requestId: 'reg-p23-guard',
      profileId: ctx.profileId,
      userTaskId: task.id,
      reason: 'довести до конца',
      criteria: [{ id: 'release-check', description: 'релиз проверен', required: true }],
      deadlineAt: T0 + HOUR,
    };

    // Нет причины / критериев / живого дедлайна — регистрация не проходит.
    await expect(ctx.gtd.register({ ...base, reason: '   ' })).rejects.toThrow(/registration_reason_required/);
    await expect(ctx.gtd.register({ ...base, criteria: [] })).rejects.toThrow(/completion_criteria_required/);
    await expect(ctx.gtd.register({ ...base, deadlineAt: T0 - 1 })).rejects.toThrow(/deadline_in_past/);
    await expect(ctx.gtd.register({ ...base, maxAttempts: 99 })).rejects.toThrow(/max_attempts_out_of_range/);
    expect(await recordCount(ctx.profileId)).toBe(0);

    // Самоконтроль: запись не может контролировать себя или другую запись.
    const record = (await ctx.gtd.register(base)).record;
    await expect(ctx.gtd.register({ ...base, supervisedByGtdId: record.gtd_id })).rejects.toThrow(GtdSelfSupervisionError);
    expect((await ctx.store.getTask(task.id))!.status).not.toBe('done');
    const rows = await ctx.gtdStore.listRecords(ctx.profileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.supervised_by_gtd_id).toBeNull();

    // Схема запрещает самоконтроль и на уровне БД (CHECK), даже в обход сервиса.
    await expect(
      env.DB.prepare(
        `UPDATE gtd_records SET supervised_by_gtd_id = ? WHERE gtd_id = ?`,
      )
        .bind(record.gtd_id, record.gtd_id)
        .run(),
    ).rejects.toThrow();

    // Вторая регистрация с ДРУГИМИ условиями — отказ: запись на задачу одна.
    await expect(ctx.gtd.register({ ...base, reason: 'другая причина' })).rejects.toThrow(GtdAlreadyRegisteredError);
    expect(await recordCount(ctx.profileId)).toBe(1);
  });

  it('3. критерии/CI: unmet -> ровно одно продолжение; met -> complete (один owner continuation)', async () => {
    const ctx = setup('profile-p23-criteria');
    const task = await admit(ctx.store, ctx.profileId, 'req-p23-criteria', 'ждём CI и проверяем интеграцию');
    const { record } = await ctx.gtd.register({
      requestId: 'reg-p23-criteria',
      profileId: ctx.profileId,
      userTaskId: task.id,
      reason: 'дождаться CI и проверить release',
      criteria: [{ id: 'ci-gate', description: 'required check зелёный', required: true }],
      deadlineAt: T0 + 4 * HOUR,
      maxAttempts: 3,
    });

    // Шаг 1: работа выполнена, но критерий ещё не подтверждён.
    await startManaged(ctx, task.id, record.gtd_id, { criteria: { 'ci-gate': false } });
    await settle(ctx, record.gtd_id, task.id);
    expect((await ctx.store.listRuns(task.id)).length).toBe(1);

    // Durable ACK GTD: одно решение -> одно продолжение (тот же userTaskId, новый runId).
    ctx.script.push({ outcome: 'succeeded', criteria: { 'ci-gate': true } });
    const ack1 = await ctx.gtd.ack(record.gtd_id);
    expect(ack1.processed).toHaveLength(1);
    expect(ack1.processed[0]!.decision).toBe('continue');
    expect(ack1.processed[0]!.reason).toBe('criteria_not_met');
    expect(ack1.processed[0]!.continuationRunId).toBeTruthy();
    expect(ack1.processed[0]!.attempt).toBe(1);

    const afterContinue = (await ctx.gtd.get(record.gtd_id))!;
    expect(afterContinue.record.attempts).toBe(1);
    expect(afterContinue.record.current_step_id).toBe('step-2');
    expect(afterContinue.record.state).toBe('active');
    expect(afterContinue.outcomes[0]!.state).toBe('acked');
    expect(afterContinue.outcomes[0]!.acked_at).toBeTruthy();

    // Повторный ACK по уже подтверждённому исходу: второго продолжения нет.
    const ackAgain = await ctx.gtd.ack(record.gtd_id);
    expect(ackAgain.processed).toHaveLength(0);
    expect(ackAgain.deferred).toBe(0);

    // Шаг 2 отработал (критерий подтверждён) -> ACK -> complete, задача закрыта GTD.
    await settle(ctx, record.gtd_id, task.id);
    const runs = await ctx.store.listRuns(task.id);
    expect(runs.length).toBe(2);
    expect(runs[0]!.id).not.toBe(runs[1]!.id);
    const ack2 = await ctx.gtd.ack(record.gtd_id);
    expect(ack2.processed[0]!.decision).toBe('complete');
    expect(ack2.processed[0]!.reason).toBe('criteria_met');
    expect(ack2.processed[0]!.continuationRunId).toBeNull();

    const done = await ctx.store.getTask(task.id);
    expect(done!.status).toBe('done');
    const doneResult = JSON.parse(done!.result_json!) as Record<string, unknown>;
    expect(doneResult.gtdId).toBe(record.gtd_id);
    expect(doneResult.completedBy).toBe('gtd');
    expect(doneResult.criteria).toEqual(['ci-gate']);
    const closed = (await ctx.gtd.get(record.gtd_id))!.record;
    expect(closed.state).toBe('completed');

    // Прогрессия: ровно два решения, ровно одно продолжение.
    const progressions = (await ctx.gtd.get(record.gtd_id))!.progressions;
    expect(progressions.map((p) => p.decision)).toEqual(['continue', 'complete']);
    expect(progressions.filter((p) => p.continuation_run_id !== null)).toHaveLength(1);

    // Поздний исход закрытой записи отклоняется и работу не возрождает.
    await ctx.gtd.reportOutcome({
      gtdId: record.gtd_id,
      userTaskId: task.id,
      stepId: 'step-3',
      outcome: 'failed',
      idempotencyKey: 'late-outcome',
    });
    const late = await ctx.gtd.ack(record.gtd_id);
    expect(late.processed[0]!.decision).toBe('reject');
    expect((await ctx.store.getTask(task.id))!.status).toBe('done');
    expect((await ctx.store.listRuns(task.id)).length).toBe(2);
  });

  it('4. wait по внешнему условию не держит токены: тики ничего не создают, условие -> один шаг', async () => {
    const ctx = setup('profile-p23-condition');
    const task = await admit(ctx.store, ctx.profileId, 'req-p23-condition', 'ждём зелёный CI');
    const { record } = await ctx.gtd.register({
      requestId: 'reg-p23-condition',
      profileId: ctx.profileId,
      userTaskId: task.id,
      reason: 'дождаться CI и проверить релиз',
      criteria: [{ id: 'ci-gate', description: 'required check зелёный', required: true }],
      deadlineAt: T0 + 4 * HOUR,
      maxAttempts: 3,
    });

    await startManaged(ctx, task.id, record.gtd_id, {
      stepOutcome: 'awaiting_condition',
      conditionRef: 'ci-run-4242',
    });
    await settle(ctx, record.gtd_id, task.id);

    const ack = await ctx.gtd.ack(record.gtd_id);
    expect(ack.processed[0]!.decision).toBe('wait');
    expect(ack.processed[0]!.reason).toBe('awaiting_external_condition');
    expect(ack.processed[0]!.continuationRunId).toBeNull();

    const waiting = (await ctx.gtd.get(record.gtd_id))!.record;
    expect(waiting.state).toBe('waiting_condition');
    expect(waiting.next_trigger_kind).toBe('condition');
    expect(waiting.next_trigger_ref).toBe('ci-run-4242');

    // Wait не держит живой процесс и не расходует токены: тики ничего не создают.
    const runsAfterWait = (await ctx.store.listRuns(task.id)).length;
    expect(runsAfterWait).toBe(1);
    const engine = (await ctx.port.status(task.id)).engine as { status: string };
    expect(['complete', 'terminated']).toContain(engine.status);
    for (let i = 0; i < 3; i += 1) {
      ctx.clock.set(T0 + (i + 1) * 60_000);
      const tick = await ctx.gtd.tick({ profileId: ctx.profileId });
      expect(tick.continued + tick.completed + tick.stopped).toBe(0);
      expect(tick.waiting).toBe(1);
    }
    expect((await ctx.store.listRuns(task.id)).length).toBe(runsAfterWait);

    // Synthetic CI закрывает условие провалом -> контроль выдаёт ровно один шаг.
    await ctx.gtd.reportCondition('ci-run-4242', {
      gtdId: record.gtd_id,
      conclusion: 'failure',
      reportRef: 'gh-actions:run/4242',
    });
    ctx.clock.set(T0 + 10 * 60_000);
    ctx.script.push({ outcome: 'succeeded', criteria: { 'ci-gate': true } });
    const tick = await ctx.gtd.tick({ profileId: ctx.profileId });
    expect(tick.continued).toBe(1);
    const resumed = (await ctx.gtd.get(record.gtd_id))!.record;
    expect(resumed.state).toBe('active');
    // attempts = число решений по исходам шагов; решение по событию его не двигает.
    expect(resumed.attempts).toBe(1);
    const progressions = (await ctx.gtd.get(record.gtd_id))!.progressions;
    expect(progressions.map((p) => [p.step_id, p.attempt, p.decision])).toEqual([
      ['step-1', 1, 'wait'],
      ['step-2', 1, 'continue'],
    ]);

    await settle(ctx, record.gtd_id, task.id);
    expect((await ctx.store.listRuns(task.id)).length).toBe(2);
    const final = await ctx.gtd.ack(record.gtd_id);
    expect(final.processed[0]!.decision).toBe('complete');
    expect((await ctx.store.getTask(task.id))!.status).toBe('done');
  });

  it('5. wait по вводу человека: durable awaiting + ответ -> ровно одно продолжение', async () => {
    const ctx = setup('profile-p23-input');
    const task = await admit(ctx.store, ctx.profileId, 'req-p23-input', 'нужен выбор пользователя для контроля');
    const { record } = await ctx.gtd.register({
      requestId: 'reg-p23-input',
      profileId: ctx.profileId,
      userTaskId: task.id,
      reason: 'довести до конца, нужен выбор пользователя',
      criteria: [{ id: 'choice-made', description: 'пользователь выбрал вариант', required: true }],
      deadlineAt: T0 + 4 * HOUR,
      maxAttempts: 3,
    });

    await startManaged(ctx, task.id, record.gtd_id, { stepOutcome: 'awaiting_user' });
    await settle(ctx, record.gtd_id, task.id);

    // Durable ожидание — истина в Task Store; попытка паркована, процесс не жив.
    const parked = (await ctx.store.getTask(task.id))!;
    expect(parked.status).toBe('awaiting_input');
    expect(parked.stage).toBe('waiting_input');
    const open = (await ctx.store.listAwaiting(task.id))[0]!;
    expect(open.status).toBe('open');
    expect(open.deadline_at).toBe(record.deadline_at);
    const parkedRun = (await ctx.store.listRuns(task.id))[0]!;
    expect(parkedRun.status).toBe('waiting');
    expect(parkedRun.finished_at).not.toBeNull();

    const ack = await ctx.gtd.ack(record.gtd_id);
    expect(ack.processed[0]!.decision).toBe('wait');
    expect(ack.processed[0]!.reason).toBe('awaiting_user_input');
    const waiting = (await ctx.gtd.get(record.gtd_id))!.record;
    expect(waiting.state).toBe('awaiting_user');
    expect(waiting.next_trigger_kind).toBe('input');
    expect(waiting.next_trigger_ref).toBe(open.awaiting_input_id);

    // Тики без ответа: ни одной новой попытки (токены не тратятся).
    const runsBefore = (await ctx.store.listRuns(task.id)).length;
    for (let i = 1; i <= 3; i += 1) {
      ctx.clock.set(T0 + i * 60_000);
      const tick = await ctx.gtd.tick({ profileId: ctx.profileId });
      expect(tick.waiting).toBe(1);
      expect(tick.continued).toBe(0);
    }
    expect((await ctx.store.listRuns(task.id)).length).toBe(runsBefore);

    // Ответ по явному адресу -> GTD выдаёт ровно одно продолжение.
    await ctx.store.answerAwaitingById({
      awaitingInputId: open.awaiting_input_id,
      idempotencyKey: 'web:p23-answer',
      answer: { optionId: 'opt-a' },
    });
    ctx.script.push({ outcome: 'succeeded', criteria: { 'choice-made': true } });
    ctx.clock.set(T0 + 5 * 60_000);
    const tick = await ctx.gtd.tick({ profileId: ctx.profileId });
    expect(tick.continued).toBe(1);

    await settle(ctx, record.gtd_id, task.id);
    const runs = await ctx.store.listRuns(task.id);
    expect(runs.length).toBe(2);
    // Тот же userTaskId, новый runId, прежняя попытка лишена прав (generation+1).
    expect(runs[0]!.id).not.toBe(runs[1]!.id);
    expect(runs[1]!.generation).toBeGreaterThan(runs[0]!.generation);
    const final = await ctx.gtd.ack(record.gtd_id);
    expect(final.processed[0]!.decision).toBe('complete');
    const done = (await ctx.store.getTask(task.id))!;
    expect(done.status).toBe('done');
    expect(done.result_json).toContain(record.gtd_id);

    // Живой процесс во время ожидания не держался: в истории нет новых запусков
    // между шагами, а продолжений ровно одно.
    const progressions = (await ctx.gtd.get(record.gtd_id))!.progressions;
    expect(progressions.filter((p) => p.continuation_run_id !== null)).toHaveLength(1);
  });

  it('6. caps завершают прогрессию: attempt cap и deadline -> stopped, обхода нет', async () => {
    const ctx = setup('profile-p23-caps');
    const task = await admit(ctx.store, ctx.profileId, 'req-p23-caps', 'шаг падает');
    const { record } = await ctx.gtd.register({
      requestId: 'reg-p23-caps',
      profileId: ctx.profileId,
      userTaskId: task.id,
      reason: 'довести до конца с проверкой',
      criteria: [{ id: 'release-ok', description: 'релиз проверен', required: true }],
      deadlineAt: T0 + 4 * HOUR,
      maxAttempts: 2,
    });

    // Попытка 1 и 2: шаг падает, критерий не подтверждён.
    await startManaged(ctx, task.id, record.gtd_id, { stepOutcome: 'failed' });
    await settle(ctx, record.gtd_id, task.id);
    ctx.script.push({ outcome: 'failed' });
    const ack1 = await ctx.gtd.ack(record.gtd_id);
    expect(ack1.processed[0]!.decision).toBe('continue');
    expect(ack1.processed[0]!.reason).toBe('step_failed_retry');

    await settle(ctx, record.gtd_id, task.id);
    const ack2 = await ctx.gtd.ack(record.gtd_id);
    expect(ack2.processed[0]!.decision).toBe('stop');
    expect(ack2.processed[0]!.reason).toBe('attempt_cap_exhausted');
    expect(ack2.processed[0]!.continuationRunId).toBeNull();

    const stopped = (await ctx.gtd.get(record.gtd_id))!.record;
    expect(stopped.state).toBe('stopped');
    expect(stopped.stop_reason).toBe('attempt_cap_exhausted');
    expect(stopped.attempts).toBe(2);
    const blocked = (await ctx.store.getTask(task.id))!;
    expect(blocked.status).toBe('blocked');
    expect(blocked.blocker_reason).toBe('attempt_cap_exhausted');
    expect(JSON.parse(blocked.result_json!) as Record<string, unknown>).toMatchObject({ stoppedBy: 'gtd', stopReason: 'attempt_cap_exhausted' });
    expect((await ctx.store.listRuns(task.id)).length).toBe(2);

    // Обхода лимита НЕТ: ни новой попытки, ни новой записи контроля.
    await ctx.gtd.reportOutcome({
      gtdId: record.gtd_id,
      userTaskId: task.id,
      stepId: 'step-3',
      outcome: 'succeeded',
      idempotencyKey: 'after-stop',
    });
    const afterStop = await ctx.gtd.ack(record.gtd_id);
    expect(afterStop.processed[0]!.decision).toBe('reject');
    expect((await ctx.store.listRuns(task.id)).length).toBe(2);
    await expect(
      ctx.gtd.register({
        requestId: 'reg-p23-caps-again',
        profileId: ctx.profileId,
        userTaskId: task.id,
        reason: 'начать контроль заново',
        criteria: [{ id: 'release-ok', description: 'релиз проверен', required: true }],
        deadlineAt: T0 + 8 * HOUR,
        maxAttempts: 5,
      }),
    ).rejects.toThrow(GtdAlreadyRegisteredError);
    expect(await recordCount(ctx.profileId)).toBe(1);

    // Закрытая запись больше не проверяется тиком.
    ctx.clock.set(T0 + 60_000);
    const tick = await ctx.gtd.tick({ profileId: ctx.profileId });
    expect(tick.checked).toBe(0);

    // Дедлайн: другой сценарий — bounded stop без новых попыток.
    const deadlineCtx = setup('profile-p23-deadline');
    const deadlineTask = await admit(deadlineCtx.store, deadlineCtx.profileId, 'req-p23-deadline', 'не успеваем вовремя');
    const deadline = await deadlineCtx.gtd.register({
      requestId: 'reg-p23-deadline',
      profileId: deadlineCtx.profileId,
      userTaskId: deadlineTask.id,
      reason: 'уложиться в дедлайн релиза',
      criteria: [{ id: 'shipped', description: 'релиз отправлен', required: true }],
      deadlineAt: T0 + HOUR,
      maxAttempts: 5,
    });
    deadlineCtx.clock.set(T0 + 2 * HOUR);
    const deadlineTick = await deadlineCtx.gtd.tick({ profileId: deadlineCtx.profileId });
    expect(deadlineTick.stopped).toBe(1);
    const stoppedDeadline = (await deadlineCtx.gtd.get(deadline.record.gtd_id))!.record;
    expect(stoppedDeadline.state).toBe('stopped');
    expect(stoppedDeadline.stop_reason).toBe('deadline_exceeded');
    expect((await deadlineCtx.store.listRuns(deadlineTask.id)).length).toBe(0);
    expect((await deadlineCtx.store.getTask(deadlineTask.id))!.status).toBe('blocked');
  });

  it('7. неизвестный gtdId у managed outcome: карантин и явный статус, не тихий fallback', async () => {
    const ctx = setup('profile-p23-quarantine');
    const task = await admit(ctx.store, ctx.profileId, 'req-p23-quarantine', 'исход без записи контроля');

    const lines: Record<string, unknown>[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      try {
        lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
      } catch {
        /* неструктурная строка */
      }
    });
    try {
      await expect(
        ctx.gtd.reportOutcome({
          gtdId: 'gtd-ffffffffffffffffffff',
          userTaskId: task.id,
          stepId: 'step-1',
          outcome: 'failed',
          idempotencyKey: 'ghost:1',
        }),
      ).rejects.toThrow(GtdUnknownRecordError);
    } finally {
      spy.mockRestore();
    }

    // Исход сохранён как quarantined: он не потерян и не стал output-owned recovery.
    const quarantined = await env.DB.prepare(`SELECT * FROM gtd_outcomes WHERE gtd_id = ?`).bind('gtd-ffffffffffffffffffff').first<Record<string, unknown>>();
    expect(quarantined!.state).toBe('quarantined');
    expect(quarantined!.reason).toBe('unknown_control_record');
    expect(await ctx.store.listRuns(task.id)).toEqual([]);
    expect((await ctx.store.getTask(task.id))!.status).toBe('active');
    const logged = lines.find((l) => l.event === 'gtd.outcome.quarantined');
    expect(logged).toBeDefined();
    expect(logged!.level).toBe('error');
    expect(logged!.reason).toBe('unknown_control_record');
    expect(logged!.reconciliationRequired).toBe(true);
    expect(logged!.continuationOwner).toBe('gtd');
  });

  it('8. логи GTD: opt-in, registration reason, wait/deadline/ACK — без секретов и текста задачи', async () => {
    const ctx = setup('profile-p23-logs');
    const task = await admit(ctx.store, ctx.profileId, 'req-p23-logs', 'жди CI и проверь интеграцию');

    const lines: Record<string, unknown>[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      try {
        lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
      } catch {
        /* неструктурная строка */
      }
    });
    try {
      await ctx.gtd.register({
        requestId: 'reg-p23-logs',
        profileId: ctx.profileId,
        userTaskId: task.id,
        reason: 'дождаться CI и проверить интеграцию',
        criteria: [{ id: 'ci-gate', description: 'required check зелёный', required: true }],
        deadlineAt: T0 + 2 * HOUR,
        maxAttempts: 2,
        nextCheckAt: T0,
      });
      const { record } = await ctx.gtd.register({
        requestId: 'reg-p23-logs',
        profileId: ctx.profileId,
        userTaskId: task.id,
        reason: 'дождаться CI и проверить интеграцию',
        criteria: [{ id: 'ci-gate', description: 'required check зелёный', required: true }],
        deadlineAt: T0 + 2 * HOUR,
        maxAttempts: 2,
        nextCheckAt: T0,
      });
      await startManaged(ctx, task.id, record.gtd_id, { stepOutcome: 'awaiting_condition', conditionRef: 'ci-run-77' });
      await settle(ctx, record.gtd_id, task.id);
      await ctx.gtd.ack(record.gtd_id);
      await ctx.gtd.tick({ profileId: ctx.profileId });
      ctx.clock.set(T0 + 3 * HOUR);
      await ctx.gtd.tick({ profileId: ctx.profileId });
    } finally {
      spy.mockRestore();
    }

    const registered = lines.find((l) => l.event === 'gtd.registered');
    expect(registered).toBeDefined();
    expect(registered!.profileId).toBe(ctx.profileId);
    expect(registered!.userTaskId).toBe(task.id);
    expect(registered!.gtdId).toMatch(/^gtd-[0-9a-f]{20}$/);
    expect(registered!.reason).toBe('explicit_opt_in');
    expect(registered!.registrationReason).toBe('дождаться CI и проверить интеграцию');
    expect(registered!.criteria).toEqual(['ci-gate']);
    expect(registered!.continuationOwner).toBe('gtd');
    expect(registered!.deadlineAt).toBe(T0 + 2 * HOUR);
    expect(registered!.maxAttempts).toBe(2);

    const received = lines.find((l) => l.event === 'gtd.outcome.received');
    expect(received!.gtdId).toBe(registered!.gtdId);
    expect(received!.stepId).toBe('step-1');
    expect(received!.outcome).toBe('awaiting_condition');
    expect(received!.runId).toBeTruthy();
    expect(received!.inboxState).toBe('pending');

    const decision = lines.find((l) => l.event === 'gtd.decision');
    expect(decision!.decision).toBe('wait');
    expect(decision!.reason).toBe('awaiting_external_condition');
    expect(decision!.triggerKind).toBe('condition');
    expect(decision!.triggerRef).toBe('ci-run-77');
    expect(decision!.ack).toBe(true);
    expect(decision!.continuationOwner).toBe('gtd');
    expect(decision!.continuationCreated).toBe(false);

    const waited = lines.find((l) => l.event === 'gtd.wait');
    expect(waited!.reason).toBe('awaiting_external_condition');

    const stopped = lines.find((l) => l.event === 'gtd.stopped');
    expect(stopped!.reason).toBe('deadline_exceeded');
    expect(stopped!.maxAttempts).toBe(2);

    // В логах только идентификаторы, ключи и причины: ни секретов, ни текста задачи.
    const text = lines.map((l) => JSON.stringify(l)).join('\n');
    expect(text).not.toContain('RUNNER_API_KEY');
    expect(text).not.toContain('Bearer ');
    expect(text).not.toContain('жди CI и проверь интеграцию');
    expect(text).not.toContain('required check зелёный');
  });
});