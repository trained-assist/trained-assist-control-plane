# Private credential boundary preparation

This is controlled CSV work plus a real provider-attestation subboundary, **not**
a completed Google Sheet scenario. Owner target is still missing. SA OAuth token
200 and Drive `about` 200 prove only the connection checked by the parent verifier;
they do not prove artifact access, Sheet ownership, MCP mounting or agent work.

## Parent-owned prerequisites

- Migration 0013 and credential wake composition deployed and validated.
- Enabled principal `integration-v1-google-host`, profile `integration-v1`, scopes
  `tasks:control`, `tasks:signal`, `tasks:read`; explicitly included in the worker's
  `CREDENTIAL_HOST_PRINCIPALS` allowlist. Parent provisions these, never this tool.
- Existing intake-user principal has intake admission plus `tasks:signal` and
  `tasks:read`. Both private bindings point to the same CP origin/profile.
- Host-configured `ROUTER_AGENT_ENGINE=dynamic-ip-azure-agent-run` and validated
  RunSpec runtime policy. Neither binding nor request selects engine/budgets.
- Private host signature supplied later as `host-client-binding.json`; no SA key,
  OAuth token, signing secret or provider-verification JSON enters this harness.

## Prepare only

Each private binding has exactly the operator-facing fields:
`baseUrl`, `profileId`, `principalId`, `principalSignature`. Parent adapts existing
client bindings locally; do not paste signatures into terminals or commit files.
Private input JSON has `goal`, `csvRef`, `bindingRef`, `providerSessionRef`.
Use the actual existing CSV reference; this harness never reads artifact bytes.
Opaque binding/session refs must correspond to the actual isolated provider
verification context, not a credential value. Goal must not claim a Sheet target.

```sh
node tools/credential-boundary-prepare.mjs prepare \
  /private/user-client-binding.json /private/host-client-binding.json \
  /private/csv-boundary-input.json /private/new-boundary-state.json
node --test tools/credential-boundary-prepare.test.mjs
```

Run preparation only when parent authorizes the live HTTP writes. A fresh UUID
creates a fresh conversation and request. `/intake` returns a durable receipt;
retry must return the same task. Host registers `/awaiting` with purpose
`credential`, exact profile/provider/binding/session refs, no checkpoint/run.
The tool requires generation 1 and zero executions, then probes ordinary
`/awaiting/:id/answer` (409) and `/signal` (delivered false). The wait must remain
open, unanswered, and signals/history unchanged. No `/route`, `/start`, readiness
callback, model, provider or artifact call is possible through its transport.

The exclusive-created output is mode 0600, checkpointed after intake and wait
registration. If preparation fails, parent inspects that private state; do not
blindly rerun with a new nonce. Partial state is not verification or success.

## Separate manual parent readiness action

First rerun the **real** isolated-provider verifier. A prior evidence file,
preflight, ordinary user text or user-supplied JSON is not authorization to
attest readiness. Only after that independent check may the trusted host send:

`POST /awaiting/<awaitingInputId>/credential-ready`, with signed host headers
`x-principal` / `x-principal-sig`, and JSON fields:

```json
{
  "status": "ready",
  "eventId": "<state.eventId>",
  "userTaskId": "<state.taskId>",
  "profileId": "integration-v1",
  "provider": "google",
  "bindingRef": "<state.bindingRef>",
  "providerSessionRef": "<state.providerSessionRef>",
  "generation": 1,
  "version": "<state.waitVersion: integer>"
}
```

This example is a contract template, not proof and not a runnable sender. Host
identity is derived from authentication, not a body field. Do not set preflight
flags/headers. The preparation command deliberately has no ready mode.

Parent verifies callback delivery and durable answered wait, the same accepted
task/conversation/generation, one execution, configured native engine and budgets,
and actual Runner progress. Replay the **identical** host/event payload manually:
receipt must report duplicate, with no extra execution/session or generation.
Finally require real CSV result/artifact evidence; readiness alone is not work
completion. Missing execution, provider handoff or Google tool host capability is
an explicit failed subboundary, not a fabricated Google Sheet success.
