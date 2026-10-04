-- 0008_start_deadline.sql
-- Верхняя граница ожидания для «принято, но не начато» (arch#132, R1/R2/R3;
-- репро — инцидент tg-bot 2026-10-04, PR #345).
--
-- stage IN ('collecting','preparing','queued','handing_off') — задача принята и
-- ждёт запуска. До этой миграции у такого входа НЕ было ни верхней границы
-- ожидания, ни внешнего детектора: единственные «часы» накопителя — аларм того
-- же Durable Object, в котором он жив. Сломанный/не взведённый аларм = тишина в
-- чате навсегда (пользователь видел только «Принял голосое», ответа не было 7
-- минут; агент при этом был здоров).
--
-- start_deadline_at — КОЛОНКА, не JSON: watchdog должен опрашивать её индексом
-- извне (cron/Workflow), считая возраст самого старого принятого, но не начатого
-- входа. Тот же приём, что у awaiting_inputs.deadline_at + idx_awaiting_due.
--
-- NULL у всех остальных stage (в том числе у терминальных): дедлайн старта там
-- неприменим. startRun() сбрасывает его в NULL в той же транзакции, которой
-- задача переходит в 'running'.

ALTER TABLE durable_tasks ADD COLUMN start_deadline_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_tasks_start_deadline ON durable_tasks(start_deadline_at)
    WHERE stage IN ('collecting','preparing','queued','handing_off');