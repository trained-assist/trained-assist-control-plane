-- 0012_stuck_input_alerts.sql
-- Repair of a migration DRIFT, found during the first real deploy of the watchdog
-- (2026-10-04, deploy of c4cb7.. / runbook #39 step 1).
--
-- What happened: 0009_pending_inputs.sql was applied to D1 from a checkout that
-- predated #38, i.e. from a version of the file that only created
-- `pending_inputs`. Wrangler records applied migrations BY FILENAME, so 0009 is
-- marked done and its current content — which also creates `stuck_input_alerts` —
-- will never run on this database. `wrangler d1 migrations list` correctly said
-- «No migrations to apply», while the table the alert dedup needs did not exist:
-- the only reason to notice was verifying the SCHEMA, not the migration list.
--
-- This is the general hazard of appending DDL to an already-applied migration
-- file: for that database the append is invisible forever. New statements go in a
-- NEW file; an applied file is never edited again.
--
-- Idempotent (IF NOT EXISTS) and additive: on a database that already has the
-- table it is a no-op.

CREATE TABLE IF NOT EXISTS stuck_input_alerts (
    incident_id   TEXT PRIMARY KEY,          -- 'task:<id>' | 'batch:<id>'
    alerted_at    INTEGER NOT NULL,          -- первое обнаружение
    last_seen_at  INTEGER,                   -- последнее обнаружение
    count         INTEGER NOT NULL DEFAULT 1 -- сколько раз видели
);
