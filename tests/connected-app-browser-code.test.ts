import { describe, expect, it } from 'vitest';
import { env } from './env';
import worker from '../src/index';
import { connectedAppRequest, type AgentProfileAuthority, type AgentProfileContext } from '../src/connected-app/session-service';

const issuer = 'https://control.example.invalid';
const redirect = 'https://recruiting.example.invalid/oauth/callback';
const crmRedirect = 'https://crm.example.invalid/oauth/callback';
const hostKey = 'host-test-key-with-at-least-thirty-two-chars';
const appKey = 'recruiting-test-key-with-at-least-thirty-two-chars';
const crmKey = 'crm-test-key-with-at-least-thirty-two-chars';
const config = { enabled: 'true', hostKey, issuer,
  serviceKeys: JSON.stringify({ 'recruiting-web': appKey, 'crm-web': crmKey }),
  redirectUris: JSON.stringify({ 'recruiting-web': redirect, 'crm-web': crmRedirect }),
};
const id = (suffix: string) => `handoff_${suffix}`;
const verifier = 'test-verifier-with-at-least-forty-three-characters-0123456789';
const state = 'csrf-state-unguessable-0123456789';
const contexts = new Map<string, AgentProfileContext>();
const currentAuthority: AgentProfileAuthority = {
  resolveBrowserSession: async () => null,
  resolveCurrentSession: async sessionId => contexts.get(sessionId) ?? null,
};
async function challenge(value = verifier): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
const authority = (sessionId: string, profileId = 'profile_demo_001', profileGeneration = 1,
  principalId = 'user_demo_001'): AgentProfileAuthority => {
  const context = { principalId, profileId, sessionId, profileGeneration };
  return { resolveBrowserSession: async () => context,
    resolveCurrentSession: async currentSessionId => currentSessionId === sessionId ? context : null };
};
async function membership(profileId: string, scopes = ['recruiting.responses.read'], audience = 'recruiting-web') {
  await env.DB.prepare(`INSERT INTO connected_app_memberships
    (principal_id,profile_id,audience,scopes_json,enabled,updated_at) VALUES(?,?,?,?,1,1)
    ON CONFLICT(principal_id,profile_id,audience) DO UPDATE SET
    scopes_json=excluded.scopes_json,enabled=1,updated_at=excluded.updated_at`)
    .bind('user_demo_001', profileId, audience, JSON.stringify(scopes)).run();
}
async function authorize(sessionId: string, options: { audience?: string; redirectUri?: string; scopes?: string;
  challenge?: string; state?: string; agentAuthority?: AgentProfileAuthority | null; injectedProfile?: string;
  agentProfile?: string; agentGeneration?: number; grantedScopes?: string[]; defaultMembership?: boolean } = {}) {
  const url = new URL(`${issuer}/v1/connected-app-sessions/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.audience ?? 'recruiting-web');
  url.searchParams.set('redirect_uri', options.redirectUri ?? (options.audience === 'crm-web' ? crmRedirect : redirect));
  url.searchParams.set('scope', options.scopes ?? 'recruiting.responses.read');
  url.searchParams.set('state', options.state ?? state);
  url.searchParams.set('code_challenge', options.challenge ?? await challenge());
  url.searchParams.set('code_challenge_method', 'S256');
  if (options.injectedProfile) url.searchParams.set('profileId', options.injectedProfile);
  if (options.defaultMembership !== false) await membership('profile_demo_001',
    options.grantedScopes ?? ['recruiting.responses.read'], options.audience === 'crm-web' ? 'crm-web' : 'recruiting-web');
  const context = { principalId: 'user_demo_001', profileId: options.agentProfile ?? 'profile_demo_001',
    sessionId, profileGeneration: options.agentGeneration ?? 1 };
  contexts.set(sessionId, context);
  const testAuthority: AgentProfileAuthority = options.agentAuthority ?? {
    resolveBrowserSession: async () => context,
    resolveCurrentSession: async currentSessionId => contexts.get(currentSessionId) ?? null,
  };
  return connectedAppRequest(new Request(url, { method: 'GET' }), env.DB, config, {},
    options.agentAuthority === undefined ? testAuthority : options.agentAuthority);
}
async function exchange(code: string, options: { audience?: string; redirectUri?: string; verifier?: string;
  state?: string; key?: string; agentAuthority?: AgentProfileAuthority | null } = {}) {
  const audience = options.audience ?? 'recruiting-web';
  const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: audience,
    redirect_uri: options.redirectUri ?? (audience === 'crm-web' ? crmRedirect : redirect), code, code_verifier: options.verifier ?? verifier,
    state: options.state ?? state });
  return connectedAppRequest(new Request(`${issuer}/v1/connected-app-sessions/exchange`, {
    method: 'POST', headers: { authorization: `Bearer ${options.key ?? (audience === 'crm-web' ? crmKey : appKey)}`,
      'content-type': 'application/x-www-form-urlencoded' }, body: form,
  }), env.DB, config, Object.fromEntries(form.entries()), options.agentAuthority === undefined
    ? currentAuthority : options.agentAuthority);
}
function codeFrom(response: Response, expectedRedirect = redirect): string {
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location') ?? '');
  expect(`${location.origin}${location.pathname}`).toBe(expectedRedirect);
  expect(location.searchParams.get('iss')).toBe(issuer);
  expect(location.searchParams.get('state')).toBe(state);
  expect(location.searchParams.has('token')).toBe(false);
  return location.searchParams.get('code') ?? '';
}
async function introspect(token: string, agentAuthority: AgentProfileAuthority | null = currentAuthority) {
  return connectedAppRequest(new Request(`${issuer}/v1/connected-app-sessions/introspect`, {
    method: 'POST', headers: { authorization: `Bearer ${appKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ token, audience: 'recruiting-web' }),
  }), env.DB, config, { token, audience: 'recruiting-web' }, agentAuthority);
}
async function hostSelect(sessionId: string, profileId: string, enabled: boolean, generation = 2) {
  if (enabled) {
    await membership(profileId);
    contexts.set(sessionId, { principalId: 'user_demo_001', profileId, sessionId, profileGeneration: generation });
  }
  const result = await connectedAppRequest(new Request(`${issuer}/v1/connected-app-sessions/select`, {
    method: 'POST', headers: { authorization: `Bearer ${hostKey}` },
  }), env.DB, config, { sessionId, principalId: 'user_demo_001', profileId, enabled,
    grants: { 'recruiting-web': ['recruiting.responses.read'] } }, currentAuthority);
  if (!enabled) contexts.delete(sessionId);
  return result;
}

