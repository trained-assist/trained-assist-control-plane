# Two-phase Google Sheet operator

Parent: [architecture #140](https://github.com/trained-assist/trained-agent-architecture/issues/140).
This operator submits the category phase only. It performs no Google requests,
credential-ready events, registration, deployment, recovery or model calls itself.
Only the parent operator may run the live commands after owner authorization.

## Prepare contract: acceptance without execution

Use an operator-owned private directory (`0700`), with JSON files/checkpoint
`0600`. Binding/source/approval/checkpoint reads reject symlinks, foreign owners,
group/world permissions and files over 1 MiB. Never use root credentials.
The binding format is the existing CSV operator format: `CONTROL_PLANE_URL`,
`CONTROL_PLANE_PROFILE` (`integration-v1`), `CONTROL_PLANE_PRINCIPAL`, and
`CONTROL_PLANE_PRINCIPAL_SIGNATURE` (64 lowercase hex characters).
The principal needs `tasks:intake`, `tasks:read` and, for explicit start,
`tasks:control`. Only its signature is sent to CP; none goes into the model goal.

Provide approved source metadata, not credentials, in `source.json`:

```json
{
  "schemaVersion": "google-sheet-source-v1",
  "spreadsheetId": "1KTYuKw-hzM5bJCHbhnm-TG63oApHX_KhuuGT2CeWaxg",
  "sourceSheetId": 1056899445,
  "sourceSheetName": "OWNER_CONFIRMED_ACTUAL_TAB_TITLE",
  "sourceRange": "A1:D1000"
}
```

The exact source title must be confirmed by the parent, not inferred from gid.
The pinned schema is `date,category,amount,merchant`. Deduplication compares all
four cells exactly, retaining the first row. Finite numeric amounts are summed
by exact category, sorted ascending. Unknown headers or incomplete reads must
stop, not invent a mapping. No fixture rows or expected numeric results are sent
to the model. Parent must provision/approve compatible isolated source data
before start; a shared empty Sheet alone does not prove that contract.

```sh
INTEGRATION_BINDINGS_FILE="$PRIVATE_RUNTIME/client-bindings.json" \
INTEGRATION_SOURCE_FILE="$PRIVATE_RUNTIME/source.json" \
INTEGRATION_REQUEST_ID=YOUR_EXPLICIT_STABLE_CASE_ID \
INTEGRATION_REPORT_FILE="$PRIVATE_RUNTIME/google-category-checkpoint.json" \
node tools/agent-google-sheet-live-run.mjs prepare
```

Only `POST /intake` and `GET /status?taskId=...` are sent. Intake uses the actual
`contractVersion:1`, explicit `profileId`, stable `requestId`, `conversationRef`
and `sessionId`, and text-only `inputItems`. It has no `artifactRefs`, snapshot,
execution policy, MCP or secret fields. The checkpoint is exclusively created
before intake and stores the accepted task before subsequent checks. The printed
`taskId`, `requestId`, `conversationRef` and `phase:prepared` are the preparation
contract for parent registration. Prepared status requires active/queued,
generation 1, same conversation and no durable attempts. The current CP returns
`engine:{error:...}` for a missing Workflow; this is not a fake `no_engine`
status or independent proof of native runtime health.

Repeating prepare without `INTEGRATION_RESUME=true` refuses an existing checkpoint.
An explicitly resumed intake repeats only the identical request/envelope;
an already prepared checkpoint reads status only. Never replace the case ID
after an ambiguous intake outcome.

## Parent-owned activation and explicit start

The actual route API accepts `{taskId,continue:true}`; it has no client MCP
configuration channel. Configure existing CP host `RUN_SPEC_MCP` and
`RUN_SPEC_OUTPUTS` through the parent-owned deployment/configuration path, and
enable the current native engine and continuation policy. Configure the existing
Runner binding resolver so it authorizes this accepted task/profile and registers
the **canonical Runner `run_<UUID>` after normalization, before model dispatch**.
The CP Workflow attempt ID and locally derived RunSpec ID are not canonical
Runner IDs. No fabricated run ID or model-supplied registration is permitted.
Parent must verify real provider authentication separately, and the documents
host owner target must pin this exact spreadsheet, source title/gid and permitted
result write. Keep the SA, encryption key, transport bearer and runtime paths
on their owning private hosts, not in this input or approval file.

After these checks, create private `host-approval.json` for the accepted tuple:

```json
{
  "schemaVersion": "google-sheet-host-approval-v1",
  "approved": true,
  "taskId": "ACCEPTED_TASK_ID",
  "profileId": "integration-v1",
  "conversationId": "THE_SAME_STABLE_CASE_ID",
  "generation": 1,
  "hostEnv": {
    "RUN_SPEC_POLICY_PROFILE": "integration-v1",
    "RUN_SPEC_INPUT_REFS": "[]",
    "ROUTER_AGENT_ENGINE": "dynamic-ip-azure-agent-run",
    "RUN_SPEC_OUTPUTS": "[{\"path\":\"outputs/google-category-summary.json\",\"mime\":\"application/json\"}]",
    "RUN_SPEC_MCP": "{\"servers\":[{\"serverId\":\"google-documents\",\"transport\":\"remote\",\"url\":\"https://APPROVED_HOST/mcp\",\"bindingRef\":\"REGISTERED_OPAQUE_BINDING_REF\",\"allowedTools\":[\"gdrive_read_sheet\",\"gdrive_write_sheet\"],\"toolTimeoutMs\":30000}]}"
  }
}
```

These are existing CP **environment** fields, not a route payload or a new
controller. The approval is a local parent assertion of actual applied policy,
not a remote proof of deployed configuration or provider success. It contains
metadata only; literal tokens/header secrets and arbitrary policy fields are
refused. The checkpoint stores only its digest. The configured Runner must
resolve `bindingRef` through its existing trusted registration contract; the CLI
does not mint/read transport tokens or register anything.

```sh
INTEGRATION_BINDINGS_FILE="$PRIVATE_RUNTIME/client-bindings.json" \
INTEGRATION_SOURCE_FILE="$PRIVATE_RUNTIME/source.json" \
INTEGRATION_REQUEST_ID=THE_SAME_STABLE_CASE_ID \
INTEGRATION_REPORT_FILE="$PRIVATE_RUNTIME/google-category-checkpoint.json" \
INTEGRATION_HOST_APPROVAL_FILE="$PRIVATE_RUNTIME/host-approval.json" \
node tools/agent-google-sheet-live-run.mjs start
```

Start loads the prepared checkpoint, verifies the same source/envelope/scope,
checks pre-dispatch status, validates the separate approval, durably checkpoints
phase `route`, then sends exactly one `POST /route {taskId,continue:true}`. It
requires a nonempty decision/run ID and an issued native generation-1
continuation. It never calls `/start`, `/resume`, `/recover` or `/replay`.

The model must use a deterministic new result title `Category results <12 hex>`
derived from the stable request ID and operation ID `google-categories:<requestId>`.
Every result write supplies `operationId`, `source_sheet_name`, and
`clear_first:false`; source/other tabs are never modified. Unknown/conflicting
provider outcomes must stop for reconciliation without another title/operation.
It reads back source and result and emits the mandatory
`outputs/google-category-summary.json` with identities, computed counts/totals,
and readback flags. Declaring this output in actual CP host policy makes omitted
artifacts a Runner failure; a prompt alone does not enforce that requirement.

## Ambiguous outcomes and limits

An exclusive sibling `.lock` serializes checkpoint access. Never remove a stale
lock without owner reconciliation. Checkpoint writes use fsync and atomic rename.
Fresh duplicate intake preserves the discovered task but refuses continuation.
Route phase is checkpointed before dispatch: **any route ACK loss, malformed
response or crash stops automatic dispatch forever for that checkpoint**.
Subsequent invocations read existing status only and report a fixed reconciliation
failure, even with empty runs/unknown engine. Parent must inspect existing routing,
Workflow and Runner evidence, not rerun with a new ID. An already dispatched
checkpoint performs status-only checks against its one matching attempt.

Transport rejects redirects, credentials/query/fragment in URLs, bodies over
4 MiB, invalid/nonobject JSON and requests over 60 seconds. Reports never include
raw CP/provider errors, signature, MCP URL/binding or answer text.
`dispatched_not_verified` is not Google computation, mutation, artifact,
Telegram delivery or full architecture acceptance. Independent parent readback
must prove exact output, unchanged source, Google operation receipt, immutable
artifact bytes/hash and one canonical admission/launch. This tool does not verify
those facts. Monthly continuation is deliberately absent: later work must reuse
the accepted conversation and spreadsheet context, with a separately approved
new operation ID/title; this script must not create a replacement monthly case.

## Offline regression checks

```sh
node --experimental-transform-types --import ./tools/ts-ext-resolver.mjs \
  --test tools/agent-google-sheet-live-run.test.mjs
```

Tests use synthetic private metadata and mocked HTTP only, including the actual
CP intake normalizer and RunSpec mapper. They do not read real credentials or
submit to CP, Runner or Google. Offline PASS is not live provider acceptance.
