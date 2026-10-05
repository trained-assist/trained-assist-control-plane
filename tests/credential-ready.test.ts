import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../src/taskstore';
import { CfWorkflowPort } from '../src/workflow-port';
import { conversationPlan } from '../src/workflow-port/conversation-plan';
import type { PlanParams } from '../src/workflow-port/conversation-plan';
import type { StepCtx } from '../src/workflow-port/step-ctx';
import type { RunnerApiAdapter } from '../src/runner-adapter';
import type { CredentialReadyEvent } from '../src/awaiting/credential-ready';
import worker from '../src/index';
import { signPrincipal } from '../src/auth/principal-auth';
import { dispatchAcceptedAgent } from '../src/output/communication-v1';
import type { RouteResult } from '../src/router/service';
import { env } from './env';

const requirement = { hostPrincipalId: 'credential-host', provider: 'fixture-provider', bindingRef: 'fixture-binding', providerSessionRef: 'fixture-session' };
const taskIds: string[] = [];

afterEach(async () => {
  for (const taskId of taskIds.splice(0)) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM credential_completions WHERE user_task_id = ?').bind(taskId),
      env.DB.prepare('DELETE FROM awaiting_inputs WHERE user_task_id = ?').bind(taskId),
      env.DB.prepare('DELETE FROM task_signals WHERE user_task_id = ?').bind(taskId),
      env.DB.prepare('DELETE FROM task_events WHERE user_task_id = ?').bind(taskId),
      env.DB.prepare('DELETE FROM executions WHERE task_id = ?').bind(taskId),
      env.DB.prepare('DELETE FROM durable_tasks WHERE id = ?').bind(taskId),
    ]);
  }
});

async function parked() {
  const store = new TaskStore(env.DB);
  const taskId = `credential-${crypto.randomUUID()}`;
  taskIds.push(taskId);
  await store.admitTask({ id: taskId, profileId: 'credential-profile', goal: 'finish outstanding agent work' });
  const { awaitingInputId } = await store.openAwaiting({ taskId, purpose: 'credential', question: 'Connect provider',
    respondentScope: 'credential-profile', schema: { credential: requirement } });
  const awaiting = (await store.getAwaiting(awaitingInputId))!;
  const event: CredentialReadyEvent = { ...requirement, awaitingInputId, userTaskId: taskId,
    profileId: 'credential-profile', eventId: `ready-${crypto.randomUUID()}`, generation: awaiting.generation, version: awaiting.version };
  return { store, taskId, awaitingInputId, event };
}

function wakePort(store: TaskStore, sendEvent = vi.fn(async () => {})) {
  const workflow = { get: vi.fn(async () => ({ status: async () => ({ status: 'waiting' }), sendEvent })) };
  return { port: new CfWorkflowPort(workflow as unknown as Workflow, store), workflow, sendEvent };
}

