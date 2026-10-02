import { FencedError, TaskStore, TerminalStateError } from '../src/taskstore';
import { describe, expect, it } from 'vitest';
import { env } from './env';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

describe('Task Store: generation fencing (INV-02)', () => {
  it('запись с устаревшим generation отклоняется, состояние не меняется, событие fenced видно', async () => {
    const store = new TaskStore(env.DB);
    const id = nextId('fence');
    const { task } = await store.createTask({ id, profileId: 'p', goal: 'fencing' });
    expect(task.generation).toBe(1);

    await store.commit(id, 1, { status: 'active', stage: 'running', step: 'run' });

    // Устаревший писатель (поколение 0) пытается записать результат.
    await expect(
      store.commit(id, 0, { status: 'done', result: { stale: true }, step: 'apply' }),
    ).rejects.toBeInstanceOf(FencedError);

    const after = await store.requireTask(id);
    expect(after.status).toBe('active');
    expect(after.stage).toBe('running');
    expect(after.updated_at).toBeGreaterThanOrEqual(task.updated_at);

    const fenced = (await store.history(id)).filter((e) => e.kind === 'fenced');
    expect(fenced).toHaveLength(1);
    const payload = JSON.parse(fenced[0]!.payload_json);
    expect(payload.attemptedGeneration).toBe(0);
    expect(payload.currentGeneration).toBe(1);
    expect(fenced[0]!.generation).toBe(0);
  });

  it('bumpGeneration переводит задачу в новое поколение: старый владелец отвергнут, новый пишет', async () => {
    const store = new TaskStore(env.DB);
    const id = nextId('bump');
    const { task } = await store.createTask({ id, profileId: 'p', goal: 'bump' });

    const gen2 = await store.bumpGeneration(id, { reason: 'lease expired' });
    expect(gen2).toBe(task.generation + 1);

    await expect(
      store.commit(id, task.generation, { status: 'failed', step: 'apply', payload: { by: 'stale-owner' } }),
    ).rejects.toBeInstanceOf(FencedError);

    // Новый владелец пишет спокойно.
    await store.commit(id, gen2, { status: 'failed', step: 'apply', payload: { by: 'new-owner' } });
    const after = await store.requireTask(id);
    expect(after.status).toBe('failed');
    expect(after.generation).toBe(gen2);

    const events = await store.history(id);
    const failedEvent = events.find((e) => e.task_item_id === 'apply' && e.status_after === 'failed')!;
    expect(failedEvent.generation).toBe(gen2);
  });

  it('терминальной задаче bumpGeneration отклоняется', async () => {
    const store = new TaskStore(env.DB);
    const id = nextId('bump-terminal');
    const { task } = await store.createTask({ id, profileId: 'p', goal: 'terminal bump' });
    await store.commit(id, task.generation, { status: 'done', result: { ok: true } });
    await expect(store.bumpGeneration(id)).rejects.toBeInstanceOf(TerminalStateError);
  });

  it('отмена поднимает поколение и закрывает открытые ожидания', async () => {
    const store = new TaskStore(env.DB);
    const id = nextId('cancel');
    const { task } = await store.createTask({ id, profileId: 'p', goal: 'cancel' });
    await store.openAwaiting({ taskId: id, kind: 'data', question: 'Вопрос?', respondentScope: 'p' });

    const res = await store.cancel(id, { reason: 'user pressed stop' });
    expect(res.cancelled).toBe(true);
    expect(res.generation).toBe(task.generation + 1);

    const after = await store.requireTask(id);
    expect(after.status).toBe('cancelled');
    expect(await store.getOpenAwaiting(id)).toBeNull();

    // Шаг, работавший на старом поколении, больше не может ничего записать.
    await expect(store.commit(id, task.generation, { status: 'done' })).rejects.toBeInstanceOf(FencedError);
  });
});
