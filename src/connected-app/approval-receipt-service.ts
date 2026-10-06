import contract from '../../contracts/connected-app-identity-v1.contract.json';
import type { AgentProfileAuthority, AgentProfileContext } from './session-service';

type Audience = keyof typeof contract.audiences;
type Config = { enabled?: string; serviceKeys?: string; issuer?: string };
type Token = { session_id: string; generation: number; audience: string; scopes_json: string[] | string;
  issued_at: number; expires_at: number; revoked_at: number | null };
type Session = { session_id: string; principal_id: string; profile_id: string; enabled: number; generation: number; agent_generation: number };
type Intent = { intent_hash: string; session_id: string; generation: number; agent_generation: number; principal_id: string; profile_id: string;
  audience: string; client_id: string; command: string; required_scope: string; request_hash: string; source_revision: string; operation_json: string;
  created_at: number; expires_at: number; review_nonce_hash: string | null; approved_at: number | null;
  consumed_at: number | null; consumer_request_id: string | null; receipt_id: string | null };
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEX = /^[a-f0-9]{64}$/;
const MAX_INTENT_AGE = 10 * 60;
const RECEIPT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const MAX_OPERATION_BYTES = 16_384;
// v1 registers one confidential web client per audience.
const REGISTERED_CLIENT_ID: Record<Audience, string> = {
  'recruiting-web': 'recruiting-web',
  'crm-web': 'crm-web',
};
const OPERATION_SCOPE: Record<string, { audience: Audience; scope: string }> = {
  'crm.deals.create': { audience: 'crm-web', scope: 'crm.deals.create' },
};
const noStore = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff' };
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), {
  status, headers: { ...noStore, 'content-type': 'application/json; charset=utf-8' },
});
const inactive = () => json(401, { error: 'unauthorized' });
const unavailable = () => json(503, { error: 'approval_service_unavailable' });
const audienceOf = (value: unknown): Audience | null => typeof value === 'string' &&
  Object.hasOwn(contract.audiences, value) ? value as Audience : null;
const commandPolicy = (command: unknown, audience: Audience) => typeof command === 'string' &&
  OPERATION_SCOPE[command]?.audience === audience ? OPERATION_SCOPE[command] : null;
