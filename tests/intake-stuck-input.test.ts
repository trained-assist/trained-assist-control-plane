import { TaskStore } from '../src/taskstore';
import { classifyWait, enqueueStuckInputNotification, needsOperatorAlert, runStuckInputWatchdog } from '../src/intake';
import { DEFAULT_START_DEADLINE_MS } from '../src/taskstore';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from './env';

// db приватный — для уборки тестовых строк лезем через приведение типа.
const dbOf = (store: TaskStore): typeof env.DB => (store as unknown as { db: typeof env.DB }).db;

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

// D1 в файле общий (fileParallelism: false), а sweepStuckAccepted не фильтрует
// по профилю — поэтому каждый тест убирает свои задачи, иначе они накапливаются
// и «просроченные» из соседнего теста ломают счётчики.
const created: string[] = [];
const track = (id: string) => { created.push(id); return id; };
const batches: string[] = [];
const trackBatch = (id: string) => { batches.push(id); return id; };
afterEach(async () => {
  const store = new TaskStore(env.DB);
  while (created.length) {
    const id = created.pop()!;
    await dbOf(store).prepare('DELETE FROM durable_tasks WHERE id = ?').bind(id).run();
  }
  while (batches.length) {
    const id = batches.pop()!;
    await dbOf(store).prepare('DELETE FROM pending_inputs WHERE batch_id = ?').bind(id).run();
  }
});

const setup = () => new TaskStore(env.DB);

const admit = (store: TaskStore, id: string, startDeadlineMs?: number) =>
  store.admitTask({ id: track(id), profileId: 'profile-1', goal: 'сделай работу', startDeadlineMs });

