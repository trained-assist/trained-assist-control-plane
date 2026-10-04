import worker from '../src/index';
import { TaskStore } from '../src/taskstore';
import { gatewayDeliveryAdapter, localDeliveryAdapter, resolveDeliveryAdapter } from '../src/intake';
import { describe, expect, it, vi } from 'vitest';
import { env } from './env';

const store = () => new TaskStore(env.DB);

type Ctx = { waitUntil: (p: Promise<unknown>) => void; passedWhileWaiting: boolean };

const dbOf = (s: TaskStore): typeof env.DB => (s as unknown as { db: typeof env.DB }).db;
const fakeCtx = () => ({ waitUntil: () => {}, passedWhileWaiting: false } as unknown as ExecutionContext);

describe('П3c: планировщик watchdog и его работоспособность', () => {
  it('scheduled-обработчик существует и действительно запускает детектор', async () => {
    expect(typeof worker.scheduled).toBe('function');
    const mark = vi.spyOn(TaskStore.prototype, 'markWatchdogRun');
    try {
      await worker.scheduled(
        { cron: '* * * * *', scheduledTime: Date.now(), noRetry: () => {} } as never,
        { ...env, DELIVERY_ADAPTER: 'local' } as never,
        fakeCtx(),
      );
      // Детектор вызван и отметка работоспособности записана.
      expect(mark).toHaveBeenCalledTimes(1);
    } finally {
      mark.mockRestore();
    }
  });

  it('отметка работоспособности пишется только после успешного прохода', async () => {
    const s = store();
    await dbOf(s).prepare('DELETE FROM watchdog_health WHERE id = 1').run();

    const before = await s.lastWatchdogRun();
    expect(before).toBeNull(); // планировщик ещё не отработал ни разу

    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.now(), noRetry: () => {} } as never,
      { ...env, DELIVERY_ADAPTER: 'local' } as never,
      fakeCtx(),
    );

    const after = await s.lastWatchdogRun();
    expect(after).toBeTruthy();
    expect(after!.last_run_at).toBeGreaterThan(0);
    expect(after!.scanned).toBeGreaterThanOrEqual(0);
  });

  it('PREVIEW_ONLY отключает планировщик: preview не должен слать алерты', async () => {
    const s = store();
    await dbOf(s).prepare('DELETE FROM watchdog_health WHERE id = 1').run();
    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.now(), noRetry: () => {} } as never,
      { ...env, DELIVERY_ADAPTER: 'local', PREVIEW_ONLY: 'true' } as never,
      fakeCtx(),
    );
    expect(await s.lastWatchdogRun()).toBeNull();
  });
});

describe('П3b: адаптер канала — реальный или честная заглушка', () => {
  it('по умолчанию — заглушка, и она НЕ является доставкой', async () => {
    const adapter = await resolveDeliveryAdapter({});
    const res = await adapter.send({
      id: 'd-1', user_task_id: 't-1', channel: 'telegram', message_json: '{}',
    } as never);
    // Искусственный идентификатор — признак заглушки, а не подтверждения доставки.
    expect(res.providerMessageId).toMatch(/^local-telegram-/);
  });

  it('реальный адаптер шлёт в шлюз и требует providerMessageId', async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ providerMessageId: 'msg-42' }), { status: 200 }));
    vi.stubGlobal('fetch', send);
    try {
      const adapter = gatewayDeliveryAdapter({ baseUrl: 'https://gw.test', secret: 'sec' });
      const res = await adapter.send({
        id: 'd-1', user_task_id: 't-1', channel: 'telegram', message_json: '{"kind":"stuck_input"}',
        destination_id: 'chat-1', audience_id: 'aud', conversation_id: null,
      } as never);
      expect(res.providerMessageId).toBe('msg-42');
      expect(send).toHaveBeenCalledTimes(1);
      const [, init] = send.mock.calls[0] as unknown as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sec');
      expect(String(init.body)).toContain('"kind":"stuck_input"');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ответ канала без providerMessageId считается НЕ доставленным', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    try {
      const adapter = gatewayDeliveryAdapter({ baseUrl: 'https://gw.test', secret: null });
      await expect(adapter.send({
        id: 'd-1', user_task_id: 't-1', channel: 'telegram', message_json: '{}',
      } as never)).rejects.toThrow(/not confirmed/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('заявлен реальный адаптер без реквизитов — ошибка, а не тихая подмена заглушкой', async () => {
    await expect(resolveDeliveryAdapter({ DELIVERY_ADAPTER: 'gateway' })).rejects.toThrow(/GATEWAY_DELIVERY_URL/);
    // Заглушка остаётся доступной только как явный выбор песочницы.
    expect(await resolveDeliveryAdapter({ DELIVERY_ADAPTER: 'local' })).toBeTruthy();
    expect(localDeliveryAdapter()).toBeTruthy();
  });
});