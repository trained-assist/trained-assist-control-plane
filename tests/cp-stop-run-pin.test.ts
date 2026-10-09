import { describe, expect, it, vi } from 'vitest';
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import { CfWorkflowPort } from '../src/workflow-port/workflow-port';
import { CpStopTargetsService, runnerExternalStopPort } from '../src/workflow-port/external-stop';
import type { ExternalStopContext, ExternalStopOutcome } from '../src/workflow-port/external-stop';
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
  const stop = vi.fn<(context: ExternalStopContext) => Promise<ExternalStopOutcome>>(async () => ({ state: 'pending' }));
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

describe('serverless Runner run ids', () => {
  it('allows cancellation and confirmation for Durable Object sharded run ids', async () => {
    const runId = `run_${'a'.repeat(64)}_${'b'.repeat(24)}`;
    const context: ExternalStopContext = { taskId: 'task-serverless-run', profileId: 'profile-serverless-run',
      attemptId: 'attempt-serverless-run', runId, ownerGeneration: 2 };
    const adapter = {
      cancel: vi.fn(async () => ({ status: 'already_terminal' })),
      status: vi.fn(async () => ({ runId, userTaskId: context.taskId, ownerGeneration: 2,
        connectionLost: false, state: 'cancelled' })),
      result: vi.fn(async () => result(context)),
    };
    const port = runnerExternalStopPort(adapter as unknown as Pick<import('../src/runner-adapter/runner-api-adapter').RunnerApiAdapter, 'cancel' | 'status' | 'result'>);
    expect(await port.stop(context)).toMatchObject({ state: 'stopped' });
    expect(adapter.cancel).toHaveBeenCalledWith(runId, { ownerGeneration: 2, reason: undefined });
  });
});