describe('принято, но не начато: дедлайн старта и внешний детектор (arch#132 R1–R5)', () => {
  it('приём ставит дедлайн старта — принятый вход не может быть без границы ожидания', async () => {
    const store = setup();
    const { task } = await admit(store, nextId('stuck'));

    expect(task.stage).toBe('queued');
    expect(task.start_deadline_at).not.toBeNull();
    expect(task.start_deadline_at!).toBeGreaterThan(Date.now());
    expect(task.start_deadline_at!).toBeLessThanOrEqual(Date.now() + DEFAULT_START_DEADLINE_MS);
  });

  it('startRun сбрасывает дедлайн — задача перестаёт быть «принято, но не начато»', async () => {
    const store = setup();
    const { task } = await admit(store, nextId('stuck'));

    await store.startRun(task.id, { generation: 1, engine: 'opencode' });

    const after = await store.getTask(task.id);
    expect(after?.start_deadline_at).toBeNull();
  });

  it('просроченный вход виден детектором, а свежий — нет', async () => {
    const store = setup();
    const stale = await admit(store, nextId('stale'), 1); // дедлайн истекает почти сразу
    const fresh = await admit(store, nextId('fresh'));   // дефолтные 10 минут

    await new Promise((r) => setTimeout(r, 5));

    const stuck = await store.sweepStuckAccepted(Date.now());
    const ids = stuck.map((t) => t.id);
    expect(ids).toContain(stale.task.id);
    expect(ids).not.toContain(fresh.task.id);
  });

  it('детектор возвращает самую старую задачу первой и считает возраст', async () => {
    const store = setup();
    const older = await admit(store, nextId('older'), 1);
    const newer = await admit(store, nextId('newer'), 1);

    await new Promise((r) => setTimeout(r, 5));

    const result = await runStuckInputWatchdog(store, {}, Date.now());

    expect(result.stuck).toBe(2);
    expect(result.tasks[0]).toBe(older.task.id); // самая старая — первой
    expect(result.oldestAgeMs).not.toBeNull();
    expect(result.oldestAgeMs!).toBeGreaterThan(0);
  });

  it('детектор — наблюдение: он не меняет задачу и не запускает Run', async () => {
    const store = setup();
    const { task } = await admit(store, nextId('observe'), 1);

    await new Promise((r) => setTimeout(r, 5));
    await runStuckInputWatchdog(store, {}, Date.now());

    const after = await store.getTask(task.id);
    expect(after?.stage).toBe('queued');            // не переведена
    expect(after?.start_deadline_at).not.toBeNull();   // дедлайн не тронут
    expect(await store.activeRun(task.id)).toBeNull(); // Run не стартовал
  });

  it('после старта Run задача исчезает из детектора', async () => {
    const store = setup();
    const { task } = await admit(store, nextId('started'), 1);

    await store.startRun(task.id, { generation: 1, engine: 'opencode' });
    await new Promise((r) => setTimeout(r, 5));

    const result = await runStuckInputWatchdog(store, {}, Date.now());
    expect(result.stuck).toBe(0);
    expect(result.tasks).not.toContain(task.id);
  });

  it('notify вызывается на каждую просроченную задачу и получает возраст', async () => {
    const store = setup();
    const { task } = await admit(store, nextId('notify'), 1);
    await new Promise((r) => setTimeout(r, 5));

    const seen: { taskId: string | null; ageMs: number }[] = [];
    const result = await runStuckInputWatchdog(
      store,
      { notify: async (ctx) => { seen.push({ taskId: ctx.task?.id ?? null, ageMs: ctx.ageMs }); return true; } },
      Date.now(),
    );

    expect(result.stuck).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.taskId).toBe(task.id);
    expect(seen[0]!.ageMs).toBeGreaterThan(0);
  });

  it('notify по умолчанию не задан — детектор только наблюдает (не угадывает канал)', async () => {
    const store = setup();
    const { task } = await admit(store, nextId('silent'), 1);
    await new Promise((r) => setTimeout(r, 5));

    const result = await runStuckInputWatchdog(store, {}, Date.now());
    expect(result.stuck).toBe(1);
    // Доставка не поставлена: канал знает хост, а не детектор.
    expect(await store.listDeliveries(task.id)).toHaveLength(0);
  });

  it('enqueueStuckInputNotification ставит идемпотентную доставку в outbox (C02)', async () => {
    const store = setup();
    const { task } = await admit(store, nextId('deliver'), 1);

    const wait = classifyWait({ task, pendingInput: null });
    await enqueueStuckInputNotification(store, { task, pendingInput: null, wait }, { channel: 'telegram' });
    // Повторный вызов по той же задаче — не создаёт вторую доставку.
    await enqueueStuckInputNotification(store, { task, pendingInput: null, wait }, { channel: 'telegram' });

    const deliveries = await store.listDeliveries(task.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.channel).toBe('telegram');
    expect(deliveries[0]!.status).toBe('pending');
    const message = JSON.parse(deliveries[0]!.message_json) as { kind: string; actions: string[]; text: string };
    expect(message.kind).toBe('stuck_input');
    expect(message.actions).toContain('launch');
    expect(message.text.length).toBeGreaterThan(0);
  });

  it('сигнал алерта intake.stuck_input эмитится как error event (путь для Watcher)', async () => {
    const store = setup();
    // Задача в очереди за полосу — это норма, поэтому алерта нет в пределах дедлайна.
    const { task } = await admit(store, nextId('alert'), 1);
    await dbOf(store).prepare(`UPDATE durable_tasks SET stage = 'queued' WHERE id = ?`).bind(task.id).run();
    await new Promise((r) => setTimeout(r, 5));

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await runStuckInputWatchdog(store, {}, Date.now());
    } finally {
      console.log = original;
    }
    const event = lines
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .find((e) => e?.event === 'intake.stuck_input');
    expect(event).toBeTruthy();
    expect(event!.level).toBe('warn');
    expect(event!.waitKind).toBe('queued_for_lane');

    // Но если «норма» длится получасами — это уже эксплуатационная проблема.
    const hard = await runStuckInputWatchdog(store, {}, Date.now() + 31 * 60_000);
    expect(hard.oldestAgeMs).toBeGreaterThan(30 * 60_000);
  });

  it('классификация ожидания: медиа, полоса, готов-не-принят, сбой, зависание', () => {
    const task = (stage: string) => ({ id: 't', profile_id: 'p', stage }) as never;
    const pending = (prep_state: string) => ({ batch_id: 'b', profile_id: 'p', prep_state }) as never;

    expect(classifyWait({ task: task('queued'), pendingInput: null }).kind).toBe('queued_for_lane');
    expect(classifyWait({ task: task('collecting'), pendingInput: null }).kind).toBe('media_prep');
    expect(classifyWait({ task: task('handing_off'), pendingInput: null }).kind).toBe('no_progress');
    expect(classifyWait({ task: null, pendingInput: pending('collecting') }).kind).toBe('media_prep');
    expect(classifyWait({ task: null, pendingInput: pending('preparing') }).kind).toBe('media_prep');
    expect(classifyWait({ task: null, pendingInput: pending('ready') }).kind).toBe('ready_not_admitted');
    expect(classifyWait({ task: null, pendingInput: pending('failed') }).kind).toBe('technical');

    // Нормальное ожидание не алертится в пределах дедлайна, но алертится после порога.
    expect(needsOperatorAlert(classifyWait({ task: task('queued'), pendingInput: null }), 60_000)).toBe(false);
    expect(needsOperatorAlert(classifyWait({ task: task('queued'), pendingInput: null }), 31 * 60_000)).toBe(true);
    expect(needsOperatorAlert(classifyWait({ task: null, pendingInput: pending('ready') }), 1)).toBe(true);
    expect(needsOperatorAlert(classifyWait({ task: null, pendingInput: pending('failed') }), 1)).toBe(true);
  });
});

// ── Окно ДО admission (arch#132 R9) ───────────────────────────────────────────
// Детектор по durable_tasks не видит пакет, который шлюз принял, но который ещё не
// дошёл до admitTask: задачи нет — строки нет. Это ровно то окно, где вход терялся.

