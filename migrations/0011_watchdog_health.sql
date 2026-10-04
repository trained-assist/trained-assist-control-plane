-- 0011_watchdog_health.sql
-- Работоспособность планировщика watchdog (arch#132 П3c).
--
-- Детектор без планировщика — мёртвый код. Но и планировщик может умереть молча:
-- достаточно, чтобы кто-то сломал триггер. Поэтому каждый УСПЕШНЫЙ проход
-- планировщика оставляет отметку, а независимая проверка читает её и алертит при
-- устаревании. Сбой прохода отметку НЕ обновляет: «всё в порядке» не должно
-- выглядеть как успех.
--
-- Отдельным файлом, а не дописыванием к 0009: применённые миграции повторно не
-- выполняются, поэтому правка уже применённого файла молча не создала бы таблицу
-- ни на одной существующей базе.

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
