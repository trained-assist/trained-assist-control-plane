# Test-gated host MCP routing composition

This integration is available only to `integration-telegram-ux-v1`, principal `integration-telegram-ux-v1`, and the single `registry.fixture_read` tool. CP source wiring is behind the trusted profile override `hostMcpBinding: registry-mcp-test-160-read` and secret `MCP_TEST_AUTH_TOKEN`; no request field or model output can enable it. The isolated Host test Worker is deployed and provisioned. CP retains `scope` and `registryDigest` for its own revalidation but projects only Runner-accepted fields into RunSpec; Runner selects the test repository from the authenticated profile binding. Live verification is in progress. The discovery, descriptor and ownership contract is [MCP-TEST-DISCOVERY-TELEGRAM-UX-V1.md](MCP-TEST-DISCOVERY-TELEGRAM-UX-V1.md).

## Routing contract

The authenticated accepted task supplies task ID, generation, profile and principal. A trusted host injects catalogue discovery and an execution-policy reader for that exact scope. Missing scope, discovery failure, stale registry, unknown names and absent execution grants never produce selected MCP instructions. Existing authorized agent fallback retains the original aggregate and durable degraded notice.

The selector sees only the complete granted actual method-name list as `{id:name}`. It sees no catalogue descriptions, schemas or synthetic routing options. `no_matching_option` retains the existing authorized agent fallback. A registered method actually named `agent` remains an ordinary registered method, never an implicit escape from snapshot validation. The original task and conversation context remain intact. Once a method is selected, CP re-reads and compares the selected instruction to the live catalogue and trusted execution policy; it repeats this check immediately before descriptor construction and submit. Drift blocks submit and is reported as `MCP_REVALIDATION_REQUIRED`; transport and selection errors keep their own provider code.

For `integration-telegram-ux-v1`, Host discovery authorization is profile/principal scoped, permits only `tools/list`, and has no `runId`; the exact allowlist is `registry.fixture_read`. The trusted discovery binding pins a stable catalogue version and SHA-256 digest of canonical authorized tool metadata. Output re-reads `tools/list`, compares the current digest and binding policy with the selected snapshot, then builds a single-tool descriptor from the trusted host MCP policy and passes it through Workflow params to RunSpec. Drift yields an explicit blocked revalidation result. The capability is available to the agent and is not an instruction to call it for every task. Cached selections without injected host authorization are held; no new task, generation, direct CP tool call or credential issuer is introduced.

The existing accepted-task Output and Workflow/Runner paths retain execution ownership. Mocked integration tests persist selection before dispatch, prove one same-task native attempt, and show the selected instruction and an already-authorized RunSpec MCP binding reaching the real Runner HTTP adapter. These tests do not establish real tool execution or live authorization.

## Test runtime boundary

The discovery transport is pinned to the test Worker's exact HTTPS URL, sends only `tools/list`, bounds the body, rejects redirects, and scopes the request to the accepted task/profile/principal/generation. Its test Bearer cannot provision arbitrary profiles or grants. Shared Bearer transport does not authorize invocation; Host additionally checks the actual Runner-created run binding. The Worker has returned live discovery and a separate resolver-signed fixture invocation; neither proves an agent started in the active Runner service.

The trusted profile runtime supplies the same fixed one-tool descriptor to routing-time validation and Workflow RunSpec construction. Without the exact override and test Bearer, MCP remains disabled or configuration fails closed. The existing Runner must resolve and enforce the scoped binding; `allowedTools` metadata alone is not enforcement. No secrets or activation are included in this source change.

`tools/list` retrieves metadata internally because that is the existing registry protocol. Descriptions are withheld from classification and only the selected metadata is projected after selection; no separate instruction-fetch API is invented.

## Offline validation

Run `npm run typecheck`, `npm test -- tests/registry-test-mcp.test.ts tests/profile-runtime.test.ts tests/host-mcp-composition.test.ts tests/mcp-catalogue-boundary.test.ts tests/communication-v1.test.ts`, then `npm run check`. The discovery transport test uses a mocked fetch; it is not live readiness evidence.

Validation before this runtime wiring: 74 focused tests, 561 full tests across 46 files, typecheck, evidence sanitization and Wrangler dry bundle passed. Those counts predate the selection and Output revalidation follow-up. Live end-to-end readiness still requires an authorized task through the deployed CP Worker and invocation through the active Runner service.
