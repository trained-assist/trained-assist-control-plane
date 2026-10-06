import contract from '../../contracts/connected-app-identity-v1.contract.json';

type Audience = keyof typeof contract.audiences;
type Config = { enabled?: string; hostKey?: string; serviceKeys?: string; issuer?: string; redirectUris?: string };
export type AgentProfileContext = { principalId: string; profileId: string; sessionId: string;
  profileGeneration: number };
export type AgentProfileAuthority = {
  resolveBrowserSession(request: Request): Promise<AgentProfileContext | null>;
  resolveCurrentSession(sessionId: string): Promise<AgentProfileContext | null>;
};
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
function redirectOf(raw: string | undefined, audience: Audience): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)[audience];
    if (typeof value !== 'string' || !value.startsWith('https://')) return null;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.href === value ? value : null;
  } catch { return null; }
}
type Session = { principal_id: string; profile_id: string; enabled: number; generation: number; agent_generation: number };
type Membership = { scopes_json: string; enabled: number };
type Token = { session_id: string; generation: number; audience: string; scopes_json: string; issued_at: number;
  expires_at: number; revoked_at: number | null };
type Code = { session_id: string; generation: number; audience: string; scopes_json: string; redirect_uri: string;
  state_hash: string; code_challenge: string; expires_at: number; consumed_at: number | null };
