# Test MCP discovery contract for Telegram UX v1

Status (06.10.2026): the isolated Host Worker is deployed and configured. A live
Host discovery request and a separately generated Runner-resolver-signed fixture
invocation returned the expected tool/marker. The active `agent-runner-api`
service is now deployed from Runner PR #154's merged revision on the dedicated
test runtime; health is `ok`, it is idle, and the restricted
`integration-telegram-ux-v1` principal/key record plus test-only MCP resolver,
expiry and signing key are configured. The CP test Worker secrets are provisioned
and PR #67 contains the trusted profile wiring, but its deployed Worker has not
yet run an authorized task through CP discovery. Therefore no real Runner
admission, signed invocation from the active service, agent tool call, or Telegram
session has been demonstrated. The only profile in scope is
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

The model may return the registered capability ID. It cannot supply or change
the URL, server ID, profile/principal, binding reference, execution scope, tool
allowlist, catalogue or policy version, Registry digest, or credential. CP
resolves the selected ID against the current snapshot and trusted host execution
policy, then builds one descriptor with:

- `serverId` and `bindingRef` from the host binding;
- the trusted remote address from the host MCP policy;
- `allowedTools: ["registry.fixture_read"]`;
- execution `scope: "registry:fixture-read"` from the trusted binding;
- stable `catalogueVersion`, `policyVersion`, and `registryDigest` from the
  trusted Registry binding. The random `catalogueId` identifies only a CP
  snapshot and never leaves CP.

The trusted discovery binding pins `catalogueVersion` independently of the
per-request `catalogueId`. CP separately hashes canonical authorized
`tools/list` metadata as an internal `catalogueDigest`; it is not the Registry
configuration digest. The descriptor carries `catalogueVersion`
`registry-fixture-catalogue-v1`, `policyVersion` `registry-fixture-policy-v1`,
scope `registry:fixture-read`, and pinned `registryDigest`
`129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9`.
Output rechecks the original selected instruction against the current trusted
policy and discovery metadata immediately before submit, then passes that
unchanged descriptor through Workflow params and RunSpec.
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

If any pinned field changes between selection and handoff (scope, URL,
server/binding reference, allowlist, policy/catalogue version, Registry digest,
or authorized tool metadata), CP refuses submit with `MCP_REVALIDATION_REQUIRED`
and writes a user-visible `blocked` task status with the same reason. It does not
silently rebuild the instruction from a new snapshot; discovery and selection
must be repeated. Disabled Host, discovery/network, and missing-binding refusals
keep their own reason codes and are not relabeled as drift.

- **Host:** discovery transport and separate discovery/invocation
  authorization.
- **Runner:** dynamic binding resolver after a real `runId` exists.
- **CP:** pinned discovery adapter, trusted profile-policy composition, Output
  → RunSpec descriptor handoff. Runtime activation requires the exact profile
  override plus `MCP_TEST_AUTH_TOKEN` in the sandbox Worker secret store.

### Runtime ownership: do not infer a GCP VM

The Runner execution path is provided by AI Runner Agents. The test API currently
runs as `agent-runner-api` on the dedicated Contabo VM2 runtime; its deployment
and process environment are separate from GCP. GCP Secret Manager holds only the
bootstrap SSH credential used to administer that VM, not the MCP/API runtime
credentials. CP discovery happens before Runner submit and does not depend on a
Runner VM, while actual admission/invocation uses the active Runner API above.

A previous check guessed a Runner deployment from ambient local `gcloud`
context. That is not sufficient evidence about the service's deployment target.
For this test, the verified target is the running `agent-runner-api` systemd
service on Contabo VM2, reached through the recorded SSH bootstrap credential;
use the service unit, health endpoint and mode-0600 runtime files as evidence.

## Offline boundary

Tests inject catalogue and Runner fixtures and mock the pinned Host fetch. They
prove request shape, bounded discovery policy, revalidation after selection and
at Output handoff, drift result/status mapping, descriptor handoff, and no
CP-side `tools/call`; they do not prove CP-to-Host discovery through the
deployed Worker, active Runner service, or a real agent tool call. The Host test
lease and matching secret/key material are provisioned in test-only trusted
stores. This PR created no secrets; the CP test Worker was deployed separately.
Remaining acceptance is an authorized test task through the deployed CP,
admission and proof-bound Host invocation through the active Runner service, then
a real Telegram agent session if required by the user-facing acceptance.
