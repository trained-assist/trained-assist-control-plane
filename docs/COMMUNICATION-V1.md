# Communication selector v1

Integration: [architecture #140](https://github.com/trained-assist/trained-agent-architecture/issues/140).

Enable explicitly with `ROUTER_SELECTOR=communication_v1`. Unset keeps the existing P16/P17 fixture behavior. Ordinary text uses the shared MCP `resolve_user_intent`, with two registered quick answers (`system_health`, `catalog.brief`) and `agent`. Typed operations keep their existing path. No general LLM reply route is used for ordinary text in v1.

## Bindings and authenticated entry

- `COMMUNICATION_API_URL`: base URL of the independently deployed communication Worker.
- `COMMUNICATION_TOKEN`: scoped caller credential, supplied as a Worker secret.
- `COMMUNICATION_TIMEOUT_MS`: selector MCP deadline; default 25000 so routing falls back to the agent promptly when classification stalls.
- `COMMUNICATION_WRITER_TIMEOUT_MS`: writer MCP deadline; default 20000. This allows a short grounded reply more time than the selector while keeping the 5000 ms health probe inside a 60000 ms gateway request budget.
- `ROUTER_LLM_BUDGET`: permitted calls, default 2 in v1 (selector plus writer).
- `ROUTER_CONTINUATION_ENABLED=true`: allow Output to start the accepted agent task.
- `RUNNER_API_URL`, `RUNNER_API_KEY`: existing Runner adapter configuration. Missing configuration gives an explicit `runner_not_configured` dispatch refusal.
- `ROUTER_AGENT_ENGINE`: host-selected Runner engine, default `opencode`. Set to an engine advertised by the actual Runner, e.g. `dynamic-ip-azure-agent-run`; it is not chosen by the gateway or classifier. `continuation.executor` reports this configured engine. The legacy route decision/work-order executor field remains the terminal-agent annotation.
- `PRINCIPAL_SECRET`: existing scoped HMAC authentication. The principal must have `tasks:read` and `tasks:control` for v1 `/route` because selection/result/dispatch mutate Task Store.
- `ROUTER_GRANTS`: existing principal-keyed capability/integration grants. No permissions are accepted from message text.

After authenticated `/intake`, call `POST /route` with `{taskId, continue:true}`. Gateway does not call `/start` for this path.

Quick answer: HTTP response has `route:"deterministic"`, `capabilityId`, `reply.text`, and rendering metadata. Task Store is already `done`, with `result.answer`, quick-answer ID/version and evidence references. Completion is not channel delivery; the gateway reads the persisted result and uses its existing delivery flow.

Agent: HTTP response has `route:"agent"`, `needsExecutor:true`, and `continuation:{owner:"output",requested:true,issued:true,runId,generation,jobRef,executor:<configured engine>}`. Disabled policy, missing Runner, unresolved execution or GTD ownership yield an explicit refusal. The first attempt uses `CfWorkflowPort.submit`, not `resume`, preserving the accepted task and generation. An unknown attempt is not silently repeated.

## Facts, context and failures

Health probes the existing Runner adapter. A Runner 404 means its API is reachable. The report does not claim engine, external tools or channel delivery readiness. Capabilities describe registered catalog entries and principal grants; granted access is not proof of working credentials or implemented provider operations.

The shared writer receives prepared verified text, evidence references and a fixed communication goal. It does not reclassify or plan. Only an unchanged verified block is accepted in this first vertical; errors, stale revisions or added claims retain the deterministic factual answer. `rendering.source` and `rendering.failure` are persisted.

Context contains all preceding task inputs and results for the same conversation and profile. No turn/character truncation is performed. Oversized input, no matching option, unknown ID, malformed response and network/timeout failures select agent; the original durable input and full context remain in agent instructions. Only error codes are retained, not provider response bodies or credentials.

The selected result is persisted in the existing task journal with a unique event ID per task/generation. Concurrent selections use the same durable winner. Quick-answer commits use existing terminal/generation guards. Agent first-run identity and `run_started` are idempotent in Task Store; Workflow identity remains the accepted task ID. Workflow creation can be retried after a crash between journal/start and engine creation without selecting a new task or run.

## Validation

The optional `CommunicationV1Deps.namesOnly` contract sends only `{id}` options and omits the duplicated capability descriptions. It requires a compatible communication resolver; do not enable it against a resolver that still requires descriptions. This bounded vertical still advertises only its registered health/capabilities handlers and agent fallback: it is not discovery or dispatch of the full profile's native MCP catalogue. Native method discovery, permission-filtered bindings and selected-instruction dispatch must be proven separately before claiming that broader scenario.

```bash
npm run typecheck
npm test -- tests/communication-v1.test.ts tests/p16-route-policy.test.ts tests/p17-reply-or-route.test.ts tests/p20-catalog-brief.test.ts tests/task-store-consistency.test.ts
```

These tests validate HTTP/MCP contracts, D1 ownership and controlled failure. Real selector quality, Runner execution and channel delivery are separate integration evidence owned by the parent harness. No deployment is performed by this change.
