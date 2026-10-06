import { describe, expect, it } from 'vitest';
import { env } from './env';
import { createControlPlaneWorker } from '../src/index';
import type { AgentProfileAuthority, AgentProfileContext } from '../src/connected-app/session-service';

const issuer = 'https://control.example.invalid';
const hostKey = 'approval-host-test-key-with-more-than-32-characters';
const appKey = 'approval-crm-test-key-with-more-than-32-characters';
const recruitingAppKey = 'approval-recruiting-test-key-with-more-than-32-characters';
let principalId = 'approval_human_001';
let profileId = 'approval_profile_001';
let sessionId = 'approval_session_001';
let browserCookie = '';
let currentContext: AgentProfileContext | null = null;
const authority: AgentProfileAuthority = {
  resolveBrowserSession: async request => request.headers.get('cookie') === `agent_session=${browserCookie}` ? currentContext : null,
  resolveCurrentSession: async id => currentContext?.sessionId === id ? currentContext : null,
};
const worker = createControlPlaneWorker(authority);
const bindings = { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW,
  CONNECTED_APP_IDENTITY_ENABLED: 'true', CONNECTED_APP_APPROVALS_ENABLED: 'true',
  CONNECTED_APP_HOST_KEY: hostKey, CONNECTED_APP_ISSUER: issuer,
  CONNECTED_APP_SERVICE_KEYS: JSON.stringify({ 'crm-web': appKey, 'recruiting-web': recruitingAppKey }),
  CONNECTED_APP_REDIRECT_URIS: JSON.stringify({ 'crm-web': 'https://crm.example.invalid/oauth/callback',
    'recruiting-web': 'https://recruiting.example.invalid/oauth/callback' }),
};
const cp = (route: string, body: object, key = hostKey) => worker.fetch(new Request(`${issuer}/v1/connected-app-sessions/${route}`, {
  method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
}), bindings);
const approval = (route: string, body: object, key = appKey, headers: Record<string, string> = {}) => worker.fetch(
  new Request(`${issuer}/v1/connected-app-approvals/${route}`, { method: 'POST', headers: {
    authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers,
  }, body: JSON.stringify(body) }), bindings);
