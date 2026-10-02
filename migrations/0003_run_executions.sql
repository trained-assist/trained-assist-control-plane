-- 0003_run_executions.sql
-- Попытки исполнения (runId) — таблица executions по TASK-STORE-SCHEMA-V1 §6
-- (имя и состав из A2, второй набор терминов не заводится).
--
-- Статусы: running / waiting / interrupted / success / failed (наблюдения A2 §2.3)
-- + unknown (исход неизвестен: connection_lost, ARCHITECTURE §4.6) и cancelled
-- (остановлена пользователем). 'unknown' НЕ 'failed': потеря связи не доказывает
-- сбой работы. CHECK на status в A2 отсутствует — новые значения допустимы.

CREATE TABLE IF NOT EXISTS executions (
    id               TEXT PRIMARY KEY,          -- runId
    task_id          TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
    session_id      TEXT,                      -- сессия движка (runtime state)
    engine          TEXT,                      -- opencode/claude/codex/cloudflare-workflows
    model           TEXT,
    status          TEXT NOT NULL,             -- running/unknown/success/failed/interrupted/cancelled/waiting
    generation      INTEGER NOT NULL DEFAULT 0, -- поколение задачи на момент старта попытки
    started_at      INTEGER NOT NULL,
    finished_at     INTEGER,                   -- NULL = попытка не завершена (в т.ч. unknown)
    error_class     TEXT,
    error_text      TEXT,
    result_json     TEXT,
    last_heartbeat_at INTEGER,
    lease_until     INTEGER                    -- epoch ms; истечение НЕ запускает агента повторно
);

CREATE INDEX IF NOT EXISTS idx_executions_task ON executions(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_executions_lease ON executions(status, lease_until) WHERE status = 'running';
