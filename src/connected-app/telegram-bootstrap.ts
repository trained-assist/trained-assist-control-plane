import contract from '../../contracts/connected-app-identity-v1.contract.json';
import { createAgentProfileAuthorityV1 } from '../agent-profile-authority/v1';

type Audience = keyof typeof contract.audiences;
export type TelegramBootstrapConfig = {
  enabled?: string; gatewayKey?: string; issuer?: string; gatewayUrl?: string; gatewaySecret?: string;
  startUrls?: string;
};
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DECIMAL = /^[1-9][0-9]{0,19}$/;
const HEX = /^[a-f0-9]{64}$/;
const COOKIE = '__Host-ta_platform';
const CSRF_COOKIE = '__Host-ta_login_csrf';
const CODE_AGE = 300;
const SESSION_AGE = 12 * 3600;
const noStore = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), {
  status, headers: { ...noStore, 'content-type': 'application/json' },
});
const html = (status: number, value: string, extra: Record<string, string> = {}) => new Response(value, {
  status, headers: { ...noStore, 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", ...extra },
});
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function equal(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
function cookie(req: Request, name: string): string | null {
  const matches = (req.headers.get('cookie') ?? '').split(';').map(s => s.trim())
    .filter(s => s.startsWith(`${name}=`)).map(s => s.slice(name.length + 1));
  return matches.length === 1 ? matches[0] ?? null : null;
}
function origin(config: TelegramBootstrapConfig): string | null {
  try {
    if (!config.issuer) return null;
    const url = new URL(config.issuer);
    return url.protocol === 'https:' && url.origin === config.issuer && !url.username && !url.password
      ? url.origin : null;
  } catch { return null; }
}
function appStarts(raw: string | undefined): Partial<Record<Audience, string>> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Partial<Record<Audience, string>> = {};
    for (const [audience, value] of Object.entries(parsed)) {
      if (!Object.hasOwn(contract.audiences, audience) || typeof value !== 'string') continue;
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
          url.pathname !== '/auth/connected/start' || url.href !== value) continue;
      result[audience as Audience] = value;
    }
    return result;
  } catch { return {}; }
}
async function hasMembership(db: D1Database, principalId: string, profileId: string,
  audiences: readonly string[] = Object.keys(contract.audiences)): Promise<boolean> {
  const rows = await db.prepare(`SELECT audience,scopes_json FROM connected_app_memberships
    WHERE principal_id = ? AND profile_id = ? AND enabled = 1`)
    .bind(principalId, profileId).all<{ audience: string; scopes_json: string }>();
  return rows.results.some(row => {
    if (!audiences.includes(row.audience) || !Object.hasOwn(contract.audiences, row.audience)) return false;
    let scopes: unknown;
    try { scopes = JSON.parse(row.scopes_json); } catch { return false; }
    const allowed = contract.audiences[row.audience as Audience] as readonly string[];
    return Array.isArray(scopes) && scopes.length > 0 && scopes.length <= 16 &&
      scopes.every(scope => typeof scope === 'string' && allowed.includes(scope)) &&
      new Set(scopes).size === scopes.length;
  });
}
export type SendPrivateLink = (config: TelegramBootstrapConfig, chatId: number, botId: string, updateId: string,
  link: string) => Promise<void>;