async function provision(scopes = ['crm.deals.create'], audience: 'crm-web' | 'recruiting-web' = 'crm-web') {
  principalId = `approval_human_${crypto.randomUUID().replaceAll('-', '')}`;
  profileId = `approval_profile_${crypto.randomUUID().replaceAll('-', '')}`;
  sessionId = `approval_session_${crypto.randomUUID().replaceAll('-', '')}`;
  browserCookie = crypto.randomUUID();
  currentContext = { principalId, profileId, sessionId, profileGeneration: 1 };
  await env.DB.prepare(`INSERT INTO connected_app_memberships
    (principal_id,profile_id,audience,scopes_json,enabled,updated_at) VALUES(?,?, ?,?,1,?)
    ON CONFLICT(principal_id,profile_id,audience) DO UPDATE SET scopes_json=excluded.scopes_json,
      enabled=1,updated_at=excluded.updated_at`).bind(principalId, profileId, audience, JSON.stringify(scopes), Math.floor(Date.now() / 1000)).run();
  await env.DB.prepare(`INSERT INTO connected_app_sessions
    (session_id,principal_id,profile_id,enabled,generation,updated_at,agent_generation) VALUES(?,?,?,1,1,?,1)`)
    .bind(sessionId, principalId, profileId, Math.floor(Date.now() / 1000)).run();
  await env.DB.prepare('INSERT INTO connected_app_grants(session_id,audience,scopes_json) VALUES(?,?,?)')
    .bind(sessionId, audience, JSON.stringify(scopes)).run();
  const verifier = 'approval-verifier-012345678901234567890123456789012345';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const authorizeUrl = new URL(`${issuer}/v1/connected-app-sessions/authorize`);
  const redirectUri = audience === 'crm-web' ? 'https://crm.example.invalid/oauth/callback' : 'https://recruiting.example.invalid/oauth/callback';
  authorizeUrl.search = new URLSearchParams({ response_type: 'code', client_id: audience,
    redirect_uri: redirectUri, scope: scopes.join(' '),
    state: 'approval-state-0123456789012345', code_challenge: codeChallenge,
    code_challenge_method: 'S256' }).toString();
  const authorized = await worker.fetch(new Request(authorizeUrl, { headers: { cookie: `agent_session=${browserCookie}` } }), bindings);
  expect(authorized.status).toBe(303);
  const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
  const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: audience,
    redirect_uri: redirectUri, code,
    state: 'approval-state-0123456789012345', code_verifier: verifier });
  const issued = await worker.fetch(new Request(`${issuer}/v1/connected-app-sessions/exchange`, { method: 'POST',
    headers: { authorization: `Bearer ${audience === 'crm-web' ? appKey : recruitingAppKey}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form }), bindings);
  expect(issued.status).toBe(201);
  return (await issued.json() as { token: string }).token;
}
async function issueToken(scopes: string[], audience: 'crm-web' | 'recruiting-web' = 'crm-web') {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = [...tokenBytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
    .then(bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO connected_app_tokens
    (token_hash,session_id,generation,audience,scopes_json,issued_at,expires_at,revoked_at)
    VALUES(?,?,1,?,?,?,?,NULL)`).bind(hash, sessionId, audience, JSON.stringify(scopes), now, now + 3600).run();
  return raw;
}
const command = 'crm.deals.create';
const recruitingCommand = 'recruiting.responses.message.send';
const sourceRevision = 'a'.repeat(64);
const operation = { clientName: 'Тестовая компания', amount: 125000, currency: 'RUB', externalProjectId: 'case-001' };
function platformRequest(path: string, cookie = `agent_session=${browserCookie}`) {
  return new Request(`${issuer}${path}`, { headers: { cookie } });
}
async function makeResolverSession() {
  browserCookie = crypto.randomUUID();
  return `agent_session=${browserCookie}`;
}
async function prepare(token: string, op: object = operation, revision = sourceRevision,
  audience: 'crm-web' | 'recruiting-web' = 'crm-web', commandId = command) {
  const response = await approval('prepare', { appToken: token, audience, command: commandId,
    sourceRevision: revision, operation: op }, audience === 'crm-web' ? appKey : recruitingAppKey);
  expect(response.status).toBe(201);
  return await response.json() as { intentId: string; approvalUrl: string };
}
describe('CP one-use Connected App human approval receipts through real Worker and D1', () => {
  it('keeps approval routes closed by default and requires the app service credential and an active write scope', async () => {
    const closed = await worker.fetch(new Request(`${issuer}/v1/connected-app-approvals/prepare`, { method: 'POST' }),
      { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW });
    expect(closed.status).toBe(404);
    expect((await approval('prepare', { audience: 'crm-web', command, sourceRevision, operation }, 'wrong')).status).toBe(401);
    const readOnly = await provision(['crm.catalog.read']);
    expect((await approval('prepare', { appToken: readOnly, audience: 'crm-web', command, sourceRevision, operation })).status).toBe(403);

    const writer = await provision();
    expect((await approval('prepare', { appToken: writer, audience: 'crm-web', command, sourceRevision,
      operation, uncontractedField: true })).status).toBe(400);
  });

  it('binds Recruiting message approval to its own audience, scope, exact operation and one-use receipt', async () => {
    const operationRevision = 'd'.repeat(64);
    const messageOperation = {
      vacancyId: 'vacancy_demo_001', negotiationId: 'negotiation_demo_001', chatId: 'chat_demo_001',
      savedPlanRevisionSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64),
      agreementMessageId: 'applicant_agreement_001', message: 'Synthetic exact saved assignment text',
    };

    const readOnly = await provision(['recruiting.responses.read'], 'recruiting-web');
    const request = { appToken: readOnly, audience: 'recruiting-web', command: recruitingCommand,
      sourceRevision: operationRevision, operation: messageOperation };
    expect((await approval('prepare', request, recruitingAppKey)).status).toBe(403);
    expect((await approval('prepare', { ...request, audience: 'crm-web' }, appKey)).status).toBe(400);

    const token = await provision([recruitingCommand], 'recruiting-web');
    const prepared = await prepare(token, messageOperation, operationRevision, 'recruiting-web', recruitingCommand);
    const cookie = await makeResolverSession();
    const review = await worker.fetch(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie), bindings);
    expect(review.status).toBe(200);
    const html = await review.text();
    expect(html).toContain(messageOperation.message);
    expect(html).toContain(messageOperation.negotiationId);
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)?.[1] ?? '';
    const form = new URLSearchParams({ intentId: prepared.intentId, nonce });
    const confirmed = await worker.fetch(new Request(`${issuer}/v1/connected-app-approvals/confirm`, { method: 'POST',
      headers: { cookie, origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: form }), bindings);
    expect(confirmed.status).toBe(200);

    const consumeBody = { ...request, appToken: token, intentId: prepared.intentId,
      consumerRequestId: 'recruiting-message-001' };
    expect((await approval('consume', { ...consumeBody,
      operation: { ...messageOperation, message: 'Changed after approval' } }, recruitingAppKey)).status).toBe(403);
    const consumed = await approval('consume', consumeBody, recruitingAppKey);
    expect(consumed.status).toBe(201);
    const body = await consumed.json() as { receipt: Record<string, unknown> };
    expect(body.receipt).toMatchObject({ audience: 'recruiting-web', clientId: 'recruiting-web',
      command: recruitingCommand, sourceRevision: operationRevision, profileId, principalId,
      operation: messageOperation });
    expect(JSON.stringify(body)).not.toContain(token);
    expect((await approval('consume', consumeBody, recruitingAppKey)).status).toBe(200);
    expect((await approval('consume', { ...consumeBody, consumerRequestId: 'recruiting-message-002' }, recruitingAppKey)).status).toBe(409);
  });

  it('requires a same-profile human confirmation, exact origin and one-use nonce; GET never approves', async () => {
    await provision();
    const cookie = await makeResolverSession();
    const token = await issueToken(['crm.deals.create']);
    const prepared = await prepare(token);
    expect(new URL(prepared.approvalUrl).searchParams.get('intent')).toBe(prepared.intentId);
    const anonymous = await worker.fetch(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, ''), bindings);
    expect(anonymous.status).toBe(401);
    const review = await worker.fetch(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie), bindings);
    expect(review.status, await review.clone().text()).toBe(200);
    const html = await review.text();
    expect(html).toContain(operation.clientName);
    expect(html).toContain('Подтвердить точное действие');
    expect((await env.DB.prepare('SELECT approved_at FROM connected_app_approval_intents WHERE intent_hash=?')
      .bind(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prepared.intentId)).then(b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')))
      .first<{ approved_at: number | null }>())?.approved_at).toBeNull();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)?.[1] ?? '';
    const form = new URLSearchParams({ intentId: prepared.intentId, nonce });
    const deniedOrigin = await worker.fetch(new Request(`${issuer}/v1/connected-app-approvals/confirm`, {
      method: 'POST', headers: { cookie, origin: 'https://attacker.invalid', 'content-type': 'application/x-www-form-urlencoded' }, body: form,
    }), bindings);
    expect(deniedOrigin.status).toBe(403);
    const accepted = await worker.fetch(new Request(`${issuer}/v1/connected-app-approvals/confirm`, {
      method: 'POST', headers: { cookie, origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: form,
    }), bindings);
    expect(accepted.status).toBe(200);
    const replay = await worker.fetch(new Request(`${issuer}/v1/connected-app-approvals/confirm`, {
      method: 'POST', headers: { cookie, origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: form,
    }), bindings);
    expect(replay.status).toBe(403);
  });

  it('binds payload and source revision, atomically issues one receipt, and permits only exact request recovery', async () => {
    await provision();
    const cookie = await makeResolverSession();
    const token = await issueToken(['crm.deals.create']);
    const prepared = await prepare(token);
    const page = await worker.fetch(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie), bindings);
    const html = await page.text();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)?.[1] ?? '';
    const form = new URLSearchParams({ intentId: prepared.intentId, nonce });
    const confirmed = await worker.fetch(new Request(`${issuer}/v1/connected-app-approvals/confirm`, { method: 'POST',
      headers: { cookie, origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: form }), bindings);
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    const consumeBody = { appToken: token, audience: 'crm-web', command, sourceRevision, operation,
      intentId: prepared.intentId, consumerRequestId: 'crm-command-001' };
    expect((await approval('consume', { ...consumeBody, operation: { ...operation, amount: 125001 } })).status).toBe(403);
    expect((await approval('consume', { ...consumeBody, sourceRevision: 'b'.repeat(64) })).status).toBe(403);
    const consumed = await approval('consume', consumeBody);
    expect(consumed.status).toBe(201);
    const body = await consumed.json() as { receipt: Record<string, unknown> };
    expect(body.receipt).toMatchObject({ audience: 'crm-web', clientId: 'crm-web', command,
      sourceRevision, profileId, principalId, operation });
    expect(JSON.stringify(body)).not.toContain(token);
    expect(await (await approval('consume', consumeBody)).json()).toMatchObject({ receipt: { operation } });
    expect((await approval('consume', { ...consumeBody, consumerRequestId: 'crm-command-002' })).status).toBe(409);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS count FROM connected_app_approval_receipts WHERE consumer_request_id=?')
      .bind('crm-command-001').first<{ count: number }>();
    expect(rows?.count).toBe(1);
  });

  it('recovers the same consumed receipt after intent expiry and prepare-time cleanup', async () => {
    await provision();
    const cookie = await makeResolverSession();
    const token = await issueToken(['crm.deals.create']);
    const prepared = await prepare(token);
    const page = await worker.fetch(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie), bindings);
    const html = await page.text();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)?.[1] ?? '';
    const form = new URLSearchParams({ intentId: prepared.intentId, nonce });
    const confirmed = await worker.fetch(new Request(`${issuer}/v1/connected-app-approvals/confirm`, { method: 'POST',
      headers: { cookie, origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: form }), bindings);
    expect(confirmed.status).toBe(200);

    const consumerRequestId = 'crm-command-recovery-001';
    const consumeBody = { appToken: token, audience: 'crm-web', command, sourceRevision, operation,
      intentId: prepared.intentId, consumerRequestId };
    const first = await approval('consume', consumeBody);
    expect(first.status).toBe(201);
    const firstReceipt = (await first.json() as { receipt: { receiptId: string } }).receipt;

    const now = Math.floor(Date.now() / 1000);
    const intentHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prepared.intentId))
      .then(b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''));
    await env.DB.prepare('UPDATE connected_app_approval_intents SET expires_at=? WHERE intent_hash=?')
      .bind(now - 1, intentHash).run();

    const recoveredAfterExpiry = await approval('consume', consumeBody);
    expect(recoveredAfterExpiry.status).toBe(200);
    expect(await recoveredAfterExpiry.json()).toMatchObject({ receipt: { receiptId: firstReceipt.receiptId } });

    // A subsequent prepare performs expiry cleanup. A consumed receipt must remain recoverable.
    const nextIntent = await prepare(token, { ...operation, externalProjectId: 'case-next' }, 'c'.repeat(64));
    expect(nextIntent.intentId).toMatch(/^[a-f0-9]{64}$/);
    const recoveredAfterCleanup = await approval('consume', consumeBody);
    expect(recoveredAfterCleanup.status).toBe(200);
    expect(await recoveredAfterCleanup.json()).toMatchObject({ receipt: { receiptId: firstReceipt.receiptId } });
  });

  it('invalidates approval if the selected profile generation changes before confirmation or consume', async () => {
    await provision();
    const cookie = await makeResolverSession();
    const token = await issueToken(['crm.deals.create']);
    const prepared = await prepare(token);
    currentContext = { ...currentContext!, profileGeneration: currentContext!.profileGeneration + 1 };
    const review = await worker.fetch(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie), bindings);
    expect(review.status).toBe(401);
    expect((await approval('consume', { appToken: token, audience: 'crm-web', command, sourceRevision,
      operation, intentId: prepared.intentId, consumerRequestId: 'switched-profile-command' })).status).toBe(403);
  });

  it('rechecks the session grant before showing the approval form', async () => {
    await provision();
    const cookie = await makeResolverSession();
    const token = await issueToken(['crm.deals.create']);
    const prepared = await prepare(token);
    await env.DB.prepare(`UPDATE connected_app_grants SET scopes_json='[]' WHERE session_id=? AND audience='crm-web'`)
      .bind(sessionId).run();
    const review = await worker.fetch(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie), bindings);
    expect(review.status).toBe(401);
  });

  it('refuses receipt consumption after membership revocation', async () => {
    await provision();
    const cookie = await makeResolverSession();
    const token = await issueToken(['crm.deals.create']);
    const prepared = await prepare(token);
    const page = await worker.fetch(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie), bindings);
    const html = await page.text();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)?.[1] ?? '';
    const form = new URLSearchParams({ intentId: prepared.intentId, nonce });
    const confirmed = await worker.fetch(new Request(`${issuer}/v1/connected-app-approvals/confirm`, { method: 'POST',
      headers: { cookie, origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: form }), bindings);
    expect(confirmed.status).toBe(200);
    await env.DB.prepare(`UPDATE connected_app_memberships SET enabled=0 WHERE principal_id=? AND profile_id=? AND audience='crm-web'`)
      .bind(principalId, profileId).run();
    expect((await approval('consume', { appToken: token, audience: 'crm-web', command, sourceRevision,
      operation, intentId: prepared.intentId, consumerRequestId: 'revoked-membership-command' })).status).toBe(403);
  });

  it('allows only one winner when two service requests race to consume the same approval', async () => {
    await provision();
    const cookie = await makeResolverSession();
    const token = await issueToken(['crm.deals.create']);
    const prepared = await prepare(token);
    const page = await worker.fetch(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie), bindings);
    const html = await page.text();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)?.[1] ?? '';
    const form = new URLSearchParams({ intentId: prepared.intentId, nonce });
    const confirmed = await worker.fetch(new Request(`${issuer}/v1/connected-app-approvals/confirm`, { method: 'POST',
      headers: { cookie, origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: form }), bindings);
    expect(confirmed.status).toBe(200);

    const common = { appToken: token, audience: 'crm-web', command, sourceRevision, operation, intentId: prepared.intentId };
    const results = await Promise.all([
      approval('consume', { ...common, consumerRequestId: 'crm-command-race-a' }),
      approval('consume', { ...common, consumerRequestId: 'crm-command-race-b' }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM connected_app_approval_receipts WHERE intent_hash=?')
      .bind(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prepared.intentId))
        .then(b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')))
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
});
