-- 0004_delivery_and_artifacts.sql
-- Отмена и доставка (эпик #109 шаг 6): outbox доставки и ссылки на артефакты.
--
-- deliveries — по TASK-STORE-SCHEMA-V1 §5.5: доставка имеет СВОЙ статус,
-- отдельный от исполнения (C02: «исполнение и доставка имеют разные статусы»).
-- UNIQUE(user_task_id, logical_message_id) — повторная постановка того же
-- отчёта не создаёт вторую доставку. Частичный индекс outbox обслуживает
-- горячий запрос воркера доставки: «что отправить сейчас».
--
-- task_artifacts — ссылки на артефакты в базе, байты в Artifact Storage
-- (ARCHITECTURE §4.1: «в базе только ссылки, владелец, размер и контрольная
-- сумма»). Отмена задачи их не трогает: файлы переживают процесс (§4.6).

CREATE TABLE IF NOT EXISTS deliveries (
    id                  TEXT PRIMARY KEY,     -- deliveryId
    user_task_id        TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
    event_id            INTEGER,             -- task_events.id, породивший доставку
    logical_message_id  TEXT NOT NULL,       -- одно логическое сообщение; повтор сохраняет его
    conversation_id     TEXT,                -- снимок диалога-адресата на момент постановки
    audience_id         TEXT,                -- записаны ПРИ ПРИЁМЕ (INV-19)
    destination_id      TEXT,
    channel             TEXT NOT NULL,       -- telegram | web | api
    message_json        TEXT NOT NULL CHECK (json_valid(message_json)),  -- текст + ссылки, без байтов
    status              TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','accepted','delivered','failed','unknown')),
    attempt             INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     INTEGER,             -- когда пробовать снова (bounded retry)
    last_error          TEXT,
    provider_message_id TEXT,                -- nativeMessageId: гасит дубль у провайдера
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    UNIQUE (user_task_id, logical_message_id)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_outbox ON deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_task ON deliveries(user_task_id, created_at);

CREATE TABLE IF NOT EXISTS task_artifacts (
    artifact_id   TEXT PRIMARY KEY,
    user_task_id  TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,             -- что за артефакт: file | report | workspace
    artifact_ref  TEXT NOT NULL,             -- ссылка в Artifact Storage (R2/бакет)
    size_bytes    INTEGER,
    checksum      TEXT,
    run_id        TEXT,                      -- какой попыткой создан
    created_at    INTEGER NOT NULL,
    UNIQUE (user_task_id, artifact_ref)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_task ON task_artifacts(user_task_id, created_at);
