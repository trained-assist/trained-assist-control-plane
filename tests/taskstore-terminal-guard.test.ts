// Guard терминальных состояний — суть issue #90:
// поздняя запись (wait_timeout после done) не перезаписывает статус и result.
import { FencedError, TerminalStateError, TaskStore } from '../src/taskstore';
import { describe, expect, it } from 'vitest';
import { env } from './env';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

/** Задача, дошедшая до done с результатом — как ut-cf-181011-deploy в #90. */
const doneTask = async (store: TaskStore, id = nextId('done')) => {
  const { task } = await store.createTask({ id, profileId: 'p', goal: 'doom' });
  await store.commit(id, task.generation, {
    status: 'active',
    stage: 'running',
    step: 'prepare',
  });
  await store.commit(id, task.generation, {
    status: 'done',
    stage: 'finished',
    step: 'finalize',
    result: { answer: 'да', ok: true, version: 'v2' },
  });
  return task;
};

describe('Guard терминальных состояний (issue #90)', () => {
  it('позднее событие ПОСЛЕ done не меняет статус и не затирает result', async () => {
    const store = new TaskStore(env.DB);
    const task = await doneTask(store);

    // Репродукция #90: wait_timeout приходит с АКТУАЛЬНЫМ generation,
    // как это было в D1 (событие id=73, generation=1).
    await expect(
      store.commit(task.id, task.generation, {
        kind: 'awaiting_expired',
        step: 'wait',
        status: 'failed',
        result: { reason: 'user_reply_timeout' },
        payload: { timeoutSec: 86400 },
        source: 'executor',
      }),
    ).rejects.toBeInstanceOf(TerminalStateError);

    const row = await store.requireTask(task.id);
    expect(row.status).toBe('done');
    expect(row.stage).toBe('finished');

    const status = await store.statusRow(task.id);
    expect(status?.status).toBe('done');
    expect(status?.result).toEqual({ answer: 'да', ok: true, version: 'v2' });

    // Отклонение видно в журнале: попытка перехода записана, но status_after = NULL.
    const events = await store.history(task.id);
    const rejected = events.find(
      (e) => e.kind === 'task_status_changed' && e.status_before === 'done' && e.status_after === null,
    );
    expect(rejected).toBeDefined();
    const payload = JSON.parse(rejected!.payload_json);
    expect(payload.rejected).toBe('terminal_state');
    expect(payload.attempted).toBe('failed');
    expect(payload.action).toBe('awaiting_expired');
    expect(rejected!.generation).toBe(task.generation);
  });

  it('failed и cancelled тоже неизменяемы', async () => {
    const store = new TaskStore(env.DB);

    const failedTaskId = nextId('failed');
    const failedTask = (await store.createTask({ id: failedTaskId, profileId: 'p', goal: 'g' })).task;
    await store.commit(failedTaskId, failedTask.generation, { status: 'failed', result: { reason: 'x' } });
    await expect(
      store.commit(failedTaskId, failedTask.generation, { status: 'done', result: { reason: 'recovered' } }),
    ).rejects.toBeInstanceOf(TerminalStateError);
    expect((await store.requireTask(failedTaskId)).status).toBe('failed');
    expect((await store.statusRow(failedTaskId))?.result).toEqual({ reason: 'x' });

    const cancelledTaskId = nextId('cancelled');
    const cancelledTask = (await store.createTask({ id: cancelledTaskId, profileId: 'p', goal: 'g' })).task;
    await store.cancel(cancelledTaskId);
    // cancel поднял поколение: запись со старым generation отклоняется fencing'ом,
    // запись с новым — guard'ом терминального статуса.
    await expect(
      store.commit(cancelledTaskId, cancelledTask.generation, { status: 'active' }),
    ).rejects.toBeInstanceOf(FencedError);
    const cancelledNow = await store.requireTask(cancelledTaskId);
    await expect(
      store.commit(cancelledTaskId, cancelledNow.generation, { status: 'active' }),
    ).rejects.toBeInstanceOf(TerminalStateError);
    expect(cancelledNow.status).toBe('cancelled');
  });

  it('запись результата в терминальную задачу отклоняется отдельно от статуса', async () => {
    const store = new TaskStore(env.DB);
    const task = await doneTask(store);

    await expect(
      store.commit(task.id, task.generation, { step: 'apply', result: { overwrite: true } }),
    ).rejects.toBeInstanceOf(TerminalStateError);
    expect((await store.statusRow(task.id))?.result).toEqual({ answer: 'да', ok: true, version: 'v2' });
  });

  it('позднее чистое событие (без статуса) записывается, но ничего не меняет', async () => {
    const store = new TaskStore(env.DB);
    const task = await doneTask(store);
    const before = await store.statusRow(task.id);

    await store.commit(task.id, task.generation, {
      kind: 'error',
      step: 'wait',
      payload: { late: true, note: 'событие после терминала' },
    });

    const after = await store.statusRow(task.id);
    expect(after?.status).toBe('done');
    expect(after?.result).toEqual(before?.result);
    expect(after!.history.length).toBe(before!.history.length + 1);
  });

  it('cancel на done — no-op с видимым cancel_requested', async () => {
    const store = new TaskStore(env.DB);
    const task = await doneTask(store);

    const res = await store.cancel(task.id);
    expect(res.cancelled).toBe(false);
    expect(res.status).toBe('done');

    const events = await store.history(task.id);
    const rejectedCancel = events.find((e) => e.kind === 'cancel_requested');
    expect(rejectedCancel).toBeDefined();
    expect(JSON.parse(rejectedCancel!.payload_json).rejected).toBe('terminal_state');
    expect((await store.requireTask(task.id)).generation).toBe(task.generation);
  });

  it('терминальный commit закрывает открытое ожидание и снимает проекцию одной транзакцией', async () => {
    const store = new TaskStore(env.DB);
    const id = nextId('auto-close');
    const { task } = await store.createTask({ id, profileId: 'p', goal: 'g' });
    await store.openAwaiting({ taskId: id, kind: 'data', question: '?', respondentScope: 'p' });

    await store.commit(id, task.generation, { status: 'done', stage: 'finished', result: { ok: true } });

    const rows = await store.listAwaiting(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('cancelled');
    expect(await store.getOpenAwaiting(id)).toBeNull();
    const after = await store.requireTask(id);
    expect(after.awaiting_input_id).toBeNull();
    expect(after.stage).toBe('finished');
  });

  it('открытие awaiting на терминальной задаче отклоняется, строк не появляется', async () => {
    const store = new TaskStore(env.DB);
    const task = await doneTask(store);

    await expect(
      store.openAwaiting({ taskId: task.id, kind: 'data', question: '?', respondentScope: 'p' }),
    ).rejects.toBeInstanceOf(TerminalStateError);
    expect(await store.listAwaiting(task.id)).toHaveLength(0);
    expect((await store.requireTask(task.id)).awaiting_input_id).toBeNull();
  });
});
