-- Short-lived, profile/session-bound human approval intents and durable
-- one-use consumption receipts for Connected App external writes.
CREATE TABLE connected_app_approval_intents (
  intent_hash TEXT PRIMARY KEY CHECK (length(intent_hash) = 64),
  session_id TEXT NOT NULL REFERENCES connected_app_sessions(session_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  client_id TEXT NOT NULL,
  command TEXT NOT NULL,
  required_scope TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  source_revision TEXT NOT NULL CHECK (length(source_revision) = 64),
  operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  review_nonce_hash TEXT CHECK (review_nonce_hash IS NULL OR length(review_nonce_hash) = 64),
  approved_at INTEGER,
  consumed_at INTEGER,
  consumer_request_id TEXT,
  receipt_id TEXT UNIQUE,
  CHECK ((consumed_at IS NULL AND consumer_request_id IS NULL AND receipt_id IS NULL) OR
         (consumed_at IS NOT NULL AND consumer_request_id IS NOT NULL AND receipt_id IS NOT NULL))
);
CREATE INDEX idx_connected_app_approval_intents_expiry
  ON connected_app_approval_intents(expires_at);

CREATE TABLE connected_app_approval_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (length(receipt_id) = 64),
  intent_hash TEXT NOT NULL UNIQUE REFERENCES connected_app_approval_intents(intent_hash) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  client_id TEXT NOT NULL,
  command TEXT NOT NULL,
  required_scope TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  source_revision TEXT NOT NULL CHECK (length(source_revision) = 64),
  approved_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,
  consumer_request_id TEXT NOT NULL,
  operation_json TEXT NOT NULL CHECK (json_valid(operation_json))
);
CREATE INDEX idx_connected_app_approval_receipts_session
  ON connected_app_approval_receipts(session_id, consumed_at);
