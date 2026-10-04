import { TaskStore } from '../src/taskstore';
import { enqueueStuckInputNotification, runStuckInputWatchdog } from '../src/intake';
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
afterEach(async () => {
  const store = new TaskStore(env.DB);
  while (created.length) {
    const id = created.pop()!;
    await dbOf(store).prepare('DELETE FROM durable_tasks WHERE id = ?').bind(id).run();
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

    const seen: { taskId: string; ageMs: number }[] = [];
    const result = await runStuckInputWatchdog(
      store,
      { notify: async (ctx) => { seen.push({ taskId: ctx.task.id, ageMs: ctx.ageMs }); } },
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

    await enqueueStuckInputNotification(store, task, { channel: 'telegram' });
    // Повторный вызов по той же задаче — не создаёт вторую доставку.
    await enqueueStuckInputNotification(store, task, { channel: 'telegram' });

    const deliveries = await store.listDeliveries(task.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.channel).toBe('telegram');
    expect(deliveries[0]!.status).toBe('pending');
    const message = JSON.parse(deliveries[0]!.message_json) as { kind: string; action: string };
    expect(message.kind).toBe('stuck_input');
    expect(message.action).toBe('launch');
  });

  it('сигнал алерта intake.stuck_input эмитится как error event (путь для Watcher)', async () => {
    const store = setup();
    const { task } = await admit(store, nextId('alert'), 1);
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
    expect(event!.level).toBe('error');
    expect(event!.userTaskId).toBe(task.id);
    expect(event!.reason).toBe('accepted_but_not_started');
    expect(event!.stage).toBe('queued');
    expect(typeof event!.ageMs).toBe('number');
  });
});
