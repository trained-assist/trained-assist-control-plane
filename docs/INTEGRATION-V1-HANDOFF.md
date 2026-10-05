# Integration v1 test handoff

Status and evidence: [architecture issue 140](https://github.com/trained-assist/trained-agent-architecture/issues/140).
The deployed contour is isolated test infrastructure. Production traffic is unchanged.

## Deployed components

| Component | Source / review | Runtime |
| --- | --- | --- |
| Telegram gateway | [PR351](https://github.com/trained-assist/trained-assist-tg-bot/pull/351), deployed source `325f184`; durable-owner fix [PR354](https://github.com/trained-assist/trained-assist-tg-bot/pull/354) | Separate sandbox Worker and SQLite Durable Object; temporary owner-approved test bot, single private chat allowlist, signed webhook restored after verified quarantine cutover; scheduled cron remains disabled |
| Communication methods | [PR18](https://github.com/trained-assist/trained-assist-communication-skills/pull/18), `4a64612` | Separate communication Worker |
| Control plane | [PR43](https://github.com/trained-assist/trained-assist-control-plane/pull/43); deployed source `118fbf4` includes D1 manifest fix and reviewed credential-ready conversation-context fix | Separate Worker, D1 and Workflow; scoped credential host enabled; Google MCP remains off |
| Runner | [PR131](https://github.com/trained-assist/ai-agent-runner/pull/131), `97956c5` | Own permanent, boot-enabled VM unit; separate key registry/journal; Google MCP off |
| Native execution | [PR2](https://github.com/vovalikessmoothy-png/opencode-gha-runner/pull/2), execution source `47379f6`; [owned deployment PR3](https://github.com/vovalikessmoothy-png/opencode-gha-runner/pull/3) | Own Worker/KV and strong host-only claim authentication |
| Google activation primitives | [PR24](https://github.com/trained-assist/trained-assist-documents-skill/pull/24), `ae2d751`; owner-target PR22, provider-verifier PR23, source-protection PR25, fixture preparation PR26 and authenticated redirect fix PR27 | Reviewed/tested source composition; scoped writes require operation IDs and a host-pinned protected source; live Google MCP remains off; latest source not yet staged on VM |

Runner HTTPS uses a VM-side development Quick Tunnel. The laptop relay is stopped.
Each new connector process receives a new URL: update the owned Runner public URL and
CP Runner binding before submitting further work. A named tunnel and approved DNS
hostname remain the production transport gate. Shared units/tunnels stay unchanged.

## Observed scenarios

| Scenario | Result | Evidence |
| --- | --- | --- |
| Health, capabilities | PASS inside CP, zero engine attempts | `ut-957c7b8310c081cc1ba6`, `ut-61bf383b0a84408d26d1`; receipt/route replays stable; 10.8 / 10.5 seconds |
| Download/read CSV, calculate/write output | PASS | `ut-7674dc3a830519e82f8a`, generation 1, `run_f6ea41fa-dc2e-46d9-8616-f983af96f1b1`; one successful attempt |
| Telegram to actual native CSV agent to answer | PASS controlled ingress | `ut-964d6b22964427ed3927`, generation 1, canonical `run_026cf629-219c-445f-92b1-063212bcf893`; one Runner admission/dispatch, successful GHA `37284796273` attempt 1, eight completed engine tools, verified committed CSV and Telegram receipt1373/terminal1374; 195.5 seconds end-to-end |
| Pre-admission transport failure | PASS recovery | Same CSV task; zero admissions before explicit replay from `submit-runner`; no replacement task/generation |
| Verified provider wait and continuation | PASS controlled subboundary | `ut-8e39dd5dc2b208ce15f5`, `run_d3a0f0b8-52ca-4018-a8b0-254f26d67ccd`; fresh actual OAuth/Drive account verification, exact host event and duplicate replay; same task/generation, one successful attempt |
| User/preflight/wrong-binding readiness | PASS refusal | Ordinary principal 403; preflight and changed binding 409; one durable credential completion/signal retained |
| Own Runner restart | PASS terminal recovery | Both canonical CSV results/artifacts unchanged, one admission/dispatch/model launch each |
| Mandatory output omitted | PASS expected failure | `ut-3364752a81741b5e0e54`, `run_caf880bb-ce25-441f-99b8-9b1aec48f9e3`; task failed/finished, one failed attempt, `ARTIFACTS_MISSING`, zero artifacts |
| Historical Telegram delivery | FAIL replay safety, quarantined | Old capabilities receipt/terminal provider IDs changed on independent readback; both old tasks and four delivery records quarantined, not resent or relabelled as successful |
| Post-cutover controlled Telegram health/capabilities | PASS scoped quick-answer delivery | `ut-4593cff37c0fbd03ecad` and `ut-90860cc5c147cbf22d63`, generation 1, zero engine attempts; health receipt/terminal 1369/1370 remain unchanged after eight concurrent reconciliations; capabilities 1371/1372 after exact-body reconciliation of initial HTTP 500; genuine human smoke still pending |
| Delivery owner across Worker redeploy | PASS scoped durability | Historical quarantine and all six new health/capabilities/CSV provider IDs preserved after same-source Worker redeploy and eight concurrent reconciliations; each new delivery has one attempt. This is not a forced Durable Object eviction or live provider-ACK-loss test |
| Real Google Sheet and monthly follow-up | BLOCKED | Dedicated Sheet approved; exact SA authenticates, but Drive metadata returns 404 and Sheets metadata 403 `PERMISSION_DENIED`; no Google writes or model launch |

Both successful CSV outputs have 35 bytes, SHA-256
`8072bf3523ee80345e5a10a08070f0d50779c65cb5d3b611702cbab39ea95da6`,
and category totals food 150 / travel 275. Immutable output commits are
`77ec55a8bbc2a095d9fca5bc66bd6250ee9980ab` and
`fb763ab56643a2acde9457b73978fecfd8325de3`. Engine durations were 27.3 and 63.3
seconds; these exclude workflow admission, routing and transport recovery.

The failure case stores terminal failure metadata, without a durable user answer
or delivery. Gateway terminal reconciliation supplies its deterministic failure
message; real Telegram delivery still requires its separate acceptance test.

Controlled Telegram health `ut-3744e4e6163312e3e6e1` has receipt/terminal IDs
1360/1361. Its 15-second ingress ACK was lost; reconciliation preserved the same
task, generation and zero engine attempts. Controlled capabilities
`ut-f34f5dfc8e1c48f57bdb` has conflicting receipt IDs 1364/1363 and terminal IDs
1365/1366 for the same logical deliveries. Earlier successful smoke snapshots
therefore do not establish replay-safe delivery. Concurrent drains reproduce two
provider calls offline even with strongly consistent fake KV. The sandbox now uses
a reviewed SQLite Durable Object owner with a durable pre-send claim. An operator
cutover manifest matched the authoritative CP conversation inventory: two terminal
tasks and four legacy deliveries. Signed readback proved their quarantine while
delivery was paused; only then was delivery enabled and the webhook restored,
without dropping queued updates. Scheduled cron remains disabled. Unknown provider
ACKs are held without automatic retries. The initial post-cutover capabilities HTTP
500 remains in evidence; identical saved update bytes reconciled to one task and
zero engine attempts. This does not prove the original transport error's cause.

## Repeat read-only checks

Use existing private operator bindings and checkpoints; do not put their values
in repository files or command arguments. Files live in an operator-owned `0700`
directory and have mode `0600`.

```sh
INTEGRATION_BINDINGS_FILE="$PRIVATE_RUNTIME/client-bindings.json" \
INTEGRATION_TASK_ID=ut-7674dc3a830519e82f8a \
INTEGRATION_REPORT_FILE="$PRIVATE_RUNTIME/csv-readback-new.json" \
node tools/agent-csv-live-verify.mjs

node tools/credential-boundary-verify.mjs verify \
  "$PRIVATE_RUNTIME/credential-verification-expectation-v2.json" \
  "$PRIVATE_RUNTIME/credential-host-binding.json" \
  "$PRIVATE_RUNTIME/credential-csv-checkpoint.json"

(cd "$DOCUMENTS_REPO" && node scripts/sandbox/google-provider-verify.cjs \
  --runtime "$GOOGLE_PRIVATE_RUNTIME" \
  --expected-sa-email "$GOOGLE_EXPECTED_SA_EMAIL")
```

The credential verifier reads only awaiting/status projections. It proves scoped
typed readiness and the successful Workflow attempt/native final-answer channel.
Native engine identity and launch time need separate authenticated Runner/native
evidence. CSV bytes/hash need the separate artifact verifier. It does not reverify
the provider or prove Sheets/Telegram delivery.

The domain provider command performs fresh OAuth and Drive-account verification
only. Its parent-authorized live check passed with two HTTP 200 responses, exact
isolated account identity and zero artifact calls/events. It sends no readiness
event. Owner target approval and live Sheet permissions are separate gates.

New factual probes: [communication smoke instructions](COMMUNICATION-V1-LIVE-SMOKE.md).
New CSV work: [stable-ID submission and verification](AGENT-CSV-LIVE-VERIFY.md).
Credential preparation: [operator instructions](CREDENTIAL-BOUNDARY-OPERATOR.md).
Unknown outcomes require reconciliation of the existing task, not a fresh request.

## Activation gates and limits

- The owner authorized temporary test-bot credentials and webhook handoff. The
  discovered private chat is the only allowed destination; no wildcard is used.
  Delete the temporary bot or rotate its disclosed token after testing. Production
  credentials must use Secret Manager references and must not be shared in chat.
- Use an empty owner-approved Sheet shared to the dedicated test service account.
  Configure trusted per-task owner authorization and scoped HTTPS MCP forwarding
  before agent admission; credentials and owner authorization stay on the host.
  Pin `protectedSourceSheetName` before minting: scoped model writes require a valid
  operation ID, refuse the protected source even if caller arguments omit or lie
  about it, and use verified immutable new-tab operations. See the
  [two-phase Google operator](AGENT-GOOGLE-SHEET-LIVE-RUN.md); prepare accepts a
  stable task without dispatch, and ambiguous starts require reconciliation.
- Provider attestation exercised real account authentication and zero Google
  artifact calls. Automatic provider-form handoff and Sheet work remain separate gates.
- Recovery currently changes Runner result timestamps. Artifact identity and launch
counts survive; recovered timestamps cannot measure original engine execution.
- The controlled Telegram CSV independently verifies the same 35-byte/category
  fixture, committed as `a5d9296b56abe4f0ad109563399df7111cda0d44`. Google was not
  invoked. The initial public smoke run IDs reflected a synthetic routing-history
  ID; authenticated CP/Runner/native evidence establishes the canonical UUID
  above. Do not use a routing-history ID as proof of native engine execution.
- The shared legacy native gateway remains outside the owned strong-claim changes.
  Production needs least-privilege operator credentials and stable hosting.
- Full Telegram/Google acceptance remains open in issue 140.
