import contract from '../../contracts/connected-app-identity-v1.contract.json';

type Audience = keyof typeof contract.audiences;
type Config = { enabled?: string; hostKey?: string; serviceKeys?: string; issuer?: string };
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_AGE = contract.token.maxLifetimeSeconds;
const inactive = () => ({ active: false as const });
const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const invalid = () => respond({ error: 'invalid request' }, 400);
const unauthorized = () => respond({ error: 'unauthorized' }, 401);

function secureEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let difference = aa.length ^ bb.length;
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) difference |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return difference === 0;
}
function audienceOf(value: unknown): Audience | null {
  return typeof value === 'string' && Object.hasOwn(contract.audiences, value) ? value as Audience : null;
}
function scopesOf(value: unknown, audience: Audience): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 ||
      value.some(s => typeof s !== 'string' || !contract.audiences[audience].includes(s as never)) ||
      new Set(value).size !== value.length) return null;
  return value as string[];
}
async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function keysOf(raw: string | undefined): Partial<Record<Audience, string>> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const values = parsed as Record<string, unknown>;
    return Object.fromEntries(Object.entries(values).filter(([aud, key]) => audienceOf(aud) && typeof key === 'string' && key.length >= 32));
  } catch { return {}; }
}
type Session = { principal_id: string; profile_id: string; enabled: number; generation: number };
type Token = { session_id: string; generation: number; audience: string; scopes_json: string; issued_at: number;
  expires_at: number; revoked_at: number | null };