function serviceKey(raw: string | undefined, audience: Audience): string {
  try {
    const keys = JSON.parse(raw ?? '') as Record<string, unknown>;
    const key = keys[audience];
    return typeof key === 'string' && key.length >= 32 ? key : '';
  } catch { return ''; }
}
function secureEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
async function sha(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function randomHex(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new TypeError('invalid_operation');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError('invalid_operation');
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new TypeError('invalid_operation');
  return Object.fromEntries(keys.map(key => [key, canonical(object[key], depth + 1)]));
}
function operationJson(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const encoded = JSON.stringify(canonical(value));
    return new TextEncoder().encode(encoded).byteLength <= MAX_OPERATION_BYTES ? encoded : null;
  } catch { return null; }
}
async function operationHash(audience: Audience, command: string, sourceRevision: string,
  encodedOperation: string): Promise<string> {
  return sha(JSON.stringify({ audience, clientId: REGISTERED_CLIENT_ID[audience], commandId: command,
    operation: JSON.parse(encodedOperation), sourceRevision }));
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
function asHtml(status: number, value: string): Response {
  return new Response(value, { status, headers: { ...noStore, 'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY' } });
}
function appStart(raw: string | undefined, audience: Audience): string | null {
  try {
    const parsed = JSON.parse(raw ?? '') as Record<string, unknown>;
    const value = parsed[audience];
    if (typeof value !== 'string') return null;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/auth/connected/start' && url.href === value ? value : null;
  } catch { return null; }
}
async function activeAppToken(db: D1Database, rawToken: unknown, audience: Audience,
  requiredScope: string, now: number, authority: AgentProfileAuthority | null): Promise<
    { status: 'active'; token: string; session: Session; scopes: string[] } |
    { status: 'inactive' } | { status: 'unavailable' }> {
  if (!authority) return { status: 'unavailable' };
  if (typeof rawToken !== 'string' || !HEX.test(rawToken)) return { status: 'inactive' };
  const token = await db.prepare('SELECT * FROM connected_app_tokens WHERE token_hash = ?')
    .bind(await sha(rawToken)).first<Token>();
  if (!token || token.revoked_at !== null || token.audience !== audience || token.issued_at > now ||
      token.expires_at <= now || token.expires_at - token.issued_at > contract.token.maxLifetimeSeconds) return { status: 'inactive' };
  const session = await db.prepare('SELECT * FROM connected_app_sessions WHERE session_id = ?')
    .bind(token.session_id).first<Session>();
  const grant = await db.prepare('SELECT scopes_json FROM connected_app_grants WHERE session_id = ? AND audience = ?')
    .bind(token.session_id, audience).first<{ scopes_json: string }>();
  const membership = await db.prepare(`SELECT scopes_json,enabled FROM connected_app_memberships
    WHERE principal_id=? AND profile_id=? AND audience=?`)
    .bind(session?.principal_id ?? '', session?.profile_id ?? '', audience).first<{ scopes_json: string; enabled: number }>();
  let scopes: string[] = [], grantScopes: string[] = [], member: string[] = [];
  try {
    scopes = JSON.parse(typeof token.scopes_json === 'string' ? token.scopes_json : '[]');
    grantScopes = JSON.parse(grant?.scopes_json ?? '[]');
    member = JSON.parse(membership?.scopes_json ?? '[]');
  } catch { return { status: 'inactive' }; }
  if (!session || session.enabled !== 1 || session.generation !== token.generation || membership?.enabled !== 1 ||
      !Array.isArray(scopes) || !scopes.includes(requiredScope) ||
      scopes.some(scope => !grantScopes.includes(scope) || !member.includes(scope) ||
        !contract.audiences[audience].includes(scope as never))) return { status: 'inactive' };
  let current: AgentProfileContext | null;
  try { current = await authority.resolveCurrentSession(session.session_id); }
  catch { return { status: 'unavailable' }; }
  if (!current || current.sessionId !== session.session_id || current.principalId !== session.principal_id ||
      current.profileId !== session.profile_id || current.profileGeneration !== session.agent_generation)
    return { status: 'inactive' };
  return { status: 'active', token: rawToken, session, scopes };
}
async function currentAgentSession(db: D1Database, authority: AgentProfileAuthority | null,
  request: Request, intent: Intent): Promise<'active' | 'inactive' | 'unavailable'> {
  if (!authority) return 'unavailable';
  let verified: AgentProfileContext | null;
  try { verified = await authority.resolveBrowserSession(request); } catch { return 'unavailable'; }
  if (!verified || verified.sessionId !== intent.session_id || verified.principalId !== intent.principal_id ||
      verified.profileId !== intent.profile_id || verified.profileGeneration !== intent.agent_generation) return 'inactive';
  let currentAgent: AgentProfileContext | null;
  try { currentAgent = await authority.resolveCurrentSession(intent.session_id); } catch { return 'unavailable'; }
  if (!currentAgent) return 'inactive';
  if (currentAgent.sessionId !== intent.session_id || currentAgent.principalId !== intent.principal_id ||
      currentAgent.profileId !== intent.profile_id || currentAgent.profileGeneration !== intent.agent_generation) return 'inactive';
  const current = await db.prepare('SELECT * FROM connected_app_sessions WHERE session_id=?')
    .bind(intent.session_id).first<Session>();
  const membership = await db.prepare(`SELECT scopes_json,enabled FROM connected_app_memberships
    WHERE principal_id=? AND profile_id=? AND audience=?`)
    .bind(intent.principal_id, intent.profile_id, intent.audience).first<{ scopes_json: string; enabled: number }>();
  const grant = await db.prepare('SELECT scopes_json FROM connected_app_grants WHERE session_id=? AND audience=?')
    .bind(intent.session_id, intent.audience).first<{ scopes_json: string }>();
  let memberScopes: unknown, grantScopes: unknown;
  try {
    memberScopes = JSON.parse(membership?.scopes_json ?? '[]');
    grantScopes = JSON.parse(grant?.scopes_json ?? '[]');
  } catch { return 'inactive'; }
  const audience = audienceOf(intent.audience);
  const policy = audience ? commandPolicy(intent.command, audience) : null;
  if (!policy || !audience || intent.client_id !== REGISTERED_CLIENT_ID[audience] ||
      !current || current.enabled !== 1 || current.generation !== intent.generation ||
      current.principal_id !== intent.principal_id || current.profile_id !== intent.profile_id ||
      current.agent_generation !== intent.agent_generation ||
      membership?.enabled !== 1 || !Array.isArray(memberScopes) || !memberScopes.includes(policy.scope) ||
      !Array.isArray(grantScopes) || !grantScopes.includes(policy.scope)) return 'inactive';
  return 'active';
}
async function readIntent(db: D1Database, intentId: unknown): Promise<Intent | null> {
  if (typeof intentId !== 'string' || !HEX.test(intentId)) return null;
  return db.prepare('SELECT * FROM connected_app_approval_intents WHERE intent_hash=?')
    .bind(await sha(intentId)).first<Intent>();
}

/** Human-reviewed, one-use approval receipt boundary. The app service never mints approval. */
export async function connectedAppApprovalRequest(req: Request, db: D1Database, config: Config,
  body: Record<string, unknown>, agentAuthority: AgentProfileAuthority | null = null): Promise<Response> {
  if (config.enabled !== 'true') return json(404, { error: 'not found' });
  const url = new URL(req.url);
  const path = url.pathname;
  const audience = audienceOf(body.audience ?? url.searchParams.get('audience'));
  const policy = audience ? commandPolicy(body.command, audience) : null;
  const now = Math.floor(Date.now() / 1000);

  if (path === '/v1/connected-app-approvals/prepare' || path === '/v1/connected-app-approvals/consume') {
    const key = audience ? serviceKey(config.serviceKeys, audience) : '';
    const authorization = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!key || !secureEqual(authorization, key)) return inactive();
    if (req.method !== 'POST' || !audience || !policy) return json(400, { error: 'invalid request' });
    const allowedFields = path.endsWith('/prepare')
      ? ['appToken', 'audience', 'command', 'sourceRevision', 'operation']
      : ['appToken', 'audience', 'command', 'sourceRevision', 'operation', 'intentId', 'consumerRequestId'];
    if (Object.keys(body).some(field => !allowedFields.includes(field)))
      return json(400, { error: 'invalid request' });
    const activeResult = await activeAppToken(db, body.appToken, audience, policy.scope, now, agentAuthority);
    if (activeResult.status === 'unavailable') return unavailable();
    if (activeResult.status !== 'active') return json(403, { error: 'active operation scope required' });
    const active = activeResult;
    const sourceRevision = body.sourceRevision;
    const encodedOperation = operationJson(body.operation);
    if (typeof sourceRevision !== 'string' || !HEX.test(sourceRevision) || !encodedOperation)
      return json(400, { error: 'invalid request' });
    const requestHash = await operationHash(audience, String(body.command),
      sourceRevision, encodedOperation);
    const intentId = body.intentId;
    const consumerRequestId = body.consumerRequestId;
    if (path.endsWith('/prepare')) {
      if ('intentId' in body || 'consumerRequestId' in body) return json(400, { error: 'invalid request' });
      const minted = randomHex();
      const expiresAt = now + MAX_INTENT_AGE;
      await db.batch([
        db.prepare('DELETE FROM connected_app_approval_receipts WHERE consumed_at <= ?')
          .bind(now - RECEIPT_RETENTION_SECONDS),
        db.prepare(`DELETE FROM connected_app_approval_intents
          WHERE (consumed_at IS NULL AND expires_at <= ?) OR consumed_at <= ?`)
          .bind(now, now - RECEIPT_RETENTION_SECONDS),
        db.prepare(`INSERT INTO connected_app_approval_intents
          (intent_hash,session_id,generation,agent_generation,principal_id,profile_id,audience,client_id,command,required_scope,request_hash,source_revision,
           operation_json,created_at,expires_at,review_nonce_hash,approved_at,consumed_at,consumer_request_id,receipt_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL)`)
          .bind(await sha(minted), active.session.session_id, active.session.generation, active.session.agent_generation, active.session.principal_id,
            active.session.profile_id, audience, REGISTERED_CLIENT_ID[audience], body.command, policy.scope,
            requestHash, sourceRevision, encodedOperation, now, expiresAt),
      ]);
      return json(201, { version: 1, intentId: minted,
        approvalUrl: `${config.issuer}/v1/connected-app-approvals/review?intent=${minted}`, expiresAt });
    }

    if (typeof intentId !== 'string' || !HEX.test(intentId) || typeof consumerRequestId !== 'string' || !ID.test(consumerRequestId))
      return json(400, { error: 'invalid request' });
    const intent = await readIntent(db, intentId);
    if (!intent || intent.session_id !== active.session.session_id ||
        intent.generation !== active.session.generation || intent.agent_generation !== active.session.agent_generation || intent.principal_id !== active.session.principal_id ||
        intent.profile_id !== active.session.profile_id || intent.audience !== audience ||
        intent.client_id !== REGISTERED_CLIENT_ID[audience] ||
        intent.command !== body.command || intent.required_scope !== policy.scope ||
        intent.request_hash !== requestHash || intent.source_revision !== sourceRevision) return json(403, { error: 'approval not available' });
    if (intent.consumed_at !== null) {
      if (intent.consumer_request_id !== consumerRequestId || !intent.receipt_id) return json(409, { error: 'approval already consumed' });
      const existing = await db.prepare('SELECT * FROM connected_app_approval_receipts WHERE receipt_id=? AND intent_hash=? AND consumer_request_id=?')
        .bind(intent.receipt_id, intent.intent_hash, consumerRequestId).first<Record<string, unknown>>();
      if (!existing) return unavailable();
      return json(200, { version: 1, receipt: { receiptId: existing.receipt_id,
        audience: existing.audience, clientId: existing.client_id, command: existing.command,
        requestHash: existing.request_hash, sourceRevision: existing.source_revision,
        principalId: existing.principal_id, profileId: existing.profile_id,
        approvedAt: existing.approved_at, consumedAt: existing.consumed_at, operation: JSON.parse(String(existing.operation_json)) } });
    }
    if (intent.expires_at <= now) return json(403, { error: 'approval not available' });
    if (intent.approved_at === null) return json(403, { error: 'human approval required' });
    const receiptId = randomHex();
    const changed = await db.batch([
      db.prepare(`UPDATE connected_app_approval_intents
        SET consumed_at=?,consumer_request_id=?,receipt_id=?,review_nonce_hash=NULL
        WHERE intent_hash=? AND approved_at IS NOT NULL AND consumed_at IS NULL AND expires_at>?
          AND session_id=? AND generation=? AND agent_generation=? AND principal_id=? AND profile_id=? AND audience=? AND client_id=?
          AND command=? AND required_scope=? AND request_hash=? AND source_revision=?
          AND EXISTS (SELECT 1 FROM connected_app_sessions s WHERE s.session_id=? AND s.enabled=1
            AND s.generation=? AND s.principal_id=? AND s.profile_id=?)
          AND EXISTS (SELECT 1 FROM connected_app_memberships m WHERE m.principal_id=? AND m.profile_id=?
            AND m.audience=? AND m.enabled=1 AND EXISTS (SELECT 1 FROM json_each(m.scopes_json) WHERE value=?))`)
        .bind(now, consumerRequestId, receiptId, intent.intent_hash, now, active.session.session_id,
          active.session.generation, active.session.agent_generation, active.session.principal_id, active.session.profile_id, audience,
          REGISTERED_CLIENT_ID[audience],
          body.command, policy.scope, requestHash, sourceRevision, active.session.session_id,
          active.session.generation, active.session.principal_id, active.session.profile_id,
          active.session.principal_id, active.session.profile_id, audience, policy.scope),
      db.prepare(`INSERT INTO connected_app_approval_receipts
        (receipt_id,intent_hash,session_id,generation,agent_generation,principal_id,profile_id,audience,client_id,command,required_scope,request_hash,
         source_revision,approved_at,consumed_at,consumer_request_id,operation_json)
        SELECT receipt_id,intent_hash,session_id,generation,agent_generation,principal_id,profile_id,audience,client_id,command,required_scope,request_hash,
          source_revision,approved_at,consumed_at,consumer_request_id,operation_json FROM connected_app_approval_intents
        WHERE intent_hash=? AND consumed_at=? AND consumer_request_id=? AND receipt_id=?
        ON CONFLICT(intent_hash) DO NOTHING`)
        .bind(intent.intent_hash, now, consumerRequestId, receiptId),
    ]);
    if (changed[0]?.meta.changes !== 1 || changed[1]?.meta.changes !== 1) {
      const raced = await db.prepare('SELECT * FROM connected_app_approval_intents WHERE intent_hash=?')
        .bind(intent.intent_hash).first<Intent>();
      if (!raced || raced.consumer_request_id !== consumerRequestId || !raced.receipt_id ||
          raced.request_hash !== requestHash || raced.source_revision !== sourceRevision) return json(409, { error: 'approval already consumed or expired' });
      const existing = await db.prepare('SELECT * FROM connected_app_approval_receipts WHERE intent_hash=? AND consumer_request_id=?')
        .bind(intent.intent_hash, consumerRequestId).first<Record<string, unknown>>();
      if (!existing) return unavailable();
      return json(200, { version: 1, receipt: { receiptId: existing.receipt_id,
        audience: existing.audience, clientId: existing.client_id, command: existing.command,
        requestHash: existing.request_hash, sourceRevision: existing.source_revision,
        principalId: existing.principal_id, profileId: existing.profile_id,
        approvedAt: existing.approved_at, consumedAt: existing.consumed_at,
        operation: JSON.parse(String(existing.operation_json)) } });
    }
    return json(201, { version: 1, receipt: { receiptId, audience, clientId: REGISTERED_CLIENT_ID[audience],
      command: body.command, requestHash, sourceRevision, principalId: active.session.principal_id,
      profileId: active.session.profile_id, approvedAt: intent.approved_at, consumedAt: now,
      operation: JSON.parse(intent.operation_json) } });
  }

  if (path === '/v1/connected-app-approvals/review' && req.method === 'GET') {
    const intent = await readIntent(db, url.searchParams.get('intent'));
    if (!intent || intent.expires_at <= now || intent.approved_at !== null || intent.consumed_at !== null)
      return asHtml(404, '<!doctype html><html><meta charset="utf-8"><title>Подтверждение</title><p>Запрос недоступен или истёк.</p></html>');
    const agentSession = await currentAgentSession(db, agentAuthority, req, intent);
    if (agentSession === 'unavailable') return unavailable();
    if (agentSession !== 'active') return asHtml(401,
      '<!doctype html><html><meta charset="utf-8"><title>Подтверждение</title><p>Войдите в Control Plane под тем же профилем.</p></html>');
    const nonce = randomHex();
    const policy = commandPolicy(intent.command, intent.audience as Audience);
    if (!policy) return asHtml(404, '<!doctype html><html><meta charset="utf-8"><title>Подтверждение</title><p>Запрос недоступен.</p></html>');
    const updated = await db.prepare(`UPDATE connected_app_approval_intents SET review_nonce_hash=?
      WHERE intent_hash=? AND approved_at IS NULL AND consumed_at IS NULL AND expires_at>?
        AND session_id=? AND generation=? AND agent_generation=? AND principal_id=? AND profile_id=? AND audience=? AND client_id=?
        AND required_scope=?
        AND EXISTS (SELECT 1 FROM connected_app_sessions s WHERE s.session_id=? AND s.enabled=1
          AND s.generation=? AND s.agent_generation=? AND s.principal_id=? AND s.profile_id=?)
        AND EXISTS (SELECT 1 FROM connected_app_memberships m WHERE m.principal_id=? AND m.profile_id=?
          AND m.audience=? AND m.enabled=1 AND EXISTS (SELECT 1 FROM json_each(m.scopes_json) WHERE value=?))`)
      .bind(await sha(nonce), intent.intent_hash, now, intent.session_id, intent.generation, intent.agent_generation, intent.principal_id,
        intent.profile_id, intent.audience, intent.client_id, policy.scope, intent.session_id, intent.generation,
        intent.agent_generation,
        intent.principal_id, intent.profile_id, intent.principal_id, intent.profile_id, intent.audience, policy.scope).run();
    if (updated.meta.changes !== 1) return asHtml(409, '<!doctype html><html><meta charset="utf-8"><title>Подтверждение</title><p>Запрос уже обработан.</p></html>');
    let operation: unknown;
    try { operation = JSON.parse(intent.operation_json); } catch { return unavailable(); }
    const form = `<form method="post" action="/v1/connected-app-approvals/confirm"><input type="hidden" name="intentId" value="${escapeHtml(url.searchParams.get('intent') ?? '')}"><input type="hidden" name="nonce" value="${nonce}"><button type="submit">Подтвердить точное действие</button></form>`;
    return asHtml(200, `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Проверка внешнего действия</title><main><h1>Подтвердите внешний запрос</h1><p>Приложение: ${escapeHtml(intent.audience)}. Профиль: ${escapeHtml(intent.profile_id)}.</p><p>Команда: ${escapeHtml(intent.command)}. После подтверждения приложение сможет выполнить ровно один соответствующий запрос.</p><p>Ревизия источника: <code>${escapeHtml(intent.source_revision)}</code></p><p>Отпечаток точного запроса: <code>${escapeHtml(intent.request_hash)}</code></p><h2>Данные запроса</h2><pre>${escapeHtml(JSON.stringify(operation, null, 2))}</pre><p>Запрос истекает: ${new Date(intent.expires_at * 1000).toISOString()}</p>${form}</main></html>`);
  }

  if (path === '/v1/connected-app-approvals/confirm' && req.method === 'POST') {
    const origin = config.issuer ? new URL(config.issuer).origin : '';
    if (!origin || req.headers.get('origin') !== origin) return json(403, { error: 'origin required' });
    const intentId = body.intentId, nonce = body.nonce;
    const intent = await readIntent(db, intentId);
    if (!intent || typeof nonce !== 'string' || !HEX.test(nonce) || intent.expires_at <= now ||
        intent.approved_at !== null || intent.consumed_at !== null || !intent.review_nonce_hash ||
        !secureEqual(await sha(nonce), intent.review_nonce_hash)) return json(403, { error: 'approval session invalid' });
    const current = await currentAgentSession(db, agentAuthority, req, intent);
    if (current === 'unavailable') return unavailable();
    if (current !== 'active') return json(403, { error: 'approval session invalid' });
    const changed = await db.prepare(`UPDATE connected_app_approval_intents
      SET approved_at=?,review_nonce_hash=NULL WHERE intent_hash=? AND review_nonce_hash=?
        AND approved_at IS NULL AND consumed_at IS NULL AND expires_at>? AND session_id=?
        AND generation=? AND agent_generation=? AND principal_id=? AND profile_id=? AND audience=? AND client_id=?
        AND command=? AND required_scope=?
        AND EXISTS (SELECT 1 FROM connected_app_sessions s WHERE s.session_id=? AND s.enabled=1
          AND s.generation=? AND s.agent_generation=? AND s.principal_id=? AND s.profile_id=?)
        AND EXISTS (SELECT 1 FROM connected_app_memberships m WHERE m.principal_id=? AND m.profile_id=?
          AND m.audience=? AND m.enabled=1 AND EXISTS (SELECT 1 FROM json_each(m.scopes_json) WHERE value=?))`)
      .bind(now, intent.intent_hash, intent.review_nonce_hash, now, intent.session_id,
        intent.generation, intent.agent_generation, intent.principal_id, intent.profile_id, intent.audience, intent.client_id,
        intent.command, intent.required_scope, intent.session_id, intent.generation, intent.agent_generation, intent.principal_id,
        intent.profile_id, intent.principal_id, intent.profile_id, intent.audience, intent.required_scope).run();
    if (changed.meta.changes !== 1) return json(409, { error: 'approval already used or expired' });
    return asHtml(200, '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Подтверждение сохранено</title><main><h1>Подтверждение сохранено</h1><p>Control Plane записал ваше подтверждение. Вернитесь в приложение, чтобы оно выполнило ровно один запрос по проверенным данным.</p></main></html>');
  }
  return json(404, { error: 'not found' });
}
