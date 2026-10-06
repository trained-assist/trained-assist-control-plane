# Test MCP discovery contract for Telegram UX v1

Status: offline source contract, not a provisioned or live integration. The only
profile in scope is `integration-telegram-ux-v1`; the only capability exposed to
the agent is `registry.fixture_read`.

## Discovery before Runner submit

CP discovers the host catalogue after task admission and before Runner submit.
Discovery authorization is separate from invocation authorization and is scoped
to the authenticated test principal, `integration-telegram-ux-v1`, and the
single method `tools/list`. The discovery request has no `runId`; CP does not
reserve one, fabricate one, or use a probe ID. Discovery credentials carry only
the `mcp:discover` scope. If transport temporarily uses a shared Bearer, Host
must still reject invocation unless it validates the actual Runner-created
`runId` against that run's binding.

Invocation carries `X-MCP-Run-Binding`, a compact EdDSA JWS signed by the
Runner process only after API admission has created the real Run. Its claims
bind `runId`, task/profile/principal, `serverId`, `bindingRef`, exact tool
allowlist, catalogue and policy versions, registry digest, audience, and
expiry. Host verifies the Runner signature and exact match to invocation
headers and its pinned fixture policy. A valid-looking `runId` or static Bearer
without this proof is insufficient. The Runner private key and Host public JWK
are operator provisioned in the later trusted-store stage; this CP session
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
Output re-reads and revalidates the selected catalogue before passing the
descriptor through the existing Workflow submit parameters and RunSpec builder.
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

If the catalogue, profile binding, tool grant, or policy version changes between
discovery and handoff, CP returns an explicit revalidation-required blocked
route. It does not silently omit or replace the selected tool, refresh rights,
or broaden the allowlist.

- **Host:** discovery transport and separate discovery/invocation
  authorization.
- **Runner:** dynamic binding resolver after a real `runId` exists.
- **CP:** discovery adapter, trusted-policy composition, Output → RunSpec
  descriptor handoff.

## Offline boundary

Tests inject catalogue and Runner fixtures. They prove request shape, policy
checks, descriptor handoff, and no CP-side `tools/call`; they do not prove Host
stores, deployed credentials, Runner dynamic resolution, or live tool execution.
This CP session creates no secrets and deploys nothing. Trusted-store setup and
the live fixture read require the separately agreed Host/Runner stage.
