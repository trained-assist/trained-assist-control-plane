import { TaskStore } from '../src/taskstore';
import { runStuckInputSweep, gatewayDeliveryAdapter } from '../src/intake';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from './env';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const dbOf = (store: TaskStore): typeof env.DB => (store as unknown as { db: typeof env.DB }).db;

const created: string[] = [];
const track = (id: string) => { created.push(id); return id; };

const setup = () => new TaskStore(env.DB);

beforeEach(async () => {
  const store = setup();
  for (const id of created.splice(0)) {
    await dbOf(store).prepare('DELETE FROM deliveries WHERE user_task_id = ?').bind(id).run();
    await dbOf(store).prepare('DELETE FROM task_events WHERE user_task_id = ?').bind(id).run();
    await dbOf(store).prepare('DELETE FROM stuck_input_alerts WHERE incident_id = ?').bind(`task:${id}`).run();
    await dbOf(store).prepare('DELETE FROM durable_tasks WHERE id = ?').bind(id).run();
  }
});

const admitStuck = async (store: TaskStore, stage = 'handing_off', destinationId: string | null = null) => {
  const id = track(nextId('task'));
  await store.admitTask({
    id, profileId: 'profile-1', goal: 'сделай работу', startDeadlineMs: 1, destinationId,
  });
  await dbOf(store).prepare('UPDATE durable_tasks SET stage = ? WHERE id = ?').bind(stage, id).run();
  return id;
};

const expired = () => new Promise((r) => setTimeout(r, 5));

/** Симулировать истечение backoff доставки: retryAfterSec реальный (60 с). */
const expireBackoff = async (store: TaskStore, taskId: string) =>
  dbOf(store).prepare('UPDATE deliveries SET next_attempt_at = ? WHERE user_task_id = ?')
    .bind(Date.now() - 1, taskId).run();

/**
 * Faithful HTTP stub of the gateway's POST /deliver (trained-assist-tg-bot,
 * `src/index.js`). NOT a mock of our own adapter: it is the peer implementation's
 * observable behaviour, which is what makes this a seam test rather than a unit test.
 *
 * Mirrors the gateway exactly:
 *   • Bearer AGENT_SECRET required, otherwise 401
 *   • only channel=telegram, valid destinationId, non-empty text → else 400
 *   • channel refuses (ok:false) → 502 WITHOUT providerMessageId
 *   • accepted → 200 { providerMessageId }
 */
function gatewayStub(opts: { token: string; refuse?: boolean; ok?: boolean } = { token: 'sec' }) {
  const seen: { auth: string | undefined; body: any }[] = [];
  let providerId = 7000;
  const handler = vi.fn(async (url: string, init: any) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ auth: headers.Authorization, body: JSON.parse(String(init?.body ?? '{}')) });
    if (headers.Authorization !== `Bearer ${opts.token}`) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.channel !== 'telegram') return new Response(JSON.stringify({ error: 'unsupported channel' }), { status: 400 });
    if (!body.deliveryId) return new Response(JSON.stringify({ error: 'invalid deliveryId' }), { status: 400 });
    if (!body.message?.text) return new Response(JSON.stringify({ error: 'missing message text' }), { status: 400 });
    if (opts.refuse) {
      // Канал не принял: gateway отвечает 502 и НЕ возвращает providerMessageId.
      return new Response(JSON.stringify({ error: 'channel did not accept' }), { status: 502 });
    }
    if (opts.ok === false) return new Response('{}', { status: 200 });
    return new Response(JSON.stringify({ providerMessageId: `msg-${++providerId}` }), { status: 200 });
  });
  vi.stubGlobal('fetch', handler);
  return { handler, seen };
}

afterEach(() => vi.unstubAllGlobals());

