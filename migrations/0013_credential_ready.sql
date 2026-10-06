CREATE TABLE credential_completions (
    host_principal_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    awaiting_input_id TEXT NOT NULL UNIQUE REFERENCES awaiting_inputs(awaiting_input_id),
    user_task_id TEXT NOT NULL REFERENCES durable_tasks(id),
    profile_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    binding_ref TEXT NOT NULL,
    provider_session_ref TEXT NOT NULL,
    generation INTEGER NOT NULL,
    wait_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    continuation_status TEXT NOT NULL DEFAULT 'pending' CHECK (continuation_status IN ('pending', 'woken', 'stale')),
    dispatched_at INTEGER,
    PRIMARY KEY (host_principal_id, event_id)
);

CREATE INDEX credential_continuations_pending ON credential_completions(continuation_status, created_at);

CREATE TRIGGER credential_ready_guard BEFORE INSERT ON credential_completions
WHEN NOT EXISTS (SELECT 1 FROM credential_completions WHERE host_principal_id = NEW.host_principal_id AND event_id = NEW.event_id)
    AND NOT EXISTS (
        SELECT 1 FROM awaiting_inputs awaiting JOIN durable_tasks task ON task.id = awaiting.user_task_id
        WHERE awaiting.awaiting_input_id = NEW.awaiting_input_id AND awaiting.user_task_id = NEW.user_task_id
          AND awaiting.purpose = 'credential' AND awaiting.status = 'open' AND awaiting.deadline_at > NEW.created_at
          AND awaiting.generation = NEW.generation AND awaiting.version = NEW.wait_version
          AND task.generation = NEW.generation AND task.profile_id = NEW.profile_id
          AND awaiting.respondent_scope = NEW.profile_id AND task.status = 'awaiting_input'
          AND task.awaiting_input_id = awaiting.awaiting_input_id AND awaiting.checkpoint_ref IS NULL
          AND json_extract(awaiting.schema_json, '$.credential.hostPrincipalId') = NEW.host_principal_id
          AND json_extract(awaiting.schema_json, '$.credential.provider') = NEW.provider
          AND json_extract(awaiting.schema_json, '$.credential.bindingRef') = NEW.binding_ref
          AND json_extract(awaiting.schema_json, '$.credential.providerSessionRef') = NEW.provider_session_ref
          AND NOT EXISTS (SELECT 1 FROM executions execution WHERE execution.task_id = task.id AND (execution.session_id IS NOT NULL OR execution.status IN ('unknown', 'interrupted')))
    )
BEGIN
    SELECT RAISE(ABORT, 'credential_wait_mismatch');
END;

CREATE TRIGGER credential_ready_apply AFTER INSERT ON credential_completions
BEGIN
    INSERT INTO task_signals(user_task_id, step_key, idempotency_key, event_type, payload_json, source, generation, created_at, consumed_at, consumed_by_execution)
    VALUES(NEW.user_task_id, NEW.awaiting_input_id, 'credential-ready:' || NEW.host_principal_id || ':' || NEW.event_id,
      'credential_ready', json_object('status', 'ready', 'bindingRef', NEW.binding_ref, 'provider', NEW.provider),
      'system', NEW.generation, NEW.created_at, NEW.created_at, NEW.awaiting_input_id);

    UPDATE awaiting_inputs SET status = 'answered', answered_at = NEW.created_at,
      answer_signal_id = last_insert_rowid(),
      answer_json = json_object('status', 'ready', 'bindingRef', NEW.binding_ref, 'provider', NEW.provider,
        'eventId', NEW.event_id, 'generation', NEW.generation, 'version', NEW.wait_version)
    WHERE awaiting_input_id = NEW.awaiting_input_id;

    INSERT INTO task_events(user_task_id, kind, status_before, status_after, generation, source, payload_json, created_at)
    VALUES(NEW.user_task_id, 'awaiting_answered', 'awaiting_input', 'active', NEW.generation, 'input',
      json_object('awaitingInputId', NEW.awaiting_input_id, 'bindingRef', NEW.binding_ref, 'provider', NEW.provider,
        'eventId', NEW.event_id, 'verified', 1), NEW.created_at);

    INSERT INTO task_events(user_task_id, kind, generation, source, payload_json, created_at)
    VALUES(NEW.user_task_id, 'continuation.created', NEW.generation, 'input',
      json_object('awaitingInputId', NEW.awaiting_input_id, 'eventId', NEW.event_id, 'reason', 'credential_ready'), NEW.created_at);

    UPDATE durable_tasks SET status = 'active', stage = 'running', awaiting_input_id = NULL,
      updated_at = NEW.created_at, revision = revision + 1 WHERE id = NEW.user_task_id;
END;
