import { describe, expect, it, vi } from 'vitest';
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import { CfWorkflowPort } from '../src/workflow-port/workflow-port';
import { CpStopTargetsService } from '../src/workflow-port/external-stop';
import type { ExternalStopContext } from '../src/workflow-port/external-stop';
import type { RunnerResult } from '../src/runner-adapter/runner-api-adapter';

let sequence = 0;

async function fixture() {
  const store = new TaskStore(env.DB);
  const suffix = `${Date.now()}-${++sequence}`;
  const taskId = `stop-pin-${suffix}`;
  const profileId = `stop-pin-profile-${suffix}`;
  const conversationId = `stop-pin-conversation-${suffix}`;
  const requestId = `tgcp-${String(sequence).padStart(64, '0')}`;
  await store.admitTask({ id: taskId, profileId, conversationId, requestId,
    receiptId: `stop-pin-receipt-${suffix}`, goal: 'offline pin fixture' });
  const runId = `run_00000000-0000-0000-0000-${String(sequence).padStart(12, '0')}`;
  const attempt = await store.startRun(taskId, { generation: 1, sessionId: runId });
  const resolved = await store.resolveCpStopTargets({ profileId, conversationId, admissionRequestIds: [requestId] });
  if (!resolved.ok) throw new Error('fixture resolution failed');
  const target = resolved.targets[0]!;
  const input = { profileId, conversationId, windowId: `stop-pin-window-${suffix}`,
    admissionRequestIds: [requestId], admissionBarrierComplete: true, restart: false };
  const opened = await store.openCpStopWindow({ ...input, targets: [target] });
  if (!opened.ok) throw new Error('fixture window failed');
  const snapshotId = opened.window.snapshot_id;
  const terminate = vi.fn(async () => {});
  const status = vi.fn(async () => ({ status: 'running' }));
  const workflow = { get: vi.fn(async () => ({ status, terminate })) } as unknown as Workflow;
  const stop = vi.fn(async (context: ExternalStopContext) => ({ state: 'pending' as const }));
  const port = new CfWorkflowPort(workflow, store, undefined, { stop });
  const pin = { target, snapshotId };
  return { store, taskId, profileId, conversationId, requestId, runId, attempt, input, target,
    snapshotId, terminate, status, stop, port, pin };
}

function result(context: ExternalStopContext): RunnerResult {
  return { runId: context.runId!, userTaskId: context.taskId, profileId: context.profileId,
    ownerGeneration: context.ownerGeneration, outcome: 'cancelled', exitReason: 'cancelled',
    exitCode: null, exitSignal: 'SIGTERM', exitObserved: true, startedAt: '', finishedAt: '',
    usage: { status: 'unknown' }, outputRefs: [], persistence: 'not_required', cleanup: 'completed', logPath: '' };
}

