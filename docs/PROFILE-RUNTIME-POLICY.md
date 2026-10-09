# Trusted profile runtime policy

This opt-in host policy separates profile identity from Agent API execution. A
durable task profile identifies the tenant workspace; the Control Plane
authenticates as its service principal and signs a short-lived tenant/profile
capability. The Agent API validates that capability and selects an allowed
engine from its own `AGENT_API_ENGINE_CHAIN`. CP omits `engine` from the submit
body when `RUNNER_API_ENGINE_SELECTION=agent_api`; no profile chooses a VM, GHA,
or other executor.

Enable delegated routing in a sandbox Worker with these bindings:

- `RUNNER_API_URL`: trusted Agent API endpoint.
- `RUNNER_API_KEY_AGENT_API`: API service-principal key. It authenticates CP
  to the Agent API; it does not select a profile or executor.
- `RUNNER_PROFILE_DELEGATION_SECRET`: matches the Agent API delegation secret.
- `RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID`: principal represented by that API key.
- `RUNNER_PROFILE_DELEGATION_TENANT_ID`: sandbox tenant for the test profile.
- `RUNNER_API_ENGINE_SELECTION=agent_api`: asks the API to select from its own
  configured engine chain.

For the sandbox profile `integration-telegram-ux-v1`, the trusted profile
override may instead select `RUNNER_API_URL_TELEGRAM_UX`. The value is pinned to
the approved VM2 sandbox API base
`https://169-58-15-230.sslip.io/runner-mcp-test`; only that profile uses it.
Other profiles keep `RUNNER_API_URL`. The read-only profile-health probe uses
the same resolved URL and logs only the hostname, never the path or query.

## Ownership and routing order

In `agent_api` mode, engine ownership belongs to the Agent API. Do not set
`ROUTER_AGENT_ENGINE`, send an `engine` in the submit body, select an engine
from a locally cached capabilities response, or pin a repository in the CP
RunSpec. CP authenticates to the configured Agent API and supplies the signed
tenant/profile identity; the API validates the identity and selects an engine
per its live engine chain and principal policy. The API's selection is the
source of truth. If the API cannot select or admit a run, report a dispatch
failure with the API's error class; do not describe it as an LLM/provider
failure.

Text routing has two model boundaries. First,
`communication:resolve_user_intent` chooses a registered capability/quick
answer or the `agent` route. On `agent`, CP dispatches through the Agent API;
only after successful admission does the task agent's model start and choose
from its permitted MCP tools. A null `capabilityId` with `route=agent` means
the resolver selected agent fallback, not an MCP tool call. In the persisted
`routing.selected` event, `modelId`, `modelCalls`, `providerCode`,
`capabilityId`, `route` and `degraded` describe the resolver. They do not prove
that the task-agent model ran. Runner/API dispatch events and the execution's
`session_id`/`model` establish that later boundary; `runner_submit_rejected`
with no execution session means no task-agent model or tool call occurred.

The resolved durable profile ID is signed per request with the tenant and
principal, expires after one minute, and is never accepted from caller text. The
Agent API resolves the repository from the signed profile route. Keep
`RUN_SPEC_REPOSITORY` unset in this mode. The profile override may still declare
a host-owned policy or MCP fixture; it must not select a Runner key or engine.
This path is enabled only when the complete delegation configuration exists; an
incomplete delegation fails closed. Setting `RUNNER_API_ENGINE_SELECTION` to
`agent_api` without the dedicated API key, delegation secret, principal, tenant,
and endpoint also fails closed. Without Agent API selection or any partial
delegation identity (principal or tenant), the historical profile-specific
policy behavior remains for compatibility. A delegation secret by itself is
inert and does not select Agent API mode; this avoids an orphaned secret
disabling an explicitly configured profile API route.

The isolated CP sandbox-3 config declares tenant
`sandbox3-acceptance-a-20261008` and API principal
`sandbox3-agent-api-principal`. Its current deployment intentionally has no
Agent API URL or credentials and keeps intake/execution disabled. Provision the
scoped API key and delegation secret only through the sandbox environment once
the bounded allowance gate is ready. These sandbox values must not be reused
for production tenants.

The isolated test principal may use the optional Worker secret
`PRINCIPAL_SECRET_TELEGRAM_UX`. It overrides `PRINCIPAL_SECRET` only for
`integration-telegram-ux-v1`; all other principals keep the shared verifier
secret. Store the matching test-client copy in the local macOS Keychain under
service `trained-assist-cp-test-principal-hmac-v1` and account
`integration-telegram-ux-v1`. Do not copy it into this repository or use the
unrelated GCP `CP23_PRINCIPAL_SECRET` value.

