import contract from '../../contracts/connected-app-identity-v1.contract.json';
import type { PlatformSessionResolver, VerifiedPlatformSession } from './session-service';

type Audience = keyof typeof contract.audiences;
export type TelegramBootstrapConfig = {
  enabled?: string; gatewayKey?: string; issuer?: string; gatewayUrl?: string; gatewaySecret?: string;
  startUrls?: string;
};
type Binding = { principal_id: string; enabled: number };
type Challenge = { bot_id: string; telegram_user_id: string; principal_id: string; profile_id: string;
  expires_at: number; consumed_at: number | null; invalidated_at: number | null };
type BrowserSession = { session_id: string; bot_id: string; telegram_user_id: string; principal_id: string;
  profile_id: string; expires_at: number; revoked_at: number | null };
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
async function eligibleProfiles(db: D1Database, principalId: string,
  audiences: readonly string[]): Promise<string[]> {
  const rows = await db.prepare(`SELECT DISTINCT profile_id FROM connected_app_memberships
    WHERE principal_id = ? AND enabled = 1 ORDER BY profile_id`).bind(principalId)
    .all<{ profile_id: string }>();
  const profiles: string[] = [];
  for (const row of rows.results) {
    if (ID.test(row.profile_id) && await hasMembership(db, principalId, row.profile_id, audiences))
      profiles.push(row.profile_id);
  }
  return profiles;
}
async function currentBinding(db: D1Database, botId: string, telegramUserId: string): Promise<Binding | null> {
  return db.prepare(`SELECT principal_id,enabled FROM connected_app_telegram_bindings
    WHERE bot_id = ? AND telegram_user_id = ?`).bind(botId, telegramUserId).first<Binding>();
}
async function currentBrowserSession(req: Request, db: D1Database): Promise<BrowserSession | null> {
  const raw = cookie(req, COOKIE);
  if (!raw || !HEX.test(raw)) return null;
  const row = await db.prepare('SELECT * FROM connected_app_browser_sessions WHERE session_hash = ?')
    .bind(await hash(raw)).first<BrowserSession>();
  if (!row || row.revoked_at !== null || row.expires_at <= Math.floor(Date.now() / 1000)) return null;
  const binding = await currentBinding(db, row.bot_id, row.telegram_user_id);
  return binding?.enabled === 1 && binding.principal_id === row.principal_id ? row : null;
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
    const binding = await currentBinding(db, botId, userId);
    if (!binding || binding.enabled !== 1 || !ID.test(binding.principal_id) ||
        !(await eligibleProfiles(db, binding.principal_id, Object.keys(starts))).length)
      return json(403, { error: 'forbidden' });
    const code = token();
    const inserted = await db.prepare(`INSERT INTO connected_app_telegram_challenges
      (code_hash,bot_id,update_id,telegram_user_id,principal_id,profile_id,created_at,expires_at,consumed_at,invalidated_at)
      VALUES(?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT(bot_id,update_id) DO NOTHING`)
      .bind(await hash(code), botId, updateId, userId, binding.principal_id, '', now, now + CODE_AGE).run();
    if (inserted.meta.changes !== 1) return json(202, { accepted: true, duplicate: true });
    const link = `${base}/v1/connected-app-bootstrap/telegram?c=${code}`;
    try { await send(config, chatId, botId, updateId, link); }
    catch {
      await db.prepare(`UPDATE connected_app_telegram_challenges SET invalidated_at = ? WHERE code_hash = ?`)
        .bind(now, await hash(code)).run();
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
    const digest = await hash(code);
    const challenge = await db.prepare('SELECT * FROM connected_app_telegram_challenges WHERE code_hash = ?')
      .bind(digest).first<Challenge>();
    if (!challenge || challenge.expires_at <= now || challenge.consumed_at !== null || challenge.invalidated_at !== null)
      return html(403, 'Ссылка устарела');
    const binding = await currentBinding(db, challenge.bot_id, challenge.telegram_user_id);
    if (!binding || binding.enabled !== 1 || binding.principal_id !== challenge.principal_id ||
        !(await eligibleProfiles(db, challenge.principal_id, Object.keys(starts))).length)
      return html(403, 'Ссылка устарела');
    const consumed = await db.prepare(`UPDATE connected_app_telegram_challenges SET consumed_at = ?
      WHERE code_hash = ? AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > ?`)
      .bind(now, digest, now).run();
    if (consumed.meta.changes !== 1) return html(403, 'Ссылка устарела');
    const sessionToken = token();
    const old = cookie(req, COOKIE);
    const sessionId = token();
    const oldDigest = old && HEX.test(old) ? await hash(old) : null;
    const previous = oldDigest ? await db.prepare(`SELECT session_id FROM connected_app_browser_sessions
      WHERE session_hash = ?`).bind(oldDigest).first<{ session_id: string }>() : null;
    const saved = await db.batch([
      ...(oldDigest ? [db.prepare(`UPDATE connected_app_browser_sessions SET revoked_at = COALESCE(revoked_at, ?)
        WHERE session_hash = ?`).bind(now, oldDigest)] : []),
      ...(previous ? [db.prepare(`UPDATE connected_app_sessions SET enabled = 0, generation = generation + 1,
        updated_at = ? WHERE session_id = ?`).bind(now, previous.session_id)] : []),
      db.prepare(`INSERT INTO connected_app_browser_sessions
        (session_hash,session_id,bot_id,telegram_user_id,principal_id,profile_id,issued_at,expires_at,revoked_at)
        SELECT ?,?,c.bot_id,c.telegram_user_id,c.principal_id,'',?,?,NULL
        FROM connected_app_telegram_challenges c
        JOIN connected_app_telegram_bindings b ON b.bot_id=c.bot_id AND b.telegram_user_id=c.telegram_user_id
        WHERE c.code_hash=? AND c.consumed_at=? AND c.invalidated_at IS NULL AND b.enabled=1
          AND b.principal_id=c.principal_id
          AND EXISTS(SELECT 1 FROM connected_app_memberships m WHERE m.principal_id=c.principal_id
            AND m.enabled=1)`)
        .bind(await hash(sessionToken), sessionId, now, now + SESSION_AGE, digest, now),
    ]);
    if (saved.at(-1)?.meta.changes !== 1) return html(403, 'Ссылка устарела');
    return new Response(null, { status: 303, headers: { ...noStore, location: '/v1/connected-app-bootstrap/apps',
      'set-cookie': `${COOKIE}=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_AGE}` } });
  }
  if (path === '/v1/connected-app-bootstrap/apps' && req.method === 'GET') {
    const session = await currentBrowserSession(req, db);
    if (!session) return html(401, 'Войдите по новой ссылке из Telegram.');
    const profiles = await eligibleProfiles(db, session.principal_id, Object.keys(starts));
    if (!profiles.length) return html(403, 'Нет доступных профилей.');
    const csrf = token();
    const choices = profiles.map(profile => `<button type="submit" name="profile_id" value="${profile}">${profile}</button>`).join('');
    const chooser = `<form method="post" action="/v1/connected-app-bootstrap/select-profile"><input type="hidden" name="csrf" value="${csrf}">${choices}</form>`;
    const verified = profiles.includes(session.profile_id) ? await telegramPlatformSessionResolver(db)(req) : null;
    const links = Object.entries(starts).filter(([audience]) => verified &&
      Object.hasOwn(verified.grants, audience)).map(([audience, href]) =>
      `<li><a href="${href}">${audience === 'recruiting-web' ? 'Рекрутинг' : 'CRM'}</a></li>`).join('');
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
    const session = await currentBrowserSession(req, db);
    if (!session) return html(401, 'Войдите по новой ссылке из Telegram.');
    if (!(await eligibleProfiles(db, session.principal_id, Object.keys(starts))).includes(profile))
      return html(403, 'Профиль недоступен');
    const raw = cookie(req, COOKIE)!;
    const saved = await db.batch([
      db.prepare(`UPDATE connected_app_browser_sessions SET profile_id = ? WHERE session_hash = ?
        AND revoked_at IS NULL AND expires_at > ? AND principal_id = ?
        AND EXISTS(SELECT 1 FROM connected_app_memberships m WHERE m.principal_id = ?
          AND m.profile_id = ? AND m.enabled = 1)`)
        .bind(profile, await hash(raw), now, session.principal_id, session.principal_id, profile),
      db.prepare(`UPDATE connected_app_sessions SET enabled = 0, generation = generation + 1,
        updated_at = ? WHERE session_id = ?`).bind(now, session.session_id),
    ]);
    if (saved[0]?.meta.changes !== 1) return html(403, 'Профиль недоступен');
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
      const digest = await hash(old);
      const previous = await db.prepare('SELECT session_id FROM connected_app_browser_sessions WHERE session_hash = ?')
        .bind(digest).first<{ session_id: string }>();
      await db.batch([
        db.prepare('UPDATE connected_app_browser_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE session_hash = ?')
          .bind(now, digest),
        ...(previous ? [db.prepare(`UPDATE connected_app_sessions SET enabled = 0, generation = generation + 1,
          updated_at = ? WHERE session_id = ?`).bind(now, previous.session_id)] : []),
      ]);
    }
    return new Response(null, { status: 303, headers: { ...noStore, location: '/',
      'set-cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` } });
  }
  return json(404, { error: 'not found' });
}

export function telegramPlatformSessionResolver(db: D1Database): PlatformSessionResolver {
  return async (req): Promise<VerifiedPlatformSession | null> => {
    const row = await currentBrowserSession(req, db);
    if (!row || !ID.test(row.profile_id)) return null;
    const members = await db.prepare(`SELECT audience,scopes_json FROM connected_app_memberships
      WHERE principal_id = ? AND profile_id = ? AND enabled = 1`)
      .bind(row.principal_id, row.profile_id).all<{ audience: string; scopes_json: string }>();
    const grants: Partial<Record<Audience, string[]>> = {};
    for (const member of members.results) {
      if (!Object.hasOwn(contract.audiences, member.audience)) continue;
      const audience = member.audience as Audience;
      let scopes: unknown;
      try { scopes = JSON.parse(member.scopes_json); } catch { continue; }
      if (!Array.isArray(scopes) || !scopes.length || scopes.length > 16 ||
          new Set(scopes).size !== scopes.length || scopes.some(scope =>
        typeof scope !== 'string' || !contract.audiences[audience].includes(scope as never))) continue;
      grants[audience] = scopes as string[];
    }
    return Object.keys(grants).length ? { principalId: row.principal_id, profileId: row.profile_id,
      sessionId: row.session_id, grants } : null;
  };
}
