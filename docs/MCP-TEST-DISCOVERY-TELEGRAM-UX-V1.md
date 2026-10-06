# Test MCP discovery contract for Telegram UX v1

Status: the isolated Host Worker is deployed and configured. A live Host
discovery request and a separately generated Runner-resolver-signed fixture
invocation returned the expected tool/marker. The latter verifies Host proof
validation and the resolver's signing output; it does not prove that an active
Runner service launched an agent or that the agent called the tool. Current CP
PR wiring has not yet been deployed to the test Worker. The active Runner
service and a real Telegram agent session are still unverified. The only profile in scope is
`integration-telegram-ux-v1`; the only capability exposed to the agent is
`registry.fixture_read`.

## Discovery before Runner submit

CP discovers the host catalogue after task admission and before Runner submit.
Discovery authorization is separate from invocation authorization and is scoped
to the authenticated test principal, `integration-telegram-ux-v1`, and the
single method `tools/list`. The discovery request has no `runId`; CP does not
reserve one, fabricate one, or use a probe ID. CP's test transport is pinned to
`https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp`; its
`MCP_TEST_AUTH_TOKEN` secret is sent only on bounded, redirect-refusing
`tools/list` requests. Discovery credentials carry only the `mcp:discover` scope. If transport temporarily uses a shared Bearer, Host
must still reject invocation unless it validates the actual Runner-created
`runId` against that run's binding.

Invocation carries `X-MCP-Run-Binding`, a compact EdDSA JWS signed by the
Runner process only after API admission has created the real Run. Its claims
bind `runId`, task/profile/principal, `serverId`, `bindingRef`, exact tool
allowlist, catalogue and policy versions, registry digest, audience, and
expiry. Host verifies the Runner signature and exact match to invocation
headers and its pinned fixture policy. A valid-looking `runId` or static Bearer
without this proof is insufficient. The Runner private key and Host public JWK
are operator provisioned in their respective trusted stores; this CP change
creates neither.

The catalogue adapter may paginate `tools/list`, but it exposes only the
host-policy allowlist. For this profile that allowlist must equal
`["registry.fixture_read"]`. Names and selected metadata are accepted only from
the authenticated Host response. CP never sends `tools/call`.

## Selection and RunSpec handoff

The model may return the registered capability ID. It cannot supply a URL,
server ID, profile, binding reference, tool allowlist, credential, or policy
version. CP Output resolves the selected ID against the current discovery
snapshot and trusted host execution policy, then builds one descriptor with:

- `serverId` and `bindingRef` from the host binding;
- the trusted remote address from the host MCP policy;
- `allowedTools: ["registry.fixture_read"]`;
- stable `catalogueVersion` and `policyVersion` from the trusted discovery binding;
  the random per-request snapshot ID is internal correlation only.

The trusted discovery binding pins `catalogueVersion` independently of the
per-request `catalogueId`. CP hashes canonical authorized `tools/list` metadata
and requires it to match the binding's pinned catalogue digest. For this fixture
the version is `registry-fixture-catalogue-v1` and the digest is
`sha256-f88f1d0502220618f596906d27a671e8d086c4be0eff2da6fd77b4f160f9f07d`;
the Host's internal `registryDigest` in the Runner proof is a separate digest.
After the model selects a capability, CP re-reads `tools/list` and compares the
selected instruction with the current trusted discovery binding and execution
policy. Output repeats this check immediately before constructing the descriptor
and passing it through the existing Workflow submit parameters and RunSpec
builder. If either check detects drift, CP refuses the submit; it never silently
rebuilds the selected descriptor from the changed catalogue.
The selected capability is presented to the agent as available; instructions
say to use it only when needed for the accepted task.
Normal agent work is not required to call it. The end-to-end fixture task must
explicitly ask the agent to read the fixture so that a tool invocation is an
acceptance expectation for that task.

CP never invokes tools itself. Runner creates the real `runId` at submit,
resolves the descriptor dynamically after creation, and signs the run binding
proof from the accepted RunSpec. Invocation authorization must bind the
descriptor to that run and enforce the tool allowlist; discovery authorization
does not grant invocation.

## Drift and ownership

If the catalogue digest/version, profile binding, tool grant, or policy version
changes between discovery and selection or before handoff, CP returns
`MCP_REVALIDATION_REQUIRED` in the route result and user-facing status and does
not submit to Runner. It does not silently omit or replace the selected tool,
refresh rights, or broaden the allowlist. Other failures retain their own
provider code and existing fallback behavior; CP does not label an outage,
timeout, malformed response, or unrelated selection error as catalogue drift.

- **Host:** discovery transport and separate discovery/invocation
  authorization.
- **Runner:** dynamic binding resolver after a real `runId` exists.
- **CP:** pinned discovery adapter, trusted profile-policy composition, Output
  → RunSpec descriptor handoff. Runtime activation requires the exact profile
  override plus `MCP_TEST_AUTH_TOKEN` in the sandbox Worker secret store.

### Runtime ownership: do not infer a GCP VM

The Runner execution path is provided by AI Runner Agents. This integration has
no dedicated GCP VM dependency; configure Runner's test MCP bearer and signing
key through the trusted configuration path for the actual Runner Agents runtime.
CP discovery happens before Runner submit and does not require a Runner VM.

A previous check treated a terminated VM found under the local `gcloud`
configuration as the Runner deployment. That was an incorrect inference:
`gcloud config get-value project` reports ambient CLI context, not the service's
deployment target or owner. The VM was legacy and had no verified relationship
to AI Runner Agents. Do not start or provision it for this integration. Use the
Runner Agents deployment/configuration as the source of truth for invocation
credentials and runtime readiness.

## Offline boundary

Tests inject catalogue and Runner fixtures and mock the pinned Host fetch. They
prove request shape, bounded discovery policy, revalidation after selection and
at Output handoff, drift result/status mapping, descriptor handoff, and no
CP-side `tools/call`; they do not prove deployed CP wiring, active Runner
service, or a real agent tool call. The Host test lease and matching secret/key
material are provisioned in test-only trusted stores. This PR itself creates no
secrets and deploys nothing. Remaining acceptance is deployment of this CP
revision, invocation through the active Runner service, and a real Telegram
agent session.
