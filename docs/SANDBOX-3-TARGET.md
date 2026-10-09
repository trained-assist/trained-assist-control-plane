# Isolated CP sandbox-3 target

This target is an isolated Control Plane lane. It uses the serverless Runner
boundary defined in trained-agent-architecture; it is not connected to a
VM-hosted API.

## Resources

- CP Worker: `trained-assist-cp-sandbox3`
- CP mock Runner API Worker: `trained-assist-runner-api-cp-sandbox3`
- Existing sandbox3 Runner API Worker: `trained-assist-runner-api-sandbox3` (separate registry)
- Telegram gateway: `trained-assist-tg-sandbox3`
- Workflow: `ta-cp-sandbox3-task-workflow`
- D1: `ta-sandbox3-taskstore` (`1e1b8108-9186-43e2-8e50-436598233165`)
- CP URL: `https://trained-assist-cp-sandbox3.skillset-apply.workers.dev`
- Runner API URL: `https://trained-assist-runner-api-cp-sandbox3.skillset-apply.workers.dev`

## Runtime boundary

CP's `RUNNER_API_URL` points only to the Cloudflare Runner API Worker. CP has no
France VM, GHA gateway/workflow, or execution-worker URL or credential. Runner
API owns admission, placement and its dispatch credentials. For ordinary Agent
Runs its default execution worker is the existing worker in France. The worker
executes the process; it does not host the Runner API.

The CP test Runner Worker has a separate key registry and Durable Object namespace,
is pinned to `mock-test`, and has no France worker credentials. The existing
`trained-assist-runner-api-sandbox3` Worker remains untouched because it has a
separate Telegram MCP test principal.

The CP target remains fail-closed:
`PREVIEW_ONLY=true`, `PILOT_ENABLED=false`, and `ROUTER_AGENT_ALLOWED=false`.
Do not bind the shared Telegram UX D1 or staging/production D1 databases here.

## Deployment and preflight

Use **Deploy isolated CP sandbox-3** from protected `main` with its confirmation
input enabled. The workflow uses the protected `staging` GitHub environment,
checks the expected Cloudflare account, pins `BUILD_SHA`, and performs read-only
health and diagnostics checks. It does not apply migrations or enable execution.

`npm run sandbox:preflight:sandbox3` checks the deployed CP and Telegram
bindings, CP liveness/D1/Workflow, nonterminal and foreign-profile state, the
scoped `integration-sandbox3-v1` principal, Telegram state isolation, and the
public Runner endpoint's Cloudflare Worker identity, version and anonymous-auth
refusal. It performs only read-only Cloudflare and D1 queries. `CONFIGURED`
means bindings are present and the lane state is reusable; the report always
leaves Runner admission journal and real Telegram E2E unverified until they are
tested separately.

The `telegram-ux-sandbox-test-pass.yml` workflow exposes these sandbox3 modes:

- `sandbox3-public-preflight`: check Runner API health/version/anonymous-auth
  refusal and verify that the configured sandbox API key is accepted using a
  read-only authenticated capabilities request. It requires `RUNNER_MOCK_KEY_SEED`
  from the protected sandbox environment and does not write credentials.
- `pair-sandbox3-cp`: validate the API key against Runner API, then write only
  the mock-only API-key hash to the dedicated `trained-assist-runner-api-cp-sandbox3`
  Worker, then sync the complete expected CP credential set and a `tasks:read`
  operator principal. It supports idempotent repair when that complete set is
  already present; it refuses partial or incorrectly typed sets and preserves
  the separate Telegram intake secret. After updating the Runner API key hash,
  it waits for authenticated capabilities to accept the key before writing CP
  credentials or starting the mock probe.
- `sandbox3-cp-mock-probe`: exercise the authenticated CP adapter against the
  fixed `mock-test` Runner API contract. It creates no CP task and calls no
  model or France worker.

After each run the workflow sweeps only terminal tasks whose `request_id` uses
the reserved `sandbox3-test-` prefix in this lane's D1. Cascading task history
is removed with the task. Tasks still active or carrying non-cascading control,
credential, input-buffer, or schedule references are retained for investigation.
Normal Telegram requests and all other profiles are outside the cleanup scope.
The cleanup report is included in the sanitized workflow artifact.

VM-hosted sandbox3 Runner API installation and proxy setup modes are retired.
Do not restart a VM service to test the API boundary. Do not reset shared D1 or
Workflow state; use unique idempotency keys and reconcile accepted operations.

## Acceptance limits

Public health/version plus anonymous-auth refusal proves only the serverless API
boundary. An authenticated `mock-test` proves the CP adapter and durable Runner
admission path without model or France-worker execution. Real Agent Run
acceptance still requires Runner's France worker readiness, a disposable
sandbox profile with bounded free execution, verified result persistence, and
Telegram delivery. CP execution flags stay disabled until those gates pass.
