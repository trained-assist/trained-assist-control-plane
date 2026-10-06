import type { AgentProfileAuthority, AgentProfileContext } from '../connected-app/session-service';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEX = /^[a-f0-9]{64}$/;
const COOKIE = '__Host-ta_platform';
const DECIMAL = /^[1-9][0-9]{0,19}$/;
type Binding = { principal_id: string; enabled: number };
export type AgentBrowserSession = { session_id: string; bot_id: string; telegram_user_id: string;
  principal_id: string; profile_id: string; profile_generation: number;
  expires_at: number; revoked_at: number | null };
export type AgentAuthority = AgentProfileAuthority & {
  contractVersion: 'agent-profile-context-v1';
  telegramPrincipal(botId: string, telegramUserId: string): Promise<string | null>;
  profileIds(principalId: string): Promise<string[]>;
  insertLoginChallenge(input: { codeHash: string; botId: string; updateId: string;
    telegramUserId: string; principalId: string; now: number; expiresAt: number }): Promise<boolean>;
  invalidateLoginChallenge(codeHash: string, now: number): Promise<void>;
  consumeLoginChallenge(input: { codeHash: string; sessionHash: string; sessionId: string; now: number;
    expiresAt: number }): Promise<boolean>;
  selectProfile(sessionHash: string, principalId: string, profileId: string, now: number): Promise<boolean>;
  revokeBrowserSession(sessionHash: string, now: number): Promise<string | null>;
  currentBrowserSession(request: Request): Promise<AgentBrowserSession | null>;
};
const hash = async (value: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
};
function rawCookie(request: Request): string | null {
  const values = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${COOKIE}=`)).map(value => value.slice(COOKIE.length + 1));
  return values.length === 1 && HEX.test(values[0] ?? '') ? values[0] ?? null : null;
}
function validContext(row: AgentBrowserSession, now: number): AgentProfileContext | null {
  if (!ID.test(row.principal_id) || !ID.test(row.profile_id) || !ID.test(row.session_id) ||
      !Number.isSafeInteger(row.profile_generation) || row.profile_generation < 1 ||
      row.revoked_at !== null || row.expires_at <= now) return null;
  return { principalId: row.principal_id, profileId: row.profile_id,
    sessionId: row.session_id, profileGeneration: row.profile_generation };
}

/** Agent-owned identity authority v1. No API grants are read or written here. */
export function createAgentProfileAuthorityV1(db: D1Database,
  clock: () => number = () => Math.floor(Date.now() / 1000)): AgentAuthority {
  const currentBrowserSession = async (request: Request): Promise<AgentBrowserSession | null> => {
    const raw = rawCookie(request);
    if (!raw) return null;
    const row = await db.prepare(`SELECT * FROM agent_profile_browser_sessions WHERE session_hash = ?`)
      .bind(await hash(raw)).first<AgentBrowserSession>();
    if (!row || !ID.test(row.principal_id) || !ID.test(row.session_id) ||
        !Number.isSafeInteger(row.profile_generation) || row.profile_generation < 0 ||
        row.revoked_at !== null || row.expires_at <= clock()) return null;
    const binding = await db.prepare(`SELECT principal_id, enabled FROM agent_telegram_bindings
      WHERE bot_id = ? AND telegram_user_id = ?`).bind(row.bot_id, row.telegram_user_id).first<Binding>();
    if (binding?.enabled !== 1 || binding.principal_id !== row.principal_id) return null;
    if (!row.profile_id) return row;
    const membership = await db.prepare(`SELECT enabled FROM agent_profile_memberships
      WHERE principal_id = ? AND profile_id = ?`).bind(row.principal_id, row.profile_id).first<{ enabled: number }>();
    return membership?.enabled === 1 ? row : null;
  };
  return {
    contractVersion: 'agent-profile-context-v1',
    currentBrowserSession,
    async telegramPrincipal(botId, telegramUserId) {
      if (!ID.test(botId) || !DECIMAL.test(telegramUserId)) return null;
      const row = await db.prepare(`SELECT principal_id, enabled FROM agent_telegram_bindings
        WHERE bot_id = ? AND telegram_user_id = ?`).bind(botId, telegramUserId).first<Binding>();
      return row?.enabled === 1 && ID.test(row.principal_id) ? row.principal_id : null;
    },
    async profileIds(principalId) {
      if (!ID.test(principalId)) return [];
      const result = await db.prepare(`SELECT profile_id FROM agent_profile_memberships
        WHERE principal_id = ? AND enabled = 1 ORDER BY profile_id`).bind(principalId).all<{ profile_id: string }>();
      return result.results.map(row => row.profile_id).filter(value => ID.test(value));
    },
    async insertLoginChallenge(input) {
      if (!HEX.test(input.codeHash) || !ID.test(input.botId) || !DECIMAL.test(input.updateId) ||
          !DECIMAL.test(input.telegramUserId) || !ID.test(input.principalId) ||
          !Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.now)
        return false;
      const result = await db.prepare(`INSERT INTO agent_profile_login_challenges
        (code_hash,bot_id,update_id,telegram_user_id,principal_id,created_at,expires_at,consumed_at,invalidated_at)
        SELECT ?,?,?,?,?,?,?,NULL,NULL WHERE EXISTS(SELECT 1 FROM agent_telegram_bindings
          WHERE bot_id=? AND telegram_user_id=? AND principal_id=? AND enabled=1)
        ON CONFLICT(bot_id,update_id) DO NOTHING`)
        .bind(input.codeHash, input.botId, input.updateId, input.telegramUserId, input.principalId,
          input.now, input.expiresAt, input.botId, input.telegramUserId, input.principalId).run();
      return result.meta.changes === 1;
    },
    async consumeLoginChallenge(input) {
      if (!HEX.test(input.codeHash) || !HEX.test(input.sessionHash) || !HEX.test(input.sessionId) ||
          !Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.now)
        return false;
      const result = await db.batch([
        db.prepare(`UPDATE agent_profile_login_challenges SET consumed_at=?,consumed_session_hash=? WHERE code_hash=?
          AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>? AND EXISTS(
            SELECT 1 FROM agent_telegram_bindings b WHERE b.bot_id=agent_profile_login_challenges.bot_id
              AND b.telegram_user_id=agent_profile_login_challenges.telegram_user_id
              AND b.principal_id=agent_profile_login_challenges.principal_id AND b.enabled=1)`)
          .bind(input.now, input.sessionHash, input.codeHash, input.now),
        db.prepare(`INSERT INTO agent_profile_browser_sessions
          (session_hash,session_id,bot_id,telegram_user_id,principal_id,profile_id,profile_generation,issued_at,expires_at,revoked_at)
          SELECT ?,?,c.bot_id,c.telegram_user_id,c.principal_id,'',0,?,?,NULL FROM agent_profile_login_challenges c
          WHERE c.code_hash=? AND c.consumed_session_hash=? AND c.invalidated_at IS NULL`)
          .bind(input.sessionHash, input.sessionId, input.now, input.expiresAt, input.codeHash, input.sessionHash),
      ]);
      return result[0]?.meta.changes === 1 && result[1]?.meta.changes === 1;
    },
    async invalidateLoginChallenge(codeHash, now) {
      if (!HEX.test(codeHash) || !Number.isSafeInteger(now)) return;
      await db.prepare(`UPDATE agent_profile_login_challenges SET invalidated_at=COALESCE(invalidated_at,?)
        WHERE code_hash=?`).bind(now, codeHash).run();
    },
    async selectProfile(sessionHash, principalId, profileId, now) {
      if (!HEX.test(sessionHash) || !ID.test(principalId) || !ID.test(profileId) || !Number.isSafeInteger(now)) return false;
      const result = await db.prepare(`UPDATE agent_profile_browser_sessions SET profile_id=?,
        profile_generation=profile_generation+1 WHERE session_hash=? AND principal_id=? AND revoked_at IS NULL
        AND expires_at>? AND EXISTS(SELECT 1 FROM agent_profile_memberships m
          WHERE m.principal_id=? AND m.profile_id=? AND m.enabled=1) AND profile_id<>?`)
        .bind(profileId, sessionHash, principalId, now, principalId, profileId, profileId).run();
      if (result.meta.changes === 1) return true;
      const existing = await db.prepare(`SELECT 1 FROM agent_profile_browser_sessions s WHERE s.session_hash=?
        AND s.principal_id=? AND s.profile_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND EXISTS(
          SELECT 1 FROM agent_profile_memberships m WHERE m.principal_id=s.principal_id
            AND m.profile_id=s.profile_id AND m.enabled=1)`)
        .bind(sessionHash, principalId, profileId, now).first();
      return existing !== null;
    },
    async revokeBrowserSession(sessionHash, now) {
      if (!HEX.test(sessionHash) || !Number.isSafeInteger(now)) return null;
      const row = await db.prepare(`SELECT session_id FROM agent_profile_browser_sessions WHERE session_hash=?`)
        .bind(sessionHash).first<{ session_id: string }>();
      await db.prepare(`UPDATE agent_profile_browser_sessions SET revoked_at=COALESCE(revoked_at,?)
        WHERE session_hash=?`).bind(now, sessionHash).run();
      return row?.session_id ?? null;
    },
    async resolveBrowserSession(request) {
      const row = await currentBrowserSession(request);
      return row ? validContext(row, clock()) : null;
    },
    async resolveCurrentSession(sessionId) {
      if (!ID.test(sessionId)) return null;
      const row = await db.prepare(`SELECT * FROM agent_profile_browser_sessions WHERE session_id=?`)
        .bind(sessionId).first<AgentBrowserSession>();
      if (!row || !validContext(row, clock())) return null;
      const binding = await db.prepare(`SELECT enabled,principal_id FROM agent_telegram_bindings
        WHERE bot_id=? AND telegram_user_id=?`).bind(row.bot_id, row.telegram_user_id).first<Binding>();
      const membership = await db.prepare(`SELECT enabled FROM agent_profile_memberships
        WHERE principal_id=? AND profile_id=?`).bind(row.principal_id, row.profile_id).first<{ enabled: number }>();
      return binding?.enabled === 1 && binding.principal_id === row.principal_id && membership?.enabled === 1
        ? validContext(row, clock()) : null;
    },
  };
}
