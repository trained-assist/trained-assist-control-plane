import { TaskStore } from '../src/taskstore';
import { describe, expect, it } from 'vitest';
import { env } from './env';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const newTask = async (store: TaskStore, id = nextId('sig')) => {
  const { task } = await store.createTask({ id, profileId: 'p', goal: 'сигналы' });
  return task;
};

describe('Task Store: дедупликация сигналов (§5.3)', () => {
  it('повторная доставка того же ключа не создаёт вторую строку', async () => {
    const store = new TaskStore(env.DB);
    const task = await newTask(store);

    const first = await store.recordSignal({
      taskId: task.id,
      idempotencyKey: 'telegram:42',
      eventType: 'user_reply',
      payload: { text: 'да' },
    });
    const second = await store.recordSignal({
      taskId: task.id,
      idempotencyKey: 'telegram:42',
      eventType: 'user_reply',
      payload: { text: 'да' },
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.signal.id).toBe(first.signal.id);
    expect(await store.listSignals(task.id)).toHaveLength(1);

    const received = (await store.history(task.id)).filter((e) => e.kind === 'signal_received');
    expect(received).toHaveLength(1);
  });

  it('идентичность = userTaskId + шаг + ключ: другой шаг — другая строка', async () => {
    const store = new TaskStore(env.DB);
    const task = await newTask(store);

    const unbound = await store.recordSignal({
      taskId: task.id,
      idempotencyKey: 'web:7',
      eventType: 'user_reply',
    });
    const bound = await store.recordSignal({
      taskId: task.id,
      idempotencyKey: 'web:7',
      eventType: 'user_reply',
      stepKey: 'wait',
    });

    expect(unbound.inserted).toBe(true);
    expect(bound.inserted).toBe(true);
    expect(await store.listSignals(task.id)).toHaveLength(2);
  });

  it('ранний сигнал (до парковки) не теряется: takeSignal забирает его первым', async () => {
    const store = new TaskStore(env.DB);
    const task = await newTask(store);

    // Сигнал пришёл раньше, чем шаг начал ждать.
    await store.recordSignal({
      taskId: task.id,
      idempotencyKey: 'tg:early',
      eventType: 'user_reply',
      payload: { text: 'early' },
    });

    const taken = await store.takeSignal(task.id, 'user_reply', { step: 'wait' });
    expect(taken?.idempotency_key).toBe('tg:early');
    expect(taken?.consumed_at).not.toBeNull();
    expect(JSON.parse(taken!.payload_json)).toEqual({ text: 'early' });

    // Повторное потребление ничего не находит.
    expect(await store.takeSignal(task.id, 'user_reply', { step: 'wait' })).toBeNull();

    const events = await store.history(task.id);
    expect(events.filter((e) => e.kind === 'step_woken')).toHaveLength(1);
  });

  it('consume оставляет неизрасходованные сигналы других типов на месте', async () => {
    const store = new TaskStore(env.DB);
    const task = await newTask(store);
    await store.recordSignal({ taskId: task.id, idempotencyKey: 'tg:1', eventType: 'user_reply' });
    await store.recordSignal({ taskId: task.id, idempotencyKey: 'tg:2', eventType: 'callback' });

    expect(await store.takeSignal(task.id, 'user_reply')).not.toBeNull();
    expect(await store.takeSignal(task.id, 'user_reply')).toBeNull();
    const pending = await store.pendingSignals(task.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.event_type).toBe('callback');
  });

  it('сигнал неизвестной задачи отклоняется (нет строки адресата)', async () => {
    const store = new TaskStore(env.DB);
    await expect(
      store.recordSignal({ taskId: nextId('missing'), idempotencyKey: 'x:1', eventType: 'user_reply' }),
    ).rejects.toThrow(/not found/);
  });
});
