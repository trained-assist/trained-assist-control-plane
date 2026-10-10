-- Opt-in connected app identity. Only hashes of bearer tokens are persisted.
CREATE TABLE connected_app_sessions (
  session_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  generation INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE connected_app_grants (
  session_id TEXT NOT NULL REFERENCES connected_app_sessions(session_id) ON DELETE CASCADE,
  audience TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  PRIMARY KEY (session_id, audience)
);

CREATE TABLE connected_app_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES connected_app_sessions(session_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  audience TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_connected_app_tokens_session ON connected_app_tokens(session_id);