describe('verified credential completion', () => {
  it('keeps a pre-execution continuation pending without trusted execution settings', async () => {
    const { store, taskId, event } = await parked();
    const workflow = { get: vi.fn(async () => { throw new Error('not started'); }), create: vi.fn() };
    const port = new CfWorkflowPort(workflow as unknown as Workflow, store);
    expect(await port.completeCredential(event)).toMatchObject({ delivered: false });
    expect(workflow.create).not.toHaveBeenCalled();
    expect(await store.listRuns(taskId)).toHaveLength(0);
    expect(await store.pendingCredentialContinuations()).toEqual(expect.arrayContaining([expect.objectContaining({ user_task_id: taskId })]));
  });

  it('preserves configured native engine and runtime budgets when readiness starts initial work', async () => {
    const { store, taskId, event, awaitingInputId } = await parked();
    const workflow = { get: vi.fn(async () => { throw new Error('not started'); }), create: vi.fn(async () => ({})) };
    const execution = { runnerEngine: 'dynamic-ip-azure-agent-run', runnerTimeoutSec: 900, runnerPollSec: 3 };
    const port = new CfWorkflowPort(workflow as unknown as Workflow, store, execution);
    expect(await port.completeCredential(event)).toMatchObject({ delivered: true });
    expect(workflow.create).toHaveBeenCalledWith({ id: taskId, params: expect.objectContaining({
      ...execution, taskId, generation: event.generation, awaitingInputId,
    }) });
    expect(await port.completeCredential(event)).toMatchObject({ duplicate: true, delivered: true });
    expect(workflow.create).toHaveBeenCalledTimes(1);
  });

  it('adopts the registered credential wait before Output dispatch starts the workflow', async () => {
    const { store, taskId, awaitingInputId } = await parked();
    const workflow = { get: vi.fn(async () => { throw new Error('not started'); }), create: vi.fn(async (_input: { id: string; params: PlanParams }) => ({})) };
    const port = new CfWorkflowPort(workflow as unknown as Workflow, store);
    const task = await store.requireTask(taskId);
    await dispatchAcceptedAgent(store, port, task, { continuation: { goal: task.goal } } as RouteResult, 'dynamic-ip-azure-agent-run');
    expect(workflow.create).toHaveBeenCalledWith({ id: taskId, params: expect.objectContaining({
      awaitingInputId, runnerEngine: 'dynamic-ip-azure-agent-run',
    }) });
    expect((await store.getAwaiting(awaitingInputId))?.status).toBe('open');
    const submit = vi.fn();
    const waitFor = vi.fn(async () => { throw new Error('credential wait reached'); });
    const params = workflow.create.mock.calls[0]![0].params;
    await expect(conversationPlan({ waitFor } as unknown as StepCtx, store, params, {
      adapter: { submit } as unknown as RunnerApiAdapter,
    })).rejects.toThrow('credential wait reached');
    expect(waitFor).toHaveBeenCalledWith('wait', 'credential_ready', expect.any(Number));
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects text and generic signals without storing a credential answer', async () => {
    const { store, taskId, awaitingInputId } = await parked();
    await expect(store.answerAwaitingById({ awaitingInputId, idempotencyKey: 'user-text', answer: { answer: 'I connected it' } })).rejects.toThrow('verified_credential_event_required');
    await expect(store.answerAwaiting({ taskId, answer: 'ready' })).rejects.toThrow('verified_credential_event_required');
    const { port } = wakePort(store);
    expect(await port.signal(taskId, 'user_reply', { answer: 'ready' })).toMatchObject({ delivered: false, reason: 'verified_credential_event_required' });
    expect((await store.getAwaiting(awaitingInputId))?.status).toBe('open');
    expect(await store.listSignals(taskId)).toHaveLength(0);
  });

  it.each(['generation', 'version', 'profileId', 'provider', 'bindingRef', 'providerSessionRef', 'hostPrincipalId', 'userTaskId'] as const)('rejects a mismatched %s before any durable effect', async field => {
    const { store, taskId, event } = await parked();
    const invalid = { ...event, [field]: typeof event[field] === 'number' ? Number(event[field]) + 1 : 'other-reference' };
    await expect(store.completeCredentialAwaiting(invalid)).rejects.toThrow();
    expect((await store.requireTask(taskId)).status).toBe('awaiting_input');
    expect(await store.pendingCredentialContinuations()).not.toEqual(expect.arrayContaining([expect.objectContaining({ user_task_id: taskId })]));
    expect(await store.listSignals(taskId)).toHaveLength(0);
  });

  it('rejects a completion after task generation changes', async () => {
    const { store, taskId, event } = await parked();
    await store.bumpGeneration(taskId, { reason: 'superseded' });
    await expect(store.completeCredentialAwaiting(event)).rejects.toThrow();
    expect((await store.requireTask(taskId)).status).toBe('awaiting_input');
  });

  it('rejects expired and cancelled waits', async () => {
    const expired = await parked();
    await env.DB.prepare('UPDATE awaiting_inputs SET deadline_at = ? WHERE awaiting_input_id = ?').bind(Date.now() - 1, expired.awaitingInputId).run();
    await expect(expired.store.completeCredentialAwaiting(expired.event)).rejects.toThrow();
    const cancelled = await parked();
    await cancelled.store.commit(cancelled.taskId, cancelled.event.generation, { status: 'cancelled' });
    await expect(cancelled.store.completeCredentialAwaiting(cancelled.event)).rejects.toThrow();
    expect((await cancelled.store.requireTask(cancelled.taskId)).status).toBe('cancelled');
  });

  it('persists readiness, wait answer and continuation intent atomically, and deduplicates a lost ACK', async () => {
    const { store, taskId, awaitingInputId, event } = await parked();
    const first = await store.completeCredentialAwaiting(event);
    expect(first.duplicate).toBe(false);
    const repeat = await store.completeCredentialAwaiting(event);
    expect(repeat.duplicate).toBe(true);
    expect((await store.getAwaiting(awaitingInputId))?.status).toBe('answered');
    expect((await store.requireTask(taskId)).status).toBe('active');
    expect(await store.listSignals(taskId)).toHaveLength(1);
    expect((await store.history(taskId)).filter(entry => entry.kind === 'continuation.created')).toHaveLength(1);
    expect((await store.pendingCredentialContinuations()).filter(entry => entry.user_task_id === taskId)).toHaveLength(1);
    await expect(store.completeCredentialAwaiting({ ...event, bindingRef: 'other-binding' })).rejects.toThrow('answer conflict');
  });

  it('deduplicates concurrent copies of the same verified event', async () => {
    const { store, taskId, event } = await parked();
    await Promise.all([store.completeCredentialAwaiting(event), store.completeCredentialAwaiting(event)]);
    expect(await store.listSignals(taskId)).toHaveLength(1);
    expect((await store.history(taskId)).filter(entry => entry.kind === 'continuation.created')).toHaveLength(1);
  });

  it('recovers a durable continuation after wake failure without changing task or generation', async () => {
    const { store, taskId, event } = await parked();
    await store.startRun(taskId, { engine: 'cloudflare-workflows', generation: event.generation, sessionId: null });
    const failed = wakePort(store, vi.fn(async () => { throw new Error('wake unavailable'); }));
    expect(await failed.port.completeCredential(event)).toMatchObject({ delivered: false });
    const recovered = wakePort(new TaskStore(env.DB));
    await recovered.port.recoverCredentialContinuations();
    expect(recovered.sendEvent).toHaveBeenCalledWith({ type: 'credential_ready', payload: { awaitingInputId: event.awaitingInputId } });
    expect(await recovered.port.completeCredential(event)).toMatchObject({ duplicate: true, delivered: true });
    expect(recovered.sendEvent).toHaveBeenCalledTimes(1);
    expect((await store.requireTask(taskId)).generation).toBe(event.generation);
    expect(await store.listRuns(taskId)).toHaveLength(1);
  });

  it('never wakes a cancelled task after readiness was persisted', async () => {
    const { store, taskId, event } = await parked();
    await store.completeCredentialAwaiting(event);
    await store.commit(taskId, event.generation, { status: 'cancelled' });
    const { port, sendEvent } = wakePort(store);
    await port.recoverCredentialContinuations();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('does not wake a superseded wait after another interaction opens', async () => {
    const { store, taskId, event } = await parked();
    await store.completeCredentialAwaiting(event);
    await store.openAwaiting({ taskId, purpose: 'missing_fact', question: 'Different interaction', respondentScope: event.profileId });
    const { port, sendEvent } = wakePort(store);
    await port.recoverCredentialContinuations();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('does not complete outstanding work as no_engine when a credential answer is ready', async () => {
    const { store, taskId, awaitingInputId, event } = await parked();
    await store.completeCredentialAwaiting(event);
    const outcome = await conversationPlan({} as StepCtx, store, { taskId, profileId: event.profileId, generation: event.generation, awaitingInputId });
    expect(outcome).toEqual({ ok: false, reason: 'credential_execution_unavailable' });
    expect((await store.requireTask(taskId)).status).toBe('active');
    const submit = vi.fn(async () => { throw new Error('Runner continuation reached'); });
    const ctx = { step: async (_name: string, operation: () => Promise<unknown>) => operation() } as StepCtx;
    await expect(conversationPlan(ctx, store, { taskId, profileId: event.profileId, generation: event.generation, awaitingInputId }, {
      adapter: { submit } as unknown as RunnerApiAdapter,
    })).rejects.toThrow('Runner continuation reached');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ userTaskId: taskId })]));
    expect((await store.requireTask(taskId)).status).toBe('active');
  });

  it('refuses interrupted Runner execution instead of starting another run', async () => {
    const { store, taskId, event } = await parked();
    await store.startRun(taskId, { engine: 'opencode', generation: event.generation, sessionId: 'existing-runner-session' });
    await expect(store.completeCredentialAwaiting(event)).rejects.toThrow();
  });

  it('requires a host-registered wait before submitting a credential-dependent task', async () => {
    const store = new TaskStore(env.DB);
    const taskId = `credential-${crypto.randomUUID()}`;
    taskIds.push(taskId);
    const { port, workflow } = wakePort(store);
    await expect(port.submit({ id: taskId, profileId: 'credential-profile', goal: 'needs provider', awaitingPurpose: 'credential' })).rejects.toThrow('registered_credential_wait_required');
    expect(workflow.get).not.toHaveBeenCalled();
    expect(await store.listRuns(taskId)).toHaveLength(0);
  });

  it('requires a signed registered host and rejects unverified states at the HTTP boundary', async () => {
    const { store, event, awaitingInputId } = await parked();
    const secret = 'credential-test-secret';
    const { workflow, sendEvent } = wakePort(store);
    const bindings = { DB: env.DB, TASK_WORKFLOW: workflow as unknown as Workflow, PRINCIPAL_SECRET: secret, CREDENTIAL_HOST_PRINCIPALS: requirement.hostPrincipalId };
    await store.upsertPrincipal({ principalId: requirement.hostPrincipalId, profileId: event.profileId, scopes: ['tasks:signal', 'tasks:control'] });
    await store.upsertPrincipal({ principalId: 'ordinary-user', profileId: event.profileId, scopes: ['tasks:signal', 'tasks:control'] });
    const request = async (principal: string, status: string, signed = true) => worker.fetch(new Request(`https://cp.test/awaiting/${awaitingInputId}/credential-ready`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-principal': principal,
        'x-principal-sig': signed ? await signPrincipal(principal, secret) : 'wrong-signature' },
      body: JSON.stringify({ ...event, status }),
    }), bindings);
    expect((await request(requirement.hostPrincipalId, 'ready', false)).status).toBe(403);
    expect((await request('ordinary-user', 'ready')).status).toBe(403);
    expect((await request(requirement.hostPrincipalId, 'stored')).status).toBe(409);
    const preflight = await worker.fetch(new Request(`https://cp.test/awaiting/${awaitingInputId}/credential-ready`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-principal': requirement.hostPrincipalId,
        'x-principal-sig': await signPrincipal(requirement.hostPrincipalId, secret), 'x-zerocreds-preflight': 'true' },
      body: JSON.stringify({ ...event, status: 'ready' }),
    }), bindings);
    expect(preflight.status).toBe(409);
    expect((await store.getAwaiting(awaitingInputId))?.status).toBe('open');
    expect((await request(requirement.hostPrincipalId, 'ready')).status).toBe(200);
    expect((await store.getAwaiting(awaitingInputId))?.status).toBe('answered');
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect((await request(requirement.hostPrincipalId, 'ready')).status).toBe(200);
    expect(sendEvent).toHaveBeenCalledTimes(1);
  });
});
