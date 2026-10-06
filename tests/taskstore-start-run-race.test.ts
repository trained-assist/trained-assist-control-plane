import { describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../src/taskstore';
import { FencedError, TaskStoreError } from '../src/taskstore/errors';
import { env } from './env';

async function fixture() {
  const store = new TaskStore(env.DB);
  const taskId = `start-race-${crypto.randomUUID()}`;
  await store.admitTask({ id: taskId, profileId: 'start-race', goal: 'race test', startDeadlineMs: 60_000 });
  return { store, taskId };
}

describe('atomic non-idempotent run admission', () => {
  it('rejects an already stale generation without an execution, event or deadline mutation', async () => {
    const { store, taskId } = await fixture();
    await store.bumpGeneration(taskId);
    const before = await store.requireTask(taskId);
    await expect(store.startRun(taskId, { generation: 1 })).rejects.toBeInstanceOf(FencedError);
    expect(await store.requireTask(taskId)).toEqual(before);
    expect(await store.listRuns(taskId)).toEqual([]);
    expect((await store.history(taskId)).filter(event => event.kind === 'run_started')).toEqual([]);
  });

  it.each(['generation', 'done', 'failed', 'cancelled'] as const)
  ('rejects %s arriving after the initial task read', async transition => {
    const { store, taskId } = await fixture();
    const requireTask = store.requireTask.bind(store);
    vi.spyOn(store, 'requireTask').mockImplementationOnce(async id => {
      const stale = await requireTask(id);
      if (transition === 'generation') await store.bumpGeneration(taskId);
      else if (transition === 'cancelled') await store.confirmCancel(taskId, { expectedGeneration: 1 });
      else await store.commit(taskId, 1, { status: transition });
      return stale;
    });
    await expect(store.startRun(taskId, { generation: 1, sessionId: 'never-launched' }))
      .rejects.toBeInstanceOf(transition === 'generation' ? FencedError : TaskStoreError);
    const after = await requireTask(taskId);
    expect(after.start_deadline_at).not.toBeNull();
    expect(after.generation).toBe(transition === 'generation' ? 2 : 1);
    expect(await store.listRuns(taskId)).toEqual([]);
    expect((await store.history(taskId)).filter(event => event.kind === 'run_started')).toEqual([]);
  });

  it('publishes exactly one event referencing the admitted execution and clears its deadline', async () => {
    const { store, taskId } = await fixture();
    const run = await store.startRun(taskId, { generation: 1, engine: 'native', sessionId: 'accepted-run', leaseSec: 10 });
    expect(await store.listRuns(taskId)).toEqual([run]);
    const events = (await store.history(taskId)).filter(event => event.kind === 'run_started');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ execution_id: run.id, generation: run.generation });
    expect(JSON.parse(events[0]!.payload_json)).toMatchObject({ runId: run.id, sessionId: 'accepted-run' });
    expect((await store.requireTask(taskId)).start_deadline_at).toBeNull();
  });
});
