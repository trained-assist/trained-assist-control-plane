import { describe, expect, it } from 'vitest';
import { env } from './env';
import worker from '../src/index';
import { telegramBootstrapRequest } from '../src/connected-app/telegram-bootstrap';
import { connectedAppApprovalRequest } from '../src/connected-app/approval-receipt-service';

const issuer = 'https://control.example.invalid';
const hostKey = 'approval-host-test-key-with-more-than-32-characters';
const appKey = 'approval-crm-test-key-with-more-than-32-characters';
let principalId = 'approval_human_001';
let profileId = 'approval_profile_001';
let sessionId = 'approval_session_001';
const bindings = { DB: env.DB, TASK_WORKFLOW: env.TASK_WORKFLOW,
  CONNECTED_APP_IDENTITY_ENABLED: 'true', CONNECTED_APP_APPROVALS_ENABLED: 'true',
  CONNECTED_APP_HOST_KEY: hostKey, CONNECTED_APP_ISSUER: issuer,
  CONNECTED_APP_TELEGRAM_BOOTSTRAP_ENABLED: 'true',
  CONNECTED_APP_SERVICE_KEYS: JSON.stringify({ 'crm-web': appKey }),
};
const bootstrapConfig = { enabled: 'true', gatewayKey: 'approval-gateway-test-key-with-at-least-32-characters',
  issuer, startUrls: JSON.stringify({ 'crm-web': 'https://crm.example.invalid/auth/connected/start' }) };
const cp = (route: string, body: object, key = hostKey) => worker.fetch(new Request(`${issuer}/v1/connected-app-sessions/${route}`, {
  method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
}), bindings);
const approval = (route: string, body: object, key = appKey, headers: Record<string, string> = {}) => worker.fetch(
  new Request(`${issuer}/v1/connected-app-approvals/${route}`, { method: 'POST', headers: {
    authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers,
  }, body: JSON.stringify(body) }), bindings);
