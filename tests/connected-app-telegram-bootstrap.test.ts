import { describe, expect, it, vi } from 'vitest';
import { env } from './env';
import worker from '../src/index';
import { telegramBootstrapRequest, sendPrivateLink, type SendPrivateLink } from '../src/connected-app/telegram-bootstrap';
import { createAgentProfileAuthorityV1 } from '../src/agent-profile-authority/v1';

const issuer = 'https://control.example.invalid';
const gatewayKey = 'telegram-gateway-test-key-with-32-chars';
const config = { enabled: 'true', gatewayKey, issuer,
  startUrls: JSON.stringify({ 'recruiting-web': 'https://recruiting.example.invalid/auth/connected/start' }) };
const bot = 'bot_recruiting';
const user = '123456789';
const chat = 123456789;
const principal = 'human_telegram_001';
const profile = 'profile_telegram_001';
let nextUpdate = 800000;
async function provision() {
  await env.DB.prepare(`INSERT INTO agent_telegram_bindings
    (bot_id,telegram_user_id,principal_id,enabled,updated_at) VALUES(?,?,?,1,1)
    ON CONFLICT(bot_id,telegram_user_id) DO UPDATE SET principal_id=excluded.principal_id,
    enabled=1,updated_at=updated_at+1`)
    .bind(bot, user, principal).run();
  await env.DB.prepare(`INSERT INTO agent_profile_memberships
    (principal_id,profile_id,enabled,updated_at) VALUES(?,?,1,1)
    ON CONFLICT(principal_id,profile_id) DO UPDATE SET enabled=1,updated_at=updated_at+1`)
    .bind(principal, profile).run();
  await env.DB.prepare(`INSERT INTO connected_app_memberships
    (principal_id,profile_id,audience,scopes_json,enabled,updated_at) VALUES(?,?,?,?,1,1)
    ON CONFLICT(principal_id,profile_id,audience) DO UPDATE SET scopes_json=excluded.scopes_json,
    enabled=1,updated_at=updated_at+1`)
    .bind(principal, profile, 'recruiting-web', JSON.stringify(['recruiting.responses.read'])).run();
}
async function start(updateId: string, body: Record<string, unknown> = {}, key = gatewayKey,
  send: SendPrivateLink = async () => {}) {
  return telegramBootstrapRequest(new Request(`${issuer}/v1/connected-app-bootstrap/telegram/start`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ botId: bot, updateId, telegramUserId: user, chatId: chat, chatType: 'private', ...body }),
  }), env.DB, config, send);
}
async function linkFor(updateId = String(nextUpdate++)) {
  let link = '';
  const response = await start(updateId, {}, gatewayKey, async (_config, actualChat, _bot, _update, value) => {
    expect(actualChat).toBe(chat);
    link = value;
  });
  expect(response.status).toBe(202);
  return link;
}
async function preview(link: string) {
  return telegramBootstrapRequest(new Request(link), env.DB, config);
}
function csrfFrom(page: string): string { return page.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1] ?? ''; }
async function redeem(link: string, csrf: string, csrfCookie: string, old = '') {
  return telegramBootstrapRequest(new Request(`${issuer}/v1/connected-app-bootstrap/telegram`, {
    method: 'POST', headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded',
      cookie: `${csrfCookie}${old ? `; ${old}` : ''}` },
    body: new URLSearchParams({ c: new URL(link).searchParams.get('c') ?? '', csrf }),
  }), env.DB, config);
}
async function selectProfile(browserCookie: string, selected = profile) {
  const page = await telegramBootstrapRequest(new Request(`${issuer}/v1/connected-app-bootstrap/apps`, {
    headers: { cookie: browserCookie },
  }), env.DB, config);
  const csrf = csrfFrom(await page.text());
  const csrfCookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
  return telegramBootstrapRequest(new Request(`${issuer}/v1/connected-app-bootstrap/select-profile`, {
    method: 'POST', headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded',
      cookie: `${browserCookie}; ${csrfCookie}` },
    body: new URLSearchParams({ profile_id: selected, csrf }),
  }), env.DB, config);
}

