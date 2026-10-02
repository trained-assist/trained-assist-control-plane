-- 0005_awaiting_purpose_and_engine_refs.sql
-- Шаг 5 эпика #109: «Conversation и Awaiting user input» (#115 — host-owned
-- interaction tool; durable wait живёт в Task Store, не в движке).
--
-- purpose — ЗАЧЕМ спрашиваем (закрытая лексика), kind — ФОРМА ответа (A2 §5.4:
-- data/choice/approval). Второй набор терминов не заводится: purpose отображается
-- в kind таблицей в src/awaiting/purpose.ts, в базе хранятся оба поля.
--
-- engine_*_ref — маппинг engine↔platform из #115: engineSessionRef /
-- engineRequestRef / toolCallRef. Это ССЫЛКИ, они не заменяют platform IDs
-- (userTaskId / awaitingInputId / generation) и не участвуют в идентичности.

ALTER TABLE awaiting_inputs ADD COLUMN purpose TEXT
    CHECK (purpose IS NULL OR purpose IN ('preference','missing_fact','credential','approval'));

ALTER TABLE awaiting_inputs ADD COLUMN engine_session_ref TEXT;
ALTER TABLE awaiting_inputs ADD COLUMN engine_request_ref TEXT;
ALTER TABLE awaiting_inputs ADD COLUMN tool_call_ref TEXT;