Keep the Keychain item as the sole operator source for this principal. Do not
rotate the Cloudflare secret independently. Before deployment, run
`npm run sandbox:preflight:telegram-ux`; this validates the exact sandbox
Worker/D1 target and Cloudflare account, checks Worker liveness, and uses the
authenticated lane readiness endpoint when the deployed revision has it. On an
older revision, it reports that readiness is not deployed yet; the endpoint is
checked after the first code deployment. Deploy
with `npm run sandbox:deploy:telegram-ux`: the command copies the Keychain value
directly to the named sandbox Worker without placing it in arguments or logs,
deploys only `wrangler.telegram-ux-v1.jsonc`, then runs the authenticated
readiness check followed by the explicit `accept_only` intake/status/events
smoke. The readiness check is read-only and blocks when the profile has any
nonterminal task. The later smoke never starts Runner, but it does create a
durable sandbox receipt. A deploy is not accepted if the principal signature
does not authenticate, readiness is unavailable, or receipt/status/events
readback fails.

The regular Telegram UX deploy command does not generate or rotate credentials.
The separate workflow
[`telegram-ux-sandbox-test-pass.yml`](../.github/workflows/telegram-ux-sandbox-test-pass.yml)
is the one-click sandbox test pass when dispatched with `mode=bootstrap`: it verifies the account/config, applies
only the named sandbox D1 migrations, deploys the current `main` revision to
the exact CP sandbox Worker, then bootstraps the isolated `mock-test` identity
and requires the authenticated CP probe to return `succeeded / pong`. It
derives a stable Runner API key from the protected `RUNNER_MOCK_KEY_SEED`, sends
only its SHA-256 hash over SSH to the root-owned Runner provisioner, and writes
the key directly to `RUNNER_API_KEY_TELEGRAM_UX_MOCK_TEST`. The normal Telegram
UX key, URL, and collector are not changed. The fixed mock probe is idempotent
and creates one Runner admission record, but no CP task or Workflow. A shared
Telegram lane readiness check is intentionally not a gate for this isolated
principal; it does not participate in this test pass.

Before the first run, create a GitHub Actions environment named `sandbox` and
restrict deployments to protected `main`.
Set these four protected environment secrets once; do not put their values in
the repository or workflow inputs. Generate the Runner seed directly into the
secret store with
`openssl rand -base64 48 | gh secret set --env sandbox RUNNER_MOCK_KEY_SEED`.

| Environment secret | Purpose |
| --- | --- |
| `CF_API_TOKEN` | Cloudflare token for the trained-assist test account with Workers Scripts and D1 permissions needed by the pinned sandbox config |
| `CP_TELEGRAM_UX_PRINCIPAL_SECRET` | Existing test principal credential used only to authenticate the CP probe; must already match `PRINCIPAL_SECRET_TELEGRAM_UX` on the sandbox Worker |
| `RUNNER_MOCK_KEY_SEED` | At least 32 bytes; derives the stable dedicated mock API key |
| `VM2_SSH_PRIVATE_KEY` | SSH identity allowed to run only the installed root provisioner via `sudo -n` |

Cloudflare account ID, VM2 SSH host/user, and the verified VM2 SSH host key are
pinned in the deployment module. Host key checking is strict; there are no
workflow variables to maintain.

The workflow verifies the exact sandbox Wrangler config, authenticated
Cloudflare account, and Worker liveness before it changes sandbox state. It
applies migrations and deploys only the pinned sandbox config, verifies the
deployed build SHA, registers the key hash at Runner, updates only the dedicated
mock-key binding, and requires `succeeded / pong` from CP. It never reads back
secret values.
The `sandbox-bootstrap-evidence.json` artifact contains resource and secret
names, revisions, boundary outcomes, and the synthetic Runner run ID only. It
contains neither the derived key nor the CP principal secret. Changing the key
seed derives a new key; the Runner provisioner intentionally retains old hashes
until an operator explicitly removes them, so seed replacement alone is not a
revocation procedure.

