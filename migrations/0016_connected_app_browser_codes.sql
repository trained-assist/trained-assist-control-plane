-- Only hashes of one-time browser handoff codes are persisted.
CREATE TABLE connected_app_browser_codes (
  code_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES connected_app_sessions(session_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  audience TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  redirect_uri TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_connected_app_browser_codes_session ON connected_app_browser_codes(session_id);