/** Host-side and app-service API only. No browser credential is minted here. */
export async function connectedAppRequest(req: Request, db: D1Database, config: Config, body: Record<string, unknown>): Promise<Response> {
  if (config.enabled !== 'true') return respond({ error: 'not found' }, 404);
  const url = new URL(req.url);
  const path = url.pathname;
  const audience = audienceOf(body.audience);
  const now = Math.floor(Date.now() / 1000);
  const isIntrospect = path === '/v1/connected-app-sessions/introspect';
  const hostKey = (config.hostKey?.length ?? 0) >= 32 ? config.hostKey ?? '' : '';
  const serviceKey = audience ? keysOf(config.serviceKeys)[audience] ?? '' : '';
  const supplied = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (isIntrospect ? !secureEqual(supplied, serviceKey) : !secureEqual(supplied, hostKey)) return unauthorized();
  if (req.method !== 'POST') return respond({ error: 'method not allowed' }, 405);

  if (isIntrospect) {
    if (!audience || typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) return respond(inactive());
    const row = await db.prepare('SELECT * FROM connected_app_tokens WHERE token_hash = ?')
      .bind(await hash(body.token)).first<Token>();
    if (!row || row.revoked_at !== null || row.audience !== audience || row.expires_at <= now || row.issued_at > now) return respond(inactive());
    const session = await db.prepare('SELECT * FROM connected_app_sessions WHERE session_id = ?')
      .bind(row.session_id).first<Session>();
    const grant = await db.prepare('SELECT scopes_json FROM connected_app_grants WHERE session_id = ? AND audience = ?')
      .bind(row.session_id, audience).first<{ scopes_json: string }>();
    const tokenScopes = JSON.parse(row.scopes_json) as string[];
    const currentScopes = grant ? JSON.parse(grant.scopes_json) as string[] : [];
    if (!session || session.enabled !== 1 || session.generation !== row.generation ||
        !ID.test(session.principal_id) || !ID.test(session.profile_id) ||
        !tokenScopes.length || !tokenScopes.every(scope => currentScopes.includes(scope))) return respond(inactive());
    return respond({ active: true, iss: config.issuer, aud: audience, sub: session.principal_id,
      profileId: session.profile_id, sessionId: row.session_id, nbf: row.issued_at, exp: row.expires_at,
      scopes: tokenScopes });
  }

  if (path === '/v1/connected-app-sessions/select') {
    const { sessionId, principalId, profileId, enabled, grants } = body;
    if (typeof sessionId !== 'string' || !ID.test(sessionId) || typeof principalId !== 'string' || !ID.test(principalId) ||
        typeof profileId !== 'string' || !ID.test(profileId) || typeof enabled !== 'boolean' ||
        typeof grants !== 'object' || grants === null || Array.isArray(grants)) return invalid();
    const entries = Object.entries(grants);
    if (!entries.length || entries.some(([aud, scopes]) => !audienceOf(aud) || !scopesOf(scopes, aud as Audience))) return invalid();
    const previous = await db.prepare('SELECT principal_id FROM connected_app_sessions WHERE session_id = ?')
      .bind(sessionId).first<{ principal_id: string }>();
    if (previous && previous.principal_id !== principalId) return respond({ error: 'session owner conflict' }, 409);
    // Every host update advances generation, immediately invalidating earlier tokens.
    await db.batch([
      db.prepare(`INSERT INTO connected_app_sessions(session_id, principal_id, profile_id, enabled, generation, updated_at)
        VALUES(?,?,?,?,1,?) ON CONFLICT(session_id) DO UPDATE SET profile_id=excluded.profile_id,
        enabled=excluded.enabled, generation=generation+1, updated_at=excluded.updated_at`)
        .bind(sessionId, principalId, profileId, enabled ? 1 : 0, now),
      db.prepare('DELETE FROM connected_app_grants WHERE session_id = ?').bind(sessionId),
      ...entries.map(([aud, scopes]) => db.prepare('INSERT INTO connected_app_grants(session_id,audience,scopes_json) VALUES(?,?,?)')
        .bind(sessionId, aud, JSON.stringify(scopes))),
    ]);
    return respond({ selected: true });
  }

  if (path === '/v1/connected-app-sessions/issue') {
    const sessionId = body.sessionId;
    const scopes = audience ? scopesOf(body.scopes, audience) : null;
    if (typeof sessionId !== 'string' || !ID.test(sessionId) || !audience || !scopes) return invalid();
    if (!config.issuer || !/^https:\/\//.test(config.issuer)) return respond({ error: 'issuer not configured' }, 503);
    const session = await db.prepare('SELECT * FROM connected_app_sessions WHERE session_id = ?')
      .bind(sessionId).first<Session>();
    const grant = await db.prepare('SELECT scopes_json FROM connected_app_grants WHERE session_id = ? AND audience = ?')
      .bind(sessionId, audience).first<{ scopes_json: string }>();
    const allowed = grant ? JSON.parse(grant.scopes_json) as string[] : [];
    if (!session || session.enabled !== 1 || !scopes.every(scope => allowed.includes(scope))) return respond({ error: 'forbidden' }, 403);
    const bearer = token();
    await db.prepare(`INSERT INTO connected_app_tokens(token_hash,session_id,generation,audience,scopes_json,issued_at,expires_at,revoked_at)
      VALUES(?,?,?,?,?,?,?,NULL)`).bind(await hash(bearer), sessionId, session.generation, audience,
      JSON.stringify(scopes), now, now + MAX_AGE).run();
    return respond({ token: bearer, expiresAt: now + MAX_AGE }, 201);
  }

  if (path === '/v1/connected-app-sessions/revoke') {
    const tokenHash = typeof body.token === 'string' && /^[a-f0-9]{64}$/.test(body.token) ? await hash(body.token) : null;
    if (!tokenHash || !HASH.test(tokenHash)) return invalid();
    await db.prepare('UPDATE connected_app_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?')
      .bind(now, tokenHash).run();
    return respond({ revoked: true });
  }
  if (path === '/v1/connected-app-sessions/disable-principal') {
    const principalId = body.principalId;
    if (typeof principalId !== 'string' || !ID.test(principalId)) return invalid();
    await db.prepare('UPDATE connected_app_sessions SET enabled = 0, generation = generation + 1, updated_at = ? WHERE principal_id = ?')
      .bind(now, principalId).run();
    return respond({ disabled: true });
  }
  return respond({ error: 'not found' }, 404);
}