The existing CP principal ID remains fixed; its HMAC secret is a separate,
replaceable credential. This workflow reads that credential from the protected
environment to authenticate the probe and does not change the principal ID or
secret. If the secret is reset, keep the protected environment and CP sandbox
Worker copies in sync. Do not clear shared D1, Workflow, or collector state to
make readiness pass. The workflow is dispatch-only from `main`, targets
Cloudflare sandbox and `agent-runner-api-mcp-test.service`, and is not a
production promotion path.
This procedure does not deploy Telegram Worker secrets; the gateway's
precomputed signature must be sourced from the same principal secret and
verified independently before Telegram live acceptance.

### Read-only bootstrap preflight

The same workflow offers `mode=preflight` (implementation: [CP #158](https://github.com/trained-assist/trained-assist-control-plane/issues/158)). It validates the pinned account
and config, reads CP liveness and its deployed SHA, queries only
`SELECT name FROM d1_migrations`, checks the pinned SSH hostname, and performs
signed GETs for lane occupancy and profile-scoped Runner reachability. It does
not apply migrations, deploy, provision/rotate secrets, submit a mock run, or
restart Runner. `RUNNER_MOCK_KEY_SEED` is not required for this mode.

An occupied lane fails with `sandbox_lane_has_nonterminal_task`; the independent
profile-health read still runs. The artifact records counts and boundary results,
not task payloads or CLI output. `preflight_passed` establishes these access/read
checks only; it does not prove state isolation, write permissions, Worker/model
execution, Telegram delivery, or full lane READY.

```sh
gh workflow run telegram-ux-sandbox-test-pass.yml \
  --repo trained-assist/trained-assist-control-plane --ref main -f mode=preflight
```

The workflow defaults to `mode=inventory`, which adds the Runner-owned
[read-only helper](https://github.com/trained-assist/ai-agent-runner/pull/213).
Its exact source revision and SHA-256 digest are pinned in the deployment
contract; downloaded bytes are verified before sending them over pinned SSH.
The helper reads only the declared test EnvironmentFile, admission journal and
current manifest. The artifact contains an allowlisted metadata projection:
installed source SHA, binding-presence booleans, approved engine names and
admission/unknown counts. Raw script exceptions, credentials and run data are
excluded. Any unresolved Runner admission blocks this mode, even when CP has
zero nonterminal tasks. It never restarts or edits the old test service.

```sh
gh workflow run telegram-ux-sandbox-test-pass.yml \
  --repo trained-assist/trained-assist-control-plane --ref main -f mode=inventory
```

The helper's `journalTerminalOnly` flag is a journal snapshot, not a held admission
fence or proof of Worker process exit. Fresh-lane readiness remains the scope of
[CP #159](https://github.com/trained-assist/trained-assist-control-plane/issues/159)
and [architecture #236](https://github.com/trained-assist/trained-agent-architecture/issues/236).

Use `mode=bootstrap` explicitly for the existing paired-key deployment/mock flow,
only when that shared target's state is safe for the requested operation.

### Fresh sandbox3 namespace through the same operator channel

The existing workflow has explicit modes for the previously declared
sandbox3 service; it creates no Cloudflare resources and leaves shared MCP
API/state untouched:

- `sandbox3-operator-preflight`: byte-verified read-only namespace/proxy metadata, including allowlisted systemd failure result and bounded exit status.
- `sandbox3-proxy-preflight`: inspect nginx marker booleans without emitting its
  configuration. It also counts server blocks containing the exact host, TLS port and legacy upstream together. Global markers do not prove routing or TLS readiness; an ambiguous count does not authorize editing.
- `sandbox3-mock-probe`: verify installed source/process, then test loopback auth
  refusal, terminal mock pong, result, idempotent receipt and events. The scoped
  API key travels only over stdin; an unknown result prevents replay. This
  component check does not establish Telegram or real worker execution.
- `configure-sandbox3-proxy`: explicit fixed route configuration via byte-verified
  helper. Requires exact runtime and one qualified TLS server, preserves legacy
  bytes in a private root-only backup, validates nginx before reload and restores
  on failure while preserving concurrent edits. Runner is not restarted. External
  TLS/health/anonymous auth refusal is checked separately after configuration.
- `sandbox3-public-preflight`: repeat read-only exact process/source and public
  TLS/health/auth-refusal checks, without reapplying an exclusive route edit.
- `prepare-sandbox3`: verify the existing signed candidate, then invoke the
  existing Runner lane bootstrap's fixed contract stage over pinned SSH. Refuse
  any existing component or aliased path. Derive scoped credentials from the
  existing seed, send only the key hash and delegation secret over stdin, create
  the distinct nonlogin user/private new config/registry/empty journal/unit.
  No service starts and CP credentials are not changed.
- `install-sandbox3`: reverify candidate/provenance, transfer only public verified
  artifact/operator files to a private temporary directory, install through the
  existing lane installer with its explicit pinned MCP-runtime compatibility
  contract, then verify active PID argv/cwd and manifest source SHA. Cleanup
  removes only this operation's transport directory.

Dispatch from protected main with `-f mode=<mode>`. Install requires the already
prepared inactive target; it never stops an active API. Any unresolved admission
blocks restart/rollback. Namespace preparation is exclusive and does not replace
or recover a previously occupied target.

This initial registry permits mock-test only. There is no default engine chain,
provider credential, profile workspace or real execution; no paid traffic can
start. The artifact records CP credentials/public route/real execution as
unverified. Provision and prove TLS/proxy, pair CP credentials, independently
probe API/CP mock, then enforce bounded free-only worker/profile storage before
real Telegram acceptance. These modes alone do not establish full readiness.

### Existing signed candidate access preflight

`mode=candidate-preflight` reuses this workflow's operator environment and
verifies access to the existing signed Runner candidate before installation.
It checks the successful build run, exact artifact name, pinned archive SHA-256,
GitHub provenance signer and manifest source/target/version. It downloads to a
private temporary directory and removes it afterwards; no archive is extracted
to a service directory and no install, restart or admission occurs. The artifact
records source/hash/provenance and `installed=false` only. GitHub access errors
are sanitized into an owning boundary instead of exposing command output.

```bash
gh workflow run telegram-ux-sandbox-test-pass.yml \
  --repo trained-assist/trained-assist-control-plane --ref main -f mode=candidate-preflight
```

This independent boundary does not require the old Runner journal to be terminal
and does not make that service restart-safe. The candidate's archive target is
MCP test; installing its runtime in a fresh service requires a reviewed explicit
operator-target contract.

### Explicit sandbox file permission repair

The existing workflow also accepts `mode=repair-permissions` for the two
fixed MCP test service files. It downloads the reviewed Runner helper at a
pinned source revision and verifies its SHA-256 before sending bytes over the
pinned SSH connection. The helper verifies the fixed service account and validates both file owners (root
or sandbox before changing its environment mode; sandbox for its journal), canonical paths,
regular-file identity and the sandbox environment before restricting unsafe
modes to `0600`. It preserves file bytes and owners and performs no service
restart, admission, journal replay or cancellation. An already-private operator-owned
environment is preserved without mutation. Failed inventory can report lstat-only
file access/owner categories, without content, owner IDs or arbitrary paths. Default inventory stays
read-only. A successful repair is followed by the same read-only inventory;
unresolved admissions still block reuse independently of the permission repair.

```bash
gh workflow run telegram-ux-sandbox-test-pass.yml \
  --repo trained-assist/trained-assist-control-plane --ref main -f mode=repair-permissions
```

The artifact records only fixed component statuses and the reviewed operator
revision. A file owner or target mismatch fails closed and needs investigation.
This operation does not prove a fresh Runner lane or full Telegram readiness.

### Run and inspect the CP → Runner sandbox E2E

This workflow is the quickest end-to-end check of CP-to-Runner API auth and the
Runner `mock-test` contract. It is separate from the Telegram webhook E2E below.
Dispatch it from protected `main`:

```sh
gh workflow run telegram-ux-sandbox-test-pass.yml \
  --repo trained-assist/trained-assist-control-plane --ref main -f mode=bootstrap
gh run list --repo trained-assist/trained-assist-control-plane \
  --workflow telegram-ux-sandbox-test-pass.yml --limit 5
gh run watch RUN_ID --repo trained-assist/trained-assist-control-plane --exit-status
gh run download RUN_ID --repo trained-assist/trained-assist-control-plane \
  --name telegram-ux-sandbox-test-pass-RUN_ID
```

Before dispatch, the GitHub `sandbox` environment must have the four secrets
listed above. `CF_API_TOKEN` must authenticate to account
`d740a05e9442c1d0feacae2dfc673e93` and have D1 migration and Worker deployment
permissions. `wrangler whoami` proves the account only; Cloudflare error `7403`
at `sandboxMigrations` means the token lacks D1 access. Check secret **names**
in GitHub; never print values while diagnosing credentials.

Accept a run only when its `sandbox-bootstrap-evidence.json` artifact has
`outcome: "passed"`, all `boundaries` are `PASS`, and the probe reports
`runnerState: "succeeded"`, `answer: "pong"`,
`runnerOutcome: "succeeded"`, and `runnerAdmissionPersisted: true`. Also verify
`cpTaskCreated: false` and `workerOrModelCalled: false`. The artifact is
sanitized: it includes resource names, source SHA and the synthetic Runner run
ID, never the derived Runner key or CP principal secret. Link the run and SHA
from the acceptance issue/PR.

Cloudflare may briefly serve the previous Worker version after deploy. If the
only failed boundary is `sandboxPostDeployLiveness` with
`sandbox_worker_build_sha_mismatch`, read the sandbox `/healthz` until
`buildSha` matches the run's source SHA, then rerun the workflow. Its named D1
migrations and deploy are idempotent. If a failure occurs at or after
`runnerPrincipalProvisioning`, inspect the original run and artifact first:
Runner may already have persisted the synthetic admission.

This E2E proves the CP → Runner `mock-test` API path only. It does not post a
Telegram update, create a CP task/Workflow, call a real Worker/model/MCP tool,
or prove Telegram delivery. For the separate real Telegram ingress flow, use
the bot repository's [integration E2E runbook](https://github.com/trained-assist/trained-assist-tg-bot/blob/main/docs/INTEGRATION-V1-SMOKE.md)
and its delivery-owner acceptance gate.

The legacy generic preset inherits the global repository, cwd, result policy and
bounded runtime limits, but sets declared outputs, host input references and
environment allowlist to empty arrays and disables policy-wide MCP. In Agent API
delegation mode, the host always removes the global repository, outputs, input
references, and MCP; only `LLM_LADDER_TOKEN` may remain in the environment
allowlist. A separately validated, host-built descriptor may be passed for
`integration-telegram-ux-v1` after the test-only `tools/list` discovery contract in
[`MCP-TEST-DISCOVERY-TELEGRAM-UX-V1.md`](MCP-TEST-DISCOVERY-TELEGRAM-UX-V1.md).
The model cannot author that descriptor. An empty output manifest means no
mandatory CSV: it does not authorize missing declared outputs in other profiles.
Caller-supplied text cannot select a preset or change output requirements.
Accepted attachment references are not silently removed; native input references
remain unsupported and must not be presented as materialized files.

The Workflow loads the durable task before selecting policy and credentials;
the payload's profile cannot override the stored profile. Task-scoped route
readiness and artifact access use the same resolver. The global `/runner/health`
probe retains its original deployment-wide credential. Unknown override profiles,
fields or presets, malformed mappings and incomplete generic bindings fail
closed. Historical profiles are unchanged when no override mapping exists.

For an authenticated, read-only diagnostic of the sandbox profile adapter, call
`GET /internal/runner/profile-health` with the normal signed principal headers.
The principal must own `integration-telegram-ux-v1` and have `tasks:read`. The
route resolves the scoped Runner key from the durable principal profile, probes
only `GET /v1/runs/health-probe-<random-id>/status`, returns a sanitized reachability result,
and caches it for 10 seconds. It does not create a task, Workflow, or model call.
This verifies CP-to-Runner API reachability/authentication only; a 404 for the
synthetic probe run is expected and does not prove engine readiness or execution.

## Provisioning gate

Before enabling delegated routing, provision one Runner API service principal
with the required run scopes and a sandbox tenant route. The API key authenticates
the Control Plane; the signed short-lived capability supplies the trusted tenant
and profile. Configure the Agent API engine chain and principal engine permissions
at the API boundary. Verify the key, delegation secret, tenant route and allowed
engine inventory before a sandbox task. A profile identifier does not select an
engine or API endpoint.

Gateway collector snapshots, conversation/index identity, discovery, client
authentication and delivery-owner scope must consistently select the new trusted
profile. A chat-profile label alone cannot change the fixed client's credentials.
Existing CSV profile and delivery manifest remain unchanged. This policy does
not add native cancellation, supplementation or legacy project/session APIs.

## Offline validation

```sh
npm run typecheck
npx vitest run tests/profile-runtime.test.ts tests/own-api-run-spec.test.ts tests/communication-v1.test.ts tests/own-api-one-shot.test.ts
```

Fixtures verify dedicated-key selection, invalid mapping rejection, preserved
principal/profile equality, unchanged CSV requirements, durable-profile selection
despite a spoofed Workflow payload, generic native success with zero artifacts,
CSV `ARTIFACTS_MISSING` preservation and terminal replay without another submit.
They do not prove deployed registry bindings, native model execution or Telegram
delivery.
