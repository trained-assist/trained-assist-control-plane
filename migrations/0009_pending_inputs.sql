-- 0009_pending_inputs.sql
-- Наблюдаемый принятый вход ДО запуска: окно между «шлюз принял сообщение» и
-- «Input создал задачу» (arch#132 R9; разбор — issue #132).
--
-- Проблема: watchdog «принято, но не начато» смотрит durable_tasks.start_deadline_at
-- и therefore НЕ ВИДИТ сообщение, которое ещё лежит в накопителе шлюза и не дошло
-- до admitTask. Ровно это окно породило инцидент 2026-10-04 (tg-bot #346): вход
-- принят, задачи нет, детектор молчит, чат молчит.
--
-- Почему НЕ durable_tasks: заводить пользовательскую задачу на каждое сообщение
-- только ради watchdog нельзя — это раздувает Task Store задачами без результата
-- и без попыток. Ни одна существующая таблица не подходит: durable_tasks — это
-- задача (с lifecycle), awaiting_inputs — ожидание ответа внутри задачи,
-- conversations — диалог, admission_principals — права. Здесь нужна лёгкая запись
-- «штука, принятая шлюзом, ещё не ставшая задачей».
--
-- first_message_at НИКОГДА не перебивается новыми сообщениями: иначе активный чат
-- постоянно подставляет свежие сообщения и возраст самого старого непродвинувшегося
-- ввода становится невидимым. Новые сообщения двигают только message_count/updated_at.
--
-- Детектор читает idx_pending_inputs_due: не-admitted (user_task_id IS NULL) и
-- просроченные, порядок по first_message_at (самый старый — первым). Он живёт
-- ВНЕ накопителя, поэтому сломанный/не взведённый аларм DO не может оставить вход
-- незамеченным.

CREATE TABLE IF NOT EXISTS pending_inputs (
    batch_id         TEXT PRIMARY KEY,              -- id пакета накопителя (стабильный)
    version          INTEGER NOT NULL,              -- версия контракта принятия
    profile_id       TEXT NOT NULL,
    channel          TEXT,                          -- telegram | web | api | cron
    conversation_id  TEXT,
    audience_id      TEXT,                          -- адрес доставки (INV-19)
    destination_id   TEXT,
    first_message_at INTEGER NOT NULL,              -- время ПЕРВОГО сообщения пакета
    message_count    INTEGER NOT NULL DEFAULT 0,
    prep_state       TEXT NOT NULL DEFAULT 'collecting'
        CHECK (prep_state IN ('collecting','preparing','ready','failed','admitted')),
    deadline_at      INTEGER,                       -- верхняя граница ожидания (NULL = не задана)
    user_task_id     TEXT,                          -- связь с задачей после admitTask
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    -- Пакет не может быть одновременно признан не-admitted и привязан к задаче.
    CHECK (user_task_id IS NULL OR prep_state = 'admitted')
);

-- Детектор: не-admitted + просроченные, самый старый первый.
CREATE INDEX IF NOT EXISTS idx_pending_inputs_due ON pending_inputs(first_message_at)
    WHERE user_task_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_pending_inputs_profile ON pending_inputs(profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_pending_inputs_task ON pending_inputs(user_task_id)
    WHERE user_task_id IS NOT NULL;
-- Операторские алерты по инциденту «принято, но не начато» (arch#132 R4,
-- Приоритет 3). Один инцидент = один алерт: планировщик шлёт алерт на ПЕРВОЕ
-- обнаружение, дальше инцидент только копит count. Иначе зависший вход шлёт
-- алерт на каждом проходе планировщика и тревога перестаёт быть сигналом.
CREATE TABLE IF NOT EXISTS stuck_input_alerts (
    incident_id   TEXT PRIMARY KEY,          -- 'task:<id>' | 'batch:<id>'
    alerted_at    INTEGER NOT NULL,          -- первое обнаружение
    last_seen_at  INTEGER,                   -- последнее обнаружение
    count         INTEGER NOT NULL DEFAULT 1 -- сколько раз видели
);

-- Работоспособность планировщика watchdog (arch#132 П3c).
--
-- Детектор без планировщика — мёртвый код. Но и планировщик может умереть молча:
-- достаточно, чтобы кто-то сломал триггер. Поэтому каждый УСПЕШНЫЙ проход
-- планировщика оставляет отметку, а независимая проверка читает её и алертит при
-- устаревании. Сбой прохода отметку НЕ обновляет: «всё в порядке» не должно
-- выглядеть как успех.
CREATE TABLE IF NOT EXISTS watchdog_health (
    id             INTEGER PRIMARY KEY CHECK (id = 1),  -- единственная строка-маркер
    last_run_at    INTEGER NOT NULL,
    scanned        INTEGER NOT NULL DEFAULT 0,
    queued         INTEGER NOT NULL DEFAULT 0,
    delivered      INTEGER NOT NULL DEFAULT 0,
    skipped_stale  INTEGER NOT NULL DEFAULT 0,
    alerts         INTEGER NOT NULL DEFAULT 0,
    oldest_age_ms  INTEGER
);
