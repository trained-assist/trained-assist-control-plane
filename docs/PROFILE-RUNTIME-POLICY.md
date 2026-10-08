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
- `RUNNER_API_KEY_TELEGRAM_UX`: API service-principal key. It authenticates CP
  to the Agent API; it does not select a profile or executor.
- `RUNNER_PROFILE_DELEGATION_SECRET`: matches the Agent API delegation secret.
- `RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID`: principal represented by that API key.
- `RUNNER_PROFILE_DELEGATION_TENANT_ID`: sandbox tenant for the test profile.
- `RUNNER_API_ENGINE_SELECTION=agent_api`: asks the API to select from its own
  configured engine chain.

The resolved durable profile ID is signed per request with the tenant and
principal, expires after one minute, and is never accepted from caller text. The
Agent API resolves the repository from the signed profile route. Keep
`RUN_SPEC_REPOSITORY` unset in this mode. The profile override may still declare
a host-owned policy or MCP fixture; it must not select a Runner key or engine.
This path is enabled only when the complete delegation configuration exists; an
incomplete delegation fails closed. Without delegation, the historical
profile-specific policy behavior remains for compatibility.

The sandbox3 config uses tenant
`sandbox3-acceptance-a-20261008` and principal
`integration-telegram-ux-v1`. Production needs a trusted tenant mapping derived
from the authenticated account; this sandbox constant must not be reused for
production tenants.

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
Worker/D1 target and Cloudflare account without changing remote state. Deploy
with `npm run sandbox:deploy:telegram-ux`: the command copies the Keychain value
directly to the named sandbox Worker without placing it in arguments or logs,
deploys only `wrangler.telegram-ux-v1.jsonc`, then runs the authenticated
`accept_only` intake/status/events smoke. The smoke never starts Runner; it
creates a durable sandbox receipt. A deploy is not accepted if the principal
signature does not authenticate or the receipt/status/events readback fails.
This procedure does not deploy Telegram Worker secrets; the gateway's
precomputed signature must be sourced from the same principal secret and
verified independently before Telegram live acceptance.

The generic preset inherits the global repository, cwd, result policy and bounded
runtime limits, but sets declared outputs, host input references and environment
allowlist to empty arrays and disables policy-wide MCP. A separately validated,
host-built descriptor may be passed for `integration-telegram-ux-v1` after the
test-only `tools/list` discovery contract in
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