async function s256(verifier: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function membershipScopes(db: D1Database, principalId: string, profileId: string,
  audience: Audience): Promise<string[]> {
  // This row is only an audience-specific Connected App entitlement. It is not
  // proof that the Agent user belongs to the profile; that comes from Agent authority.
  const row = await db.prepare(`SELECT scopes_json, enabled FROM connected_app_memberships
    WHERE principal_id = ? AND profile_id = ? AND audience = ?`)
    .bind(principalId, profileId, audience).first<Membership>();
  if (!row || row.enabled !== 1) return [];
  try { return scopesOf(JSON.parse(row.scopes_json), audience) ?? []; } catch { return []; }
}

function validAgentContext(context: AgentProfileContext | null, sessionId?: string): context is AgentProfileContext {
  return !!context && ID.test(context.principalId) && ID.test(context.profileId) && ID.test(context.sessionId) &&
    (sessionId === undefined || context.sessionId === sessionId) &&
    Number.isSafeInteger(context.profileGeneration) && context.profileGeneration > 0;
}

function matchesAgentSession(context: AgentProfileContext | null, sessionId: string, session: Session): boolean {
  return validAgentContext(context, sessionId) && context.principalId === session.principal_id &&
    context.profileId === session.profile_id && context.profileGeneration === session.agent_generation;
}

async function resolveCurrent(authority: AgentProfileAuthority | null, sessionId: string): Promise<
  { status: 'active'; context: AgentProfileContext } | { status: 'inactive' } | { status: 'unavailable' }> {
  if (!authority) return { status: 'unavailable' };
  try {
    const context = await authority.resolveCurrentSession(sessionId);
    return validAgentContext(context, sessionId) ? { status: 'active', context } : { status: 'inactive' };
  } catch {
    return { status: 'unavailable' };
  }
}

function authorityUnavailable() {
  return respond({ error: 'agent profile authority unavailable' }, 503);
}

/** Host-side and app-service API only. No browser credential is minted here. */
export async function connectedAppRequest(req: Request, db: D1Database, config: Config, body: Record<string, unknown>,
  agentAuthority: AgentProfileAuthority | null = null): Promise<Response> {
  if (config.enabled !== 'true') return respond({ error: 'not found' }, 404);
  const url = new URL(req.url);
  const path = url.pathname;
  const audience = audienceOf(body.audience);
  const now = Math.floor(Date.now() / 1000);
  const isIntrospect = path === '/v1/connected-app-sessions/introspect';
  const isAuthorize = path === '/v1/connected-app-sessions/authorize';
  const isExchange = path === '/v1/connected-app-sessions/exchange';
  const params = isAuthorize ? url.searchParams : null;
  const requestedAudience = isAuthorize ? params?.get('client_id') : body.client_id;
  const handoffAudience = audienceOf(requestedAudience);
  const hostKey = (config.hostKey?.length ?? 0) >= 32 ? config.hostKey ?? '' : '';
  const serviceKey = (isExchange ? handoffAudience : audience) ?
    keysOf(config.serviceKeys)[(isExchange ? handoffAudience : audience)!] ?? '' : '';
  const supplied = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!isAuthorize && (isIntrospect || isExchange ? !secureEqual(supplied, serviceKey) : !secureEqual(supplied, hostKey))) return unauthorized();
  if (req.method !== (isAuthorize ? 'GET' : 'POST')) return respond({ error: 'method not allowed' }, 405);

  if (isAuthorize) {
    // The Worker deliberately supplies no production authority until Agent auth is wired.
    if (!agentAuthority) return authorityUnavailable();
    const scopeText = params?.get('scope') ?? '';
    const requested = handoffAudience ? scopesOf(scopeText.split(' '), handoffAudience) : null;
    const registeredRedirect = handoffAudience ? redirectOf(config.redirectUris, handoffAudience) : null;
    const state = params?.get('state');
    const challenge = params?.get('code_challenge');
    const required = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state',
      'code_challenge', 'code_challenge_method'];
    if (!required.every(key => params?.getAll(key).length === 1) ||
        params?.get('response_type') !== 'code' || params?.get('code_challenge_method') !== 'S256' ||
        !handoffAudience || !requested || !registeredRedirect || params?.get('redirect_uri') !== registeredRedirect ||
        typeof state !== 'string' || state.length < 16 || state.length > 256 ||
        typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return invalid();
    if (!config.issuer || !/^https:\/\//.test(config.issuer)) return respond({ error: 'issuer not configured' }, 503);
    let verified: AgentProfileContext | null;
    try { verified = await agentAuthority.resolveBrowserSession(req); }
    catch { return authorityUnavailable(); }
    if (!validAgentContext(verified)) return unauthorized();
    const allowed = await membershipScopes(db, verified.principalId, verified.profileId, handoffAudience);
    if (!allowed.length || !requested.every(scope => allowed.includes(scope))) return respond({ error: 'forbidden' }, 403);
    const previous = await db.prepare('SELECT * FROM connected_app_sessions WHERE session_id = ?')
      .bind(verified.sessionId).first<Session>();
    if (previous && previous.principal_id !== verified.principalId) return respond({ error: 'session owner conflict' }, 409);
    const oldGrant = await db.prepare('SELECT scopes_json FROM connected_app_grants WHERE session_id = ? AND audience = ?')
      .bind(verified.sessionId, handoffAudience).first<{ scopes_json: string }>();
    const changed = !previous || previous.profile_id !== verified.profileId || previous.enabled !== 1 ||
      previous.agent_generation !== verified.profileGeneration ||
      oldGrant?.scopes_json !== JSON.stringify(allowed);
    if (changed) {
      await db.batch([
        db.prepare(`INSERT INTO connected_app_sessions(session_id,principal_id,profile_id,enabled,generation,updated_at,agent_generation)
          VALUES(?,?,?,?,1,?,?) ON CONFLICT(session_id) DO UPDATE SET profile_id=excluded.profile_id,
          agent_generation=excluded.agent_generation,
          enabled=1,generation=generation+1,updated_at=excluded.updated_at`)
          .bind(verified.sessionId, verified.principalId, verified.profileId, 1, now, verified.profileGeneration),
        ...(previous?.profile_id !== verified.profileId
          ? [db.prepare('DELETE FROM connected_app_grants WHERE session_id = ?').bind(verified.sessionId)] : []),
        db.prepare(`INSERT INTO connected_app_grants(session_id,audience,scopes_json) VALUES(?,?,?)
          ON CONFLICT(session_id,audience) DO UPDATE SET scopes_json=excluded.scopes_json`)
          .bind(verified.sessionId, handoffAudience, JSON.stringify(allowed)),
      ]);
    }
    const current = await db.prepare('SELECT generation FROM connected_app_sessions WHERE session_id = ?')
      .bind(verified.sessionId).first<{ generation: number }>();
    if (!current) return respond({ error: 'session unavailable' }, 503);
    const code = token();
    await db.prepare(`INSERT INTO connected_app_browser_codes
      (code_hash,session_id,generation,audience,scopes_json,redirect_uri,state_hash,code_challenge,created_at,expires_at,consumed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`).bind(await hash(code), verified.sessionId, current.generation, handoffAudience,
      JSON.stringify(requested), registeredRedirect, await hash(state), challenge, now, now + 60).run();
    const location = new URL(registeredRedirect);
    location.searchParams.set('code', code);
    location.searchParams.set('state', state);
    location.searchParams.set('iss', config.issuer);
    return new Response(null, { status: 303, headers: { location: location.href, 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer' } });
  }

  if (isExchange) {
    const registeredRedirect = handoffAudience ? redirectOf(config.redirectUris, handoffAudience) : null;
    const code = body.code;
    const state = body.state;
    const verifier = body.code_verifier;
    if (body.grant_type !== 'authorization_code' || !handoffAudience || !registeredRedirect ||
        body.redirect_uri !== registeredRedirect ||
        typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code) ||
        typeof state !== 'string' || state.length < 16 || state.length > 256 ||
        typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return invalid();
    const codeHash = await hash(code);
    const row = await db.prepare('SELECT * FROM connected_app_browser_codes WHERE code_hash = ?')
      .bind(codeHash).first<Code>();
    if (!row || row.audience !== handoffAudience || row.redirect_uri !== registeredRedirect ||
        row.state_hash !== await hash(state) || row.code_challenge !== await s256(verifier) ||
        row.expires_at <= now || row.consumed_at !== null)
      return respond({ error: 'invalid code' }, 403);
    const session = await db.prepare('SELECT * FROM connected_app_sessions WHERE session_id = ?')
      .bind(row.session_id).first<Session>();
    if (!session || session.enabled !== 1 || session.generation !== row.generation)
      return respond({ error: 'session changed' }, 403);
    const currentContext = await resolveCurrent(agentAuthority, row.session_id);
    if (currentContext.status === 'unavailable') return authorityUnavailable();
    if (currentContext.status !== 'active' || !matchesAgentSession(currentContext.context, row.session_id, session))
      return respond({ error: 'session changed' }, 403);
    const grant = await db.prepare('SELECT scopes_json FROM connected_app_grants WHERE session_id = ? AND audience = ?')
      .bind(row.session_id, handoffAudience).first<{ scopes_json: string }>();
    const scopes = JSON.parse(row.scopes_json) as string[];
    const allowed = grant ? JSON.parse(grant.scopes_json) as string[] : [];
    const appScopes = await membershipScopes(db, session.principal_id, session.profile_id, handoffAudience);
    if (!scopes.every(scope => allowed.includes(scope) && appScopes.includes(scope))) return respond({ error: 'session changed' }, 403);
    if (!config.issuer || !/^https:\/\//.test(config.issuer)) return respond({ error: 'issuer not configured' }, 503);
    // An unavailable authority above does not burn the code. Consume only after
    // current Agent session and app grant have both been checked.
    const consume = await db.prepare(`UPDATE connected_app_browser_codes SET consumed_at = ?
      WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`).bind(now, codeHash, now).run();
    if (consume.meta.changes !== 1) return respond({ error: 'invalid code' }, 403);
    const bearer = token();
    await db.prepare(`INSERT INTO connected_app_tokens(token_hash,session_id,generation,audience,scopes_json,issued_at,expires_at,revoked_at)
      VALUES(?,?,?,?,?,?,?,NULL)`).bind(await hash(bearer), row.session_id, row.generation, handoffAudience,
      JSON.stringify(scopes), now, now + MAX_AGE).run();
    return respond({ token: bearer, expiresAt: now + MAX_AGE }, 201);
  }

  if (isIntrospect) {
    if (!audience || typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) return respond(inactive());
    const row = await db.prepare('SELECT * FROM connected_app_tokens WHERE token_hash = ?')
      .bind(await hash(body.token)).first<Token>();
    if (!row || row.revoked_at !== null || row.audience !== audience || row.expires_at <= now || row.issued_at > now) return respond(inactive());
    const session = await db.prepare('SELECT * FROM connected_app_sessions WHERE session_id = ?')
      .bind(row.session_id).first<Session>();
    if (!session || session.enabled !== 1 || session.generation !== row.generation ||
        !ID.test(session.principal_id) || !ID.test(session.profile_id)) return respond(inactive());
    const currentContext = await resolveCurrent(agentAuthority, row.session_id);
    if (currentContext.status === 'unavailable') return authorityUnavailable();
    const grant = await db.prepare('SELECT scopes_json FROM connected_app_grants WHERE session_id = ? AND audience = ?')
      .bind(row.session_id, audience).first<{ scopes_json: string }>();
    const tokenScopes = JSON.parse(row.scopes_json) as string[];
    const currentScopes = grant ? JSON.parse(grant.scopes_json) as string[] : [];
    const appScopes = await membershipScopes(db, session.principal_id, session.profile_id, audience);
    if (currentContext.status !== 'active' || !matchesAgentSession(currentContext.context, row.session_id, session) ||
        !tokenScopes.length || !tokenScopes.every(scope => currentScopes.includes(scope) && appScopes.includes(scope))) return respond(inactive());
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
    // Disabling is only a revocation of an existing session. It must not create
    // app state from caller-supplied identity fields or alter Agent selection.
    if (!enabled) {
      if (!previous) return respond({ selected: true });
      if (previous.principal_id !== principalId) return respond({ error: 'session owner conflict' }, 409);
      await db.prepare(`UPDATE connected_app_sessions SET enabled = 0, generation = generation + 1, updated_at = ?
        WHERE session_id = ?`).bind(now, sessionId).run();
      return respond({ selected: true });
    }
    if (!agentAuthority) return authorityUnavailable();
    const currentContext = await resolveCurrent(agentAuthority, sessionId);
    if (currentContext.status === 'unavailable') return authorityUnavailable();
    if (currentContext.status !== 'active' || !validAgentContext(currentContext.context, sessionId) ||
        currentContext.context.principalId !== principalId || currentContext.context.profileId !== profileId)
      return respond({ error: 'agent profile context mismatch' }, 403);
    const agentGeneration = currentContext.context.profileGeneration;
    if (previous && previous.principal_id !== principalId) return respond({ error: 'session owner conflict' }, 409);
    if (enabled) {
      for (const [aud, scopes] of entries) {
        const memberScopes = await membershipScopes(db, principalId, profileId, aud as Audience);
        if (!(scopes as string[]).every(scope => memberScopes.includes(scope))) return respond({ error: 'forbidden' }, 403);
      }
    }
    // Every host update advances generation, immediately invalidating earlier tokens.
    await db.batch([
      db.prepare(`INSERT INTO connected_app_sessions(session_id, principal_id, profile_id, enabled, generation, updated_at, agent_generation)
        VALUES(?,?,?,?,1,?,?) ON CONFLICT(session_id) DO UPDATE SET profile_id=excluded.profile_id,
        agent_generation=excluded.agent_generation,
        enabled=excluded.enabled, generation=generation+1, updated_at=excluded.updated_at`)
        .bind(sessionId, principalId, profileId, enabled ? 1 : 0, now, agentGeneration),
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
    if (!session || session.enabled !== 1) return respond({ error: 'forbidden' }, 403);
    const currentContext = await resolveCurrent(agentAuthority, sessionId);
    if (currentContext.status === 'unavailable') return authorityUnavailable();
    if (currentContext.status !== 'active' || !matchesAgentSession(currentContext.context, sessionId, session))
      return respond({ error: 'forbidden' }, 403);
    const appScopes = await membershipScopes(db, session.principal_id, session.profile_id, audience);
    if (!scopes.every(scope => allowed.includes(scope) && appScopes.includes(scope))) return respond({ error: 'forbidden' }, 403);
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
