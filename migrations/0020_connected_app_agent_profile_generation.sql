-- Connected App sessions mirror the current Agent selection generation so
-- profile switches/logout can invalidate app codes and tokens on next use.
ALTER TABLE connected_app_sessions
  ADD COLUMN agent_generation INTEGER NOT NULL DEFAULT 0;
