# Credential readiness boundary v1

Implementation issue: [#44](https://github.com/trained-assist/trained-assist-control-plane/issues/44),
parent [architecture #140](https://github.com/trained-assist/trained-agent-architecture/issues/140).

This boundary supports a host-registered credential wait **before external Runner
execution**. It does not implement OAuth, a broker, Google credential provisioning,
provider validation, native Runner interaction awaiting, or checkpoint resume.
Those capabilities remain unverified. The endpoint stays closed when
`CREDENTIAL_HOST_PRINCIPALS` is absent.

## Registration

A trusted adapter uses the existing principal signature and admission scopes.
Its exact principal ID must also appear in the comma-separated
`CREDENTIAL_HOST_PRINCIPALS` binding. Keep this identity separate from user and
Telegram gateway principals. The host is responsible for authenticating the
provider handoff and verifying actual provider acceptance before reporting ready.
An ordinary user assertion, token storage or a preflight is not readiness evidence.

`POST /awaiting` requires `tasks:control` for the task profile:

```json
{
  "taskId": "ut-example",
  "purpose": "credential",
  "credential": {
    "provider": "registered-provider",
    "bindingRef": "binding-example",
    "providerSessionRef": "form-example"
  },
  "question": "Connect the required provider"
}
```

The host principal is derived from authenticated headers, not the JSON body.
The existing wait stores the requirement in `schema_json.credential`. Its response
includes `awaitingInputId`, `generation`, `version`, and deadline. All refs are
opaque identifiers, not credential values, authorization URLs or tokens.
`POST /start` adopts an existing open wait before submitting work to Runner.

## Verified host completion

The same registered host uses `tasks:signal` for
`POST /awaiting/:awaitingInputId/credential-ready`:

```json
{
  "status": "ready",
  "eventId": "provider-event-example",
  "userTaskId": "ut-example",
  "profileId": "profile-example",
  "provider": "registered-provider",
  "bindingRef": "binding-example",
  "providerSessionRef": "form-example",
  "generation": 1,
  "version": 1
}
```

This is a trusted host attestation, **not** validation of a provider by CP. Only
the authenticated host may submit it. The provider/session/binding/profile and
wait generation/version must match registration exactly. Expired, cancelled,
superseded and post-Runner waits are rejected. Neither generic `/signal` nor
`/awaiting/:id/answer` may resolve a credential wait.

Migration `0013_credential_ready.sql` extends the existing wait with a deduplicated
verified-event inbox and continuation intent. SQLite triggers commit the event,
signal, wait answer, task transition and continuation intent in one transaction.
Replay of the same host/event returns the receipt; reuse with different refs is a
conflict. Secrets never enter this payload, Task Store or the task journal.

## Continuation and limits

`CfWorkflowPort` owns continuation. A live workflow is woken after durable commit;
its wait reads the persisted answer. If no execution has ever started, the same
port may submit the existing task using the answered wait. A failed wake retains
the pending intent; `/recover` and scheduled recovery retry it. Duplicate wake
hints do not create another task or generation.

Initial submission requires the port constructor's third argument to supply
trusted `runnerEngine`, `runnerTimeoutSec` and `runnerPollSec`. The deployment's
existing runtime-policy/env factory must pass these settings to both HTTP and
recovery ports. Without them, readiness is durable but initial work stays pending;
it must not silently select the legacy `opencode` engine or default budgets.
This patch intentionally does not introduce another runtime-policy owner.

Credential readiness proceeds to outstanding Runner work rather than completing
the demo `no_engine` branch. Missing Runner configuration leaves the task
nonterminal. An existing Runner session, unknown/interrupted attempt or checkpoint
is rejected: this patch has no safe capability to resume that execution. A dead
workflow with an existing attempt retains its intent for recovery; it is not
automatically recreated. The host must not claim successful connection or resumed
agent work from a queued/woken intent alone.

Validation: `tests/credential-ready.test.ts` uses real D1 migrations and synthetic
host refs, with workflow wake and Runner submit fixtures. It proves local guards,
durability, dedup and continuation routing, not a live provider/Runner connection.

Migration compatibility: the guard uses a trigger `WHEN` predicate and a single
`SELECT RAISE`, avoiding nested `CASE ... END` in the trigger body. The remote
D1 migration initially failed with `incomplete input`; local parsers did not
reproduce that failure. `node tools/credential-migration-selfcheck.mjs` checks
Wrangler statement boundaries and SQLite installation. Wrangler 4.146.0 local
migration application also passes. Remote D1 acceptance still needs the deployment
owner's verification; these local checks do not prove the server parser fix.
