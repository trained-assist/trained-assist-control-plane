import { describe, expect, it } from 'vitest';
import { env } from './env';
import worker from '../src/index';

const hostKey = 'host-test-key-with-at-least-thirty-two-chars';
const recruitingKey = 'recruiting-test-key-with-at-least-thirty-two-chars';
const crmKey = 'crm-test-key-with-at-least-thirty-two-chars';
const bindings = {
  DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW,
  CONNECTED_APP_IDENTITY_ENABLED: 'true',
  CONNECTED_APP_HOST_KEY: hostKey,
  CONNECTED_APP_SERVICE_KEYS: JSON.stringify({ 'recruiting-web': recruitingKey, 'crm-web': crmKey }),
  CONNECTED_APP_ISSUER: 'https://control.example.invalid',
};
const path = '/v1/connected-app-sessions/';
const request = (route: string, body: object, key: string, enabled = true) => worker.fetch(
  new Request(`https://control.example.invalid${path}${route}`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), { ...bindings, CONNECTED_APP_IDENTITY_ENABLED: enabled ? 'true' : undefined },
);
async function membership(profileId: string, scopes: string[]) {
  await env.DB.prepare(`INSERT INTO connected_app_memberships
    (principal_id,profile_id,audience,scopes_json,enabled,updated_at) VALUES(?,?,?,?,1,1)
    ON CONFLICT(principal_id,profile_id,audience) DO UPDATE SET
    scopes_json=excluded.scopes_json,enabled=1,updated_at=excluded.updated_at`)
    .bind('user_demo_001', profileId, 'recruiting-web', JSON.stringify(scopes)).run();
}
const select = async (sessionId: string, profileId: string, scopes = ['recruiting.responses.read'], enabled = true) => {
  if (enabled) await membership(profileId, scopes);
  return request('select', { sessionId, principalId: 'user_demo_001', profileId, enabled,
    grants: { 'recruiting-web': scopes } }, hostKey);
};
const issue = (sessionId: string, scopes = ['recruiting.responses.read']) =>
  request('issue', { sessionId, audience: 'recruiting-web', scopes }, hostKey);
const introspect = (token: string, audience = 'recruiting-web', key = recruitingKey) =>
  request('introspect', { token, audience }, key);

