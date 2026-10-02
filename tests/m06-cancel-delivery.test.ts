// Эпик #109 шаг 6 «Отмена и доставка»:
//  - раздельные «запрос отмены» и «подтверждённая остановка» (доказано в
//    p05-p06-status-recovery.test.ts, здесь — сквозная проверка с доставкой);
//  - ОДИН владелец доставки;
//  - retry доставки НЕ повторяет execution;
//  - артефакты после отмены сохраняются.
import { TaskStore } from '../src/taskstore';
import { CfWorkflowPort, deliverOnce, PLAN_VERSION, type DeliveryAdapter } from '../src/workflow-port';
import { describe, expect, it, vi } from 'vitest';
import { env } from './env';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pollUntil = async <T>(label: string, fn: () => Promise<T | null | undefined>, timeoutMs = 30_000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(50);
  }
};

const setup = () => {
  const store = new TaskStore(env.DB);
  const port = new CfWorkflowPort(env.TASK_WORKFLOW, store);
  return { store, port };
};

const doneTask = async (store: TaskStore, port: CfWorkflowPort, taskId = nextId('m06')) => {
  await port.submit({ id: taskId, profileId: 'profile-1', goal: 'отмена и доставка' });
  await pollUntil('awaiting_input', async () => store.getOpenAwaiting(taskId));
  await port.signal(taskId, 'user_reply', { answer: 'да' }, { idempotencyKey: `web:${taskId}` });
  await pollUntil('done', async () => {
    const row = await store.requireTask(taskId);
    return row.status === 'done' ? row : null;
  });
  return taskId;
};

describe('M06: доставка — один владелец и retry без повтора execution', () => {
  it('постановка в outbox идемпотентна по logicalMessageId; проекция delivery_state', async () => {
    const { store, port } = setup();
    const taskId = await doneTask(store, port);

    const first = await store.queueDelivery({
      taskId,
      logicalMessageId: `result-${taskId}`,
      channel: 'telegram',
      message: { text: 'Готово' },
    });
    const second = await store.queueDelivery({
      taskId,
      logicalMessageId: `result-${taskId}`,
      channel: 'telegram',
      message: { text: 'Готово' },
    });

    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    expect(second.delivery.id).toBe(first.delivery.id);
    expect(await store.listDeliveries(taskId)).toHaveLength(1);
    expect((await store.requireTask(taskId)).delivery_state).toBe('pending');

    const queued = (await store.history(taskId)).filter((e) => e.kind === 'delivery_queued');
    expect(queued).toHaveLength(1);
  });

  it('ОДИН владелец: две конкурентные отправки — одна доставка уходит один раз', async () => {
    const { store, port } = setup();
    const taskId = await doneTask(store, port);
    await store.queueDelivery({ taskId, logicalMessageId: `one-${taskId}`, channel: 'telegram', message: { text: 'ok' } });

    const adapter: DeliveryAdapter = { send: async () => ({ providerMessageId: 'tg-msg-1' }) };
    const [a, b] = await Promise.all([
      deliverOnce(store, 'owner-a', adapter, { taskId }),
      deliverOnce(store, 'owner-b', adapter, { taskId }),
    ]);

    const results = [a, b].filter(Boolean);
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe('delivered');

    const deliveries = await store.listDeliveries(taskId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('delivered');
    expect(deliveries[0]!.attempt).toBe(1);
    expect(deliveries[0]!.provider_message_id).toBe('tg-msg-1');
    expect((await store.requireTask(taskId)).delivery_state).toBe('delivered');
  });

  it('управляемый сбой отправки: bounded retry, execution НЕ повторяется', async () => {
    const { store, port } = setup();
    const taskId = await doneTask(store, port);
    await store.queueDelivery({ taskId, logicalMessageId: `retry-${taskId}`, channel: 'api', message: { text: 'ok' } });

    // Снимок исполнения ДО неудачной отправки.
    const taskBefore = await store.requireTask(taskId);
    const runsBefore = await store.listRuns(taskId);
    const eventsBefore = await store.history(taskId);

    const send = vi.fn().mockRejectedValueOnce(new Error('injected: provider 500')).mockResolvedValue({ providerMessageId: 'api-1' });
    const adapter: DeliveryAdapter = { send };

    const failed = await deliverOnce(store, 'owner-a', adapter, { taskId, retryAfterSec: 0, maxAttempts: 3 });
    expect(failed!.outcome).toBe('retry_scheduled');
    expect(failed!.attempt).toBe(1);

    // Провал доставки не тронул исполнение: статус, поколение и попытки те же;
    // изменилась только проекция доставки.
    const taskAfterFail = await store.requireTask(taskId);
    expect(taskAfterFail.status).toBe(taskBefore.status);
    expect(taskAfterFail.generation).toBe(taskBefore.generation);
    expect(taskAfterFail.result_json).toBe(taskBefore.result_json);
    expect(taskAfterFail.delivery_state).toBe('pending');
    expect(await store.listRuns(taskId)).toEqual(runsBefore);

    const firstEvents = await store.history(taskId);
    const newKinds = firstEvents.slice(eventsBefore.length).map((e) => e.kind);
    expect(newKinds).toEqual(['delivery_failed']);

    // Повтор доставки (retry) — тоже без повтора execution.
    const retried = await deliverOnce(store, 'owner-a', adapter, { taskId, retryAfterSec: 0, maxAttempts: 3 });
    expect(retried!.outcome).toBe('delivered');
    expect(retried!.attempt).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);

    const taskAfterRetry = await store.requireTask(taskId);
    expect(taskAfterRetry.status).toBe(taskBefore.status);
    expect(taskAfterRetry.generation).toBe(taskBefore.generation);
    expect(taskAfterRetry.result_json).toBe(taskBefore.result_json);
    expect(taskAfterRetry.delivery_state).toBe('delivered');
    expect(await store.listRuns(taskId)).toEqual(runsBefore);
    const deliveryKinds = (await store.history(taskId)).slice(eventsBefore.length).map((e) => e.kind);
    expect(deliveryKinds).toEqual(['delivery_failed', 'delivery_sent']);
  });

  it('исчерпание попыток -> failed без нового retry', async () => {
    const { store, port } = setup();
    const taskId = await doneTask(store, port);
    await store.queueDelivery({ taskId, logicalMessageId: `dead-${taskId}`, channel: 'api', message: { text: 'ok' } });
    const adapter: DeliveryAdapter = { send: async () => { throw new Error('injected: provider down'); } };

    const first = await deliverOnce(store, 'owner-a', adapter, { taskId, retryAfterSec: 0, maxAttempts: 1 });
    expect(first!.outcome).toBe('failed');

    const delivery = (await store.listDeliveries(taskId))[0]!;
    expect(delivery.status).toBe('failed');
    expect(delivery.next_attempt_at).toBeNull();
    expect(delivery.last_error).toContain('injected');
    expect((await store.requireTask(taskId)).delivery_state).toBe('failed');
    // Больше нечего отправлять.
    expect(await deliverOnce(store, 'owner-a', adapter, { taskId, retryAfterSec: 0, maxAttempts: 1 })).toBeNull();
  });
});

