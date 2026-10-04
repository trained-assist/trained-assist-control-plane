import { TaskStore } from '../src/taskstore';
import { describe, expect, it } from 'vitest';
import { env } from './env';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const dbOf = (store: TaskStore): typeof env.DB => (store as unknown as { db: typeof env.DB }).db;

const created: string[] = [];
const track = (id: string) => { created.push(id); return id; };

const setup = () => new TaskStore(env.DB);

async function cleanup() {
  const store = new TaskStore(env.DB);
  for (const id of created.splice(0)) {
    await dbOf(store).prepare('DELETE FROM deliveries WHERE user_task_id = ?').bind(id).run();
    await dbOf(store).prepare('DELETE FROM task_events WHERE user_task_id = ?').bind(id).run();
    await dbOf(store).prepare('DELETE FROM executions WHERE task_id = ?').bind(id).run();
    await dbOf(store).prepare('DELETE FROM durable_tasks WHERE id = ?').bind(id).run();
  }
}

const admit = async (store: TaskStore, id: string, startDeadlineMs?: number) =>
  store.admitTask({ id: track(id), profileId: 'profile-1', goal: 'сделай работу', startDeadlineMs });

describe('Task Store: атомарность старта (Приоритет 4.1)', () => {
  it('попытка, событие и сброс дедлайна согласованы — ложного зависания не остаётся', async () => {
    const store = setup();
    const { task } = await admit(store, nextId('task'), 60_000);
    expect(task.start_deadline_at).not.toBeNull();

    await store.startRun(task.id, { generation: 1, engine: 'opencode' });

    const after = await store.getTask(task.id);
    const events = await store.history(task.id);
    const runs = await store.listRuns(task.id);

    // Раньше это были три отдельных .run(): падение между ними оставляло задачу
    // с попыткой, но с не сброшенным дедлайном — и watchdog видел «принято, но не
    // начато» у задачи, которая УЖЕ идёт. Теперь граница одна транзакция.
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('running');
    expect(after?.start_deadline_at).toBeNull();
    const started = events.filter((e) => e.kind === 'run_started');
    expect(started).toHaveLength(1);
    expect(started[0]!.execution_id).toBe(runs[0]!.id);
    await cleanup();
  });

  it('событие run_started несёт ссылку на попытку и её runId', async () => {
    const store = setup();
    const { task } = await admit(store, nextId('task'), 60_000);
    const run = await store.startRun(task.id, { generation: 1, engine: 'opencode', sessionId: 'sess-9' });
    const ev = (await store.history(task.id)).find((e) => e.kind === 'run_started')!;
    expect(ev.execution_id).toBe(run.id);
    expect(JSON.parse(ev.payload_json!).runId).toBe(run.id);
    await cleanup();
  });
});

describe('Task Store: дедуп доставки не ухудшает подтверждённое состояние (Приоритет 4.2)', () => {
  it('повтор того же logicalMessageId после delivered НЕ возвращает задачу в pending', async () => {
    const store = setup();
    const { task } = await admit(store, nextId('task'));
    const { delivery } = await store.queueDelivery({
      taskId: task.id, logicalMessageId: 'm1', channel: 'telegram', message: { text: 'ok' },
    });
    await store.confirmDelivery(delivery.id, { providerMessageId: 'pm-1' });
    expect((await store.requireTask(task.id)).delivery_state).toBe('delivered');

    // Повтор той же логической доставки — no-op по строке deliveries…
    const again = await store.queueDelivery({
      taskId: task.id, logicalMessageId: 'm1', channel: 'telegram', message: { text: 'ok' },
    });
    expect(again.queued).toBe(false);
    expect(await store.listDeliveries(task.id)).toHaveLength(1);
    // …и НЕ откатывает подтверждённое состояние доставки в pending.
    expect((await store.requireTask(task.id)).delivery_state).toBe('delivered');
    await cleanup();
  });

  it('повтор после сбоя ДОЛЖЕН снова взвести pending — иначе доставка теряется', async () => {
    const store = setup();
    const { task } = await admit(store, nextId('task'));
    const { delivery } = await store.queueDelivery({
      taskId: task.id, logicalMessageId: 'm1', channel: 'telegram', message: { text: 'ok' },
    });
    await store.failDelivery(delivery.id, { error: 'down', retryAfterSec: 0, maxAttempts: 3 });
    expect((await store.requireTask(task.id)).delivery_state).toBe('pending');

    await store.queueDelivery({ taskId: task.id, logicalMessageId: 'm1', channel: 'telegram', message: { text: 'ok' } });
    expect((await store.requireTask(task.id)).delivery_state).toBe('pending');
    await cleanup();
  });
});