describe('Connected App browser authorization code with PKCE S256', () => {
  it('is fail-closed without Agent profile authority', async () => {
    const response = await authorize(id('closed'), { agentAuthority: null });
    expect(response.status).toBe(503);
    const workerResponse = await worker.fetch(new Request(`${issuer}/v1/connected-app-sessions/authorize`, { method: 'GET' }),
      { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, CONNECTED_APP_IDENTITY_ENABLED: 'true' });
    expect(workerResponse.status).toBe(503);
  });

  it('issues only explicitly granted Recruiting report and assignment scopes', async () => {
    const scopes = ['recruiting.reports.read', 'recruiting.reports.create',
      'recruiting.reports.review', 'recruiting.assignment.review'];
    const code = codeFrom(await authorize(id('workflow-scopes'), {
      scopes: scopes.join(' '), grantedScopes: scopes,
    }));
    const issued = await exchange(code);
    expect(issued.status).toBe(201);
    const { token } = await issued.json() as { token: string };
    expect(await (await introspect(token)).json()).toMatchObject({ active: true, scopes });
  });

  it('issues CRM deal creation only as its own CRM audience grant', async () => {
    const scopes = ['crm.deals.create'];
    const code = codeFrom(await authorize(id('crm-deal-create'), { audience: 'crm-web',
      scopes: scopes.join(' '), grantedScopes: scopes }), crmRedirect);
    const issued = await exchange(code, { audience: 'crm-web' });
    expect(issued.status).toBe(201);
    const { token } = await issued.json() as { token: string };
    const active = await connectedAppRequest(new Request(`${issuer}/v1/connected-app-sessions/introspect`, {
      method: 'POST', headers: { authorization: `Bearer ${crmKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token, audience: 'crm-web' }),
    }), env.DB, config, { token, audience: 'crm-web' }, currentAuthority);
    expect(await active.json()).toMatchObject({ active: true, aud: 'crm-web', scopes });
  });

  it('exchanges once with exact client, redirect, state and PKCE verifier', async () => {
    const sessionId = id('happy');
    const code = codeFrom(await authorize(sessionId, { injectedProfile: 'attacker_profile' }));
    expect((await exchange(code, { verifier: 'wrong-verifier-with-at-least-forty-three-characters-0123456789' })).status).toBe(403);
    expect((await exchange(code, { state: 'wrong-state-unguessable-0123456789' })).status).toBe(403);
    expect((await exchange(code, { key: 'wrong-app-secret' })).status).toBe(401);
    const response = await exchange(code);
    expect(response.status).toBe(201);
    const { token } = await response.json() as { token: string };
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(await (await introspect(token)).json()).toMatchObject({ active: true, aud: 'recruiting-web',
      profileId: 'profile_demo_001', sessionId, scopes: ['recruiting.responses.read'] });
    expect((await exchange(code)).status).toBe(403);
  });

  it('rejects wrong redirect, audience and scope before code creation or redemption', async () => {
    expect((await authorize(id('wrong_redirect'), { redirectUri: 'https://evil.example.invalid/callback' })).status).toBe(400);
    expect((await authorize(id('wrong_aud'), { audience: 'unknown-web' })).status).toBe(400);
    expect((await authorize(id('scope'), { scopes: 'recruiting.candidateSearch' })).status).toBe(403);
    const code = codeFrom(await authorize(id('bound')));
    expect((await exchange(code, { redirectUri: 'https://evil.example.invalid/callback' })).status).toBe(400);
    expect((await exchange(code, { audience: 'crm-web' })).status).toBe(403);
    expect((await exchange(code)).status).toBe(201);
  });

  it('rejects ambiguous authorization parameters and PKCE downgrade', async () => {
    const url = new URL(`${issuer}/v1/connected-app-sessions/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', 'recruiting-web');
    url.searchParams.set('redirect_uri', redirect);
    url.searchParams.append('redirect_uri', 'https://evil.example.invalid/callback');
    url.searchParams.set('scope', 'recruiting.responses.read');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', await challenge());
    url.searchParams.set('code_challenge_method', 'S256');
    expect((await connectedAppRequest(new Request(url), env.DB, config, {}, authority(id('duplicate')))).status).toBe(400);
    url.searchParams.delete('redirect_uri');
    url.searchParams.set('redirect_uri', redirect);
    url.searchParams.set('code_challenge_method', 'plain');
    expect((await connectedAppRequest(new Request(url), env.DB, config, {}, authority(id('plain')))).status).toBe(400);
  });

  it('rejects a code after profile switch or logout and revokes an issued token', async () => {
    const switchSession = id('switch');
    const beforeSwitch = codeFrom(await authorize(switchSession));
    await hostSelect(switchSession, 'profile_demo_002', true);
    expect((await exchange(beforeSwitch)).status).toBe(403);
    const logoutSession = id('logout');
    const beforeLogout = codeFrom(await authorize(logoutSession));
    await hostSelect(logoutSession, 'profile_demo_001', false);
    expect((await exchange(beforeLogout)).status).toBe(403);
    const activeSession = id('revoke');
    const code = codeFrom(await authorize(activeSession));
    const { token } = await (await exchange(code)).json() as { token: string };
    const revoked = await connectedAppRequest(new Request(`${issuer}/v1/connected-app-sessions/revoke`, {
      method: 'POST', headers: { authorization: `Bearer ${hostKey}` },
    }), env.DB, config, { token });
    expect(revoked.status).toBe(200);
    expect(await (await introspect(token)).json()).toEqual({ active: false });
    const nextCode = codeFrom(await authorize(activeSession));
    const next = (await (await exchange(nextCode)).json() as { token: string }).token;
    await hostSelect(activeSession, 'profile_demo_001', false);
    expect(await (await introspect(next)).json()).toEqual({ active: false });
  });

  it('rejects stale Agent selection generations and fails closed on authority outage without consuming a code', async () => {
    const sessionId = id('agent-generation');
    const code = codeFrom(await authorize(sessionId, { agentGeneration: 4 }));
    const changed = authority(sessionId, 'profile_demo_001', 5);
    expect((await exchange(code, { agentAuthority: changed })).status).toBe(403);
    const unavailable: AgentProfileAuthority = {
      resolveBrowserSession: async () => { throw new Error('unavailable'); },
      resolveCurrentSession: async () => { throw new Error('unavailable'); },
    };
    expect((await exchange(code, { agentAuthority: unavailable })).status).toBe(503);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
    const codeHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    const pending = await env.DB.prepare('SELECT consumed_at FROM connected_app_browser_codes WHERE code_hash = ?')
      .bind(codeHash).first<{ consumed_at: number | null }>();
    expect(pending?.consumed_at).toBeNull();
    const issued = await exchange(code);
    expect(issued.status).toBe(201);
    const { token } = await issued.json() as { token: string };
    expect((await introspect(token, unavailable)).status).toBe(503);
    expect(await (await introspect(token)).json()).toMatchObject({ active: true });
  });

  it('does not let the host choose a profile that differs from Agent authority', async () => {
    const sessionId = id('forged-select');
    await membership('profile_demo_001');
    const denied = await connectedAppRequest(new Request(`${issuer}/v1/connected-app-sessions/select`, {
      method: 'POST', headers: { authorization: `Bearer ${hostKey}` },
    }), env.DB, config, { sessionId, principalId: 'user_demo_001', profileId: 'profile_attacker', enabled: true,
      grants: { 'recruiting-web': ['recruiting.responses.read'] } }, authority(sessionId));
    expect(denied.status).toBe(403);
    expect(await env.DB.prepare('SELECT session_id FROM connected_app_sessions WHERE session_id = ?')
      .bind(sessionId).first()).toBeNull();
  });

  it('rejects expired codes', async () => {
    const code = codeFrom(await authorize(id('expired')));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
    const codeHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare('UPDATE connected_app_browser_codes SET expires_at = 1 WHERE code_hash = ?')
      .bind(codeHash).run();
    expect((await exchange(code)).status).toBe(403);
  });

  it('rejects browser authorization without independent membership and invalidates code after revocation', async () => {
    const missing = await authorize(id('membership_missing'), {
      agentProfile: 'profile_unreviewed',
    });
    expect(missing.status).toBe(403);
    const otherUserContext = { principalId: 'user_other', profileId: 'profile_demo_001', sessionId: id('other_user'), profileGeneration: 1 };
    const otherUser = await authorize(id('other_user'), { agentAuthority: {
      resolveBrowserSession: async () => otherUserContext,
      resolveCurrentSession: async () => otherUserContext,
    } });
    expect(otherUser.status).toBe(403);
    const sessionId = id('membership_revoked');
    const code = codeFrom(await authorize(sessionId));
    await env.DB.prepare(`UPDATE connected_app_memberships SET enabled = 0
      WHERE principal_id = ? AND profile_id = ? AND audience = ?`)
      .bind('user_demo_001', 'profile_demo_001', 'recruiting-web').run();
    expect((await exchange(code)).status).toBe(403);
  });

  it('requires a reviewed assignment grant before issuing a one-use browser code', async () => {
    const sessionId = id('assignment_review');
    const profileId = 'profile_assignment_review';
    const scope = 'recruiting.assignment.review';
    const resolve = authority(sessionId, profileId);
    await membership(profileId, ['recruiting.responses.read']);
    expect((await authorize(sessionId, { scopes: scope, agentAuthority: resolve, agentProfile: profileId,
      defaultMembership: false })).status).toBe(403);
    await membership(profileId, [scope]);
    const code = codeFrom(await authorize(sessionId, { scopes: scope, agentAuthority: resolve, agentProfile: profileId,
      defaultMembership: false }));
    const { token } = await (await exchange(code)).json() as { token: string };
    expect(await (await introspect(token)).json()).toMatchObject({
      active: true, profileId, scopes: [scope],
    });
    expect((await exchange(code)).status).toBe(403);
    await env.DB.prepare(`UPDATE connected_app_memberships SET enabled=0,updated_at=updated_at+1
      WHERE principal_id=? AND profile_id=? AND audience='recruiting-web'`)
      .bind('user_demo_001', profileId).run();
    expect(await (await introspect(token)).json()).toEqual({ active: false });
  });
});