describe('M06: отмена, доставка и артефакты', () => {
  it('подтверждённая отмена подавляет retry доставки (C03)', async () => {
    const { store, port } = setup();
    const taskId = nextId('m06-cancel-suppress');
    await port.submit({ id: taskId, profileId: 'profile-1', goal: 'отмена с доставкой' });
    await pollUntil('awaiting_input', async () => store.getOpenAwaiting(taskId));

    await store.queueDelivery({
      taskId,
      logicalMessageId: `cancel-report-${taskId}`,
      channel: 'telegram',
      message: { text: 'отчёт по задаче' },
    });

    // Остановка подтверждена.
    const cancelled = await port.cancel(taskId, { reason: 'user pressed stop' });
    expect(cancelled.cancelled).toBe(true);

    const delivery = (await store.listDeliveries(taskId))[0]!;
    expect(delivery.status).toBe('failed');
    expect(delivery.last_error).toBe('suppressed_by_cancel');
    expect(delivery.next_attempt_at).toBeNull();

    // Воркер доставки не отправляет подавленное.
    const adapter: DeliveryAdapter = { send: async () => ({ providerMessageId: 'tg-x' }) };
    expect(await deliverOnce(store, 'owner-a', adapter, { taskId, retryAfterSec: 0 })).toBeNull();

    const cancelledEvent = (await store.history(taskId)).find((e) => e.kind === 'task_cancelled');
    expect(cancelledEvent).toBeDefined();
    expect(JSON.parse(cancelledEvent!.payload_json).deliveriesSuppressed).toBe(1);
  });

  it('артефакты сохраняются после отмены', async () => {
    const { store, port } = setup();
    const taskId = nextId('m06-artifacts');
    await port.submit({ id: taskId, profileId: 'profile-1', goal: 'артефакт до отмены' });
    await pollUntil('awaiting_input', async () => store.getOpenAwaiting(taskId));

    const run = (await store.listRuns(taskId))[0]!;
    await store.recordArtifact({
      taskId,
      kind: 'report',
      artifactRef: `r2://control-plane/${taskId}/report.md`,
      sizeBytes: 2048,
      checksum: 'sha256:deadbeef',
      runId: run.id,
    });

    const before = await store.listArtifacts(taskId);
    expect(before).toHaveLength(1);

    const cancelled = await port.cancel(taskId, { reason: 'user pressed stop' });
    expect(cancelled.stopConfirmed).toBe(true);
    expect((await store.requireTask(taskId)).status).toBe('cancelled');

    // Отмена не удаляет артефакты: файлы переживают остановку (§4.6).
    const after = await store.listArtifacts(taskId);
    expect(after).toHaveLength(1);
    expect(after[0]!.artifact_id).toBe(before[0]!.artifact_id);
    expect(after[0]!.checksum).toBe('sha256:deadbeef');
    expect(after[0]!.run_id).toBe(run.id);
  });

  it('артефакт финализации попадает в сообщение доставки (ссылки, не байты)', async () => {
    const { store, port } = setup();
    const taskId = await doneTask(store, port);

    const run = (await store.listRuns(taskId))[0]!;
    await store.recordArtifact({
      taskId,
      kind: 'file',
      artifactRef: `r2://control-plane/${taskId}/answer.json`,
      sizeBytes: 64,
      runId: run.id,
      generation: run.generation,
    });
    // Повтор той же ссылки — no-op.
    const again = await store.recordArtifact({
      taskId,
      kind: 'file',
      artifactRef: `r2://control-plane/${taskId}/answer.json`,
      sizeBytes: 64,
      runId: run.id,
    });
    expect(again.created).toBe(false);
    expect(await store.listArtifacts(taskId)).toHaveLength(1);

    const artifacts = await store.listArtifacts(taskId);
    const { delivery } = await store.queueDelivery({
      taskId,
      logicalMessageId: `with-artifacts-${taskId}`,
      channel: 'telegram',
      message: { text: 'Готово', artifactRefs: artifacts.map((a) => a.artifact_ref) },
    });
    const message = JSON.parse(delivery.message_json);
    expect(message.artifactRefs).toEqual([`r2://control-plane/${taskId}/answer.json`]);
    expect(delivery.message_json).not.toContain('64'); // байтов в сообщении нет, только ссылки

    const snapshot = await port.status(taskId);
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.deliveries).toHaveLength(1);
  });
});
