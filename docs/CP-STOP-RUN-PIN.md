# Immutable CP stop execution pins

Conversation stop snapshots retain receipt identity, the task generation at capture, and the complete sorted attempt set. Each attempt pins its CP attempt ID, canonical Runner ID (or unknown null), owner generation, and host-derived submission idempotency key. Retry uses the stored snapshot, never current activeRun discovery. Historical snapshots missing these fields remain unresolved and are not upgraded from current state.

The CP-owned pinned cancellation path atomically claims one fenced task generation with a durable snapshot/task correlation. Retries reuse that claim. SQL guards check the current snapshot, receipt, profile, task generation, exact attempt membership, Runner IDs and submission-key witnesses before claim, attempt finalization, proof publication and terminal mutation. Generation, run, key or membership drift stays unresolved. Runner cancellation always uses the captured canonical run and its captured owner generation; an overlapping new attempt is never substituted. A failure or race does not write a new task result or artifact, nor claim a fresh attempt exited.

Pinned stop does not call Workflow terminate by mutable task ID. Native exit evidence alone does not confirm a still-running Workflow: terminal Workflow observation is also required. Task generation fencing may prevent the old Workflow from committing, but is not evidence that it terminated. Existing unpinned explicit cancellation remains unchanged. STOP must remain OFF; these are source/offline tests, not live cancellation proof.

## Remaining wire and ownership requirements

- A generation-specific immutable Workflow instance/control handle is needed before automatic Workflow termination can be enabled safely. The current `Workflow.get(taskId).terminate()` cannot express that fence; this patch never uses it in the pinned path.
- Before the first snapshot exists, CP still discovers open conversation tasks when the admission barrier closes. A trusted intent-time task/receipt inventory or cutoff contract is needed to prove those memberships belonged to the original Telegram stop intent. A persisted snapshot never expands on retry.
- TG STOPfalse must gate mutations and pending stop alarms. This CP patch does not revoke old principals, change profile scopes, or isolate shared D1 from another authorized Worker. Direct legacy `/cancel` is outside the immutable conversation-window path.

Offline tests cover cold window retry, single generation claim, old snapshots, generation/attempt/run/key/profile drift, insertion between guard read and claim, insertion before native dispatch, a new native run during old cancellation, terminal SQL race, false exit provenance, and preserving later task identity and output ownership. No deployment, live control, owner credentials, or historical task rewrite is part of the change.

Local validation on the composed `e573345` baseline: typecheck PASS; 91 focused tests PASS; 524 full tests across 44 files PASS; evidence sanitization checks PASS. Workerd emitted Workflow lifecycle diagnostics during cancellation tests; the suites exited successfully. Fourteen new execution-pin regressions are synthetic/offline and do not establish live STOP readiness.
