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
