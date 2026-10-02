-- 0002_task_admission.sql
-- Приём задачи и durable receipt (контракт C01, карточка P04).
--
-- Ключ идемпотентности приёма — requestId в рамках профиля: scope ключа включает
-- проверенного вызывающего (profile_id, C01). UNIQUE-индекс ставится на
-- durable_tasks.request_id, который A2 §5.1 и предназначал ровно для приёма по
-- ключу идемпотентности. Дедуп бессрочный (срок очистки не объявлен).
--
-- Принципалы приёма: identity + профиль + scope. Секреты (API keys, C13) здесь не
-- хранятся и не проверяются — это зона credential broker; таблица описывает
-- права доступа, а не credential.

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_request ON durable_tasks(profile_id, request_id)
    WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS admission_principals (
    principal_id TEXT PRIMARY KEY,
    profile_id   TEXT NOT NULL,                -- профиль, к которому принципал привязан
    scopes       TEXT NOT NULL CHECK (json_valid(scopes)),  -- JSON-массив scope: tasks:intake, tasks:read, tasks:signal
    enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admission_principals_profile ON admission_principals(profile_id);