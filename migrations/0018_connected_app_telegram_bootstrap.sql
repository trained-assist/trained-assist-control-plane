-- Private, reviewed Telegram actor binding. Never populated from update payloads.
CREATE TABLE connected_app_telegram_bindings (
  bot_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, telegram_user_id)
);
CREATE TABLE connected_app_telegram_challenges (
  code_hash TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  update_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  invalidated_at INTEGER,
  UNIQUE (bot_id, update_id)
);
CREATE TABLE connected_app_browser_sessions (
  session_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  bot_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_connected_app_browser_sessions_binding
  ON connected_app_browser_sessions(bot_id, telegram_user_id);

-- A revoked then re-enabled binding or membership cannot revive a challenge or browser session.
CREATE TRIGGER connected_app_telegram_binding_changed AFTER UPDATE ON connected_app_telegram_bindings
BEGIN
  UPDATE connected_app_telegram_challenges SET invalidated_at = COALESCE(invalidated_at, NEW.updated_at)
    WHERE bot_id = NEW.bot_id AND telegram_user_id = NEW.telegram_user_id;
  UPDATE connected_app_browser_sessions SET revoked_at = COALESCE(revoked_at, NEW.updated_at)
    WHERE bot_id = NEW.bot_id AND telegram_user_id = NEW.telegram_user_id;
  UPDATE connected_app_sessions SET enabled = 0, generation = generation + 1, updated_at = NEW.updated_at
    WHERE principal_id = OLD.principal_id AND profile_id = OLD.profile_id;
END;
CREATE TRIGGER connected_app_telegram_binding_removed AFTER DELETE ON connected_app_telegram_bindings
BEGIN
  UPDATE connected_app_telegram_challenges SET invalidated_at = COALESCE(invalidated_at, CAST(strftime('%s','now') AS INTEGER))
    WHERE bot_id = OLD.bot_id AND telegram_user_id = OLD.telegram_user_id;
  UPDATE connected_app_browser_sessions SET revoked_at = COALESCE(revoked_at, CAST(strftime('%s','now') AS INTEGER))
    WHERE bot_id = OLD.bot_id AND telegram_user_id = OLD.telegram_user_id;
  UPDATE connected_app_sessions SET enabled = 0, generation = generation + 1, updated_at = CAST(strftime('%s','now') AS INTEGER)
    WHERE principal_id = OLD.principal_id AND profile_id = OLD.profile_id;
END;
CREATE TRIGGER connected_app_browser_membership_changed AFTER UPDATE ON connected_app_memberships
BEGIN
  UPDATE connected_app_telegram_challenges SET invalidated_at = COALESCE(invalidated_at, NEW.updated_at)
    WHERE principal_id = NEW.principal_id AND profile_id = NEW.profile_id;
  UPDATE connected_app_browser_sessions SET revoked_at = COALESCE(revoked_at, NEW.updated_at)
    WHERE principal_id = NEW.principal_id AND profile_id = NEW.profile_id;
END;
CREATE TRIGGER connected_app_browser_membership_removed AFTER DELETE ON connected_app_memberships
BEGIN
  UPDATE connected_app_telegram_challenges SET invalidated_at = COALESCE(invalidated_at, CAST(strftime('%s','now') AS INTEGER))
    WHERE principal_id = OLD.principal_id AND profile_id = OLD.profile_id;
  UPDATE connected_app_browser_sessions SET revoked_at = COALESCE(revoked_at, CAST(strftime('%s','now') AS INTEGER))
    WHERE principal_id = OLD.principal_id AND profile_id = OLD.profile_id;
END;
