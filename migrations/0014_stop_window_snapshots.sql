-- Durable stop-window membership. One current snapshot per generic conversation;
-- explicit restart with a new window_id replaces it only after stop confirmation.
CREATE TABLE cp_stop_windows (
  profile_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  window_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL UNIQUE,
  admission_request_ids_json TEXT NOT NULL,
  targets_json TEXT NOT NULL,
  stop_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (stop_confirmed IN (0,1)),
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, conversation_id)
);
