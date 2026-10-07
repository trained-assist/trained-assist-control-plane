import { describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../src/taskstore';
import worker from '../src/index';
import { signPrincipal } from '../src/auth/principal-auth';
import { env } from './env';

const secret = 'delivery-route-test-secret';

async function queuedDelivery() {
  const store = new TaskStore(env.DB);
  const principalId = `delivery-operator-${crypto.randomUUID()}`;
  const taskId = `delivery-route-${crypto.randomUUID()}`;
  await store.upsertPrincipal({ principalId, profileId: 'delivery-profile', scopes: ['tasks:control'] });
  await store.admitTask({ id: taskId, profileId: 'delivery-profile', goal: 'deliver reviewed result' });
  await store.commit(taskId, 1, { status: 'done', result: { answer: 'synthetic result' } });
  await store.queueDelivery({ taskId, logicalMessageId: `message-${taskId}`, channel: 'telegram', message: { text: 'synthetic' } });
  return { store, principalId, taskId };
}

function signedRequest(principalId: string, signature: string, taskId: string) {
  return new Request('https://cp.test/deliveries/deliver', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-principal': principalId, 'x-principal-sig': signature },
    body: JSON.stringify({ taskId }),
  });
}

describe('HTTP delivery route adapter binding', () => {
  it('rejects missing or unsupported adapter configuration without claiming the outbox item', async () => {
    for (const deliveryAdapter of [undefined, 'typo']) {
      const { store, principalId, taskId } = await queuedDelivery();
      const signature = await signPrincipal(principalId, secret);
      const response = await worker.fetch(signedRequest(principalId, signature, taskId), {
        DB: env.DB,
        TASK_WORKFLOW: env.TASK_WORKFLOW,
        PRINCIPAL_SECRET: secret,
        ...(deliveryAdapter === undefined ? {} : { DELIVERY_ADAPTER: deliveryAdapter }),
      });
      expect(response.status).toBe(503);
      expect((await store.listDeliveries(taskId))[0]?.status).toBe('pending');
      expect((await store.listDeliveries(taskId))[0]?.provider_message_id).toBeNull();
    }
  });

  it('uses the configured gateway adapter through the real authenticated HTTP handler', async () => {
    const { store, principalId, taskId } = await queuedDelivery();
    const signature = await signPrincipal(principalId, secret);
    const send = vi.fn(async () => new Response(JSON.stringify({ providerMessageId: 'gateway-message-42' }), {
      status: 202, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', send);
    try {
      const response = await worker.fetch(signedRequest(principalId, signature, taskId), {
        DB: env.DB,
        TASK_WORKFLOW: env.TASK_WORKFLOW,
        PRINCIPAL_SECRET: secret,
        DELIVERY_ADAPTER: 'gateway',
        GATEWAY_DELIVERY_URL: 'https://gateway.test',
        GATEWAY_DELIVERY_SECRET: 'gateway-test-secret',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ outcome: 'delivered', providerMessageId: 'gateway-message-42' });
      expect(send).toHaveBeenCalledOnce();
      const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://gateway.test/deliver');
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer gateway-test-secret');
      expect((await store.listDeliveries(taskId))[0]).toMatchObject({ status: 'delivered', provider_message_id: 'gateway-message-42' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('authenticates before reading the outbox or calling an external adapter', async () => {
    const { taskId } = await queuedDelivery();
    const send = vi.fn(async () => new Response(JSON.stringify({ providerMessageId: 'must-not-send' }), { status: 200 }));
    vi.stubGlobal('fetch', send);
    try {
      const response = await worker.fetch(new Request('https://cp.test/deliveries/deliver', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId }),
      }), { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, DELIVERY_ADAPTER: 'gateway', GATEWAY_DELIVERY_URL: 'https://gateway.test' });
      expect(response.status).toBe(401);
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
