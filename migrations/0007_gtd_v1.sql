-- 0007_gtd_v1.sql
-- P23 «GTD opt-in и bounded control» (trained-agent-architecture#62, этап I07).
--
-- GTD — владелец durable progression ОДНОЙ явно зарегистрированной User Task
-- (PLAYBOOKS-VS-GETTING-THINGS-DONE-BOUNDARIES §5a «gtdId — запись контроля,
-- даже без playbook»). Термины не плодятся: gtdId — тот же идентификатор,
-- что уже появился в schedule_occurrences.gtd_id (P22) и в user_value задачи;
-- здесь он наконец получает свою запись.
--
-- Три инварианта, которые обеспечивает сама схема (а не только код):
--
--  1. **Одна запись контроля на одну User Task** — UNIQUE(user_task_id).
--     Вторая запись для той же задачи невозможна в принципе, поэтому
--     исчерпание caps нельзя обойти «новой записью контроля»: повторная
--     регистрация возвращает ту же (уже stopped) строку, а не новую.
--  2. **gtdId детерминирован** от (profile_id, user_task_id) — повторная
--     регистрация того же контроля даёт тот же ID, а не второй.
--  3. **Самоконтроль запрещён на уровне БД** — CHECK не даёт записи контролировать
--     саму себя; сервис дополнительно отклоняет любую цепочку «GTD контролирует
--     GTD» (§ «Решение владельца»: не допускается, только deterministic health
--     supervision).
--
-- Ожидание (wait) НЕ держит живой процесс: состояние ожидания — строка
-- gtd_records (state + next_trigger) и, для ожидания человека, уже существующая
-- строка awaiting_inputs. Никакого процесса, никакого расхода токенов: следующая
-- попытка создаётся только после события (ответ/условие/таймер) — см.
-- gtd_progressions.continuation_run_id.

CREATE TABLE IF NOT EXISTS gtd_records (
    gtd_id                TEXT PRIMARY KEY,
    profile_id            TEXT NOT NULL,
    user_task_id          TEXT NOT NULL,
    -- Причина регистрации: почему эта задача взята на контроль (явный opt-in).
    registration_reason   TEXT NOT NULL,
    -- Критерии завершения: [{id, description, required}]. Пустым быть не могут:
    -- «контролировать» без критерия недостаточно (§ «Решение владельца»).
    criteria_json         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(criteria_json)),
    -- Явный владелец продолжения: у managed work это всегда gtd (§5a).
    continuation_owner    TEXT NOT NULL DEFAULT 'gtd' CHECK (continuation_owner = 'gtd'),
    state                 TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active','awaiting_user','waiting_condition','completed','cancelled','stopped')),
    stop_reason           TEXT,
    -- Что запускает следующую проверку: timer | condition | input.
    next_trigger_kind     TEXT CHECK (next_trigger_kind IN ('timer','condition','input')),
    next_trigger_ref      TEXT,
    next_check_at         INTEGER,
    deadline_at           INTEGER NOT NULL,
    max_attempts          INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    attempts              INTEGER NOT NULL DEFAULT 0,
    -- Шаг, который ждёт результата: стабилен между попытками (§11).
    current_step_id       TEXT,
    control_generation    INTEGER NOT NULL DEFAULT 1,
    -- Кто контролирует эту запись. NULL = регистрация от пользователя/хоста.
    -- Любое не-NULL значение отклоняется сервисом: самоконтроль запрещён.
    supervised_by_gtd_id  TEXT,
    last_outcome          TEXT,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL,
    revision              INTEGER NOT NULL DEFAULT 1,
    UNIQUE (user_task_id),
    CHECK (supervised_by_gtd_id IS NULL OR supervised_by_gtd_id <> gtd_id)
);

CREATE INDEX IF NOT EXISTS idx_gtd_records_due ON gtd_records(state, next_check_at)
    WHERE state IN ('active','awaiting_user','waiting_condition');
CREATE INDEX IF NOT EXISTS idx_gtd_records_profile ON gtd_records(profile_id, created_at);

-- Durable inbox Output -> GTD (§5a): исход шага сохраняется ДО решения GTD,
-- поэтому потеря ACK не теряет исход. Дедуп — по ключу идемпотентности исхода.
CREATE TABLE IF NOT EXISTS gtd_outcomes (
    outcome_id        TEXT PRIMARY KEY,
    gtd_id            TEXT NOT NULL,
    profile_id        TEXT NOT NULL,
    user_task_id      TEXT NOT NULL,
    run_id            TEXT,
    step_id           TEXT NOT NULL,
    outcome           TEXT NOT NULL
        CHECK (outcome IN ('succeeded','failed','awaiting_user','awaiting_condition')),
    detail_json       TEXT,
    event_id          INTEGER,
    idempotency_key   TEXT NOT NULL,
    state             TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','acked','rejected','quarantined')),
    reason            TEXT,
    attempt           INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    acked_at          INTEGER,
    UNIQUE (gtd_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_gtd_outcomes_pending ON gtd_outcomes(gtd_id, created_at)
    WHERE state = 'pending';

-- Решения GTD: ровно одно на (запись, шаг, попытка). Это и есть «один владелец
-- продолжения» на уровне данных: второй continuation для того же шага и попытки
-- вставить нельзя, а continuation_run_id показывает, какой именно Run выдан.
CREATE TABLE IF NOT EXISTS gtd_progressions (
    progression_id       TEXT PRIMARY KEY,
    gtd_id               TEXT NOT NULL,
    user_task_id         TEXT NOT NULL,
    attempt              INTEGER NOT NULL,
    step_id              TEXT NOT NULL,
    decision             TEXT NOT NULL
        CHECK (decision IN ('continue','wait','complete','stop','reject')),
    reason               TEXT NOT NULL,
    trigger_kind         TEXT,
    trigger_ref          TEXT,
    outcome_id           TEXT,
    continuation_run_id  TEXT,
    created_at           INTEGER NOT NULL,
    UNIQUE (gtd_id, step_id, attempt)
);

-- Внешние условия (synthetic CI provider песочницы I07): ссылка на внешний
-- отчёт/гейт, который ждёт GTD. Это источник триггера, а не второй набор
-- терминов: condition_ref — тот же вид ссылки, что engine_session_ref в
-- awaiting_inputs (корреляция, не идентичность).
CREATE TABLE IF NOT EXISTS gtd_conditions (
    condition_ref  TEXT PRIMARY KEY,
    gtd_id         TEXT NOT NULL,
    user_task_id   TEXT NOT NULL,
    conclusion     TEXT NOT NULL CHECK (conclusion IN ('success','failure','neutral')),
    report_ref     TEXT,
    source         TEXT,
    created_at     INTEGER NOT NULL
);
