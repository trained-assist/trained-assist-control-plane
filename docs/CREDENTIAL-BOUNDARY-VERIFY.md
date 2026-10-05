# Read-only credential-boundary verification

Parent: trained-agent-architecture#140. Base source: `72a70df`.
This operator tool reads existing evidence; it cannot deliver readiness, create a
wait/task, route, start, replay or recover an execution. It does not read Google
credentials, contact Google, or claim Google Sheets or Telegram acceptance.

## Inputs and command

Use a dedicated operator-owned directory (`0700`) containing three regular,
owner-only files (`0600`, no symlinks):

1. An independently pinned expectation, using the schema below.
2. The existing dedicated host HTTP binding: `baseUrl`, `profileId`, `principalId`,
   `principalSignature`. Only the signed host principal is used; no root key is
   needed. Its origin must match the independently pinned expectation exactly.
3. The existing credential preparation/completion checkpoint. Do not fabricate,
   rewrite or advance its flags to make verification pass.

```json
{
  "version": "credential-boundary-verify-v2",
  "cpOrigin": "https://OWNED_CONTROL_PLANE_HOST",
  "statusMethod": "GET",
  "taskId": "ut-example",
  "profileId": "integration-v1",
  "hostPrincipalId": "integration-v1-google-host",
  "conversationRef": "credential-csv-conversation-example",
  "awaitingInputId": "example-wait",
  "provider": "google",
  "bindingRef": "example-isolated-binding",
  "providerSessionRef": "example-isolated-session",
  "eventId": "google-ready-example",
  "generation": 1,
  "waitVersion": 1,
  "runId": "run_00000000-0000-0000-0000-000000000000",
  "orchestrationEngine": "cloudflare-workflows",
  "nativeEngine": "dynamic-ip-azure-agent-run"
}
```

Replace every example identity with the existing operator-approved scope and
canonical Runner ID. `statusMethod` may be `GET` or `POST`; the latter sends only
`{taskId}` to the read-only `/status` projection. This is not a continuation POST.
The expectation schema rejects unknown keys; the origin has no path, credentials,
query or fragment. Private binding values are never arguments or printed output.

Schema v2 replaces the ambiguous v1 `engine` field; v1 inputs refuse rather than
being silently reinterpreted. Use a separately reviewed v2 expectation; do not
rewrite checkpoint evidence or relax assertions to make an old run pass.
`orchestrationEngine` identifies the CP attempt owner. `nativeEngine` expresses
the expected Runner selection, not proof of that selection.

```sh
node tools/credential-boundary-verify.mjs verify \
  /absolute/private/expectation.json \
  /absolute/private/credential-host-binding.json \
  /absolute/private/credential-csv-checkpoint.json
```

The tool makes exactly two signed reads: `GET /awaiting/{expectedId}`, followed by
the chosen `/status` read. Paths/task bodies are pinned; redirects are errors;
each response and input file is bounded to 1 MiB, with a 30-second request deadline.
Failures print only a fixed refusal report and return nonzero. There is no poll,
retry, checkpoint write, credential provisioning, or mutation endpoint.

## Verified boundary and limitations

- Checkpoint: exact task/profile/conversation/provider/binding/session/event/
  generation/wait-version scope, typed ready event, finalized delivery phase and
  confirmed initial plus identical duplicate-delivery acknowledgements.
- Durable wait: exact credential requirement and actor scope, answered typed-ready
  JSON and projection, no native checkpoint, answer timestamp and signal identity.
- Task: same task/conversation/generation, terminal `done`, answered-wait projection
  and exactly one consumed, unrejected typed credential-ready signal.
- Workflow execution: one total attempt, exact canonical Runner session and CP
  orchestration engine/generation, Workflow start after readiness and successful
  completion, with a persisted native final-answer channel.

Original CP `WorkflowPort.submit` sets `engine: "cloudflare-workflows"`
(`src/workflow-port/workflow-port.ts:263`). `TaskStore.startRun` persists that
label and Workflow `started_at`; neither field describes native launch.
`TaskStore.attachRunnerRun` updates only `session_id`
(`src/taskstore/task-store.ts:701`). Runner selection is separately supplied as
`runnerEngine` by the conversation plan.

The verifier emits `successfulWorkflowAttemptCount: 1`,
`workflowStartedAfterReadiness: true`, `nativeFinalAnswerChannelVerified: true`,
**`nativeEngineVerified: false`** and **`nativeLaunchTimeVerified: false`**.
A canonical UUID or answer-channel marker alone never proves selected engine or
native launch time. Selected-native acceptance additionally needs independently
scoped Runner status/capabilities and parent-owned configured-engine/native-job
evidence for this exact run. This tool does not obtain or validate that evidence;
changing local metadata cannot make those flags true.

`/status` at this revision does not expose task `profile_id`; actor scope is checked
using the signed dedicated host binding, checkpoint and wait `respondent_scope`.
Server-side task authorization remains essential. The two reads are not an atomic
snapshot; disagreement fails closed rather than replaying or repairing anything.

Checkpoint flags/acknowledgements are operator evidence, not a new independent
OAuth check or cryptographic proof of event causality. The verifier does not query
the completion table or assert how many workflow wake hints were sent. A pass
proves the durable boundary, one successful Workflow attempt after readiness and
the native final-answer channel. It does not prove selected native-engine identity,
native launch time, broker readiness, native-checkpoint resume, CSV correctness
or outbound delivery.

## Immutable CSV readback: separate acceptance step

Run the existing `tools/agent-csv-live-verify.mjs` separately, using its existing
private operator binding format and the **same** verified task ID:

```sh
INTEGRATION_TASK_ID=EXISTING_TASK_ID \
INTEGRATION_BINDINGS_FILE=/absolute/private/existing-csv-verifier-binding.json \
node tools/agent-csv-live-verify.mjs
```

That verifier checks the immutable GitHub commit reference, downloads published
CSV bytes, matches receipt/Task Store size and SHA256, and verifies the known
category totals. Accept the combined result only when both reports pass and their
task ID, canonical run ID and generation match. Do not combine different attempts
or use a ready-event acknowledgement as CSV readback. Neither step is Telegram
delivery or Google Sheets read/write acceptance. The authoring/tests perform no
live requests; executing these commands is a separate operator action.

## Offline tests

```sh
node --test tools/credential-boundary-verify.test.mjs
```

Tests use synthetic private files and injected HTTP fixtures, including foreign
origins/scopes, generic answers, replay mismatch, diagnostic answers, extra/unknown
attempts, oversized responses, redirect errors, and sanitized CLI failures.
