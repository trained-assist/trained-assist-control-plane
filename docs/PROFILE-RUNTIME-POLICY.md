# Trusted profile runtime policy

This opt-in host policy isolates ordinary Telegram text tasks from the existing
integration CSV acceptance policy. It changes no deployed binding, principal,
Runner registry, Google session or delivery-owner manifest.

`integration-v1` and historical profiles retain the complete existing global
RunSpec policy and `RUNNER_API_KEY`. The special profile
`integration-telegram-ux-v1` is unavailable until the host configures:

```json
{
  "RUN_SPEC_PROFILE_OVERRIDES": "{\"integration-telegram-ux-v1\":{\"policy\":\"generic_text_v1\",\"runnerKeyBinding\":\"RUNNER_API_KEY_TELEGRAM_UX\"}}"
}
```

Provision `RUNNER_API_KEY_TELEGRAM_UX` separately as a Worker secret. It must
be nonempty and distinct from the global Runner key. The URL remains the existing
trusted `RUNNER_API_URL`. Never place a credential in the override JSON, task
input, Workflow payload or model prompt.

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

Before enabling the gateway adapter, the parent must provision a CP principal
whose authorized profile equals `integration-telegram-ux-v1`, and a dedicated
Runner registry principal/key bound to that same profile and permitted native
engine. Runner derives the execution profile from the authenticated key, not
from the submit body; selecting a distinct key in CP cannot prove its registry
binding. Verify that binding before any model submission. CP principal/profile
authorization is unchanged.

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
