# Late Runner result reconciliation

An observation deadline is not an engine failure. After the accepted Runner run
times out, becomes unavailable, or reports connection loss, the conversation
workflow records an unknown-outcome event and sleeps durably before observing
that same run again. Backoff is 15, 30, then at most 60 seconds between observation
windows. Each window retains its existing runtime-plus-startup observation limit.

The cached `submit-runner` receipt remains authoritative. Reconciliation does not
create a task, generation, attempt, or another Runner submission. Separate named
steps and sleeps allow Cloudflare to resume after process loss without reusing a
cached timeout as the final workflow outcome. Repeated connection-loss observation
does not try to mark an already unknown attempt unknown again.

A late readable terminal result follows the existing success/failure finalization
path. Unknown events are diagnostic evidence, not proof of engine exit or result
delivery. Existing cancellation and generation fences remain in force.

This source change does not rewrite historical Runner results or restart completed
workflow instances. Operator reconciliation of an old cached-timeout instance is
separate from deploying the new behavior. Offline cached-step/D1 tests are not a
live Cloudflare recovery or Telegram acceptance claim.
