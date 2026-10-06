import { describe, expect, it } from 'vitest';
import { env } from './env';
import worker from '../src/index';
import { connectedAppRequest, type PlatformSessionResolver } from '../src/connected-app/session-service';

const issuer = 'https://control.example.invalid';
const redirect = 'https://recruiting.example.invalid/oauth/callback';
const hostKey = 'host-test-key-with-at-least-thirty-two-chars';
const appKey = 'recruiting-test-key-with-at-least-thirty-two-chars';
const config = { enabled: 'true', hostKey, issuer,
  serviceKeys: JSON.stringify({ 'recruiting-web': appKey }),
  redirectUris: JSON.stringify({ 'recruiting-web': redirect }),
};
const id = (suffix: string) => `handoff_${suffix}`;
const verifier = 'test-verifier-with-at-least-forty-three-characters-0123456789';
const state = 'csrf-state-unguessable-0123456789';
async function challenge(value = verifier): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
const resolver = (sessionId: string, profileId = 'profile_demo_001'): PlatformSessionResolver => async () => ({
  principalId: 'user_demo_001', profileId, sessionId,
  grants: { 'recruiting-web': ['recruiting.responses.read'] },
});
async function authorize(sessionId: string, options: { audience?: string; redirectUri?: string; scopes?: string;
  challenge?: string; state?: string; resolve?: PlatformSessionResolver | null; injectedProfile?: string } = {}) {
  const url = new URL(`${issuer}/v1/connected-app-sessions/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.audience ?? 'recruiting-web');
  url.searchParams.set('redirect_uri', options.redirectUri ?? redirect);
  url.searchParams.set('scope', options.scopes ?? 'recruiting.responses.read');
  url.searchParams.set('state', options.state ?? state);
  url.searchParams.set('code_challenge', options.challenge ?? await challenge());
  url.searchParams.set('code_challenge_method', 'S256');
  if (options.injectedProfile) url.searchParams.set('profileId', options.injectedProfile);
  return connectedAppRequest(new Request(url, { method: 'GET' }), env.DB, config, {},
    options.resolve === undefined ? resolver(sessionId) : options.resolve);
}
async function exchange(code: string, options: { audience?: string; redirectUri?: string; verifier?: string;
  state?: string; key?: string } = {}) {
  const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: options.audience ?? 'recruiting-web',
    redirect_uri: options.redirectUri ?? redirect, code, code_verifier: options.verifier ?? verifier,
    state: options.state ?? state });
  return worker.fetch(new Request(`${issuer}/v1/connected-app-sessions/exchange`, {
    method: 'POST', headers: { authorization: `Bearer ${options.key ?? appKey}`,
      'content-type': 'application/x-www-form-urlencoded' }, body: form,
  }), { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW,
    CONNECTED_APP_IDENTITY_ENABLED: 'true', CONNECTED_APP_HOST_KEY: hostKey,
    CONNECTED_APP_SERVICE_KEYS: config.serviceKeys, CONNECTED_APP_REDIRECT_URIS: config.redirectUris,
    CONNECTED_APP_ISSUER: issuer });
}
function codeFrom(response: Response): string {
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location') ?? '');
  expect(`${location.origin}${location.pathname}`).toBe(redirect);
  expect(location.searchParams.get('iss')).toBe(issuer);
  expect(location.searchParams.get('state')).toBe(state);
  expect(location.searchParams.has('token')).toBe(false);
  return location.searchParams.get('code') ?? '';
}
async function introspect(token: string) {
  return worker.fetch(new Request(`${issuer}/v1/connected-app-sessions/introspect`, {
    method: 'POST', headers: { authorization: `Bearer ${appKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ token, audience: 'recruiting-web' }),
  }), { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW,
    CONNECTED_APP_IDENTITY_ENABLED: 'true', CONNECTED_APP_SERVICE_KEYS: config.serviceKeys,
    CONNECTED_APP_ISSUER: issuer });
}
async function hostSelect(sessionId: string, profileId: string, enabled: boolean) {
  return connectedAppRequest(new Request(`${issuer}/v1/connected-app-sessions/select`, {
    method: 'POST', headers: { authorization: `Bearer ${hostKey}` },
  }), env.DB, config, { sessionId, principalId: 'user_demo_001', profileId, enabled,
    grants: { 'recruiting-web': ['recruiting.responses.read'] } });
}

describe('Connected App browser authorization code with PKCE S256', () => {
  it('is fail-closed without a platform session resolver', async () => {
    const response = await authorize(id('closed'), { resolve: null });
    expect(response.status).toBe(503);
    const workerResponse = await worker.fetch(new Request(`${issuer}/v1/connected-app-sessions/authorize`, { method: 'GET' }),
      { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW, CONNECTED_APP_IDENTITY_ENABLED: 'true' });
    expect(workerResponse.status).toBe(503);
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
    expect((await authorize(id('wrong_aud'), { audience: 'crm-web' })).status).toBe(400);
    expect((await authorize(id('scope'), { scopes: 'recruiting.candidateSearch' })).status).toBe(403);
    const code = codeFrom(await authorize(id('bound')));
    expect((await exchange(code, { redirectUri: 'https://evil.example.invalid/callback' })).status).toBe(400);
    expect((await exchange(code, { audience: 'crm-web' })).status).toBe(401);
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
    expect((await connectedAppRequest(new Request(url), env.DB, config, {}, resolver(id('duplicate')))).status).toBe(400);
    url.searchParams.delete('redirect_uri');
    url.searchParams.set('redirect_uri', redirect);
    url.searchParams.set('code_challenge_method', 'plain');
    expect((await connectedAppRequest(new Request(url), env.DB, config, {}, resolver(id('plain')))).status).toBe(400);
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

  it('rejects expired codes', async () => {
    const code = codeFrom(await authorize(id('expired')));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
    const codeHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare('UPDATE connected_app_browser_codes SET expires_at = 1 WHERE code_hash = ?')
      .bind(codeHash).run();
    expect((await exchange(code)).status).toBe(403);
  });
});