describe('immutable stop execution pins', () => {
  it('retries the same snapshot and native tuple without repeated generation bumps or Workflow termination', async () => {
    const current = await fixture();
    const service = new CpStopTargetsService(current.store, current.port);
    const first = await service.stop(current.input);
    const second = await service.stop(current.input);
    expect(first).toMatchObject({ snapshotId: current.snapshotId, unresolved: true });
    expect(second.tasks).toEqual(first.tasks);
    expect((await current.store.requireTask(current.taskId)).generation).toBe(2);
    expect(current.stop).toHaveBeenCalledTimes(2);
    for (const [context] of current.stop.mock.calls) expect(context).toMatchObject({ taskId: current.taskId,
      profileId: current.profileId, attemptId: current.attempt.id, runId: current.runId, ownerGeneration: 1 });
    expect(current.terminate).not.toHaveBeenCalled();
  });

  it.each(['generation', 'attempt', 'run', 'key', 'profile'] as const)
  ('rejects %s drift before any control side effect', async drift => {
    const current = await fixture();
    if (drift === 'generation') await current.store.bumpGeneration(current.taskId);
    if (drift === 'attempt') await current.store.startRun(current.taskId, { generation: 1 });
    if (drift === 'run') await env.DB.prepare('UPDATE executions SET session_id = ? WHERE id = ?')
      .bind('run_ffffffff-ffff-ffff-ffff-ffffffffffff', current.attempt.id).run();
    if (drift === 'key') current.pin.target.attempts[0]!.idempotencyKey = 'untrusted-key';
    if (drift === 'profile') current.pin.target.profileId = 'foreign-profile';
    const before = await current.store.requireTask(current.taskId);
    expect(await current.port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: false });
    expect(await current.store.requireTask(current.taskId)).toEqual(before);
    expect(current.stop).not.toHaveBeenCalled();
    expect(current.terminate).not.toHaveBeenCalled();
  });

  it('atomically rejects an attempt appearing between guard read and durable cancellation claim', async () => {
    const current = await fixture();
    const matches = current.store.cpStopTargetMatches.bind(current.store);
    vi.spyOn(current.store, 'cpStopTargetMatches').mockImplementationOnce(async (...args) => {
      const matched = await matches(...args);
      await current.store.startRun(current.taskId, { generation: 1 });
      return matched;
    });
    expect(await current.port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: false });
    expect((await current.store.requireTask(current.taskId)).generation).toBe(1);
    expect(current.stop).not.toHaveBeenCalled();
    expect((await current.store.history(current.taskId)).filter(event => event.kind === 'cancel_requested')).toHaveLength(0);
  });

  it('rechecks a new attempt inserted after claim and before native dispatch', async () => {
    const current = await fixture();
    const claim = current.store.claimCpStopTarget.bind(current.store);
    vi.spyOn(current.store, 'claimCpStopTarget').mockImplementationOnce(async (...args) => {
      const generation = await claim(...args);
      await current.store.startRun(current.taskId, { generation: generation! });
      return generation;
    });
    expect(await current.port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: false });
    expect(current.stop).not.toHaveBeenCalled();
    expect(current.terminate).not.toHaveBeenCalled();
  });

  it('a generation and new native run racing the old cancel never become new control targets or output owners', async () => {
    const current = await fixture();
    const stop = vi.fn(async (context: ExternalStopContext) => {
      const generation = await current.store.bumpGeneration(current.taskId);
      await current.store.startRun(current.taskId, { generation,
        sessionId: 'run_ffffffff-ffff-ffff-ffff-ffffffffffff' });
      return { state: 'stopped' as const, result: result(context) };
    });
    const port = new CfWorkflowPort({ get: vi.fn() } as unknown as Workflow, current.store, undefined, { stop });
    expect(await port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: false });
    expect(await port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: false });
    expect(stop).toHaveBeenCalledOnce();
    expect(stop.mock.calls[0]![0].runId).toBe(current.runId);
    expect(await current.store.requireRun(current.attempt.id)).toMatchObject({ status: 'running', finished_at: null });
    expect(await current.store.requireTask(current.taskId)).toMatchObject({ generation: 3, result_json: null });
    expect((await current.store.history(current.taskId)).filter(event => event.kind === 'task_cancelled')).toHaveLength(0);
    expect(await current.store.listArtifacts(current.taskId)).toEqual([]);
    expect(await current.store.listDeliveries(current.taskId)).toEqual([]);
  });

  it('holds on live Workflow even after real native exit; never uses mutable task-ID terminate', async () => {
    const current = await fixture();
    const stop = vi.fn(async (context: ExternalStopContext) => ({ state: 'stopped' as const, result: result(context) }));
    const workflow = { get: vi.fn(async () => ({ status: current.status, terminate: current.terminate })) } as unknown as Workflow;
    const port = new CfWorkflowPort(workflow, current.store, undefined, { stop });
    expect(await port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: false });
    expect(current.terminate).not.toHaveBeenCalled();
    expect((await current.store.requireTask(current.taskId)).status).not.toBe('cancelled');
    current.status.mockResolvedValueOnce({ status: 'complete' });
    expect(await port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: true, status: 'cancelled' });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('guards terminal commit when a new attempt appears between validation and status mutation', async () => {
    const current = await fixture();
    const generation = await current.store.claimCpStopTarget(current.target, current.snapshotId);
    const getTask = current.store.getTask.bind(current.store);
    vi.spyOn(current.store, 'getTask').mockImplementationOnce(async (...args) => {
      const task = await getTask(...args);
      await current.store.startRun(current.taskId, { generation: generation! });
      return task;
    });
    expect(await current.store.confirmCancel(current.taskId, { expectedGeneration: generation!, stopPin: current.pin }))
      .toMatchObject({ cancelled: false });
    expect((await current.store.requireTask(current.taskId)).status).not.toBe('cancelled');
  });

  it('holds a snapshot whose durable submission witness has a conflicting key', async () => {
    const current = await fixture();
    await current.store.logEvent({ taskId: current.taskId, kind: 'progress', generation: 1, source: 'executor',
      payload: { event: 'runner_submit_started', attemptId: current.attempt.id, idempotencyKey: 'conflicting-host-key' } });
    expect(await current.port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: false });
    expect(current.stop).not.toHaveBeenCalled();
    expect((await current.store.requireTask(current.taskId)).generation).toBe(1);
  });

  it('rejects false exit provenance and never publishes it into the task result or native proof', async () => {
    const current = await fixture();
    const stop = vi.fn(async (context: ExternalStopContext) => ({ state: 'stopped' as const,
      result: { ...result(context), ownerGeneration: 99 } }));
    const port = new CfWorkflowPort({ get: vi.fn() } as unknown as Workflow, current.store, undefined, { stop });
    expect(await port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: false });
    expect(await current.store.requireTask(current.taskId)).toMatchObject({ result_json: null });
    expect((await current.store.history(current.taskId)).filter(event => event.kind === 'task_cancelled')).toHaveLength(0);
    expect((await current.store.requireRun(current.attempt.id)).finished_at).toBeNull();
  });

  it('rejects historical snapshots without pins and never selects a later task on a retry', async () => {
    const current = await fixture();
    await current.store.admitTask({ id: `${current.taskId}-later`, profileId: current.profileId,
      conversationId: current.conversationId, requestId: `tgcp-${'f'.repeat(64)}`,
      receiptId: `${current.taskId}-later-receipt`, goal: 'must remain untouched' });
    const service = new CpStopTargetsService(current.store, current.port);
    expect((await service.stop(current.input)).tasks.map(target => target.userTaskId)).toEqual([current.taskId]);
    const { taskGeneration, attempts, ...historical } = current.target;
    await env.DB.prepare('UPDATE cp_stop_windows SET targets_json = ? WHERE snapshot_id = ?')
      .bind(JSON.stringify([historical]), current.snapshotId).run();
    current.stop.mockClear();
    expect(await service.stop(current.input)).toMatchObject({ unresolved: true, reason: 'identity_mismatch' });
    expect(current.stop).not.toHaveBeenCalled();
  });
});