describe('connected app identity opt-in D1 runtime', () => {
  it('stays closed without feature flag and host/service bindings', async () => {
    const disabled = await request('select', { sessionId: 's_disabled' }, hostKey, false);
    expect(disabled.status).toBe(404);
    expect(disabled.headers.get('cache-control')).toBe('no-store');
    expect((await request('select', { sessionId: 's_wrong' }, 'wrong')).status).toBe(401);
    expect((await introspect('0'.repeat(64), 'recruiting-web', crmKey)).status).toBe(401);
  });

  it('issues a bounded opaque token for one exact audience and scope', async () => {
    expect((await select('session_demo_100', 'profile_demo_100')).status).toBe(200);
    const issued = await issue('session_demo_100');
    expect(issued.status).toBe(201);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    const { token } = await issued.json() as { token: string };
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const active = await introspect(token);
    expect(active.status).toBe(200);
    expect(active.headers.get('cache-control')).toBe('no-store');
    const value = await active.json() as Record<string, unknown>;
    expect(value).toMatchObject({ active: true, iss: 'https://control.example.invalid',
      aud: 'recruiting-web', sub: 'user_demo_001', profileId: 'profile_demo_100',
      sessionId: 'session_demo_100', scopes: ['recruiting.responses.read'] });
    expect(value).not.toHaveProperty('token');
    expect((value.exp as number) - (value.nbf as number)).toBeLessThanOrEqual(3600);
    expect(await (await introspect(token, 'crm-web', crmKey)).json()).toEqual({ active: false });
    expect((await issue('session_demo_100', ['recruiting.candidateSearch'])).status).toBe(403);
    expect((await issue('session_demo_100', ['crm.catalog.read'])).status).toBe(400);
    const stored = await env.DB.prepare('SELECT token_hash FROM connected_app_tokens WHERE session_id = ?')
      .bind('session_demo_100').first<{ token_hash: string }>();
    expect(stored?.token_hash).not.toBe(token);
  });

  it('invalidates on profile switch, scope removal, session disable and token revocation', async () => {
    await select('session_demo_200', 'profile_demo_200');
    const old = (await (await issue('session_demo_200')).json() as { token: string }).token;
    await select('session_demo_200', 'profile_demo_201');
    expect(await (await introspect(old)).json()).toEqual({ active: false });
    const next = (await (await issue('session_demo_200')).json() as { token: string }).token;
    await select('session_demo_200', 'profile_demo_201', ['recruiting.candidateSearch']);
    expect(await (await introspect(next)).json()).toEqual({ active: false });
    const search = (await (await issue('session_demo_200', ['recruiting.candidateSearch'])).json() as { token: string }).token;
    expect((await request('revoke', { token: search }, hostKey)).status).toBe(200);
    expect(await (await introspect(search)).json()).toEqual({ active: false });
    const after = (await (await issue('session_demo_200', ['recruiting.candidateSearch'])).json() as { token: string }).token;
    await select('session_demo_200', 'profile_demo_201', ['recruiting.candidateSearch'], false);
    expect(await (await introspect(after)).json()).toEqual({ active: false });
    expect((await issue('session_demo_200', ['recruiting.candidateSearch'])).status).toBe(403);
  });

  it('rejects scope escalation, duplicate grants and session owner takeover', async () => {
    expect((await request('select', { sessionId: 'session_demo_300', principalId: 'user_demo_001',
      profileId: 'profile_demo_300', enabled: true, grants: { 'recruiting-web': ['crm.catalog.read'] } }, hostKey)).status).toBe(400);
    expect((await select('session_demo_300', 'profile_demo_300')).status).toBe(200);
    expect((await request('select', { sessionId: 'session_demo_300', principalId: 'user_other',
      profileId: 'profile_other', enabled: true, grants: { 'recruiting-web': ['recruiting.responses.read'] } }, hostKey)).status).toBe(409);
    expect((await request('select', { sessionId: 'session_demo_301', principalId: 'user_demo_001',
      profileId: 'profile_demo_300', enabled: true,
      grants: { 'recruiting-web': ['recruiting.responses.read', 'recruiting.responses.read'] } }, hostKey)).status).toBe(400);
  });

  it('principal disable closes every session owned by that principal', async () => {
    await select('session_demo_401', 'profile_demo_401');
    await select('session_demo_402', 'profile_demo_402');
    const first = (await (await issue('session_demo_401')).json() as { token: string }).token;
    const second = (await (await issue('session_demo_402')).json() as { token: string }).token;
    expect((await request('disable-principal', { principalId: 'user_demo_001' }, hostKey)).status).toBe(200);
    expect(await (await introspect(first)).json()).toEqual({ active: false });
    expect(await (await introspect(second)).json()).toEqual({ active: false });
  });

  it('expires tokens and keeps malformed or legacy credentials inactive', async () => {
    await select('session_demo_500', 'profile_demo_500');
    const bearer = (await (await issue('session_demo_500')).json() as { token: string }).token;
    expect(await (await introspect('legacy-agent-jwt')).json()).toEqual({ active: false });
    expect(await (await introspect('rt_legacy_run_token')).json()).toEqual({ active: false });
    const row = await env.DB.prepare('SELECT token_hash FROM connected_app_tokens WHERE session_id = ?')
      .bind('session_demo_500').first<{ token_hash: string }>();
    await env.DB.prepare('UPDATE connected_app_tokens SET expires_at = 1 WHERE token_hash = ?')
      .bind(row?.token_hash).run();
    expect(await (await introspect(bearer)).json()).toEqual({ active: false });
  });

  it('rejects host selection without reviewed membership and revokes on membership loss', async () => {
    const sessionId = 'session_membership_guard';
    const denied = await request('select', { sessionId, principalId: 'user_demo_001',
      profileId: 'profile_unreviewed', enabled: true,
      grants: { 'recruiting-web': ['recruiting.responses.read'] } }, hostKey);
    expect(denied.status).toBe(403);
    expect(await env.DB.prepare('SELECT session_id FROM connected_app_sessions WHERE session_id = ?')
      .bind(sessionId).first()).toBeNull();
    await select(sessionId, 'profile_reviewed');
    const bearer = (await (await issue(sessionId)).json() as { token: string }).token;
    await env.DB.prepare(`UPDATE connected_app_memberships SET enabled = 0
      WHERE principal_id = ? AND profile_id = ? AND audience = ?`)
      .bind('user_demo_001', 'profile_reviewed', 'recruiting-web').run();
    expect(await (await introspect(bearer)).json()).toEqual({ active: false });
    expect((await issue(sessionId)).status).toBe(403);
  });
});
