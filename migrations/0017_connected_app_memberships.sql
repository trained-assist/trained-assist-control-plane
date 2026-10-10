-- Memberships are provisioned only after an independent identity review. No public
-- route writes this table; an authenticated browser session alone cannot grant one.
CREATE TABLE connected_app_memberships (
  principal_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, profile_id, audience)
);

-- A disabled then re-enabled membership must never resurrect an old token.
CREATE TRIGGER connected_app_membership_changed AFTER UPDATE ON connected_app_memberships
BEGIN
  UPDATE connected_app_sessions SET generation = generation + 1, updated_at = NEW.updated_at
    WHERE principal_id = NEW.principal_id AND profile_id = NEW.profile_id;
END;
CREATE TRIGGER connected_app_membership_removed AFTER DELETE ON connected_app_memberships
BEGIN
  UPDATE connected_app_sessions SET generation = generation + 1, updated_at = CAST(strftime('%s','now') AS INTEGER)
    WHERE principal_id = OLD.principal_id AND profile_id = OLD.profile_id;
END;