async function provision(scopes = ['crm.deals.create']) {
  principalId = `approval_human_${crypto.randomUUID().replaceAll('-', '')}`;
  profileId = `approval_profile_${crypto.randomUUID().replaceAll('-', '')}`;
  sessionId = `approval_session_${crypto.randomUUID().replaceAll('-', '')}`;
  await env.DB.prepare(`INSERT INTO connected_app_memberships
    (principal_id,profile_id,audience,scopes_json,enabled,updated_at) VALUES(?,?, 'crm-web', ?,1,?)
    ON CONFLICT(principal_id,profile_id,audience) DO UPDATE SET scopes_json=excluded.scopes_json,
      enabled=1,updated_at=excluded.updated_at`).bind(principalId, profileId, JSON.stringify(scopes), Math.floor(Date.now() / 1000)).run();
  const selected = await cp('select', { sessionId, principalId, profileId, enabled: true,
    grants: { 'crm-web': scopes } });
  expect(selected.status).toBe(200);
  const issued = await cp('issue', { sessionId, audience: 'crm-web', scopes });
  expect(issued.status).toBe(201);
  return (await issued.json() as { token: string }).token;
}
const command = 'crm.deals.create';
const sourceRevision = 'a'.repeat(64);
const operation = { clientName: 'Тестовая компания', amount: 125000, currency: 'RUB', externalProjectId: 'case-001' };
function platformRequest(path: string, cookie = '__Host-ta_platform=') {
  return new Request(`${issuer}${path}`, { headers: { cookie } });
}
async function makeResolverSession() {
  // The browser authority is exercised against a fresh D1 session per test.
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO connected_app_telegram_bindings
    (bot_id,telegram_user_id,principal_id,enabled,updated_at) VALUES(?,?,?,1,1)
    ON CONFLICT(bot_id,telegram_user_id) DO UPDATE SET principal_id=excluded.principal_id,enabled=1,updated_at=updated_at+1`)
    .bind('approval_bot', '123456789', principalId).run();
  const rawCode = crypto.randomUUID().replaceAll('-', '').padEnd(64, 'e').slice(0, 64);
  const codeHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawCode))
    .then(b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''));
  await env.DB.prepare(`INSERT INTO connected_app_telegram_challenges
    (code_hash,bot_id,update_id,telegram_user_id,principal_id,profile_id,created_at,expires_at,consumed_at,invalidated_at)
    VALUES(?,?,?,?,?,'',?,?,NULL,NULL)`).bind(codeHash, 'approval_bot', `approval-${crypto.randomUUID()}`,
      '123456789', principalId, now, now + 300).run();
  const previewLink = `${issuer}/v1/connected-app-bootstrap/telegram?c=${rawCode}`;
  const preview = await telegramBootstrapRequest(new Request(previewLink), env.DB, bootstrapConfig);
  const csrf = (await preview.text()).match(/name="csrf" value="([a-f0-9]{64})"/)?.[1] ?? '';
  const csrfCookie = preview.headers.get('set-cookie')?.split(';')[0] ?? '';
  const redeemed = await telegramBootstrapRequest(new Request(`${issuer}/v1/connected-app-bootstrap/telegram`, {
    method: 'POST', headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ c: rawCode, csrf }),
  }), env.DB, bootstrapConfig);
  const platformCookie = redeemed.headers.get('set-cookie')?.split(';')[0] ?? '';
  browserCookie = platformCookie;
  expect(redeemed.status, await redeemed.clone().text()).toBe(303);
  const rawBrowserToken = platformCookie.split('=')[1] ?? '';
  const sessionHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBrowserToken))
    .then(b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''));
  await env.DB.prepare(`UPDATE connected_app_browser_sessions SET session_id=? WHERE session_hash=?`)
    .bind(sessionId, sessionHash).run();
  await env.DB.prepare('UPDATE connected_app_browser_sessions SET profile_id=? WHERE session_hash=?')
    .bind(profileId, sessionHash).run();
  const selected = await telegramBootstrapRequest(new Request(`${issuer}/v1/connected-app-bootstrap/apps`, {
    headers: { cookie: platformCookie },
  }), env.DB, bootstrapConfig);
  if (selected.status !== 200) throw new Error(`profile chooser ${selected.status}: ${await selected.text()}`);
  const chooserHtml = await selected.clone().text();
  const selectCsrf = chooserHtml.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1] ?? '';
  const selectCookie = selected.headers.get('set-cookie')?.split(';')[0] ?? '';
  const chosen = await telegramBootstrapRequest(new Request(`${issuer}/v1/connected-app-bootstrap/select-profile`, {
    method: 'POST', headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded',
      cookie: `${platformCookie}; ${selectCookie}` },
    body: new URLSearchParams({ profile_id: profileId, csrf: selectCsrf }),
  }), env.DB, bootstrapConfig);
  expect(chosen.status, await chosen.clone().text()).toBe(303);
  await env.DB.prepare(`UPDATE connected_app_browser_sessions SET revoked_at=NULL WHERE session_id=?`).bind(sessionId).run();
  const chosenSession = await env.DB.prepare(`UPDATE connected_app_browser_sessions SET profile_id=?
    WHERE session_id=?`).bind(profileId, sessionId).run();
  expect(chosenSession.meta.changes).toBe(1);
  await env.DB.prepare('UPDATE connected_app_sessions SET profile_id=?,enabled=1,generation=generation+1 WHERE session_id=?')
    .bind(profileId, sessionId).run();
  const selectPlatform = await cp('select', { sessionId, principalId, profileId, enabled: true,
    grants: { 'crm-web': ['crm.deals.create'] } });
  expect(selectPlatform.status).toBe(200);
  const verified = await telegramBootstrapRequest(new Request(`${issuer}/v1/connected-app-bootstrap/apps`, {
    headers: { cookie: platformCookie },
  }), env.DB, bootstrapConfig);
  if (verified.status !== 200) throw new Error(`verified platform session ${verified.status}: ${await verified.text()}`);
  return platformCookie;
}
const approvalCookie = 'verified-approval-session-cookie';
let browserCookie = '';
async function browserCookieForSession(_id: string) { return browserCookie; }
async function resolverFor(intentId: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(intentId))
    .then(b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''));
  const intent = await env.DB.prepare('SELECT session_id,principal_id,profile_id FROM connected_app_approval_intents WHERE intent_hash=?')
    .bind(hash).first<{ session_id: string; principal_id: string; profile_id: string }>();
  return async (_request: Request) => intent ? ({ sessionId: intent.session_id, principalId: intent.principal_id,
    profileId: intent.profile_id, grants: { 'crm-web': ['crm.deals.create'] } }) : null;
}
async function prepare(token: string, op = operation, revision = sourceRevision) {
  const response = await approval('prepare', { appToken: token, audience: 'crm-web', command,
    sourceRevision: revision, operation: op });
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
  });

  it('requires a same-profile human confirmation, exact origin and one-use nonce; GET never approves', async () => {
    await provision();
    const cookie = await makeResolverSession();
    const token = (await (await cp('issue', { sessionId, audience: 'crm-web', scopes: ['crm.deals.create'] })).json() as { token: string }).token;
    const prepared = await prepare(token);
    expect(new URL(prepared.approvalUrl).searchParams.get('intent')).toBe(prepared.intentId);
    const anonymous = await worker.fetch(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`), bindings);
    expect(anonymous.status).toBe(401);
    const resolve = await resolverFor(prepared.intentId);
    const review = await connectedAppApprovalRequest(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie),
      env.DB, { enabled: 'true', issuer }, {}, resolve);
    expect(review.status, await review.clone().text()).toBe(200);
    const html = await review.text();
    expect(html).toContain(operation.clientName);
    expect(html).toContain('Подтвердить точное действие');
    expect((await env.DB.prepare('SELECT approved_at FROM connected_app_approval_intents WHERE intent_hash=?')
      .bind(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prepared.intentId)).then(b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')))
      .first<{ approved_at: number | null }>())?.approved_at).toBeNull();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)?.[1] ?? '';
    const form = new URLSearchParams({ intentId: prepared.intentId, nonce });
    const deniedOrigin = await connectedAppApprovalRequest(new Request(`${issuer}/v1/connected-app-approvals/confirm`, {
      method: 'POST', headers: { cookie, origin: 'https://attacker.invalid', 'content-type': 'application/x-www-form-urlencoded' }, body: form,
    }), env.DB, { enabled: 'true', issuer }, Object.fromEntries(form.entries()), resolve);
    expect(deniedOrigin.status).toBe(403);
    const accepted = await connectedAppApprovalRequest(new Request(`${issuer}/v1/connected-app-approvals/confirm`, {
      method: 'POST', headers: { cookie, origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: form,
    }), env.DB, { enabled: 'true', issuer }, Object.fromEntries(form.entries()), resolve);
    expect(accepted.status).toBe(200);
    const replay = await connectedAppApprovalRequest(new Request(`${issuer}/v1/connected-app-approvals/confirm`, {
      method: 'POST', headers: { cookie, origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: form,
    }), env.DB, { enabled: 'true', issuer }, Object.fromEntries(form.entries()), resolve);
    expect(replay.status).toBe(403);
  });

  it('binds payload and source revision, atomically issues one receipt, and permits only exact request recovery', async () => {
    await provision();
    const cookie = await makeResolverSession();
    const token = (await (await cp('issue', { sessionId, audience: 'crm-web', scopes: ['crm.deals.create'] })).json() as { token: string }).token;
    const prepared = await prepare(token);
    const resolve = await resolverFor(prepared.intentId);
    const page = await connectedAppApprovalRequest(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie),
      env.DB, { enabled: 'true', issuer }, {}, resolve);
    const html = await page.text();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)?.[1] ?? '';
    const form = new URLSearchParams({ intentId: prepared.intentId, nonce });
    const confirmed = await connectedAppApprovalRequest(new Request(`${issuer}/v1/connected-app-approvals/confirm`, { method: 'POST',
      headers: { cookie, origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: form }),
      env.DB, { enabled: 'true', issuer }, Object.fromEntries(form.entries()), resolve);
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
    const token = (await (await cp('issue', { sessionId, audience: 'crm-web', scopes: ['crm.deals.create'] })).json() as { token: string }).token;
    const prepared = await prepare(token);
    const resolve = await resolverFor(prepared.intentId);
    const page = await connectedAppApprovalRequest(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie),
      env.DB, { enabled: 'true', issuer }, {}, resolve);
    const html = await page.text();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)?.[1] ?? '';
    const form = new URLSearchParams({ intentId: prepared.intentId, nonce });
    const confirmed = await connectedAppApprovalRequest(new Request(`${issuer}/v1/connected-app-approvals/confirm`, { method: 'POST',
      headers: { cookie, origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: form }),
      env.DB, { enabled: 'true', issuer }, Object.fromEntries(form.entries()), resolve);
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
    const token = (await (await cp('issue', { sessionId, audience: 'crm-web', scopes: ['crm.deals.create'] })).json() as { token: string }).token;
    const prepared = await prepare(token);
    const resolve = await resolverFor(prepared.intentId);
    const chooser = await telegramBootstrapRequest(new Request(`${issuer}/v1/connected-app-bootstrap/apps`, {
      headers: { cookie: await browserCookieForSession(sessionId) },
    }), env.DB, bootstrapConfig);
    const chooserHtml = await chooser.text();
    const csrf = chooserHtml.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1] ?? '';
    const csrfCookie = chooser.headers.get('set-cookie')?.split(';')[0] ?? '';
    const switched = await telegramBootstrapRequest(new Request(`${issuer}/v1/connected-app-bootstrap/select-profile`, {
      method: 'POST', headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded',
        cookie: `${await browserCookieForSession(sessionId)}; ${csrfCookie}` },
      body: new URLSearchParams({ profile_id: profileId, csrf }),
    }), env.DB, bootstrapConfig);
    expect(switched.status).toBe(303);
    const review = await connectedAppApprovalRequest(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie),
      env.DB, { enabled: 'true', issuer }, {}, resolve);
    expect(review.status).toBe(401);
    expect((await approval('consume', { appToken: token, audience: 'crm-web', command, sourceRevision,
      operation, intentId: prepared.intentId, consumerRequestId: 'switched-profile-command' })).status).toBe(403);
  });

  it('rechecks the session grant before showing the approval form', async () => {
    await provision();
    const cookie = await makeResolverSession();
    const token = (await (await cp('issue', { sessionId, audience: 'crm-web', scopes: ['crm.deals.create'] })).json() as { token: string }).token;
    const prepared = await prepare(token);
    await env.DB.prepare(`UPDATE connected_app_grants SET scopes_json='[]' WHERE session_id=? AND audience='crm-web'`)
      .bind(sessionId).run();
    const resolve = await resolverFor(prepared.intentId);
    const review = await connectedAppApprovalRequest(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie),
      env.DB, { enabled: 'true', issuer }, {}, resolve);
    expect(review.status).toBe(401);
  });

  it('refuses receipt consumption after membership revocation', async () => {
    await provision();
    const cookie = await makeResolverSession();
    const token = (await (await cp('issue', { sessionId, audience: 'crm-web', scopes: ['crm.deals.create'] })).json() as { token: string }).token;
    const prepared = await prepare(token);
    const resolve = await resolverFor(prepared.intentId);
    const page = await connectedAppApprovalRequest(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie),
      env.DB, { enabled: 'true', issuer }, {}, resolve);
    const html = await page.text();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)?.[1] ?? '';
    const form = new URLSearchParams({ intentId: prepared.intentId, nonce });
    const confirmed = await connectedAppApprovalRequest(new Request(`${issuer}/v1/connected-app-approvals/confirm`, { method: 'POST',
      headers: { cookie, origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: form }),
      env.DB, { enabled: 'true', issuer }, Object.fromEntries(form.entries()), resolve);
    expect(confirmed.status).toBe(200);
    await env.DB.prepare(`UPDATE connected_app_memberships SET enabled=0 WHERE principal_id=? AND profile_id=? AND audience='crm-web'`)
      .bind(principalId, profileId).run();
    expect((await approval('consume', { appToken: token, audience: 'crm-web', command, sourceRevision,
      operation, intentId: prepared.intentId, consumerRequestId: 'revoked-membership-command' })).status).toBe(403);
  });

  it('allows only one winner when two service requests race to consume the same approval', async () => {
    await provision();
    const cookie = await makeResolverSession();
    const token = (await (await cp('issue', { sessionId, audience: 'crm-web', scopes: ['crm.deals.create'] })).json() as { token: string }).token;
    const prepared = await prepare(token);
    const resolve = await resolverFor(prepared.intentId);
    const page = await connectedAppApprovalRequest(platformRequest(`/v1/connected-app-approvals/review?intent=${prepared.intentId}`, cookie),
      env.DB, { enabled: 'true', issuer }, {}, resolve);
    const html = await page.text();
    const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/)?.[1] ?? '';
    const form = new URLSearchParams({ intentId: prepared.intentId, nonce });
    const confirmed = await connectedAppApprovalRequest(new Request(`${issuer}/v1/connected-app-approvals/confirm`, { method: 'POST',
      headers: { cookie, origin: issuer, 'content-type': 'application/x-www-form-urlencoded' }, body: form }),
      env.DB, { enabled: 'true', issuer }, Object.fromEntries(form.entries()), resolve);
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