describe('immutable stop execution pins', () => {
  it('repins known terminal evidence into the snapshot before final confirmation', async () => {
    const current = await fixture();
    current.status.mockResolvedValue({ status: 'complete' });
    current.stop.mockImplementation(async context => ({ state: 'stopped', result: result(context) }));
    expect(await current.port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: true });
    const proofId = `cp-stop-proof:${current.snapshotId}:${current.attempt.id}`;
    await env.DB.prepare('DELETE FROM task_events WHERE event_id = ?').bind(proofId).run();
    const service = new CpStopTargetsService(current.store, current.port);
    expect(await service.stop(current.input)).toMatchObject({ stopConfirmed: true });
    expect(await env.DB.prepare('SELECT event_id FROM task_events WHERE event_id = ?').bind(proofId).first()).not.toBeNull();
    expect(current.stop).toHaveBeenCalledTimes(1);
  });

  it.each(['finished', 'unfinished', 'submitted', 'late-submitted'] as const)
  ('handles a null native run identity only when safely %s', async state => {
    const current = await fixture();
    await env.DB.prepare('UPDATE executions SET session_id = NULL WHERE id = ?').bind(current.attempt.id).run();
    if (state !== 'unfinished') await current.store.finishRun(current.attempt.id, 'failed');
    await current.store.commit(current.taskId, 1, { status: 'failed' });
    const resolved = await current.store.resolveCpStopTargets({ profileId: current.profileId,
      conversationId: current.conversationId, admissionRequestIds: [current.requestId] });
    if (!resolved.ok) throw new Error('null run fixture failed');
    await env.DB.prepare('UPDATE cp_stop_windows SET targets_json = ? WHERE snapshot_id = ?')
      .bind(JSON.stringify(resolved.targets), current.snapshotId).run();

    const submission = () => current.store.logEvent({ taskId: current.taskId, kind: 'progress', source: 'executor', generation: 1,
      payload: { event: 'runner_submit_started', attemptId: current.attempt.id, idempotencyKey: resolved.targets[0]!.attempts[0]!.idempotencyKey } });
    if (state === 'submitted') await submission();
    if (state === 'late-submitted') {
      const update = current.store.updateCpStopWindow.bind(current.store);
      vi.spyOn(current.store, 'updateCpStopWindow').mockImplementationOnce(async input => {
        expect(input.stopConfirmed).toBe(true);
        await submission();
        return update(input);
      });
    }
    current.status.mockResolvedValue({ status: 'complete' });
    const service = new CpStopTargetsService(current.store, current.port);
    expect(await service.stop(current.input)).toMatchObject({ stopConfirmed: state === 'finished' });
    expect(current.stop).not.toHaveBeenCalled();
  });

  it('accepts an exact durable pre-admission rejection as no native run during stop reconciliation', async () => {
    const current = await fixture();
    current.status.mockResolvedValue({ status: 'errored' });
    await env.DB.prepare('UPDATE executions SET session_id = NULL WHERE id = ?').bind(current.attempt.id).run();
    const targetAttempt = current.target.attempts[0]!;
    await current.store.logEvent({ taskId: current.taskId, generation: 1, kind: 'progress', source: 'executor',
      payload: { event: 'runner_submit_started', attemptId: current.attempt.id, idempotencyKey: targetAttempt.idempotencyKey } });
    await current.store.finishRun(current.attempt.id, 'failed', { errorClass: 'runner_rejected', errorText: 'INVALID_REQUEST' });
    await current.store.logEvent({ taskId: current.taskId, generation: 1, kind: 'progress', executionId: current.attempt.id,
      source: 'executor', payload: { event: 'runner_submit_rejected', attemptId: current.attempt.id,
        idempotencyKey: targetAttempt.idempotencyKey } });
    await current.store.commit(current.taskId, 1, { status: 'failed' });
    const resolved = await current.store.resolveCpStopTargets({ profileId: current.profileId,
      conversationId: current.conversationId, admissionRequestIds: [current.requestId] });
    if (!resolved.ok) throw new Error('rejected attempt target resolution failed');
    await env.DB.prepare('UPDATE cp_stop_windows SET targets_json = ? WHERE snapshot_id = ?')
      .bind(JSON.stringify(resolved.targets), current.snapshotId).run();

    expect(await current.store.runnerSubmitMayHaveStarted(current.taskId, current.attempt.id)).toBe(false);
    expect(await current.store.cpStopTargetMatches(resolved.targets[0]!, current.snapshotId, 1)).toBe(true);

    const service = new CpStopTargetsService(current.store, current.port);
    expect(await service.stop(current.input)).toMatchObject({ stopConfirmed: true, unresolved: false });
    expect(current.stop).not.toHaveBeenCalled();
  });

  it.each(['insert-attempt', 'delete-attempt', 'attempt-generation', 'attempt-run', 'task-generation',
    'delete-task', 'delete-claim', 'mutate-claim', 'delete-proof', 'proof-profile', 'proof-run',
    'proof-generation', 'proof-exit', 'proof-source', 'proof-kind', 'proof-event', 'proof-payload',
    'execution-reopened', 'submission-key'] as const)
  ('rejects %s after per-task stop proof but before the window CAS', async mutation => {
    const current = await fixture();
    current.status.mockResolvedValue({ status: 'complete' });
    current.stop.mockImplementation(async context => ({ state: 'stopped', result: result(context) }));
    const service = new CpStopTargetsService(current.store, current.port);
    const update = current.store.updateCpStopWindow.bind(current.store);
    vi.spyOn(current.store, 'updateCpStopWindow').mockImplementationOnce(async input => {
      expect(input.stopConfirmed).toBe(true);
      expect((await current.store.requireTask(current.taskId)).status).toBe('cancelled');
      if (mutation === 'insert-attempt') await env.DB.prepare(`INSERT INTO executions
        (id, task_id, status, generation, started_at, last_heartbeat_at)
        SELECT id || '-late', task_id, 'running', generation, started_at, last_heartbeat_at FROM executions WHERE id = ?`)
        .bind(current.attempt.id).run();
      if (mutation === 'delete-attempt') await env.DB.prepare('DELETE FROM executions WHERE id = ?').bind(current.attempt.id).run();
      if (mutation === 'attempt-generation') await env.DB.prepare('UPDATE executions SET generation = generation + 1 WHERE id = ?').bind(current.attempt.id).run();
      if (mutation === 'attempt-run') await env.DB.prepare("UPDATE executions SET session_id = 'foreign-run' WHERE id = ?").bind(current.attempt.id).run();
      if (mutation === 'task-generation') await env.DB.prepare('UPDATE durable_tasks SET generation = generation + 1 WHERE id = ?').bind(current.taskId).run();
      if (mutation === 'delete-task') await env.DB.prepare('DELETE FROM durable_tasks WHERE id = ?').bind(current.taskId).run();
      const claimId = `cp-stop-claim:${current.snapshotId}:${current.taskId}`;
      const proofId = `cp-stop-proof:${current.snapshotId}:${current.attempt.id}`;
      if (mutation === 'delete-claim') await env.DB.prepare('DELETE FROM task_events WHERE event_id = ?').bind(claimId).run();
      if (mutation === 'mutate-claim') await env.DB.prepare("UPDATE task_events SET payload_json = '{}' WHERE event_id = ?").bind(claimId).run();
      if (mutation === 'delete-proof') await env.DB.prepare('DELETE FROM task_events WHERE event_id = ?').bind(proofId).run();
      if (mutation === 'proof-profile') await env.DB.prepare("UPDATE task_events SET payload_json = json_set(payload_json, '$.nativeStops[0].profileId', 'foreign') WHERE event_id = ?").bind(proofId).run();
      if (mutation === 'proof-run') await env.DB.prepare("UPDATE task_events SET payload_json = json_set(payload_json, '$.nativeStops[0].runId', 'foreign') WHERE event_id = ?").bind(proofId).run();
      if (mutation === 'proof-generation') await env.DB.prepare("UPDATE task_events SET payload_json = json_set(payload_json, '$.nativeStops[0].ownerGeneration', 99) WHERE event_id = ?").bind(proofId).run();
      if (mutation === 'proof-exit') await env.DB.prepare("UPDATE task_events SET payload_json = json_set(payload_json, '$.nativeStops[0].exitObserved', json('false')) WHERE event_id = ?").bind(proofId).run();
      if (mutation === 'proof-source') await env.DB.prepare("UPDATE task_events SET source = 'executor' WHERE event_id = ?").bind(proofId).run();
      if (mutation === 'proof-kind') await env.DB.prepare("UPDATE task_events SET kind = 'run_started' WHERE event_id = ?").bind(proofId).run();
      if (mutation === 'proof-event') await env.DB.prepare("UPDATE task_events SET payload_json = json_set(payload_json, '$.event', 'unrelated') WHERE event_id = ?").bind(proofId).run();
      if (mutation === 'proof-payload') await env.DB.prepare("UPDATE task_events SET payload_json = 'null' WHERE event_id = ?").bind(proofId).run();
      if (mutation === 'execution-reopened') await env.DB.prepare("UPDATE executions SET status = 'running', finished_at = NULL WHERE id = ?").bind(current.attempt.id).run();
      if (mutation === 'submission-key') await current.store.logEvent({ taskId: current.taskId, generation: 1,
        kind: 'progress', source: 'executor', payload: { event: 'runner_submit_started', attemptId: current.attempt.id, idempotencyKey: 'foreign' } });
      return update(input);
    });
    expect(await service.stop(current.input)).toMatchObject({ stopConfirmed: false, unresolved: true });
    expect(await current.store.cpStopWindow(current.profileId, current.conversationId)).toMatchObject({ stop_confirmed: 0 });
    expect(current.stop).toHaveBeenCalledTimes(1);
    expect(current.terminate).not.toHaveBeenCalled();
  });

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

  it.each(['done', 'failed', 'cancelled'] as const)
  ('does not confirm stop for TaskStore %s while Workflow is running or unobservable', async taskStatus => {
    const current = await fixture();
    const originalResult = { original: taskStatus, answer: 'preserve original terminal result' };
    await current.store.finishRun(current.attempt.id, 'failed');
    await current.store.commit(current.taskId, 1, { status: taskStatus, stage: 'finished', result: originalResult });
    const stop = vi.fn(async (context: ExternalStopContext) => ({ state: 'stopped' as const, result: result(context) }));
    const workflow = { get: vi.fn(async () => ({ status: current.status, terminate: current.terminate })) } as unknown as Workflow;
    const port = new CfWorkflowPort(workflow, current.store, undefined, { stop });
    expect(await port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: false });
    expect(current.status).toHaveBeenCalledOnce();
    current.status.mockRejectedValueOnce(new Error('Workflow status unavailable'));
    expect(await port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: false });
    expect(current.terminate).not.toHaveBeenCalled();
    expect(JSON.parse((await current.store.requireTask(current.taskId)).result_json!)).toEqual(originalResult);
    current.status.mockResolvedValueOnce({ status: 'complete' });
    expect(await port.cancel(current.taskId, { stopPin: current.pin }))
      .toMatchObject({ stopConfirmed: true, status: taskStatus, cancelled: taskStatus === 'cancelled' });
    expect(stop).toHaveBeenCalledOnce();
    expect(JSON.parse((await current.store.requireTask(current.taskId)).result_json!)).toEqual(originalResult);
  });

  it('preserves a finished export failure while recording separate successful native exit evidence', async () => {
    const current = await fixture();
    const originalResult = { reason: 'export_not_persisted', persistence: 'failed' };
    await current.store.finishRun(current.attempt.id, 'failed', {
      errorClass: 'export_not_persisted', errorText: 'Export was not confirmed', result: originalResult,
    });
    await current.store.commit(current.taskId, 1, { status: 'failed', stage: 'finished', result: originalResult });
    const before = await current.store.requireRun(current.attempt.id);
    const stop = vi.fn(async (context: ExternalStopContext) => ({ state: 'stopped' as const,
      result: { ...result(context), outcome: 'succeeded' as const, exitCode: 0, exitSignal: null } }));
    const workflow = { get: vi.fn(async () => ({ status: current.status, terminate: current.terminate })) } as unknown as Workflow;
    const port = new CfWorkflowPort(workflow, current.store, undefined, { stop });
    expect(await port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: false });
    expect(await current.store.requireRun(current.attempt.id)).toEqual(before);
    const proofs = (await current.store.history(current.taskId)).map(event => JSON.parse(event.payload_json))
      .filter(payload => payload.event === 'native_stop.confirmed');
    expect(proofs).toHaveLength(1);
    expect(proofs[0].nativeStops).toMatchObject([{ attemptId: current.attempt.id, runId: current.runId,
      ownerGeneration: 1, state: 'succeeded', exitObserved: true }]);
    current.status.mockResolvedValueOnce({ status: 'complete' });
    expect(await port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: true, status: 'failed' });
    expect(await current.store.requireRun(current.attempt.id)).toEqual(before);
    expect(JSON.parse((await current.store.requireTask(current.taskId)).result_json!)).toEqual(originalResult);
    expect(stop).toHaveBeenCalledOnce();
    expect(current.terminate).not.toHaveBeenCalled();
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

  it('rolls back cancellation, awaiting cleanup, delivery suppression and journal together on transaction failure', async () => {
    const current = await fixture();
    await current.store.openAwaiting({ taskId: current.taskId, purpose: 'missing_fact', question: 'fixture wait',
      respondentScope: current.profileId, generation: 1 });
    const delivery = await current.store.queueDelivery({ taskId: current.taskId,
      logicalMessageId: `${current.taskId}-delivery`, channel: 'telegram', message: { text: 'pending fixture' } });
    const generation = await current.store.claimCpStopTarget(current.target, current.snapshotId);
    const before = await current.store.requireTask(current.taskId);
    const broken = new TaskStore({ prepare: env.DB.prepare.bind(env.DB),
      batch: (statements: D1PreparedStatement[]) => env.DB.batch([...statements,
        env.DB.prepare('INSERT INTO stop_pin_nonexistent_table(value) VALUES(1)')]),
    } as unknown as D1Database);
    await expect(broken.confirmCancel(current.taskId, { expectedGeneration: generation!, stopPin: current.pin })).rejects.toThrow();
    expect(await current.store.requireTask(current.taskId)).toEqual(before);
    expect((await current.store.getOpenAwaiting(current.taskId))?.status).toBe('open');
    expect((await current.store.requireDelivery(delivery.delivery.id)).status).toBe('pending');
    expect((await current.store.history(current.taskId)).filter(event => event.kind === 'task_cancelled')).toHaveLength(0);
    const lostAck = new TaskStore({ prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.batch(statements);
        throw new Error('Committed cancellation ACK lost');
      },
    } as unknown as D1Database);
    await expect(lostAck.confirmCancel(current.taskId, { expectedGeneration: generation!, stopPin: current.pin }))
      .rejects.toThrow('Committed cancellation ACK lost');
    expect((await current.store.requireTask(current.taskId)).status).toBe('cancelled');
    expect(await current.store.getOpenAwaiting(current.taskId)).toBeNull();
    expect(await current.store.requireDelivery(delivery.delivery.id)).toMatchObject({ status: 'failed', last_error: 'suppressed_by_cancel' });
    const events = (await current.store.history(current.taskId)).filter(event => event.kind === 'task_cancelled');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload_json).deliveriesSuppressed).toBe(1);
    await current.store.confirmCancel(current.taskId, { expectedGeneration: generation!, stopPin: current.pin });
    expect((await current.store.history(current.taskId)).filter(event => event.kind === 'task_cancelled')).toHaveLength(1);
  });

  it('cold retry repairs historical cancelled state with missing cleanup and event exactly once', async () => {
    const current = await fixture();
    await current.store.openAwaiting({ taskId: current.taskId, purpose: 'missing_fact', question: 'fixture wait',
      respondentScope: current.profileId, generation: 1 });
    const delivery = await current.store.queueDelivery({ taskId: current.taskId,
      logicalMessageId: `${current.taskId}-delivery`, channel: 'telegram', message: { text: 'pending fixture' } });
    await current.store.claimCpStopTarget(current.target, current.snapshotId);
    await env.DB.prepare("UPDATE durable_tasks SET status = 'cancelled' WHERE id = ?").bind(current.taskId).run();
    const stop = vi.fn(async (context: ExternalStopContext) => ({ state: 'stopped' as const, result: result(context) }));
    const workflow = { get: vi.fn(async () => ({ status: async () => ({ status: 'complete' }) })) } as unknown as Workflow;
    const store = new TaskStore(env.DB);
    const port = new CfWorkflowPort(workflow, store, undefined, { stop });
    expect(await port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: true });
    expect(await store.getOpenAwaiting(current.taskId)).toBeNull();
    expect((await store.requireDelivery(delivery.delivery.id)).status).toBe('failed');
    const events = (await store.history(current.taskId)).filter(event => event.kind === 'task_cancelled');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload_json).deliveriesSuppressed).toBe(1);
    expect(await port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: true });
    expect((await store.history(current.taskId)).filter(event => event.kind === 'task_cancelled')).toEqual(events);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('late pending updates cannot regress confirmed snapshot or affect replacement snapshot identity', async () => {
    const current = await fixture();
    let releaseLate!: () => void;
    let enterLate!: () => void;
    const gate = new Promise<void>(resolve => { releaseLate = resolve; });
    const entered = new Promise<void>(resolve => { enterLate = resolve; });
    const stop = vi.fn<(context: ExternalStopContext) => Promise<ExternalStopOutcome>>(
      async context => ({ state: 'stopped', result: result(context) }))
      .mockImplementationOnce(async () => { enterLate(); await gate; return { state: 'pending' }; });
    current.status.mockResolvedValue({ status: 'complete' });
    const workflow = { get: vi.fn(async () => ({ status: current.status })) } as unknown as Workflow;
    const port = new CfWorkflowPort(workflow, current.store, undefined, { stop });
    const service = new CpStopTargetsService(current.store, port);
    const polled = service.stop(current.input);
    await entered;
    expect(await service.stop(current.input)).toMatchObject({ stopConfirmed: true });
    releaseLate();
    expect(await polled).toMatchObject({ stopConfirmed: false });
    const saved = await current.store.cpStopWindow(current.profileId, current.conversationId);
    expect(saved).toMatchObject({ snapshot_id: current.snapshotId, stop_confirmed: 1, reason: null });
    const replacement = await current.store.openCpStopWindow({ ...current.input,
      windowId: `${current.input.windowId}-replacement`, restart: true, targets: [current.target] });
    if (!replacement.ok) throw new Error('replacement fixture failed');
    expect(await current.store.updateCpStopWindow({ ...current.input, snapshotId: current.snapshotId,
      stopConfirmed: false, reason: 'native_stop_unknown' })).toBeNull();
    expect(await current.store.cpStopWindow(current.profileId, current.conversationId))
      .toMatchObject({ snapshot_id: replacement.window.snapshot_id, stop_confirmed: 0 });
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
