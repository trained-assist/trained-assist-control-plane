import { describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../src/taskstore';
import { CfWorkflowPort } from '../src/workflow-port/workflow-port';
import { runnerExternalStopPort, type ExternalStopContext, type ExternalStopPort } from '../src/workflow-port/external-stop';
import { RunnerApiAdapter, type RunnerResult, type RunnerStatusView } from '../src/runner-adapter/runner-api-adapter';
import { env } from './env';

let sequence = 0;
const nativeRunId = 'run_00000000-0000-0000-0000-000000000001';

function nativeFake(context: ExternalStopContext, state = 'cancelled') {
  const status: RunnerStatusView = { requestId: 'fixture', userTaskId: context.taskId, conversationId: 'fixture',
    runId: context.runId ?? nativeRunId, ownerGeneration: context.ownerGeneration, state, cancelRequested: true,
    connectionLost: false, observedAt: new Date().toISOString(), sequence: 1, fencing: { rejected: 0 } };
  const result: RunnerResult = { runId: context.runId ?? nativeRunId, userTaskId: context.taskId, profileId: context.profileId,
    ownerGeneration: context.ownerGeneration, outcome: 'cancelled', exitReason: 'cancelled', exitCode: null,
    exitSignal: null, exitObserved: true, startedAt: '', finishedAt: '', usage: { status: 'unknown' },
    outputRefs: [], persistence: 'persisted', cleanup: 'completed', logPath: '' };
  const adapter: Pick<RunnerApiAdapter, 'cancel' | 'status' | 'result'> = {
    cancel: vi.fn(async () => ({ status: 'stop_pending' })),
    status: vi.fn(async () => status), result: vi.fn(async () => result),
  };
  return { adapter, status, result };
}

async function setup(withNative = true) {
  const taskId = `native-cancel-${++sequence}-${Date.now()}`;
  const runId = `run_00000000-0000-0000-0000-${sequence.toString(16).padStart(12, '0')}`;
  const store = new TaskStore(env.DB);
  const admitted = await store.admitTask({ id: taskId, profileId: 'fixture-profile', goal: 'offline stop proof' });
  const attempt = await store.startRun(taskId, { generation: admitted.task.generation, engine: 'cloudflare-workflows' });
  if (withNative) await store.attachRunnerRun(attempt.id, runId);
  const terminate = vi.fn(async () => {});
  const workflow = { get: vi.fn(async () => ({ terminate })) } as unknown as Workflow;
  const context: ExternalStopContext = { taskId, profileId: 'fixture-profile', attemptId: attempt.id,
    runId: withNative ? runId : null, ownerGeneration: attempt.generation };
  const fake = nativeFake(context);
  return { store, taskId, attempt, terminate, workflow, context, ...fake };
}

describe('native cancellation requires actual terminal evidence', () => {
  it('real Runner HTTP adapter sends exact original-generation cancel before status/result readback', async () => {
    const fixture = await setup();
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const transport = (async (url: string, init: RequestInit) => {
      const path = new URL(String(url)).pathname;
      requests.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-key');
      return Response.json(path.endsWith('/cancel') ? { status: 'stop_pending' }
        : path.endsWith('/status') ? fixture.status : fixture.result);
    }) as unknown as typeof fetch;
    const adapter = new RunnerApiAdapter('https://runner.invalid', 'fixture-key', transport);
    const port = new CfWorkflowPort(fixture.workflow, fixture.store, undefined, runnerExternalStopPort(adapter));
    expect((await port.cancel(fixture.taskId, { reason: 'fixture user stop' })).stopConfirmed).toBe(true);
    expect(requests).toEqual([
      { path: `/v1/runs/${fixture.context.runId}/cancel`, method: 'POST', body: { ownerGeneration: fixture.attempt.generation, reason: 'fixture user stop' } },
      { path: `/v1/runs/${fixture.context.runId}/status`, method: 'GET', body: null },
      { path: `/v1/runs/${fixture.context.runId}/result`, method: 'GET', body: null },
    ]);
  });

  it('Runner HTTP cancellation rejection never confirms stopped or reads result', async () => {
    const fixture = await setup();
    const transport = vi.fn(async () => new Response('{"error":{"code":"DENIED","message":"fixture rejected"}}', { status: 403 }));
    const adapter = new RunnerApiAdapter('https://runner.invalid', 'fixture-key', transport as unknown as typeof fetch);
    const port = new CfWorkflowPort(fixture.workflow, fixture.store, undefined, runnerExternalStopPort(adapter));
    expect((await port.cancel(fixture.taskId)).stopConfirmed).toBe(false);
    expect(transport).toHaveBeenCalledOnce();
    expect((await fixture.store.getRun(fixture.attempt.id))?.status).toBe('running');
  });
  it('confirmed native exit closes task/attempt using original Runner generation, not bumped CP generation', async () => {
    const fixture = await setup();
    const port = new CfWorkflowPort(fixture.workflow, fixture.store, undefined, runnerExternalStopPort(fixture.adapter));
    const outcome = await port.cancel(fixture.taskId);
    expect(outcome.stopConfirmed).toBe(true);
    expect((await fixture.store.requireTask(fixture.taskId)).status).toBe('cancelled');
    expect((await fixture.store.getRun(fixture.attempt.id))?.status).toBe('cancelled');
    expect(fixture.adapter.cancel).toHaveBeenCalledWith(fixture.context.runId, { ownerGeneration: fixture.attempt.generation, reason: undefined });
  });

  for (const kind of ['pending', 'rejected', 'failed_cancel', 'unknown_ack', 'unknown', 'exit_unobserved', 'wrong_task', 'wrong_profile', 'wrong_run', 'wrong_generation', 'lost_connection', 'status_mismatch']) {
    it(`${kind} never confirms task or finishes attempt despite Workflow termination`, async () => {
      const fixture = await setup();
      if (kind === 'pending') fixture.status.state = 'running';
      if (kind === 'rejected') fixture.adapter.cancel = vi.fn(async () => ({ status: 'rejected' }));
      if (kind === 'failed_cancel') fixture.adapter.cancel = vi.fn(async () => ({ status: 'failed' }));
      if (kind === 'unknown_ack') fixture.adapter.cancel = vi.fn(async () => ({ status: 'unknown' }));
      if (kind === 'unknown') fixture.adapter.status = vi.fn(async () => { throw new Error('offline'); });
      if (kind === 'exit_unobserved') fixture.result.exitObserved = false;
      if (kind === 'wrong_task') fixture.result.userTaskId = 'other-task';
      if (kind === 'wrong_profile') fixture.result.profileId = 'other-profile';
      if (kind === 'wrong_run') fixture.result.runId = 'other-run';
      if (kind === 'wrong_generation') fixture.result.ownerGeneration += 1;
      if (kind === 'lost_connection') fixture.status.connectionLost = true;
      if (kind === 'status_mismatch') fixture.status.ownerGeneration += 1;
      const port = new CfWorkflowPort(fixture.workflow, fixture.store, undefined, runnerExternalStopPort(fixture.adapter));
      expect((await port.cancel(fixture.taskId)).stopConfirmed).toBe(false);
      expect(fixture.terminate).toHaveBeenCalledOnce();
      expect((await fixture.store.requireTask(fixture.taskId)).status).not.toBe('cancelled');
      expect((await fixture.store.getRun(fixture.attempt.id))?.status).toBe('running');
      expect((await fixture.store.history(fixture.taskId)).some(event => event.kind === 'task_cancelled' || event.kind === 'run_finished')).toBe(false);
    });
  }

  it('missing external hook cannot falsely confirm an attached Runner', async () => {
    const fixture = await setup();
    const port = new CfWorkflowPort(fixture.workflow, fixture.store);
    expect((await port.cancel(fixture.taskId)).stopConfirmed).toBe(false);
  });

  it('configured external hook with no known Runner identity remains unknown', async () => {
    const fixture = await setup(false);
    const port = new CfWorkflowPort(fixture.workflow, fixture.store, undefined, runnerExternalStopPort(fixture.adapter));
    expect((await port.cancel(fixture.taskId)).stopConfirmed).toBe(false);
    expect(fixture.adapter.cancel).not.toHaveBeenCalled();
  });

  it('legacy Workflow-only cancellation remains supported without external hook', async () => {
    const fixture = await setup(false);
    const port = new CfWorkflowPort(fixture.workflow, fixture.store);
    expect((await port.cancel(fixture.taskId)).stopConfirmed).toBe(true);
  });

  it('throwing external port cannot confirm cancellation', async () => {
    const fixture = await setup();
    const hook: ExternalStopPort = { stop: async () => { throw new Error('offline'); } };
    const port = new CfWorkflowPort(fixture.workflow, fixture.store, undefined, hook);
    expect((await port.cancel(fixture.taskId)).stopConfirmed).toBe(false);
  });

  it('new CP generation during external stop refuses confirmation', async () => {
    const fixture = await setup();
    const hook: ExternalStopPort = { stop: async () => {
      await fixture.store.bumpGeneration(fixture.taskId, { reason: 'offline concurrent recovery' });
      return { state: 'stopped', result: fixture.result };
    } };
    const port = new CfWorkflowPort(fixture.workflow, fixture.store, undefined, hook);
    expect((await port.cancel(fixture.taskId)).stopConfirmed).toBe(false);
  });

  it('unknown bound native attempt also refuses confirmation without external hook', async () => {
    const fixture = await setup();
    await fixture.store.markConnectionLost(fixture.context.runId!, 'offline connection loss');
    const port = new CfWorkflowPort(fixture.workflow, fixture.store);
    expect((await port.cancel(fixture.taskId)).stopConfirmed).toBe(false);
    expect((await fixture.store.getRun(fixture.attempt.id))?.status).toBe('unknown');
  });

  it('native cancel exceptions and Workflow terminate errors do not finalize', async () => {
    const fixture = await setup();
    fixture.adapter.cancel = vi.fn(async () => { throw new Error('offline rejected'); });
    const port = new CfWorkflowPort(fixture.workflow, fixture.store, undefined, runnerExternalStopPort(fixture.adapter));
    expect((await port.cancel(fixture.taskId)).stopConfirmed).toBe(false);
    fixture.terminate.mockRejectedValueOnce(new Error('offline workflow failure'));
    expect((await port.cancel(fixture.taskId)).stopConfirmed).toBe(false);
    expect(fixture.adapter.status).not.toHaveBeenCalled();
  });

  it('atomic confirmation fence rejects generation change after the initial task read', async () => {
    const fixture = await setup();
    const generation = (await fixture.store.requireTask(fixture.taskId)).generation;
    const readTask = fixture.store.getTask.bind(fixture.store);
    const spy = vi.spyOn(fixture.store, 'getTask').mockImplementationOnce(async taskId => {
      const row = await readTask(taskId);
      await env.DB.prepare('UPDATE durable_tasks SET generation = generation + 1 WHERE id = ?').bind(taskId).run();
      return row;
    });
    try {
      expect((await fixture.store.confirmCancel(fixture.taskId, { expectedGeneration: generation })).cancelled).toBe(false);
      expect((await fixture.store.requireTask(fixture.taskId)).status).not.toBe('cancelled');
    } finally { spy.mockRestore(); }
  });
});