/** Uses the existing authenticated gateway /deliver seam, never a synthetic success adapter. */
export const sendPrivateLink: SendPrivateLink = async (config, chatId, botId, updateId, link) => {
  if (!config.gatewayUrl || !config.gatewaySecret || config.gatewaySecret.length < 32) throw new Error('gateway unavailable');
  const base = new URL(config.gatewayUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('gateway unavailable');
  const target = new URL('deliver/connected-app', `${base.href.replace(/\/$/, '')}/`);
  const deliveryId = `login-${await hash(`${botId}:${updateId}`)}`;
  const response = await fetch(target, { method: 'POST', redirect: 'manual',
    headers: { authorization: `Bearer ${config.gatewaySecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ deliveryId, botId, channel: 'telegram', destinationId: chatId,
      message: { kind: 'text', text: `Открыть веб-приложение: ${link}` } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || response.redirected) throw new Error('gateway unavailable');
  const result = await response.json().catch(() => null) as { providerMessageId?: unknown } | null;
  if (!result || !(Number.isSafeInteger(result.providerMessageId) && Number(result.providerMessageId) > 0))
    throw new Error('gateway unavailable');
};

/** Opt-in first-party login bootstrap. No membership or Telegram binding write route. */
export async function telegramBootstrapRequest(req: Request, db: D1Database, config: TelegramBootstrapConfig,
  send: SendPrivateLink = sendPrivateLink): Promise<Response> {
  if (config.enabled !== 'true') return json(404, { error: 'not found' });
  const base = origin(config);
  if (!base) return json(503, { error: 'issuer unavailable' });
  const url = new URL(req.url);
  const path = url.pathname;
  const now = Math.floor(Date.now() / 1000);
  const authority = createAgentProfileAuthorityV1(db);
  const starts = appStarts(config.startUrls);
  if (path === '/v1/connected-app-bootstrap/telegram/start') {
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
    if (!config.gatewayKey || config.gatewayKey.length < 32 ||
        !equal(req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '', config.gatewayKey))
      return json(401, { error: 'unauthorized' });
    if (!Object.keys(starts).length) return json(503, { error: 'app links unavailable' });
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const botId = body?.botId, updateId = body?.updateId, userId = body?.telegramUserId;
    const chatId = body?.chatId;
    if (typeof botId !== 'string' || !ID.test(botId) || typeof updateId !== 'string' || !DECIMAL.test(updateId) ||
        typeof userId !== 'string' || !DECIMAL.test(userId) ||
        typeof chatId !== 'number' || !Number.isSafeInteger(chatId) || chatId <= 0 ||
        String(chatId) !== userId || body?.chatType !== 'private') return json(400, { error: 'invalid private update' });
    const principalId = await authority.telegramPrincipal(botId, userId);
    if (!principalId || !(await eligibleProfiles(db, authority, principalId, Object.keys(starts))).length)
      return json(403, { error: 'forbidden' });
    const code = token();
    const inserted = await authority.insertLoginChallenge({ codeHash: await hash(code), botId, updateId,
      telegramUserId: userId, principalId, now, expiresAt: now + CODE_AGE });
    if (!inserted) return json(202, { accepted: true, duplicate: true });
    const link = `${base}/v1/connected-app-bootstrap/telegram?c=${code}`;
    try { await send(config, chatId, botId, updateId, link); }
    catch {
      await authority.invalidateLoginChallenge(await hash(code), now);
      return json(503, { error: 'delivery unavailable' });
    }
    return json(202, { accepted: true, duplicate: false });
  }
  if (path === '/v1/connected-app-bootstrap/telegram' && req.method === 'GET') {
    const code = url.searchParams.get('c');
    if (!code || !HEX.test(code)) return html(400, 'Ссылка недействительна');
    const csrf = token();
    return html(200, `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Войти</title><form method="post" action="/v1/connected-app-bootstrap/telegram"><input type="hidden" name="c" value="${code}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Войти</button></form></html>`,
      { 'set-cookie': `${CSRF_COOKIE}=${csrf}; HttpOnly; Secure; SameSite=Strict; Path=/` });
  }
  if (path === '/v1/connected-app-bootstrap/telegram' && req.method === 'POST') {
    if (req.headers.get('origin') !== base || !req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))
      return html(403, 'Вход отклонён');
    const form = await req.formData().catch(() => new FormData());
    const code = form.get('c'), csrf = form.get('csrf');
    if (typeof code !== 'string' || !HEX.test(code) || typeof csrf !== 'string' || !HEX.test(csrf) ||
        !equal(csrf, cookie(req, CSRF_COOKIE) ?? '')) return html(403, 'Вход отклонён');
    const sessionToken = token();
    const old = cookie(req, COOKIE);
    const sessionId = token();
    const consumed = await authority.consumeLoginChallenge({ codeHash: await hash(code),
      sessionHash: await hash(sessionToken), sessionId, now, expiresAt: now + SESSION_AGE });
    if (!consumed) return html(403, 'Ссылка устарела');
    if (old && HEX.test(old)) {
      const oldSessionId = await authority.revokeBrowserSession(await hash(old), now);
      if (oldSessionId) await db.prepare(`UPDATE connected_app_sessions SET enabled=0,
        generation=generation+1,updated_at=? WHERE session_id=?`).bind(now, oldSessionId).run();
    }
    return new Response(null, { status: 303, headers: { ...noStore, location: '/v1/connected-app-bootstrap/apps',
      'set-cookie': `${COOKIE}=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_AGE}` } });
  }
  if (path === '/v1/connected-app-bootstrap/apps' && req.method === 'GET') {
    const session = await authority.currentBrowserSession(req);
    if (!session) return html(401, 'Войдите по новой ссылке из Telegram.');
    const profiles = await eligibleProfiles(db, authority, session.principal_id, Object.keys(starts));
    if (!profiles.length) return html(403, 'Нет доступных профилей.');
    const csrf = token();
    const choices = profiles.map(profile => `<button type="submit" name="profile_id" value="${profile}">${profile}</button>`).join('');
    const chooser = `<form method="post" action="/v1/connected-app-bootstrap/select-profile"><input type="hidden" name="csrf" value="${csrf}">${choices}</form>`;
    const verified = profiles.includes(session.profile_id) ? await authority.resolveBrowserSession(req) : null;
    const links = (await Promise.all(Object.entries(starts).map(async ([audience, href]) =>
      verified && await hasMembership(db, session.principal_id, session.profile_id, [audience])
        ? `<li><a href="${href}">${audience === 'recruiting-web' ? 'Рекрутинг' : 'CRM'}</a></li>` : null)))
      .filter((value): value is string => value !== null).join('');
    return html(200, `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Выбор профиля</title><h1>Выберите профиль</h1>${chooser}${links ? `<h2>Выбран: ${session.profile_id}</h2><ul>${links}</ul>` : ''}</html>`,
      { 'set-cookie': `${CSRF_COOKIE}=${csrf}; HttpOnly; Secure; SameSite=Strict; Path=/` });
  }
  if (path === '/v1/connected-app-bootstrap/select-profile' && req.method === 'POST') {
    if (req.headers.get('origin') !== base || !req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))
      return html(403, 'Выбор отклонён');
    const form = await req.formData().catch(() => new FormData());
    const profile = form.get('profile_id'), csrf = form.get('csrf');
    if (typeof profile !== 'string' || !ID.test(profile) || typeof csrf !== 'string' || !HEX.test(csrf) ||
        !equal(csrf, cookie(req, CSRF_COOKIE) ?? '')) return html(403, 'Выбор отклонён');
    const session = await authority.currentBrowserSession(req);
    if (!session) return html(401, 'Войдите по новой ссылке из Telegram.');
    if (!(await eligibleProfiles(db, authority, session.principal_id, Object.keys(starts))).includes(profile))
      return html(403, 'Профиль недоступен');
    const raw = cookie(req, COOKIE)!;
    if (!(await authority.selectProfile(await hash(raw), session.principal_id, profile, now)))
      return html(403, 'Профиль недоступен');
    return new Response(null, { status: 303, headers: { ...noStore,
      location: '/v1/connected-app-bootstrap/apps' } });
  }
  if (path === '/v1/connected-app-bootstrap/logout' && req.method === 'GET') {
    const csrf = token();
    return html(200, `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Выйти</title><form method="post" action="/v1/connected-app-bootstrap/logout"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Выйти</button></form></html>`,
      { 'set-cookie': `${CSRF_COOKIE}=${csrf}; HttpOnly; Secure; SameSite=Strict; Path=/` });
  }
  if (path === '/v1/connected-app-bootstrap/logout' && req.method === 'POST') {
    if (req.headers.get('origin') !== base || !req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))
      return html(403, 'Выход отклонён');
    const form = await req.formData().catch(() => new FormData());
    const csrf = form.get('csrf');
    if (typeof csrf !== 'string' || !HEX.test(csrf) || !equal(csrf, cookie(req, CSRF_COOKIE) ?? ''))
      return html(403, 'Выход отклонён');
    const old = cookie(req, COOKIE);
    if (old && HEX.test(old)) {
      const sessionId = await authority.revokeBrowserSession(await hash(old), now);
      if (sessionId) await db.prepare(`UPDATE connected_app_sessions SET enabled=0,
        generation=generation+1,updated_at=? WHERE session_id=?`).bind(now, sessionId).run();
    }
    return new Response(null, { status: 303, headers: { ...noStore, location: '/',
      'set-cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` } });
  }
  return json(404, { error: 'not found' });
}

async function eligibleProfiles(db: D1Database, authority: ReturnType<typeof createAgentProfileAuthorityV1>,
  principalId: string, audiences: readonly string[]): Promise<string[]> {
  const profiles = await authority.profileIds(principalId);
  const eligible: string[] = [];
  for (const profile of profiles) if (await hasMembership(db, principalId, profile, audiences)) eligible.push(profile);
  return eligible;
}
