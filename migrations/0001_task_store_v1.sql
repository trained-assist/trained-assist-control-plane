-- Task Store v1 — D1 migration 0001
-- Источник: TASK-STORE-SCHEMA-V1.md §6 («DDL v1 целиком»), адаптация под D1.
-- Скоуп M1.1 (#109): durable_tasks, task_events, task_signals, awaiting_inputs + conversations.
-- Вне скоупа M1.1 (добавляются отдельными миграциями позже): task_items, executions,
-- deliveries, legacy hook/cron таблицы.
--
-- durable_tasks.id = userTaskId (§5.1). Терминальные статусы done/failed/cancelled
-- неизменяемы — их защищает guard в репозитории (issue #90), CHECK ниже задаёт только лексику.

CREATE TABLE IF NOT EXISTS durable_tasks (
    id                        TEXT PRIMARY KEY,
    profile_id                TEXT NOT NULL,
    project_id                TEXT,
    goal                      TEXT NOT NULL,
    status                    TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('draft','active','paused','blocked',
                          'awaiting_input',
                          'done','failed','cancelled')),
    stage                     TEXT CHECK (stage IN ('collecting','preparing','queued','handing_off',
                                                    'running','evaluating','waiting_input',
                                                    'waiting_followup','finished')),
    conversation_id           TEXT,
    audience_id               TEXT,
    destination_id            TEXT,
    awaiting_input_id         TEXT,
    delivery_state            TEXT NOT NULL DEFAULT 'not_required'
        CHECK (delivery_state IN ('not_required','pending','accepted','delivered','failed','unknown')),
    generation                INTEGER NOT NULL DEFAULT 1,
    created_at                INTEGER NOT NULL,
    updated_at                INTEGER NOT NULL,
    revision                  INTEGER NOT NULL DEFAULT 0,
    playbook_id               TEXT,
    playbook_version          INTEGER,
    user_value                TEXT,
    acceptance_criteria_json  TEXT,
    contract_revision         INTEGER NOT NULL DEFAULT 1,
    execution_policy_json     TEXT,
    execution_session_id      TEXT,
    request_id                TEXT,
    blocker_reason            TEXT,
    hooks_json                TEXT,
    parent_task_id            TEXT,
    parent_item_id            TEXT,
    batch_item_key            TEXT,
    origin_session_id         TEXT,
    origin_chat_json          TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON durable_tasks(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON durable_tasks(conversation_id)
    WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_profile ON durable_tasks(profile_id, created_at);

CREATE TABLE IF NOT EXISTS task_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      TEXT,
    user_task_id  TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
    task_item_id  TEXT,
    execution_id  TEXT,
    kind          TEXT NOT NULL,
    status_before TEXT,
    status_after  TEXT,
    generation    INTEGER,
    source        TEXT NOT NULL,
    payload_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    created_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_event_id ON task_events(event_id)
    WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(user_task_id, id);
CREATE INDEX IF NOT EXISTS idx_task_events_kind ON task_events(kind, created_at);

CREATE TABLE IF NOT EXISTS task_signals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_task_id    TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
    step_key        TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    payload_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    generation      INTEGER,
    source          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    consumed_at     INTEGER,
    consumed_by_execution TEXT,
    rejected_reason TEXT,
    UNIQUE (user_task_id, step_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_task_signals_pending
    ON task_signals(user_task_id, step_key, event_type) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS awaiting_inputs (
    awaiting_input_id TEXT PRIMARY KEY,
    user_task_id      TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
    task_item_id      TEXT,
    run_id            TEXT,
    kind              TEXT NOT NULL CHECK (kind IN ('data','choice','approval')),
    question          TEXT NOT NULL,
    schema_json       TEXT,
    respondent_scope  TEXT NOT NULL,
    checkpoint_ref    TEXT,
    status            TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','answered','expired','cancelled')),
    created_at        INTEGER NOT NULL,
    deadline_at       INTEGER NOT NULL,
    answered_at       INTEGER,
    answer_signal_id  INTEGER REFERENCES task_signals(id),
    answer_json       TEXT,
    generation        INTEGER NOT NULL DEFAULT 1,
    version           INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_awaiting_one_open ON awaiting_inputs(user_task_id)
    WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_awaiting_due ON awaiting_inputs(status, deadline_at);

CREATE TABLE IF NOT EXISTS conversations (
    conversation_id TEXT PRIMARY KEY,
    profile_id      TEXT NOT NULL,
    project_id      TEXT,
    audience_id     TEXT,
    destination_id  TEXT,
    title           TEXT,
    active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    revision        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_conversations_profile ON conversations(profile_id, updated_at);