describe('принятый вход до admitTask виден детектору (arch#132 R9)', () => {
  const batch = (store: TaskStore, id: string, firstMessageAt: number, deadlineMs?: number) =>
    store.recordPendingInput({
      batchId: trackBatch(id), version: 1, profileId: 'profile-1',
      channel: 'telegram', firstMessageAt, deadlineMs,
    });

  it('приём пакета НЕ создаёт пользовательскую задачу — запись лёгкая', async () => {
    const store = setup();
    await batch(store, nextId('batch'), Date.now(), 1);

    const pending = await store.requirePendingInput(batches.at(-1)!);
    expect(pending.prep_state).toBe('collecting');
    expect(pending.user_task_id).toBeNull();
    // Задачи нет: watchdog-запись не превращается в durable_tasks строку.
    expect(await store.unfinishedTasks()).toHaveLength(0);
  });

  it('просроченный пакет без задачи попадает в детектор', async () => {
    const store = setup();
    await batch(store, nextId('batch'), Date.now(), 1);
    await new Promise((r) => setTimeout(r, 5));

    const stuck = await store.sweepStuckPendingInputs(Date.now());
    expect(stuck.map((r) => r.batch_id)).toContain(batches.at(-1)!);
  });

  it('новые сообщения НЕ подставляют возраст: first_message_at не перебивается', async () => {
    const store = setup();
    const firstAt = Date.now() - 60_000; // первый вход час назад
    await batch(store, nextId('batch'), firstAt, 1);
    const id = batches.at(-1)!;

    // Активный чат продолжает слать: свежие сообщения с текущим временем.
    await store.recordPendingInput({ batchId: id, version: 1, profileId: 'profile-1', channel: 'telegram', firstMessageAt: Date.now(), deadlineMs: 1 });
    await store.recordPendingInput({ batchId: id, version: 1, profileId: 'profile-1', channel: 'telegram', firstMessageAt: Date.now(), deadlineMs: 1 });

    const pending = await store.requirePendingInput(id);
    expect(pending.first_message_at).toBe(firstAt);   // возраст самого старого — виден
    expect(pending.message_count).toBe(3);
  });

  it('после admitTask пакет выходит из окна «до admission»', async () => {
    const store = setup();
    await batch(store, nextId('batch'), Date.now(), 1);
    const id = batches.at(-1)!;
    const { task } = await admit(store, nextId('task'));

    await store.linkPendingInputToTask(id, task.id);
    await new Promise((r) => setTimeout(r, 5));

    const pending = await store.requirePendingInput(id);
    expect(pending.prep_state).toBe('admitted');
    expect(pending.user_task_id).toBe(task.id);
    expect((await store.sweepStuckPendingInputs(Date.now())).map((r) => r.batch_id)).not.toContain(id);
  });

  it('детектор сливает оба окна и ставит самый старый первым', async () => {
    const store = setup();
    // Задача, просроченная давно (deadline 1 мс назад).
    const { task } = await admit(store, nextId('task'), 1);
    // Пакет, просроченный сильнее.
    await batch(store, nextId('batch'), Date.now(), -120_000);
    const batchId = batches.at(-1)!;
    await new Promise((r) => setTimeout(r, 5));

    const result = await runStuckInputWatchdog(store, {}, Date.now());
    expect(result.stuck).toBe(2);
    expect(result.tasks[0]).toBe(batchId); // самый старый — первым, независимо от окна
    expect(result.tasks).toContain(task.id);
  });

  it('сигнал алерта различает окна: accepted_before_admission vs accepted_but_not_started', async () => {
    const store = setup();
    const p = await batch(store, nextId('batch'), Date.now(), -60_000);
    // 'ready, но не принят' — настоящая дыра, а не ожидание медиа.
    await store.setPendingInputPrep(p.batch_id, 'ready');
    await new Promise((r) => setTimeout(r, 5));

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await runStuckInputWatchdog(store, {}, Date.now());
    } finally {
      console.log = original;
    }

    const event = lines
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .find((e) => e?.event === 'intake.stuck_input' && e?.reason === 'ready_but_not_admitted');
    expect(event).toBeTruthy();
    expect(event!.userTaskId).toBeNull();
    expect(typeof event!.batchId).toBe('string');
    expect(event!.prepState).toBe('ready');
    expect(event!.waitKind).toBe('ready_not_admitted');
  });

  it('уведомление для пакета без задачи не выдумывает доставку', async () => {
    const store = setup();
    const p = await batch(store, nextId('batch'), Date.now(), -60_000);
    await store.setPendingInputPrep(p.batch_id, 'ready');
    const id = batches.at(-1)!;
    await new Promise((r) => setTimeout(r, 5));

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await runStuckInputWatchdog(store, {
        notify: async (ctx) =>
          enqueueStuckInputNotification(store, { task: ctx.task, pendingInput: ctx.pendingInput, wait: ctx.wait }, { channel: 'telegram' }),
      }, Date.now());
    } finally {
      console.log = original;
    }

    // Доставки нет: задачи нет, а значит нет и адресата в outbox доставки.
    const skipped = lines
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .find((e) => e?.event === 'intake.stuck_input_notify_skipped' && e?.batchId === id);
    expect(skipped).toBeTruthy();
  });
});
