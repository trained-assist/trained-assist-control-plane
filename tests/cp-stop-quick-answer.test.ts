import { describe, expect, it, vi } from 'vitest';
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import { CfWorkflowPort } from '../src/workflow-port/workflow-port';
import { CpStopTargetsService } from '../src/workflow-port/external-stop';
import { communicationV1Catalog } from '../src/router/communication-v1';
import { deriveAuthorization } from '../src/router/authorization';
import { routeRequest } from '../src/router/service';
import { commitQuickAnswer } from '../src/output/communication-v1';

let sequence = 0;

async function fixture(capability = 'system_health', executed = false) {
  const store = new TaskStore(env.DB);
  const suffix = `${Date.now()}-${++sequence}`;
  const taskId = `stop-quick-${suffix}`;
  const profileId = `stop-quick-profile-${suffix}`;
  const conversationId = `stop-quick-conversation-${suffix}`;
  const requestId = `tgcp-${String(sequence).padStart(64, '0')}`;
  const { task } = await store.admitTask({ id: taskId, profileId, conversationId, requestId,
    receiptId: `${taskId}-receipt`, goal: 'Работает?' });
  if (executed) {
    const attempt = await store.startRun(taskId, { generation: 1 });
    await store.finishRun(attempt.id, 'failed', { errorClass: 'fixture_prior_execution' });
  }
  const catalog = communicationV1Catalog();
  const principalId = `${taskId}-principal`;
  const selection = await routeRequest({
    envelope: { principalId, profileId, userTaskId: taskId, conversationId, requestId,
      catalogVersion: catalog.version, policyVersion: 'communication-v1', budgets: { llmCallsRemaining: 2, agentAllowed: true }, runId: null },
    prepared: { text: task.goal, originalInput: { inputItems: [{ text: task.goal }] },
      context: { pendingProposal: null, lastAssistantText: null, sessionEmpty: true, relevantTurns: 0 },
      attachments: [], typedSignal: null, contextVersion: 'fixture-context', readinessSnapshotPresent: true },
    catalog,
    authorization: await deriveAuthorization({ principalId, profileId, scopes: ['tasks:read', 'tasks:control'],
      grantedCapabilityIds: catalog.capabilities.map(entry => entry.id), grantedIntegrationIds: [] }, catalog),
    hostFacts: { clockMs: Date.now(), connections: {}, profileFields: {}, activeTasks: [], tasksYesterday: [] },
  }, { communicationV1: { select: async () => ({ user_goal: task.goal, decision: capability }),
    health: async () => ({ runner: 'reachable', checkedAt: '2026-10-06T00:00:00Z' }) } });
  await store.saveRoutingSelection(taskId, 1, selection);
  await commitQuickAnswer(store, task, selection);
  const resolution = await store.resolveCpStopTargets({ profileId, conversationId, admissionRequestIds: [requestId] });
  if (!resolution.ok) throw new Error('fixture resolution failed');
  const target = resolution.targets[0]!;
  const input = { profileId, conversationId, windowId: `${taskId}-window`, admissionRequestIds: [requestId],
    admissionBarrierComplete: true, restart: false };
  const opened = await store.openCpStopWindow({ ...input, targets: [target] });
  if (!opened.ok) throw new Error('fixture snapshot failed');
  const get = vi.fn(async () => { throw new Error('instance.not_found'); });
  const stop = vi.fn(async () => ({ state: 'unknown' as const }));
  const port = new CfWorkflowPort({ get } as unknown as Workflow, store, undefined, { stop });
  const service = new CpStopTargetsService(store, port);
  return { store, taskId, profileId, input, target, pin: { target, snapshotId: opened.window.snapshot_id }, get, stop, port, service };
}

