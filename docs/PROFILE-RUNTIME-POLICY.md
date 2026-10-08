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

The regular Telegram UX deploy command does not generate or rotate credentials.
The separate workflow
[`telegram-ux-sandbox-test-pass.yml`](../.github/workflows/telegram-ux-sandbox-test-pass.yml)
is the one-click sandbox test pass: it verifies the account/config, applies
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

Before the first run, create a GitHub Actions environment named `sandbox`,
restrict deployments to protected `main`, and require an authorized reviewer.
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
