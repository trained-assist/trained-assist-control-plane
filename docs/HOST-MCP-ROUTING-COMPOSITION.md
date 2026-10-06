# Inactive host MCP routing composition

This source-only composition builds on PR57's unchanged metadata adapter. The production Worker does not inject host MCP dependencies. No environment flag, request field or model output can provision a resolver or enable this path. The injected `hostMcp.enabled` gate is exercised only by offline tests; no deployed configuration is changed.

## Routing contract

The authenticated accepted task supplies task ID, generation, profile and principal. A trusted host injects catalogue discovery and an execution-policy reader for that exact scope. Missing scope, discovery failure, stale registry, unknown names and absent execution grants never produce selected MCP instructions. Existing authorized agent fallback retains the original aggregate and durable degraded notice.

The selector sees only the complete granted actual method-name list as `{id:name}`. It sees no catalogue descriptions, schemas or synthetic routing options. `no_matching_option` retains the existing authorized agent fallback. A registered method actually named `agent` remains an ordinary registered method, never an implicit escape from snapshot validation. The original task and conversation context remain intact.

Only the selected method's description/schema from the same catalogue snapshot enters agent instructions. The selection carries opaque server/binding references, scope and host policy revision, with readiness explicitly `not_verified`. Before dispatch, Output rechecks the current scope, revision and existing Runner MCP server grant. Cached selections without injected host authorization are held; no new task, generation, direct CP tool call or credential issuer is introduced.

The existing accepted-task Output and Workflow/Runner paths retain execution ownership. Mocked integration tests persist selection before dispatch, prove one same-task native attempt, and show the selected instruction and an already-authorized RunSpec MCP binding reaching the real Runner HTTP adapter. These tests do not establish real tool execution or live authorization.

## Provisioning still required

The approved discovery transport must enforce authentication, bounded reads, deadlines and redirect refusal. It must attest the profile binding, complete grants and registry/instruction revision. The current registry lacks independent revision attestation. The CP must never receive a root credential capable of minting arbitrary profiles, guess a host endpoint or infer grants from user/model text.

Runtime wiring also needs an approved host execution-policy provider shared consistently with TaskWorkflow's existing profile runtime resolution. The generic text profile currently has MCP disabled; this patch does not broaden it. Both routing-time and pre-dispatch validation must use that provider, and the existing Runner must resolve and enforce the scoped binding. `allowedTools` metadata alone is not enforcement. No provider credentials, activation or readiness evidence are added here.

`tools/list` retrieves metadata internally because that is the existing registry protocol. Descriptions are withheld from classification and only the selected metadata is projected after selection; no separate instruction-fetch API is invented.

## Offline validation

Run `npm run typecheck`, `npm test -- tests/host-mcp-composition.test.ts tests/mcp-catalogue-boundary.test.ts tests/communication-v1.test.ts`, then `npm run check`. All discovery and Runner requests in the new composition tests are injected fixtures, not provider calls.

Validation on the isolated composition branch: 74 focused tests, 561 full tests across 46 files, typecheck, evidence sanitization and Wrangler dry bundle passed. The 18 new composition tests distinguish source-only mocked handoff from deployed execution. No runtime gate was enabled, and no deployment or live MCP request was made.
