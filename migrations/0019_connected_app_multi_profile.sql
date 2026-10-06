-- Fail closed during the authority change: an actor authenticates a principal,
-- while a browser session explicitly selects one reviewed profile membership.
UPDATE connected_app_sessions SET enabled = 0, generation = generation + 1,
  updated_at = CAST(strftime('%s','now') AS INTEGER)
  WHERE session_id IN (SELECT session_id FROM connected_app_browser_sessions);
UPDATE connected_app_browser_sessions SET revoked_at = COALESCE(revoked_at, CAST(strftime('%s','now') AS INTEGER));
UPDATE connected_app_telegram_challenges SET invalidated_at = COALESCE(invalidated_at, CAST(strftime('%s','now') AS INTEGER));

-- Do not silently broaden any old actor/profile row into all memberships of
-- its principal. Operator must independently review and reprovision the actor.
DROP TABLE connected_app_telegram_bindings;
CREATE TABLE connected_app_telegram_bindings (
  bot_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, telegram_user_id)
);
CREATE TRIGGER connected_app_telegram_binding_changed AFTER UPDATE ON connected_app_telegram_bindings
BEGIN
  UPDATE connected_app_telegram_challenges SET invalidated_at = COALESCE(invalidated_at, NEW.updated_at)
    WHERE bot_id = NEW.bot_id AND telegram_user_id = NEW.telegram_user_id;
  UPDATE connected_app_browser_sessions SET revoked_at = COALESCE(revoked_at, NEW.updated_at)
    WHERE bot_id = NEW.bot_id AND telegram_user_id = NEW.telegram_user_id;
  UPDATE connected_app_sessions SET enabled = 0, generation = generation + 1, updated_at = NEW.updated_at
    WHERE principal_id = OLD.principal_id AND session_id IN
      (SELECT session_id FROM connected_app_browser_sessions WHERE bot_id = OLD.bot_id AND telegram_user_id = OLD.telegram_user_id);
END;
CREATE TRIGGER connected_app_telegram_binding_removed AFTER DELETE ON connected_app_telegram_bindings
BEGIN
  UPDATE connected_app_telegram_challenges SET invalidated_at = COALESCE(invalidated_at, CAST(strftime('%s','now') AS INTEGER))
    WHERE bot_id = OLD.bot_id AND telegram_user_id = OLD.telegram_user_id;
  UPDATE connected_app_browser_sessions SET revoked_at = COALESCE(revoked_at, CAST(strftime('%s','now') AS INTEGER))
    WHERE bot_id = OLD.bot_id AND telegram_user_id = OLD.telegram_user_id;
  UPDATE connected_app_sessions SET enabled = 0, generation = generation + 1,
    updated_at = CAST(strftime('%s','now') AS INTEGER)
    WHERE principal_id = OLD.principal_id AND session_id IN
      (SELECT session_id FROM connected_app_browser_sessions WHERE bot_id = OLD.bot_id AND telegram_user_id = OLD.telegram_user_id);
END;
