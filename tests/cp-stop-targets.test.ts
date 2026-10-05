import { describe, expect, it } from 'vitest';
import { TaskStore } from '../src/taskstore';
import { CfWorkflowPort } from '../src/workflow-port/workflow-port';
import { signPrincipal } from '../src/auth/principal-auth';
import worker, { type Env } from '../src/index';
import { env } from './env';

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${++sequence}`;
const bindings = {
  DB: env.DB,
  TASK_WORKFLOW: env.TASK_WORKFLOW,
  PRINCIPAL_SECRET: 'stop-target-http-test-secret',
  NATIVE_CANCEL_CONFIRMATION: 'true',
};

async function postStop(input: Record<string, unknown>, profileId = String(input.profileId)) {
  const principalId = `stop-target-test:${profileId}`;
  const store = new TaskStore(bindings.DB);
  await store.upsertPrincipal({ principalId, profileId, scopes: ['tasks:control', 'tasks:read'] });
  const response = await worker.fetch(new Request('https://cp.test/cp-stop-targets', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-principal': principalId,
      'x-principal-sig': await signPrincipal(principalId, bindings.PRINCIPAL_SECRET),
    },
    body: JSON.stringify(input),
  }), bindings as unknown as Env);
  return { response, body: await response.json() as Record<string, unknown> };
}

async function admittedDoneTask(store: TaskStore, input: { id: string; profileId: string; conversationId: string; requestId: string }) {
  const { task } = await store.admitTask({
    id: input.id,
    profileId: input.profileId,
    conversationId: input.conversationId,
    requestId: input.requestId,
    receiptId: `receipt:${input.requestId}`,
    goal: 'done before stop window',
  });
  await store.commit(task.id, task.generation, { status: 'done', stage: 'finished', result: { ok: true } });
  return task;
}

describe('POST /cp-stop-targets', () => {
  it('returns unresolved before the durable admission barrier closes', async () => {
    const profileId = nextId('profile');
    const { response, body } = await postStop({
      profileId,
      conversationId: nextId('conversation'),
      windowId: nextId('window'),
      admissionBarrierComplete: false,
      admissionRequestIds: [],
    }, profileId);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ snapshotId: null, unresolved: true, reason: 'admission_unknown', stopConfirmed: false, tasks: [] });
  });

  it('rejects a profile outside the principal scope and malformed Telegram admission IDs without creating snapshots', async () => {
    const profileId = nextId('profile');
    const otherProfileId = nextId('profile');
    const conversationId = nextId('conversation');
    const windowId = nextId('window');
    const unauthorized = await postStop({ profileId, conversationId, windowId,
      admissionBarrierComplete: true, admissionRequestIds: [] }, otherProfileId);
    expect(unauthorized.response.status).toBe(403);

    const malformed = await postStop({ profileId, conversationId, windowId,
      admissionBarrierComplete: true, admissionRequestIds: ['tgcp-not-a-valid-id'] }, profileId);
    expect(malformed.body).toMatchObject({ snapshotId: null, unresolved: true,
      reason: 'identity_mismatch', stopConfirmed: false });
    expect(await new TaskStore(bindings.DB).cpStopWindow(profileId, conversationId)).toBeNull();
  });

  it('returns the same durable snapshot to concurrent identical first requests', async () => {
    const profileId = nextId('profile');
    const conversationId = nextId('conversation');
    const requestId = `tgcp-${'d'.repeat(64)}`;
    const task = await admittedDoneTask(new TaskStore(bindings.DB), {
      id: nextId('task'), profileId, conversationId, requestId,
    });
    const input = { profileId, conversationId, windowId: nextId('window'),
      admissionBarrierComplete: true, admissionRequestIds: [requestId] };
    const [first, second] = await Promise.all([postStop(input, profileId), postStop(input, profileId)]);
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(first.body.snapshotId).toBe(second.body.snapshotId);
    expect(first.body.tasks).toEqual(second.body.tasks);
    expect(first.body.tasks).toMatchObject([{ userTaskId: task.id, requestId }]);
  });

  it('freezes exact receipt identities until explicit restart and never adds later tasks to the old window', async () => {
    const profileId = nextId('profile');
    const conversationId = nextId('conversation');
    const firstRequest = `tgcp-${'a'.repeat(64)}`;
    const secondRequest = `tgcp-${'b'.repeat(64)}`;
    const store = new TaskStore(bindings.DB);
    const first = await admittedDoneTask(store, { id: nextId('task'), profileId, conversationId, requestId: firstRequest });
    const input = {
      profileId,
      conversationId,
      windowId: nextId('window'),
      admissionBarrierComplete: true,
      admissionRequestIds: [firstRequest],
      restart: false,
    };

    const initial = await postStop(input, profileId);
    expect(initial.response.status).toBe(200);
    expect(initial.body).toMatchObject({ unresolved: false, stopConfirmed: true, tasks: [
      { requestId: firstRequest, userTaskId: first.id, profileId, receiptId: `receipt:${firstRequest}` },
    ] });
    const snapshotId = initial.body.snapshotId;

    const second = await admittedDoneTask(store, { id: nextId('task'), profileId, conversationId, requestId: secondRequest });
    const retry = await postStop(input, profileId);
    expect(retry.body.snapshotId).toBe(snapshotId);
    expect(retry.body.tasks).toEqual(initial.body.tasks);
    expect((retry.body.tasks as unknown[]).map((task) => (task as { userTaskId: string }).userTaskId)).not.toContain(second.id);

    const restarted = await postStop({ ...input, windowId: nextId('window'), admissionRequestIds: [firstRequest, secondRequest], restart: true }, profileId);
    expect(restarted.response.status).toBe(200);
    expect(restarted.body.unresolved).toBe(false);
    expect(restarted.body.snapshotId).not.toBe(snapshotId);
    expect((restarted.body.tasks as Array<{ userTaskId: string }>).map((task) => task.userTaskId)).toEqual([first.id, second.id]);
  });

  it('uses a real Workflow binding and holds unresolved stop on an attempt with unknown native launch', async () => {
    const profileId = nextId('profile');
    const conversationId = nextId('conversation');
    const requestId = `tgcp-${'c'.repeat(64)}`;
    const taskId = nextId('task');
    const store = new TaskStore(bindings.DB);
    const port = new CfWorkflowPort(bindings.TASK_WORKFLOW, store);
    const submitted = await port.submit({
      id: taskId,
      profileId,
      conversationId,
      requestId,
      receiptId: `receipt:${requestId}`,
      goal: 'park before native launch is reconciled',
      awaitingPurpose: 'missing_fact',
      waitTimeoutSec: 600,
    });
    for (let attempt = 0; attempt < 100 && !(await store.getOpenAwaiting(taskId)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await store.getOpenAwaiting(taskId)).not.toBeNull();
    await store.logEvent({ taskId, kind: 'progress', generation: submitted.generation, executionId: submitted.runId,
      source: 'executor', payload: { event: 'runner_submit_started', attemptId: submitted.runId, idempotencyKey: 'same-attempt-key' } });

    const input = {
      profileId,
      conversationId,
      windowId: nextId('window'),
      admissionBarrierComplete: true,
      admissionRequestIds: [requestId],
    };
    const first = await postStop(input, profileId);
    expect(first.body).toMatchObject({ unresolved: true, reason: 'native_stop_unknown', stopConfirmed: false,
      tasks: [{ userTaskId: taskId, requestId }] });
    const snapshotId = first.body.snapshotId;
    const second = await postStop(input, profileId);
    expect(second.body.snapshotId).toBe(snapshotId);
    expect(second.body.unresolved).toBe(true);
    expect((await store.requireTask(taskId)).status).not.toBe('cancelled');
  }, 30_000);
});
