# Test MCP discovery contract for Telegram UX v1

Status (06.10.2026): the full test CP → Runner → native worker/GitHub Actions →
MCP Host path has passed with the only exposed tool `registry.fixture_read`.
The successful CP task was `ut-245e42e584834264a5dc`; Runner run
`run_c8fee149-b277-4ea4-925f-e4f859e7415b` completed successfully in GitHub
Actions [run #37454650132](https://github.com/vovalikessmoothy-png/opencode-gha-runner/actions/runs/37454650132).
The returned answer was `registry-fixture-marker-160-v1`, the fixture handler's
marker. CP test Worker version: `18f0cdab-638c-488a-b123-2480c21d317c`.

The CP discovery and Runner invocation use the isolated Host Worker through the
test-only `REGISTRY_MCP_HOST_SERVICE` binding. The Runner invocation proof is
created after admission with the actual Runner `runId`; Host accepted the
`tools/call` and returned the marker. No Telegram update, chat, or user was
involved. A temporary authenticated service-level probe was removed after the
run, together with its secret.

Two live Runner fail-closed submissions also passed. Unknown binding ref was
rejected as `MCP_BINDING_MISSING` (`run_5a750243-4bc7-4d36-bb12-78c97dd68346`);
catalogue-version drift was rejected as `MCP_BINDING_SCOPE_MISMATCH`
(`run_b3fc69d5-1a4d-4746-8c39-7b17286afbe3`). Both ended at preflight before
the native worker launch, and neither created a GitHub Actions run. CP's own
selection/dispatch drift mapping to `MCP_REVALIDATION_REQUIRED` remains covered
by its focused offline tests rather than a live mutation of trusted policy.

The test Runner is an isolated `agent-runner-api-mcp-test` sidecar on VM2,
running the merged Runner PR #154 revision `82d930ec90b5fec62888c8babe0d9a347533d566`.
The ordinary `agent-runner-api` unit was restored and is not used by this
test. The CP test Worker was updated from the merged PR #67 source plus the
test-only service binding; production Workers and configuration were not
changed.

## Discovery before Runner submit

CP discovers the host catalogue after task admission and before Runner submit.
Discovery authorization is separate from invocation authorization and is scoped
to the authenticated test principal, `integration-telegram-ux-v1`, and the
single method `tools/list`. The discovery request has no `runId`; CP does not
reserve one, fabricate one, or use a probe ID. CP constructs the request for
the pinned `https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp`
endpoint and sends it through the test-only `REGISTRY_MCP_HOST_SERVICE` service
binding. Its `MCP_TEST_AUTH_TOKEN` secret is sent only on bounded,
redirect-refusing `tools/list` requests. Discovery credentials carry only the
`mcp:discover` scope. The shared Bearer does not authorize invocation; Host must
still validate the actual Runner-created `runId` against that run's binding.

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

### Validation and remaining boundary

The CP MCP-focused suite passed 88/88 tests. Full `npm run check` passed:
typecheck, 681 tests in 51 files, and evidence sanitization. Miniflare printed
worker cancellation/timeout diagnostics from workflow tests, but the suite
completed with exit code 0 and no failed tests. The successful live invocation
proves the test Host call through the deployed path; it does not claim a
user-facing Telegram conversation or production readiness.

The live unknown-binding and version-drift checks submitted descriptors directly
to the isolated Runner API, so they validate Runner's own admission/preflight
gate. CP's non-submission status `MCP_REVALIDATION_REQUIRED` is covered offline;
a live CP policy-mutation test was intentionally not done because it would
require changing trusted test policy during the run. The temporary probe and
negative-test API key have been removed. Test CP/Runner/Host services remain
isolated for the next review step.

### Additional France-side run and current boundary (2026-10-06)

After the CP test-principal HMAC override was deployed, task
`ut-efdd84dc60d0fa9a999c` completed through the isolated
`agent-runner-api-mcp-test` service on France VM2. Runner run
`run_683d964a-3e4f-4885-a58a-a0541dfd8c05` reached `succeeded`; CP returned
the fixture marker. This service still dispatched through its configured
`dynamic-ip-azure-agent-run` external worker. It proves France-hosted Runner API
→ external worker, not a local OpenCode process on France. The task answer alone
is not an independent Host invocation audit, so treat the fixture call for this
run as unverified at the Host boundary. The earlier GHA run above remains the
run with recorded Host acceptance. A preceding attempt failed closed with
`MCP_ENDPOINT_NOT_ALLOWED` before worker launch when the Runner endpoint had not
yet been aligned to the pinned custom Host domain.

France's local OpenCode CLI has separately passed bounded `ladder/free` stream
smokes with `step_start`, `text`, and `step_finish` events. That is direct CLI
evidence only: [Runner #136](https://github.com/trained-assist/ai-agent-runner/issues/136)
tracks binding a France OpenCode worker into the CP/API admission path. Russia's
known `ru-edge` remains a thin edge without a persistent OpenCode/Runner worker;
the required API-boundary and concurrent-stream acceptance checks are still open.
The 60% CPU/RAM cutoff is also not active on a deployed VM worker: the repository
contains a VM capacity-admission primitive, but its own README says it is not
wired to an HTTP worker adapter or durable reservation store yet. Do not treat
the GHA fallback threshold as enforced until that integration is deployed and
tested.

### Test credential custody and deployment boundary

Store only names and locations here; secret values, signatures, private keys,
and API keys must never be committed or pasted into run evidence.

| Credential/configuration | Runtime location | Notes |
| --- | --- | --- |
| CP principal HMAC for `integration-telegram-ux-v1` | Cloudflare secret `PRINCIPAL_SECRET_TELEGRAM_UX` on the isolated CP test Worker; operator recovery copy in macOS Keychain service `trained-assist-cp-test-principal-hmac-v1`, account `integration-telegram-ux-v1` | The test-specific secret takes precedence only for this principal. Shared `PRINCIPAL_SECRET` remains unchanged. |
| CP → Runner API credential | Cloudflare secret `RUNNER_API_KEY_TELEGRAM_UX` on the isolated CP test Worker; verifier is the Runner test key registry | Never store the raw API key in docs or source. |
| CP → Host discovery Bearer | Cloudflare secret `MCP_TEST_AUTH_TOKEN` on the isolated CP test Worker | Discovery-only; does not authorize `tools/call`. |
| Host discovery Bearer and invocation policy | `MCP_TEST_AUTH_TOKEN` is a Cloudflare Worker secret on `trained-assist-mcp-host-test-160`. `MCP_TEST_PRINCIPAL_ID`, `MCP_TEST_EXPIRES_AT`, and `MCP_TEST_RUNNER_PUBLIC_JWK` are live Host Worker settings. | Expiry and public JWK are not fully represented in checked-in Worker configuration yet; reconcile them into reviewed deployment config without placing the Bearer or Runner private key there. |
| Runner invocation-signing private key and Registry test token | Mode-0600 env file `/etc/agent-runner/agent-runner-api-mcp-test.env` on France VM2, consumed by the isolated `agent-runner-api-mcp-test.service` | Host receives only the public JWK. The test Registry token is separately scoped and expiring. This service currently dispatches to the external Azure worker; it is not the local-France OpenCode binding. |
| Model Ladder bearer | Canonical current value: GCP Secret Manager `alesa-personal-assistent/LLM_LADDER_TOKEN`; Cloudflare secret `LADDER_TOKEN` on `trained-assist-llm-ladder`; the isolated France test Runner receives it as `OPENCODE_LADDER_TOKEN` and `AGENT_API_ENV.LLM_LADDER_TOKEN` | 2026-10-06 rotation added a temporary Cloudflare `LADDER_TOKEN_PREVIOUS` overlap so existing clients continue to work while they migrate. The previous value remains accepted; remove it only after consumer inventory and migration. Never expose either value. |

Ladder code deploys through its GitHub Actions workflow. Its first post-merge
revision check saw a stale response after deploy; the rerun completed green,
including the public revision check. The
isolated CP/Runner test service and VM env are configured manually. Host expiry
and public-JWK settings also lack a complete checked-in deployment source. A
repository-driven release for the France/Russia worker chain is therefore not
yet established.
