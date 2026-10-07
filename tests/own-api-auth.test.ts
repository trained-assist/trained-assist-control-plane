// Own-API dogfood (#23), шаг 4: проверяющая аутентификация принципала.
// Заголовок клиента — не доказательство личности: подпись обязана.
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import { principalAuthOf, signPrincipal, verifyPrincipal } from '../src/auth/principal-auth';
import { describe, expect, it } from 'vitest';

const SECRET = 'sandbox-test-secret';

const req = (principal: string | null, sig: string | null): Request => {
  const headers = new Headers();
  if (principal !== null) headers.set('x-principal', principal);
  if (sig !== null) headers.set('x-principal-sig', sig);
  return new Request('https://example.test/intake', { headers });
};

describe('principal-auth: подпись вместо доверия заголовку', () => {
  const auth = principalAuthOf({ PRINCIPAL_SECRET: SECRET });

  it('без секрета в binding доступ закрыт (fail closed)', async () => {
    const closed = principalAuthOf({});
    expect(closed.secret).toBeNull();
    expect(await verifyPrincipal(req('sandbox-user', 'deadbeef'), closed)).toBeNull();
  });

  it('валидная подпись возвращает principalId', async () => {
    const sig = await signPrincipal('sandbox-user', SECRET);
    expect(await verifyPrincipal(req('sandbox-user', sig), auth)).toBe('sandbox-user');
  });

  it('подмена x-principal без секрета = отказ, а не чужой профиль', async () => {
    const sig = await signPrincipal('sandbox-user', SECRET);
    // Подпись на sandbox-user, а в заголовке — кто-то другой.
    expect(await verifyPrincipal(req('someone-else', sig), auth)).toBeNull();
  });

  it('подпись от другого секрета не проходит', async () => {
    const sig = await signPrincipal('sandbox-user', 'other-secret');
    expect(await verifyPrincipal(req('sandbox-user', sig), auth)).toBeNull();
  });

  it('выбирает отдельный ключ для Telegram UX principal, не меняя общий ключ', async () => {
    const scoped = principalAuthOf({
      PRINCIPAL_SECRET: SECRET,
      PRINCIPAL_SECRET_TELEGRAM_UX: 'dedicated-telegram-ux-secret',
    });
    const testSig = await signPrincipal('integration-telegram-ux-v1', 'dedicated-telegram-ux-secret');
    const sharedSig = await signPrincipal('integration-telegram-ux-v1', SECRET);
    const otherSig = await signPrincipal('sandbox-user', SECRET);

    expect(await verifyPrincipal(req('integration-telegram-ux-v1', testSig), scoped)).toBe('integration-telegram-ux-v1');
    expect(await verifyPrincipal(req('integration-telegram-ux-v1', sharedSig), scoped)).toBeNull();
    expect(await verifyPrincipal(req('sandbox-user', otherSig), scoped)).toBe('sandbox-user');
  });

  it('выбирает отдельный ключ для integration-v1 principal, не меняя общий ключ', async () => {
    const scoped = principalAuthOf({
      PRINCIPAL_SECRET: SECRET,
      PRINCIPAL_SECRET_INTEGRATION_V1: 'dedicated-integration-v1-secret',
    });
    const testSig = await signPrincipal('integration-v1', 'dedicated-integration-v1-secret');
    const sharedSig = await signPrincipal('integration-v1', SECRET);
    const otherSig = await signPrincipal('sandbox-user', SECRET);

    expect(await verifyPrincipal(req('integration-v1', testSig), scoped)).toBe('integration-v1');
    expect(await verifyPrincipal(req('integration-v1', sharedSig), scoped)).toBeNull();
    expect(await verifyPrincipal(req('sandbox-user', otherSig), scoped)).toBe('sandbox-user');
  });

  it('выбирает отдельный ключ только для Codex sandbox smoke principal', async () => {
    const scoped = principalAuthOf({ PRINCIPAL_SECRET: SECRET, PRINCIPAL_SECRET_CODEX_SMOKE: 'dedicated-codex-smoke-secret' });
    const testSig = await signPrincipal('sde-codex-smoke-v1', 'dedicated-codex-smoke-secret');
    const sharedSig = await signPrincipal('sde-codex-smoke-v1', SECRET);
    expect(await verifyPrincipal(req('sde-codex-smoke-v1', testSig), scoped)).toBe('sde-codex-smoke-v1');
    expect(await verifyPrincipal(req('sde-codex-smoke-v1', sharedSig), scoped)).toBeNull();
  });

  it('отсутствующая и неhex-подпись отклоняются', async () => {
    expect(await verifyPrincipal(req('sandbox-user', null), auth)).toBeNull();
    expect(await verifyPrincipal(req('sandbox-user', 'not-hex'), auth)).toBeNull();
    expect(await verifyPrincipal(req('sandbox-user', 'abc'), auth)).toBeNull();
  });

  it('небезопасный principalId отклоняется', async () => {
    const sig = await signPrincipal('bad id!', SECRET);
    expect(await verifyPrincipal(req('bad id!', sig), auth)).toBeNull();
  });

  it('одинаковая подпись детерминирована — клиент и проверка считают одинаково', async () => {
    const a = await signPrincipal('sandbox-user', SECRET);
    const b = await signPrincipal('sandbox-user', SECRET);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('principal-auth: граница HTTP-слоя', () => {
  it('запрос без подписи получает 401 и не доходит до Task Store', async () => {
    const mod = await import('../src/index');
    const store = new TaskStore(env.DB);
    await store.upsertPrincipal({ principalId: 'sandbox-user', profileId: 'profile-1', scopes: ['tasks:intake', 'tasks:read'] });

    const unsigned = new Request('https://example.test/intake', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-principal': 'sandbox-user' },
      body: JSON.stringify({ requestId: `auth-${Date.now()}`, profileId: 'profile-1', inputItems: [{ text: 'проверка подписи' }] }),
    });
    const res = await mod.default.fetch(unsigned, {
      DB: env.DB,
      TASK_WORKFLOW: env.TASK_WORKFLOW,
      PRINCIPAL_SECRET: SECRET,
    });
    expect(res.status).toBe(401);
  });

  it('запрос с валидной подписью проходит проверку личности', async () => {
    const mod = await import('../src/index');
    const store = new TaskStore(env.DB);
    await store.upsertPrincipal({ principalId: 'sandbox-user', profileId: 'profile-1', scopes: ['tasks:intake', 'tasks:read'] });

    const sig = await signPrincipal('sandbox-user', SECRET);
    const res = await mod.default.fetch(
      new Request('https://example.test/intake', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-principal': 'sandbox-user', 'x-principal-sig': sig },
        body: JSON.stringify({ requestId: `auth-${Date.now()}`, profileId: 'profile-1', inputItems: [{ text: 'проверка подписи' }] }),
      }),
      { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, PRINCIPAL_SECRET: SECRET },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { durable: boolean; userTaskId: string };
    expect(body.durable).toBe(true);
    expect(body.userTaskId).toMatch(/^ut-/);
  });
});

describe('protected HTTP route scopes', () => {
  const unauthenticatedRoutes: Array<{ name: string; path: string; method: string; body?: unknown }> = [
    { name: '/recover', path: '/recover', method: 'POST', body: {} },
    { name: '/connection-lost', path: '/connection-lost', method: 'POST', body: { runId: 'missing-run' } },
    { name: '/heartbeat', path: '/heartbeat', method: 'POST', body: { runId: 'missing-run' } },
    { name: '/receipt', path: '/receipt?taskId=missing-task', method: 'GET' },
    { name: '/deliveries/deliver', path: '/deliveries/deliver', method: 'POST', body: {} },
    { name: '/runner/health', path: '/runner/health', method: 'GET' },
  ];

  it.each(unauthenticatedRoutes)('rejects anonymous $name before route work', async ({ name, path, method, body }) => {
    const mod = await import('../src/index');
    if (name === '/receipt') {
      const taskId = `anonymous-receipt-${crypto.randomUUID()}`;
      await new TaskStore(env.DB).admitTask({ id: taskId, profileId: 'private-profile', goal: 'private receipt' });
      path = `/receipt?taskId=${taskId}`;
    }
    const response = await mod.default.fetch(new Request(`https://cp.test${path}`, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    }), { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW });
    expect(response.status).toBe(401);
  });

  it('allows the tasks:read owner to read an existing task receipt', async () => {
    const mod = await import('../src/index');
    const store = new TaskStore(env.DB);
    const principalId = `receipt-reader-${crypto.randomUUID()}`;
    const taskId = `receipt-task-${crypto.randomUUID()}`;
    await store.upsertPrincipal({ principalId, profileId: 'receipt-profile', scopes: ['tasks:read'] });
    await store.admitTask({ id: taskId, profileId: 'receipt-profile', goal: 'read my receipt' });
    const signature = await signPrincipal(principalId, SECRET);
    const response = await mod.default.fetch(new Request(`https://cp.test/receipt?taskId=${taskId}`, {
      headers: { 'x-principal': principalId, 'x-principal-sig': signature },
    }), { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, PRINCIPAL_SECRET: SECRET });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userTaskId: taskId, durable: true });
  });
});
