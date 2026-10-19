-- Canonical Agent-owned identity/profile state. This lives in a namespaced,
-- independently versioned authority module inside the supported CP Worker.
-- Rows are populated only by a separately reviewed private provisioning flow.
CREATE TABLE agent_telegram_bindings (
  bot_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, telegram_user_id)
);

CREATE TABLE agent_profile_memberships (
  principal_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, profile_id)
);

CREATE TABLE agent_profile_login_challenges (
  code_hash TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  update_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_session_hash TEXT,
  invalidated_at INTEGER,
  UNIQUE (bot_id, update_id)
);

CREATE TABLE agent_profile_browser_sessions (
  session_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  bot_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  profile_id TEXT NOT NULL DEFAULT '',
  profile_generation INTEGER NOT NULL DEFAULT 0 CHECK (profile_generation >= 0),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_agent_profile_browser_sessions_actor
  ON agent_profile_browser_sessions(bot_id, telegram_user_id);
CREATE INDEX idx_agent_profile_browser_sessions_principal_profile
  ON agent_profile_browser_sessions(principal_id, profile_id);

CREATE TRIGGER agent_telegram_binding_changed AFTER UPDATE ON agent_telegram_bindings
BEGIN
  UPDATE agent_profile_login_challenges SET invalidated_at = COALESCE(invalidated_at, NEW.updated_at)
    WHERE bot_id = NEW.bot_id AND telegram_user_id = NEW.telegram_user_id;
  UPDATE agent_profile_browser_sessions SET revoked_at = COALESCE(revoked_at, NEW.updated_at)
    WHERE bot_id = NEW.bot_id AND telegram_user_id = NEW.telegram_user_id;
END;
CREATE TRIGGER agent_telegram_binding_removed AFTER DELETE ON agent_telegram_bindings
BEGIN
  UPDATE agent_profile_login_challenges SET invalidated_at = COALESCE(invalidated_at, CAST(strftime('%s','now') AS INTEGER))
    WHERE bot_id = OLD.bot_id AND telegram_user_id = OLD.telegram_user_id;
  UPDATE agent_profile_browser_sessions SET revoked_at = COALESCE(revoked_at, CAST(strftime('%s','now') AS INTEGER))
    WHERE bot_id = OLD.bot_id AND telegram_user_id = OLD.telegram_user_id;
END;
CREATE TRIGGER agent_profile_membership_changed AFTER UPDATE ON agent_profile_memberships
BEGIN
  UPDATE agent_profile_login_challenges SET invalidated_at = COALESCE(invalidated_at, NEW.updated_at)
    WHERE principal_id = NEW.principal_id;
  UPDATE agent_profile_browser_sessions SET revoked_at = COALESCE(revoked_at, NEW.updated_at)
    WHERE principal_id = NEW.principal_id AND profile_id = NEW.profile_id;
END;
CREATE TRIGGER agent_profile_membership_removed AFTER DELETE ON agent_profile_memberships
BEGIN
  UPDATE agent_profile_login_challenges SET invalidated_at = COALESCE(invalidated_at, CAST(strftime('%s','now') AS INTEGER))
    WHERE principal_id = OLD.principal_id;
  UPDATE agent_profile_browser_sessions SET revoked_at = COALESCE(revoked_at, CAST(strftime('%s','now') AS INTEGER))
    WHERE principal_id = OLD.principal_id AND profile_id = OLD.profile_id;
END;
