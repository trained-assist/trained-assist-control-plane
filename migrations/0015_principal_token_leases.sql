-- Audited short-lived principal leases issued from the protected GitHub workflow.
CREATE TABLE IF NOT EXISTS principal_token_leases (
    lease_id       TEXT PRIMARY KEY,
    principal_id   TEXT NOT NULL UNIQUE,
    profile_id     TEXT NOT NULL,
    scopes_json    TEXT NOT NULL CHECK (json_valid(scopes_json)),
    issued_by      TEXT NOT NULL,
    repository     TEXT NOT NULL,
    workflow_run_id TEXT NOT NULL,
    run_attempt    TEXT NOT NULL,
    issued_at      INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    revoked_at     INTEGER,
    revoked_by     TEXT,
    revoke_run_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_principal_token_leases_profile_expiry
    ON principal_token_leases(profile_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_principal_token_leases_actor_issued
    ON principal_token_leases(issued_by, issued_at);
