-- 0006_schedule_v1.sql
-- P22 «Schedule без обязательного GTD» (trained-agent-architecture#61, этап I07).
--
-- Расписание НЕ создаёт работу само по себе: оно создаёт occurrence — одно
-- срабатывание, у которого СВОЙ userTaskId (PLAYBOOKS-VS-GETTING-THINGS-DONE-
-- BOUNDARIES §7 «Каждая occurrence получает новый userTaskId»). Occurrence —
-- единственное место, где живёт dedup: UNIQUE (schedule_id, occurrence_key) даёт
-- «crash replay не создаёт второе срабатывание» на уровне БД, а не на уровне
-- поведения платформы.
--
-- gtd_id — намеренно NULL и без таблицы контроля: GTD не включается по умолчанию
-- (§ «Решение владельца: GTD только там, где нужен следующий контроль»). Колонка
-- оставлена явным NULL'ом, чтобы «gtdId отсутствует» было проверяемо запросом, а
-- не догадкой; заполняет её только явная регистрация на контроль (карточка P23).
--
-- next_due_at — момент БУДУЩЕГО срабатывания в timezone расписания (ms epoch).
-- Disable не обнуляет историю occurrence и не трогает уже принятые задачи:
-- выключение запрещает будущие occurrences, а не отменяет исполнение (§7
-- «Disable Schedule запрещает будущие occurrences; уже принятые User Tasks
-- продолжаются, если не указана cancel policy»).

CREATE TABLE IF NOT EXISTS schedules (
    schedule_id         TEXT PRIMARY KEY,
    profile_id          TEXT NOT NULL,
    cron_expr           TEXT NOT NULL,
    timezone            TEXT NOT NULL,
    goal                TEXT NOT NULL,
    project_id          TEXT,
    conversation_id     TEXT,
    audience_id         TEXT,
    destination_id      TEXT,
    -- allow = перекрывающиеся occurrences разрешены; skip = новое срабатывание
    -- пропускается, пока предыдущая задача не терминальна (backlog не растёт).
    overlap_policy      TEXT NOT NULL DEFAULT 'skip'
        CHECK (overlap_policy IN ('allow','skip')),
    -- skip = просроченные срабатывания не выполняются вовсе; coalesce = одно
    -- срабатывание на всё окно (крайний due). Мисфиры считаются и логируются.
    catch_up_policy     TEXT NOT NULL DEFAULT 'coalesce'
        CHECK (catch_up_policy IN ('skip','coalesce')),
    max_admit_attempts  INTEGER NOT NULL DEFAULT 5
        CHECK (max_admit_attempts BETWEEN 1 AND 10),
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    next_due_at         INTEGER,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    revision            INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_due_at);
CREATE INDEX IF NOT EXISTS idx_schedules_profile ON schedules(profile_id, created_at);

CREATE TABLE IF NOT EXISTS schedule_occurrences (
    occurrence_id  TEXT PRIMARY KEY,
    schedule_id    TEXT NOT NULL REFERENCES schedules(schedule_id) ON DELETE CASCADE,
    profile_id     TEXT NOT NULL,
    -- Ключ дедупа: момент срабатывания ISO-8601 UTC. Один и тот же момент при
    -- повторном tick/replay даёт ту же строку, а не вторую.
    occurrence_key TEXT NOT NULL,
    scheduled_for  INTEGER NOT NULL,
    state          TEXT NOT NULL DEFAULT 'due'
        CHECK (state IN ('due','admitted','skipped','failed')),
    reason         TEXT,
    user_task_id   TEXT,
    run_id         TEXT,
    -- NULL у расписаний без явной регистрации на контроль (P22/AC-141).
    gtd_id         TEXT,
    attempts       INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    UNIQUE (schedule_id, occurrence_key)
);

CREATE INDEX IF NOT EXISTS idx_occurrences_schedule ON schedule_occurrences(schedule_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_occurrences_pending ON schedule_occurrences(state, schedule_id)
    WHERE state IN ('due','failed');
