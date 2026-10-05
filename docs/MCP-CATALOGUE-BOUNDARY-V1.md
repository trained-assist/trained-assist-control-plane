# Host-authorized MCP catalogue boundary

Architecture #140. This is an isolated, dependency-injected source adapter, not an enabled route or a credential issuer. It does not call tools, start models, write Task Store, or claim that listed tools are ready.

## Existing wire protocol

The renamed registry is served by `trained-assist-agent` at source `befc4146da68364b0d3d286c5de13c94f3695598`, `src/handlers/mcp-http.js`: one authenticated JSON-RPC message per `POST /mcp`; `tools/list` returns `{tools:[{name,description?,inputSchema}]}`. Execution uses `tools/call` with `{name,arguments}`. There is no generic instruction retrieval method; description and input schema are the available selected-method metadata. The adapter also accepts standard `nextCursor` pagination; the existing agent response is a single page.

The native Runner source `97956c5bca4a9d6c87d71b826354ab05ab48811d`, `src/api/server.ts`, exposes capabilities and run APIs, not a public pre-run catalogue endpoint. Its scoped per-run MCP bridge is not a CP HTTP discovery contract. No Agent internals are imported here.

## Smallest composition

1. After intake/auth, CP derives `{taskId,generation,profileId,principalId}` from the accepted task and authenticated principal, never from model output.
2. A trusted host injects `resolveBindings(scope)`. Every returned binding must match all four scope fields and carry `serverId`, opaque `bindingRef`, host `policyVersion`, the complete granted `allowedTools`, and a credential-owning request function. `policyVersion` must change when either grants or the authoritative registry/instruction revision changes; the existing unversioned HTTP registry cannot attest this by itself. No credentials, host URLs, token minting, or alternate profile selection enter adapter types or selector input. The host transport must enforce redirect rejection, time/body bounds, authenticated peer identity and the profile binding. Resolver and transport implementations remain owner gates.
3. `discover` reads every configured server/page and intersects registered names with host grants. It returns only names as `{id:name}` selector options and an opaque local catalogue ID. Aggregate duplicates fail, rather than selecting a server implicitly or renaming actual methods. The complete list must fit the explicit resolver budget: 256 names / 24000 name characters. Oversize input fails without trimming. Discovery has a 15-second total deadline; metadata has per-item and aggregate bounds.
4. Keep the same adapter/snapshot through selection. `selectedInstruction` refuses unknown names, cross-task/generation/profile/principal reuse, and changed host policies/grants. It returns the original selected description/schema plus server/binding identity, never generated prose and never readiness claims. Snapshots are transient; restart means rediscovery, not replaying a tool. CP must persist its selection and the immutable metadata/policy witness using its existing Task Store ownership before dispatch.
5. Existing Output/Runner owns execution of the same accepted task/generation. Pass selected metadata and original task context as work instructions, and the corresponding host-authorized RunSpec MCP binding. The Runner forms/validates required arguments under the selected schema and calls the actual method through its scoped MCP channel. This adapter does not substitute a direct CP generic `tools/call` path. For mutations, persist an operation identity before contact; lost ACK is unknown and requires owner reconciliation, never an automatic repeated tool call.

## Exact owner decisions still needed

- Which independently authorized host service supplies this catalogue, and which fixed CP-principal/profile-to-native-profile mapping and complete method grants does it attest? Existing `/mcp/token` allows its host credential to mint any profile; CP must not receive that credential.
- Is the selected method's existing description/schema the approved instruction contract, or must the domain owner publish a separately versioned instruction document? No such generic API currently exists.
- Should selection hand off to the existing Runner as above, or to an existing durable deterministic execution port? The latter must first expose argument validation, scope recheck, stable operation identity and effect receipt/unknown-outcome semantics. This adapter does not invent that controller.

Until those decisions and host composition are verified, the full catalogue route must remain disabled. Registry presence is not provider authorization, credential verification, engine readiness or successful execution.

## Offline validation

`npm run typecheck` and `npm test -- tests/mcp-catalogue-boundary.test.ts`. Fixtures test complete 66/256-name aggregates, pagination, authoritative selected metadata, scope/policy fencing, unknown names, duplicates, overflow and sanitized failures. All injected RPCs are `tools/list`; no model/provider/runtime contact occurs.

Validation on the source-only branch: 27 boundary tests, 55 combined boundary/communication tests, and full `npm run check` with 459 tests plus typecheck/evidence sanitization passed. No deployed readiness or execution acceptance is inferred.