describe('Стык control plane ↔ gateway: полная цепочка доставки (arch#132 П3b)', () => {
  it('просроченный вход → детектор → outbox → gateway → подтверждённая доставка', async () => {
    const store = setup();
    const taskId = await admitStuck(store, 'handing_off', '-5496844108');
    await expired();
    const { handler, seen } = gatewayStub({ token: 'sec' });

    const adapter = gatewayDeliveryAdapter({ baseUrl: 'https://gateway.test', secret: 'sec' });
    const result = await runStuckInputSweep(store, { adapter, retryAfterSec: 0 }, Date.now());

    // Детектор увидел просроченный вход и поставил доставку в outbox.
    expect(result.scanned).toBe(1);
    expect(result.queued).toBe(1);
    // Реальный адаптер достучался до шлюза ровно один раз, с секретом и адресом.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(seen[0]!.auth).toBe('Bearer sec');
    expect(seen[0]!.body.channel).toBe('telegram');
    expect(seen[0]!.body.destinationId).toBe('-5496844108');
    expect(seen[0]!.body.message.kind).toBe('stuck_input');
    // Доставка ПОДТВЕРЖДЕНА шлюзом: providerMessageId записан, состояние delivered.
    expect(result.delivered).toBe(1);
    const delivery = (await store.listDeliveries(taskId))[0]!;
    expect(delivery.status).toBe('delivered');
    expect(delivery.provider_message_id).toMatch(/^msg-/);
    expect((await store.requireTask(taskId)).delivery_state).toBe('delivered');
  });

  it('шлюз ответил 200 БЕЗ providerMessageId — доставка не засчитывается', async () => {
    const store = setup();
    const taskId = await admitStuck(store, 'handing_off', '42');
    await expired();
    gatewayStub({ token: 'sec', ok: false });

    const adapter = gatewayDeliveryAdapter({ baseUrl: 'https://gateway.test', secret: 'sec' });
    const result = await runStuckInputSweep(store, { adapter, retryAfterSec: 0 }, Date.now());

    expect(result.delivered).toBe(0);
    const delivery = (await store.listDeliveries(taskId))[0]!;
    expect(delivery.status).not.toBe('delivered');
    expect(delivery.provider_message_id).toBeNull();
  });

  it('канал не принял (502) — доставка повторяема, а не «успешна»', async () => {
    const store = setup();
    const taskId = await admitStuck(store, 'handing_off', '42');
    await expired();
    gatewayStub({ token: 'sec', refuse: true });

    const adapter = gatewayDeliveryAdapter({ baseUrl: 'https://gateway.test', secret: 'sec' });
    const result = await runStuckInputSweep(store, { adapter, retryAfterSec: 60 }, Date.now());

    expect(result.delivered).toBe(0);
    const delivery = (await store.listDeliveries(taskId))[0]!;
    // Одна попытка на проход, backoff соблюдён: доставка повторяема, не выброшена.
    expect(delivery.status).toBe('pending');
    expect(delivery.attempt).toBe(1);
    expect((await store.requireTask(taskId)).delivery_state).toBe('pending');
  });

  it('повтор после отказа шлюза доводит доставку, и второй запуск не дублирует её', async () => {
    const store = setup();
    const taskId = await admitStuck(store, 'handing_off', '42');
    await expired();
    const stub = gatewayStub({ token: 'sec', refuse: true });
    const adapter = gatewayDeliveryAdapter({ baseUrl: 'https://gateway.test', secret: 'sec' });

    await runStuckInputSweep(store, { adapter, retryAfterSec: 60 }, Date.now());
    expect((await store.listDeliveries(taskId))[0]!.status).toBe('pending');

    // Канал ожил, backoff истёк — тот же проход доставляет.
    stub.handler.mockImplementation(async (url: string, init: any) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.Authorization !== 'Bearer sec') return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ providerMessageId: 'msg-ok' }), { status: 200 });
    });
    await expireBackoff(store, taskId);
    const second = await runStuckInputSweep(store, { adapter, retryAfterSec: 60 }, Date.now());

    expect(second.delivered).toBe(1);
    expect((await store.listDeliveries(taskId))[0]!.status).toBe('delivered');

    // Третий проход: дедуп по logical_messageId — новой доставки не создаётся.
    const third = await runStuckInputSweep(store, { adapter, retryAfterSec: 60 }, Date.now());
    expect(await store.listDeliveries(taskId)).toHaveLength(1);
    expect(third.delivered).toBe(0);
  });

  it('шлюз отверг по секрету — доставка не «успешна» и остаётся повторяемой', async () => {
    const store = setup();
    const taskId = await admitStuck(store, 'handing_off', '42');
    await expired();
    gatewayStub({ token: 'other-token' }); // наш секрет не подходит

    const adapter = gatewayDeliveryAdapter({ baseUrl: 'https://gateway.test', secret: 'sec' });
    const result = await runStuckInputSweep(store, { adapter, retryAfterSec: 60 }, Date.now());

    expect(result.delivered).toBe(0);
    expect((await store.listDeliveries(taskId))[0]!.status).toBe('pending');
  });
});
