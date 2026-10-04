import { TaskStore } from '../src/taskstore';
import { runStuckInputSweep } from '../src/intake';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './env';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const dbOf = (store: TaskStore): typeof env.DB => (store as unknown as { db: typeof env.DB }).db;

const created: string[] = [];
const batches: string[] = [];
const track = (id: string) => { created.push(id); return id; };
const trackBatch = (id: string) => { batches.push(id); return id; };

afterEach(async () => {
  const store = new TaskStore(env.DB);
  while (created.length) {
    const id = created.pop()!;
    await dbOf(store).prepare('DELETE FROM deliveries WHERE user_task_id = ?').bind(id).run();
    await dbOf(store).prepare('DELETE FROM durable_tasks WHERE id = ?').bind(id).run();
    await dbOf(store).prepare('DELETE FROM stuck_input_alerts WHERE incident_id = ?').bind(`task:${id}`).run();
  }
  while (batches.length) {
    const id = batches.pop()!;
    await dbOf(store).prepare('DELETE FROM pending_inputs WHERE batch_id = ?').bind(id).run();
    await dbOf(store).prepare('DELETE FROM stuck_input_alerts WHERE incident_id = ?').bind(`batch:${id}`).run();
  }
});

const setup = () => new TaskStore(env.DB);

const admitStuck = async (store: TaskStore, deadlineMs = 1) => {
  const id = track(nextId('task'));
  await store.admitTask({ id, profileId: 'profile-1', goal: 'сделай работу', startDeadlineMs: deadlineMs });
  return id;
};

const recordStuckBatch = async (store: TaskStore, deadlineMs = 1) => {
  const batchId = trackBatch(nextId('batch'));
  await store.recordPendingInput({
    batchId, version: 1, profileId: 'profile-1', channel: 'telegram', firstMessageAt: Date.now(), deadlineMs,
  });
  return batchId;
};

const expired = async () => new Promise((r) => setTimeout(r, 5));

describe('сквозной watchdog: пагинация, актуальность, дедуп, повтор доставки', () => {
  it('обходит ВСЕ просроченные записи, а не только первую страницу', async () => {
    const store = setup();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await admitStuck(store, 1));
    await expired();

    // pageSize=2 < 7 просроченных: без курсора проход обработал бы только две.
    const result = await runStuckInputSweep(store, { pageSize: 2 }, Date.now());

    expect(result.scanned).toBe(7);
    expect(result.queued).toBe(7);
  });

  it('уже стартовавшая задача не порождает ни доставки, ни алерта', async () => {
    const store = setup();
    const started = await admitStuck(store, 1);   // стартует и снимает дедлайн
    const stuck = await admitStuck(store, 1);
    await store.startRun(started, { generation: 1, engine: 'opencode' });
    await expired();

    const result = await runStuckInputSweep(store, {}, Date.now());

    expect(result.scanned).toBe(1);                // стартовавшей уже нет в выборке
    expect(result.queued).toBe(1);                 // в доставку ушла только реально зависшая
    expect(result.alerts).toBe(1);
    expect(await store.listDeliveries(started)).toHaveLength(0);
    expect(await store.listDeliveries(stuck)).toHaveLength(1);
  });

  it('операторский алерт по инциденту один: повторные проходы только копят count', async () => {
    const store = setup();
    await admitStuck(store, 1);
    await expired();

    const first = await runStuckInputSweep(store, {}, Date.now());
    const second = await runStuckInputSweep(store, {}, Date.now());
    const third = await runStuckInputSweep(store, {}, Date.now());

    expect(first.alerts).toBe(1);   // алерт отправлен один раз
    expect(second.alerts).toBe(0);  // повтор молчит
    expect(third.alerts).toBe(0);
    const alerts = await store.listStuckInputAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.count).toBe(3);   // но инцидент виден как накопленный
  });

  it('успешная доставка не создаёт вторую: повтор идёт в тот же logicalMessageId', async () => {
    const store = setup();
    const id = await admitStuck(store, 1);
    await expired();

    await runStuckInputSweep(store, {}, Date.now());
    await runStuckInputSweep(store, {}, Date.now());
    await runStuckInputSweep(store, {}, Date.now());

    expect(await store.listDeliveries(id)).toHaveLength(1);
  });

  it('сбой доставки даёт повтор с backoff; успех доставляет один раз', async () => {
    const store = setup();
    const id = await admitStuck(store, 1);
    await expired();

    // 1. Канал недоступен: одна попытка, доставка остаётся повторяемой.
    const failing = { send: vi.fn(async () => { throw new Error('channel down'); }) };
    const a = await runStuckInputSweep(store, { adapter: failing, retryAfterSec: 60 }, Date.now());
    expect(failing.send).toHaveBeenCalledTimes(1);
    expect(a.delivered).toBe(0);
    const afterFail = (await store.listDeliveries(id))[0]!;
    expect(afterFail.status).toBe('pending');
    expect(afterFail.next_attempt_at).toBeGreaterThan(Date.now()); // backoff соблюдён

    // 2. Канал ожил, но backoff ещё не истёк — повторной отправки нет.
    const ok = { send: vi.fn(async () => ({ providerMessageId: 'msg-1' })) };
    const b = await runStuckInputSweep(store, { adapter: ok, retryAfterSec: 60 }, Date.now());
    expect(ok.send).not.toHaveBeenCalled();
    expect(b.delivered).toBe(0);

    // 3. Backoff истёк — тот же проход доставляет.
    await dbOf(store).prepare('UPDATE deliveries SET next_attempt_at = ? WHERE user_task_id = ?')
      .bind(Date.now() - 1, id).run();
    const c = await runStuckInputSweep(store, { adapter: ok, retryAfterSec: 60 }, Date.now());
    expect(ok.send).toHaveBeenCalledTimes(1);
    expect(c.delivered).toBe(1);
    expect((await store.listDeliveries(id))[0]!.status).toBe('delivered');
  });

  it('без адаптера планировщик только ставит доставку в outbox и не «доставляет»', async () => {
    const store = setup();
    await admitStuck(store, 1);
    await expired();

    const result = await runStuckInputSweep(store, { adapter: null }, Date.now());
    expect(result.queued).toBe(1);
    expect(result.delivered).toBe(0);
  });

  it('пакет до admission тоже проходит цепочку и получает один алерт', async () => {
    const store = setup();
    const batchId = await recordStuckBatch(store, 1);
    await expired();

    const first = await runStuckInputSweep(store, {}, Date.now());
    expect(first.scanned).toBe(1);
    expect(first.alerts).toBe(1);
    // Задачи нет → доставку ставить некуда, но инцидент зафиксирован.
    expect(first.queued).toBe(0);   // задачи нет — ставить доставку некуда
    const second = await runStuckInputSweep(store, {}, Date.now());
    expect(second.alerts).toBe(0);
    expect((await store.listStuckInputAlerts())[0]!.incident_id).toBe(`batch:${batchId}`);
  });
});