describe('no-Workflow quick-answer stop evidence', () => {
  it.each(['system_health', 'catalog.brief'])('confirms only durable no-run %s through the real missing Workflow binding', async capability => {
    const current = await fixture(capability);
    const before = await current.store.requireTask(current.taskId);
    const port = new CfWorkflowPort(env.TASK_WORKFLOW, current.store);
    const service = new CpStopTargetsService(current.store, port);
    expect(await service.stop(current.input)).toMatchObject({ stopConfirmed: true, unresolved: false });
    expect(await service.stop(current.input)).toMatchObject({ stopConfirmed: true });
    expect(await current.store.requireTask(current.taskId)).toEqual(before);
    expect(await current.store.listRuns(current.taskId)).toEqual([]);
    expect((await current.store.history(current.taskId)).filter(event => event.kind === 'cancel_requested' || event.kind === 'task_cancelled')).toEqual([]);
  });

  it('does not treat arbitrary lookup failure or a running Workflow as no-Workflow evidence', async () => {
    const current = await fixture();
    current.get.mockRejectedValueOnce(new Error('HTTP_500 Workflow lookup failed'));
    expect(await current.service.stop(current.input)).toMatchObject({ stopConfirmed: false, unresolved: true });
    const workflow = { get: vi.fn(async () => ({ status: async () => ({ status: 'running' }) })) } as unknown as Workflow;
    const port = new CfWorkflowPort(workflow, current.store);
    expect(await port.cancel(current.taskId, { stopPin: current.pin })).toMatchObject({ stopConfirmed: false });
    expect(current.stop).not.toHaveBeenCalled();
  });

  it.each(['routing', 'output', 'submit', 'nonterminal', 'answer', 'version', 'decision'])('refuses missing or contradictory %s provenance', async missing => {
    const current = await fixture();
    if (missing === 'routing') await env.DB.prepare("DELETE FROM task_events WHERE user_task_id = ? AND kind = 'routing.selected'").bind(current.taskId).run();
    if (missing === 'output') await env.DB.prepare("DELETE FROM task_events WHERE user_task_id = ? AND source = 'output'").bind(current.taskId).run();
    if (missing === 'submit') await current.store.logEvent({ taskId: current.taskId, source: 'executor', kind: 'progress',
      payload: { event: 'runner_submit_started', attemptId: null, idempotencyKey: 'fixture-unknown-submit' } });
    if (missing === 'nonterminal') await env.DB.prepare("UPDATE durable_tasks SET status = 'active' WHERE id = ?").bind(current.taskId).run();
    if (missing === 'answer') {
      await env.DB.prepare("UPDATE durable_tasks SET result_json = json_remove(result_json, '$.answer') WHERE id = ?").bind(current.taskId).run();
      await env.DB.prepare("UPDATE task_events SET payload_json = json_remove(payload_json, '$.reply.text') WHERE user_task_id = ? AND kind = 'routing.selected'").bind(current.taskId).run();
    }
    if (missing === 'version') {
      await env.DB.prepare("UPDATE durable_tasks SET result_json = json_remove(result_json, '$.quickAnswer.version') WHERE id = ?").bind(current.taskId).run();
      await env.DB.prepare("UPDATE task_events SET payload_json = json_remove(payload_json, '$.decision.capabilityVersion') WHERE user_task_id = ? AND kind = 'routing.selected'").bind(current.taskId).run();
      await env.DB.prepare("UPDATE task_events SET payload_json = json_remove(payload_json, '$.capabilityVersion') WHERE user_task_id = ? AND source = 'output'").bind(current.taskId).run();
    }
    if (missing === 'decision') {
      await env.DB.prepare("UPDATE task_events SET payload_json = json_remove(payload_json, '$.decisionId') WHERE user_task_id = ? AND kind = 'routing.selected'").bind(current.taskId).run();
      await env.DB.prepare("UPDATE task_events SET payload_json = json_remove(payload_json, '$.decisionId') WHERE user_task_id = ? AND source = 'output'").bind(current.taskId).run();
    }
    expect(await current.service.stop(current.input)).toMatchObject({ stopConfirmed: false, unresolved: true });
    expect(current.stop).not.toHaveBeenCalled();
  });

  it('does not infer Workflow absence for a task with historical execution even if its answer looks quick', async () => {
    const current = await fixture('system_health', true);
    expect(await current.service.stop(current.input)).toMatchObject({ stopConfirmed: false });
    expect(current.get).toHaveBeenCalledOnce();
    expect(current.stop).not.toHaveBeenCalled();
  });

  it.each(['pending', 'accepted', 'unknown', 'failed'])('holds restart while CP output state is %s', async state => {
    const current = await fixture();
    const queued = await current.store.queueDelivery({ taskId: current.taskId, logicalMessageId: `${current.taskId}-reply`,
      channel: 'telegram', message: { text: 'fixture answer' } });
    if (state === 'accepted') await current.store.claimDelivery('fixture-owner', { taskId: current.taskId });
    if (state === 'failed') await env.DB.prepare("UPDATE deliveries SET status = 'failed' WHERE id = ?").bind(queued.delivery.id).run();
    if (state === 'unknown' || state === 'failed') await env.DB.prepare('UPDATE durable_tasks SET delivery_state = ? WHERE id = ?')
      .bind(state, current.taskId).run();
    expect(await current.service.stop(current.input)).toMatchObject({ stopConfirmed: false, unresolved: true });
    expect(current.get).not.toHaveBeenCalled();
    expect(current.stop).not.toHaveBeenCalled();
    await current.store.confirmDelivery(queued.delivery.id, { providerMessageId: 'offline-fixture-provider-ack' });
    expect(await current.service.stop(current.input)).toMatchObject({ stopConfirmed: true });
  });

  it('guards confirmation when delivery is queued after the stop observation but before snapshot persistence', async () => {
    const current = await fixture();
    const update = current.store.updateCpStopWindow.bind(current.store);
    vi.spyOn(current.store, 'updateCpStopWindow').mockImplementationOnce(async input => {
      await current.store.queueDelivery({ taskId: current.taskId, logicalMessageId: `${current.taskId}-late-reply`,
        channel: 'telegram', message: { text: 'fixture late reply' } });
      return update(input);
    });
    expect(await current.service.stop(current.input)).toMatchObject({ stopConfirmed: false, unresolved: true });
    expect(await current.store.cpStopWindow(current.profileId, current.input.conversationId)).toMatchObject({ stop_confirmed: 0 });
  });
});