describe('opt-in Telegram private-chat browser bootstrap', () => {
  it('keeps the production Worker routes closed without the bootstrap flag', async () => {
    const response = await worker.fetch(new Request(`${issuer}/v1/connected-app-bootstrap/telegram`),
      { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW });
    expect(response.status).toBe(404);
  });
  it('uses the authenticated gateway transport and requires a provider message id', async () => {
    let sent: Request | null = null;
    const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent = new Request(input, init);
      return Response.json({ providerMessageId: 123 }, { status: 200 });
    });
    vi.stubGlobal('fetch', stub);
    try {
      const outbound = { ...config, gatewayUrl: 'https://gateway.example.invalid',
        gatewaySecret: 'gateway-outbound-key-with-thirty-two-chars' };
      await sendPrivateLink(outbound, chat, bot, '5000', 'https://control.example.invalid/link');
      const actual = sent as Request | null;
      expect(actual?.url).toBe('https://gateway.example.invalid/deliver/connected-app');
      expect(actual?.headers.get('authorization')).toBe(`Bearer ${outbound.gatewaySecret}`);
      const sentBody = await actual?.json() as Record<string, unknown>;
      expect(sentBody).toMatchObject({ botId: bot, channel: 'telegram', destinationId: chat,
        message: { kind: 'text' } });
      expect(sentBody.deliveryId).toMatch(/^login-[a-f0-9]{64}$/);
      expect(stub.mock.calls[0]?.[1]?.redirect).toBe('manual');
      stub.mockResolvedValueOnce(Response.json({}, { status: 200 }));
      await expect(sendPrivateLink(outbound, chat, bot, '5001', 'https://control.example.invalid/link'))
        .rejects.toThrow('gateway unavailable');
      stub.mockResolvedValueOnce(Response.json({ providerMessageId: '' }, { status: 200 }));
      await expect(sendPrivateLink(outbound, chat, bot, '5001a', 'https://control.example.invalid/link'))
        .rejects.toThrow('gateway unavailable');
      await expect(sendPrivateLink({ ...outbound, gatewayUrl: 'http://gateway.example.invalid' }, chat, bot, '5002', 'x'))
        .rejects.toThrow('gateway unavailable');
    } finally { vi.unstubAllGlobals(); }
  });
  it('requires signed private actor, reviewed binding and membership before sending', async () => {
    const update = String(nextUpdate++);
    expect((await start(update, {}, 'wrong')).status).toBe(401);
    expect((await start(update, { chatType: 'group' })).status).toBe(400);
    expect((await start(update, { chatId: -chat })).status).toBe(400);
    expect((await start(update, { telegramUserId: '123456788' })).status).toBe(400);
    expect((await start(update)).status).toBe(403);
    const routed = await worker.fetch(new Request(`${issuer}/v1/connected-app-bootstrap/telegram/start`, {
      method: 'POST', headers: { authorization: `Bearer ${gatewayKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ botId: bot, updateId: update, telegramUserId: user,
        chatId: chat, chatType: 'private' }),
    }), { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW,
      CONNECTED_APP_TELEGRAM_BOOTSTRAP_ENABLED: 'true',
      CONNECTED_APP_TELEGRAM_GATEWAY_KEY: gatewayKey, CONNECTED_APP_ISSUER: issuer,
      CONNECTED_APP_START_URLS: config.startUrls });
    expect(routed.status).toBe(403);
    await provision();
    expect((await start(update)).status).toBe(202);
    expect(await (await start(update)).json()).toMatchObject({ duplicate: true });
    await env.DB.prepare(`UPDATE connected_app_memberships SET audience='crm-web',updated_at=updated_at+1
      WHERE principal_id=? AND profile_id=? AND audience='recruiting-web'`).bind(principal, profile).run();
    expect((await start(String(nextUpdate++))).status).toBe(403);
    await env.DB.prepare(`UPDATE connected_app_memberships SET audience='recruiting-web',updated_at=updated_at+1
      WHERE principal_id=? AND profile_id=? AND audience='crm-web'`).bind(principal, profile).run();
  });

  it('does not consume a preview, requires CSRF POST and atomically rejects replay', async () => {
    await provision();
    const link = await linkFor();
    const first = await preview(link), second = await preview(link);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const csrf = csrfFrom(await second.text());
    const csrfCookie = second.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect((await redeem(link, '0'.repeat(64), csrfCookie)).status).toBe(403);
    const accepted = await redeem(link, csrf, csrfCookie);
    expect(accepted.status).toBe(303);
    const browserCookie = accepted.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(browserCookie).toMatch(/^__Host-ta_platform=[a-f0-9]{64}$/);
    expect(accepted.headers.get('location')).toBe('/v1/connected-app-bootstrap/apps');
    expect((await selectProfile(browserCookie)).status).toBe(303);
    const landing = await telegramBootstrapRequest(new Request(`${issuer}/v1/connected-app-bootstrap/apps`, {
      headers: { cookie: browserCookie },
    }), env.DB, config);
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain('https://recruiting.example.invalid/auth/connected/start');
    expect((await redeem(link, csrf, csrfCookie)).status).toBe(403);
    const authority = createAgentProfileAuthorityV1(env.DB);
    const resolved = await authority.resolveBrowserSession(new Request(`${issuer}/v1/connected-app-sessions/authorize`, {
      headers: { cookie: browserCookie },
    }));
    expect(resolved).toMatchObject({ principalId: principal, profileId: profile,
      profileGeneration: 1 });
    expect(await authority.resolveCurrentSession(resolved!.sessionId)).toEqual(resolved);
    expect((await selectProfile(browserCookie, profile)).status).toBe(303);
    expect(await authority.resolveCurrentSession(resolved!.sessionId)).toEqual(resolved);
    const url = new URL(`${issuer}/v1/connected-app-sessions/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', 'recruiting-web');
    url.searchParams.set('redirect_uri', 'https://recruiting.example.invalid/oauth/callback');
    url.searchParams.set('scope', 'recruiting.responses.read');
    url.searchParams.set('state', 'csrf-state-unguessable-0123456789');
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', 'A'.repeat(43));
    const auth = await worker.fetch(new Request(url, { headers: { cookie: browserCookie } }), {
      DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW,
      CONNECTED_APP_IDENTITY_ENABLED: 'true', CONNECTED_APP_TELEGRAM_BOOTSTRAP_ENABLED: 'true',
      CONNECTED_APP_ISSUER: issuer,
      CONNECTED_APP_REDIRECT_URIS: JSON.stringify({ 'recruiting-web': 'https://recruiting.example.invalid/oauth/callback' }),
    });
    expect(auth.status).toBe(303);
  });

  it('closes challenge on delivery failure and on reviewed binding removal', async () => {
    await provision();
    const update = String(nextUpdate++);
    expect((await start(update, {}, gatewayKey, async () => { throw new Error('send unknown'); })).status).toBe(503);
    expect(await (await start(update)).json()).toMatchObject({ duplicate: true });
    const link = await linkFor();
    const page = await preview(link);
    const csrf = csrfFrom(await page.text());
    const csrfCookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
    await env.DB.prepare('UPDATE agent_telegram_bindings SET enabled=0,updated_at=updated_at+1 WHERE bot_id=? AND telegram_user_id=?')
      .bind(bot, user).run();
    expect((await redeem(link, csrf, csrfCookie)).status).toBe(403);
  });

  it('keeps Agent context separate from app grants and revokes it on logout', async () => {
    await provision();
    const link = await linkFor();
    const page = await preview(link);
    const csrf = csrfFrom(await page.text());
    const csrfCookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
    const accepted = await redeem(link, csrf, csrfCookie);
    const browserCookie = accepted.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect((await selectProfile(browserCookie)).status).toBe(303);
    const authority = createAgentProfileAuthorityV1(env.DB);
    const request = () => new Request(`${issuer}/v1/connected-app-sessions/authorize`, { headers: { cookie: browserCookie } });
    expect(await authority.resolveBrowserSession(request())).not.toBeNull();
    await env.DB.prepare(`UPDATE connected_app_memberships SET enabled=0,updated_at=updated_at+1
      WHERE principal_id=? AND profile_id=? AND audience='recruiting-web'`).bind(principal, profile).run();
    expect(await authority.resolveBrowserSession(request())).not.toBeNull();
    expect((await start(String(nextUpdate++))).status).toBe(403);
    await env.DB.prepare(`UPDATE connected_app_memberships SET enabled=1,updated_at=updated_at+1
      WHERE principal_id=? AND profile_id=? AND audience='recruiting-web'`).bind(principal, profile).run();
    expect(await authority.resolveBrowserSession(request())).not.toBeNull();
    const nextLink = await linkFor();
    const nextPage = await preview(nextLink);
    const nextCsrf = csrfFrom(await nextPage.text());
    const nextCsrfCookie = nextPage.headers.get('set-cookie')?.split(';')[0] ?? '';
    const nextAccepted = await redeem(nextLink, nextCsrf, nextCsrfCookie);
    const nextCookie = nextAccepted.headers.get('set-cookie')?.split(';')[0] ?? '';
    const logoutPage = await telegramBootstrapRequest(new Request(`${issuer}/v1/connected-app-bootstrap/logout`, {
      headers: { cookie: nextCookie },
    }), env.DB, config);
    const logoutCsrf = csrfFrom(await logoutPage.text());
    const logoutCsrfCookie = logoutPage.headers.get('set-cookie')?.split(';')[0] ?? '';
    const logout = await telegramBootstrapRequest(new Request(`${issuer}/v1/connected-app-bootstrap/logout`, {
      method: 'POST', headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded',
        cookie: `${nextCookie}; ${logoutCsrfCookie}` },
      body: new URLSearchParams({ csrf: logoutCsrf }),
    }), env.DB, config);
    expect(logout.status).toBe(303);
    expect(await authority.resolveBrowserSession(new Request(`${issuer}/v1/connected-app-sessions/authorize`, {
      headers: { cookie: nextCookie },
    }))).toBeNull();
  });

  it('revokes an old Connected App grant when the same browser signs in again', async () => {
    await provision();
    const firstLink = await linkFor();
    const firstPage = await preview(firstLink);
    const firstCookie = (await redeem(firstLink, csrfFrom(await firstPage.text()),
      firstPage.headers.get('set-cookie')?.split(';')[0] ?? '')).headers.get('set-cookie')?.split(';')[0] ?? '';
    const rawToken = firstCookie.split('=')[1] ?? '';
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken)))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const row = await env.DB.prepare('SELECT session_id FROM agent_profile_browser_sessions WHERE session_hash=?')
      .bind(digest).first<{ session_id: string }>();
    expect(row?.session_id).toBeTruthy();
    await env.DB.prepare(`INSERT INTO connected_app_sessions
      (session_id,principal_id,profile_id,enabled,generation,updated_at,agent_generation) VALUES(?,?,?,1,1,1,1)`)
      .bind(row!.session_id, principal, profile).run();
    const nextLink = await linkFor();
    const nextPage = await preview(nextLink);
    const response = await redeem(nextLink, csrfFrom(await nextPage.text()),
      nextPage.headers.get('set-cookie')?.split(';')[0] ?? '', firstCookie);
    expect(response.status).toBe(303);
    const prior = await env.DB.prepare('SELECT enabled,generation FROM connected_app_sessions WHERE session_id=?')
      .bind(row!.session_id).first<{ enabled: number; generation: number }>();
    expect(prior).toMatchObject({ enabled: 0, generation: 2 });
  });

  it('lets one verified actor choose either reviewed profile and fences a switch', async () => {
    await provision();
    const second = 'profile_telegram_002';
    await env.DB.prepare(`INSERT INTO agent_profile_memberships
      (principal_id,profile_id,enabled,updated_at) VALUES(?,?,1,1)`)
      .bind(principal, second).run();
    await env.DB.prepare(`INSERT INTO connected_app_memberships
      (principal_id,profile_id,audience,scopes_json,enabled,updated_at) VALUES(?,?,?,?,1,1)`)
      .bind(principal, second, 'recruiting-web', JSON.stringify(['recruiting.candidateSearch'])).run();
    const link = await linkFor();
    const page = await preview(link);
    const accepted = await redeem(link, csrfFrom(await page.text()),
      page.headers.get('set-cookie')?.split(';')[0] ?? '');
    const browserCookie = accepted.headers.get('set-cookie')?.split(';')[0] ?? '';
    const authority = createAgentProfileAuthorityV1(env.DB);
    const request = () => new Request(`${issuer}/v1/connected-app-sessions/authorize`, {
      headers: { cookie: browserCookie },
    });
    expect(await authority.resolveBrowserSession(request())).toBeNull();
    const chooser = await telegramBootstrapRequest(new Request(`${issuer}/v1/connected-app-bootstrap/apps`, {
      headers: { cookie: browserCookie },
    }), env.DB, config);
    const chooserText = await chooser.text();
    expect(chooserText).toContain(profile);
    expect(chooserText).toContain(second);
    expect(chooserText).not.toContain('https://recruiting.example.invalid/auth/connected/start');
    expect((await selectProfile(browserCookie, 'foreign_profile')).status).toBe(403);
    const otherBot = 'bot_other_user'; const otherUser = '987654321';
    const otherPrincipal = 'human_telegram_002'; const otherProfile = 'profile_telegram_003';
    await env.DB.prepare(`INSERT INTO agent_telegram_bindings
      (bot_id,telegram_user_id,principal_id,enabled,updated_at) VALUES(?,?,?,1,1)`)
      .bind(otherBot, otherUser, otherPrincipal).run();
    await env.DB.prepare(`INSERT INTO agent_profile_memberships
      (principal_id,profile_id,enabled,updated_at) VALUES(?,?,1,1)`)
      .bind(otherPrincipal, otherProfile).run();
    await env.DB.prepare(`INSERT INTO connected_app_memberships
      (principal_id,profile_id,audience,scopes_json,enabled,updated_at) VALUES(?,?,?,?,1,1)`)
      .bind(otherPrincipal, otherProfile, 'recruiting-web', JSON.stringify(['recruiting.candidateSearch'])).run();
    let otherLink = '';
    expect((await start(String(nextUpdate++), { botId: otherBot, telegramUserId: otherUser,
      chatId: Number(otherUser) }, gatewayKey, async (_cfg, _chat, _bot, _update, link) => { otherLink = link; })).status).toBe(202);
    const otherLoginPage = await preview(otherLink);
    const otherAccepted = await redeem(otherLink, csrfFrom(await otherLoginPage.text()),
      otherLoginPage.headers.get('set-cookie')?.split(';')[0] ?? '');
    const otherCookie = otherAccepted.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect((await selectProfile(otherCookie, otherProfile)).status).toBe(303);
    expect(await authority.resolveBrowserSession(new Request(`${issuer}/v1/connected-app-sessions/authorize`, {
      headers: { cookie: otherCookie },
    }))).toMatchObject({ principalId: otherPrincipal, profileId: otherProfile });
    expect((await selectProfile(browserCookie, otherProfile)).status).toBe(403);
    expect((await selectProfile(browserCookie, profile)).status).toBe(303);
    const first = await authority.resolveBrowserSession(request());
    expect(first?.profileId).toBe(profile);
    await env.DB.prepare(`INSERT INTO connected_app_sessions
      (session_id,principal_id,profile_id,enabled,generation,updated_at,agent_generation) VALUES(?,?,?,1,1,1,?)`)
      .bind(first!.sessionId, principal, profile, first!.profileGeneration).run();
    expect((await selectProfile(browserCookie, second)).status).toBe(303);
    expect((await authority.resolveBrowserSession(request()))).toMatchObject({ profileId: second,
      profileGeneration: first!.profileGeneration + 1 });
    const prior = await env.DB.prepare('SELECT enabled,generation FROM connected_app_sessions WHERE session_id=?')
      .bind(first!.sessionId).first<{ enabled: number; generation: number }>();
    expect(prior).toMatchObject({ enabled: 1, generation: 1 });
    await env.DB.prepare(`UPDATE connected_app_memberships SET enabled=0,updated_at=updated_at+1
      WHERE principal_id=? AND profile_id=? AND audience='recruiting-web'`).bind(principal, second).run();
    expect(await authority.resolveBrowserSession(request())).not.toBeNull();
    await env.DB.prepare(`UPDATE agent_profile_memberships SET enabled=0,updated_at=updated_at+1
      WHERE principal_id=? AND profile_id=?`).bind(principal, second).run();
    expect(await authority.resolveBrowserSession(request())).toBeNull();
    expect(await authority.resolveCurrentSession(first!.sessionId)).toBeNull();
    await env.DB.prepare(`UPDATE agent_profile_memberships SET enabled=1,updated_at=updated_at+1
      WHERE principal_id=? AND profile_id=?`).bind(principal, second).run();
    expect(await authority.resolveBrowserSession(request())).toBeNull();
  });
});
