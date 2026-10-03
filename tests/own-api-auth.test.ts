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
