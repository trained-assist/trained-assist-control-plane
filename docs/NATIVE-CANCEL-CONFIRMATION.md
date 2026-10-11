# Native stop confirmation

CP owns the task generation and the exact attempt identity. Intake owns the
durable per-conversation stop window and retries unresolved windows on its
alarm. `/stop` persists that intent before contacting CP. A Runner cancel
acknowledgement such as `stop_pending` only means the request was accepted; it
does not mean the process has stopped.

## Stop evidence

For a run with a receipt, the trusted, profile-scoped Runner adapter sends
cancel and reads Runner status for the same `runId`, `userTaskId`, and admitted
`ownerGeneration`. A status with `connectionLost: false` and state
`succeeded`, `failed`, or `cancelled` is enough to confirm that the process is
no longer active. The stop path does not wait for `/result`, `exitObserved`,
artifact export, publication, or workspace cleanup. Those are separate facts
and may settle independently.

When CP has no receipt, it calls Runner's task-scoped
`cancelByIdempotencyKey` with the exact persisted task, attempt key, and owner
generation. `cancelled_before_admission` proves the submit was fenced before a
run existed. If the same key was admitted, Runner returns its exact run ID and
CP checks terminal status against that identity. A missing or mismatched task,
run, or generation; connection loss; rejection; or a nonterminal status remains
pending and prevents a replacement run.

The status-only proof is recorded explicitly as
`runnerTerminalStatusObserved: true` with `exitObserved: false`; this keeps the
process stop fact distinct from a captured exit code or published result. The
CP execution row must still be terminal, the saved stop snapshot and generation
must still match, and the Workflow for that generation must be terminal before
the task can be finalized. These checks protect against a stale stop request
and against creating a second active attempt.

## Timing and recovery

The current Worker performs one immediate CP stop attempt in the `/stop` HTTP
request. If Runner still reports a pending state or a temporary failure, Intake
retains the same stop window and retries from its alarm. The request response
is not required to wait for final process termination; the bot may report that
the stop was accepted and announce confirmation when the alarm later observes
terminal status. No new generation may start before that confirmation.

Unknown state is not permission to resubmit. It remains fenced and must be
reconciled against the same Runner identity. A bounded escalation policy for a
stop that stays unresolved still needs a concrete owner, deadline, and recovery
action; an indefinitely pending stop is not an acceptable final state.

## Validation

The stop tests cover matching terminal status without `/result`, pending and
lost status, identity/generation mismatch, admission cancellation by
idempotency key, snapshot fencing, and refusal to launch a replacement while
the outcome is unresolved. Live sandbox E2E must additionally confirm the
stopped attempt and then complete a distinct fresh task.
