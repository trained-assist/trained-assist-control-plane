import { describe, expect, it } from 'vitest';
import { env } from './env';
import worker from '../src/index';
import { connectedAppRequest, type AgentProfileAuthority, type AgentProfileContext } from '../src/connected-app/session-service';

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
const contexts = new Map<string, AgentProfileContext>();
const authority: AgentProfileAuthority = {
  resolveBrowserSession: async () => null,
  resolveCurrentSession: async sessionId => contexts.get(sessionId) ?? null,
};
const request = (route: string, body: object, key: string, enabled = true) => connectedAppRequest(
  new Request(`https://control.example.invalid${path}${route}`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env.DB, { enabled: enabled ? 'true' : undefined, hostKey, serviceKeys: bindings.CONNECTED_APP_SERVICE_KEYS,
    issuer: bindings.CONNECTED_APP_ISSUER }, body as Record<string, unknown>, authority,
);
async function membership(profileId: string, scopes: string[]) {
  await env.DB.prepare(`INSERT INTO connected_app_memberships
    (principal_id,profile_id,audience,scopes_json,enabled,updated_at) VALUES(?,?,?,?,1,1)
    ON CONFLICT(principal_id,profile_id,audience) DO UPDATE SET
    scopes_json=excluded.scopes_json,enabled=1,updated_at=excluded.updated_at`)
    .bind('user_demo_001', profileId, 'recruiting-web', JSON.stringify(scopes)).run();
}
const select = async (sessionId: string, profileId: string, scopes = ['recruiting.responses.read'], enabled = true,
  profileGeneration?: number) => {
  if (enabled) {
    if (profileGeneration !== 0) await membership(profileId, scopes);
    const previous = contexts.get(sessionId);
    contexts.set(sessionId, { principalId: 'user_demo_001', profileId, sessionId,
      profileGeneration: profileGeneration === 0 ? previous?.profileGeneration ?? 1 : profileGeneration ?? (previous?.profileGeneration ?? 0) + 1 });
  }
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
    const noAgentContext = await worker.fetch(new Request(`https://control.example.invalid${path}select`, {
      method: 'POST', headers: { authorization: `Bearer ${hostKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's_no_agent', principalId: 'u1', profileId: 'p1', enabled: true,
        grants: { 'recruiting-web': ['recruiting.responses.read'] } }),
    }), { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, CONNECTED_APP_IDENTITY_ENABLED: 'true',
      CONNECTED_APP_HOST_KEY: hostKey, CONNECTED_APP_SERVICE_KEYS: bindings.CONNECTED_APP_SERVICE_KEYS,
      CONNECTED_APP_ISSUER: bindings.CONNECTED_APP_ISSUER });
    expect(noAgentContext.status).toBe(503);
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
    const disabled = await select('session_demo_200', 'profile_demo_201', ['recruiting.candidateSearch'], false);
    expect(disabled.status).toBe(200);
    contexts.delete('session_demo_200');
    expect(await (await introspect(after)).json()).toEqual({ active: false });
    expect((await issue('session_demo_200', ['recruiting.candidateSearch'])).status).toBe(403);
  });

  it('rejects scope escalation, duplicate grants and session owner takeover', async () => {
    expect((await request('select', { sessionId: 'session_demo_300', principalId: 'user_demo_001',
      profileId: 'profile_demo_300', enabled: true, grants: { 'recruiting-web': ['crm.catalog.read'] } }, hostKey)).status).toBe(400);
    expect((await select('session_demo_300', 'profile_demo_300')).status).toBe(200);
    contexts.set('session_demo_300', { principalId: 'user_other', profileId: 'profile_demo_300',
      sessionId: 'session_demo_300', profileGeneration: 2 });
    await env.DB.prepare(`INSERT INTO connected_app_memberships
      (principal_id,profile_id,audience,scopes_json,enabled,updated_at) VALUES(?,?,?,?,1,1)`)
      .bind('user_other', 'profile_demo_300', 'recruiting-web', JSON.stringify(['recruiting.responses.read'])).run();
    expect((await request('select', { sessionId: 'session_demo_300', principalId: 'user_other',
      profileId: 'profile_demo_300', enabled: true, grants: { 'recruiting-web': ['recruiting.responses.read'] } }, hostKey)).status).toBe(409);
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
    await membership('profile_reviewed', ['recruiting.responses.read']);
    expect(await (await introspect(bearer)).json()).toEqual({ active: false });
  });

  it('requires an explicit assignment grant for the selected profile and fences a profile switch', async () => {
    const sessionId = 'session_assignment_review';
    const first = 'profile_assignment_first';
    const second = 'profile_assignment_second';
    const assignment = ['recruiting.assignment.review'];
    const response = ['recruiting.responses.read'];
    await membership(first, response);
    expect((await select(sessionId, first, assignment, true, 0)).status).toBe(403);
    expect(await env.DB.prepare('SELECT session_id FROM connected_app_sessions WHERE session_id=?')
      .bind(sessionId).first()).toBeNull();
    await membership(first, assignment);
    expect((await select(sessionId, first, assignment)).status).toBe(200);
    expect((await issue(sessionId, response)).status).toBe(403);
    const firstToken = (await (await issue(sessionId, assignment)).json() as { token: string }).token;
    expect(await (await introspect(firstToken)).json()).toMatchObject({
      active: true, sub: 'user_demo_001', profileId: first, scopes: assignment,
    });

    await membership(second, response);
    expect((await select(sessionId, second, assignment, true, 0)).status).toBe(403);
    expect((await select(sessionId, second, response)).status).toBe(200);
    expect(await (await introspect(firstToken)).json()).toEqual({ active: false });
    expect((await issue(sessionId, assignment)).status).toBe(403);
    const secondToken = (await (await issue(sessionId, response)).json() as { token: string }).token;
    expect(await (await introspect(secondToken)).json()).toMatchObject({
      active: true, sub: 'user_demo_001', profileId: second, scopes: response,
    });
    await membership(second, assignment);
    expect((await issue(sessionId, assignment)).status).toBe(403);
    expect((await select(sessionId, second, assignment)).status).toBe(200);
    const assignmentToken = (await (await issue(sessionId, assignment)).json() as { token: string }).token;
    await env.DB.prepare(`UPDATE connected_app_memberships SET enabled=0,updated_at=updated_at+1
      WHERE principal_id=? AND profile_id=? AND audience='recruiting-web'`)
      .bind('user_demo_001', second).run();
    expect(await (await introspect(assignmentToken)).json()).toEqual({ active: false });
  });
});
