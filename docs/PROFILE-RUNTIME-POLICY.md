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
delegation field, the historical profile-specific policy behavior remains for
compatibility.

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

The deploy command does not generate or rotate credentials. Runner API key
pairing is a separate operation owned by Runner and CP; do not rotate either
copy independently. A future bootstrap command must preflight the current
authenticated lane before changing either secret, update both owners from one
in-memory generated key, then verify auth and emit only sanitized evidence.
Until that paired path is implemented and the shared profile has been safely
reconciled, use the existing Keychain-backed deploy flow and never clear the
shared D1, Workflow, or collector state to make readiness pass.
This procedure does not deploy Telegram Worker secrets; the gateway's
precomputed signature must be sourced from the same principal secret and
verified independently before Telegram live acceptance.

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
