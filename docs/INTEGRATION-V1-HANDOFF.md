# Integration v1 test handoff

Status and evidence: [architecture issue 140](https://github.com/trained-assist/trained-agent-architecture/issues/140).
The deployed contour is isolated test infrastructure. Production traffic is unchanged.

## Deployed components

| Component | Source / review | Runtime |
| --- | --- | --- |
| Telegram gateway | [PR351](https://github.com/trained-assist/trained-assist-tg-bot/pull/351), `844fdef` | Separate sandbox Worker; bot token and chat allowlist pending |
| Communication methods | [PR18](https://github.com/trained-assist/trained-assist-communication-skills/pull/18), `4a64612` | Separate communication Worker |
| Control plane | [PR43](https://github.com/trained-assist/trained-assist-control-plane/pull/43); deployed runtime code includes `c41db51` | Separate Worker, D1 and Workflow; scoped credential host enabled |
| Runner | [PR131](https://github.com/trained-assist/ai-agent-runner/pull/131), `97956c5` | Own permanent, boot-enabled VM unit; separate key registry/journal; Google MCP off |
| Native execution | [PR2](https://github.com/vovalikessmoothy-png/opencode-gha-runner/pull/2), execution source `47379f6`; [owned deployment PR3](https://github.com/vovalikessmoothy-png/opencode-gha-runner/pull/3) | Own Worker/KV and strong host-only claim authentication |
| Google activation primitives | [PR24](https://github.com/trained-assist/trained-assist-documents-skill/pull/24), `1466a33`; owner-target PR22 and provider-verifier PR23 | Reviewed/tested source composition; live Google MCP remains off |

Runner HTTPS uses a VM-side development Quick Tunnel. The laptop relay is stopped.
Each new connector process receives a new URL: update the owned Runner public URL and
CP Runner binding before submitting further work. A named tunnel and approved DNS
hostname remain the production transport gate. Shared units/tunnels stay unchanged.

## Observed scenarios

| Scenario | Result | Evidence |
| --- | --- | --- |
| Health, capabilities | PASS inside CP, zero engine attempts | `ut-957c7b8310c081cc1ba6`, `ut-61bf383b0a84408d26d1`; receipt/route replays stable; 10.8 / 10.5 seconds |
| Download/read CSV, calculate/write output | PASS | `ut-7674dc3a830519e82f8a`, generation 1, `run_f6ea41fa-dc2e-46d9-8616-f983af96f1b1`; one successful attempt |
| Pre-admission transport failure | PASS recovery | Same CSV task; zero admissions before explicit replay from `submit-runner`; no replacement task/generation |
| Verified provider wait and continuation | PASS controlled subboundary | `ut-8e39dd5dc2b208ce15f5`, `run_d3a0f0b8-52ca-4018-a8b0-254f26d67ccd`; fresh actual OAuth/Drive account verification, exact host event and duplicate replay; same task/generation, one successful attempt |
| User/preflight/wrong-binding readiness | PASS refusal | Ordinary principal 403; preflight and changed binding 409; one durable credential completion/signal retained |
| Own Runner restart | PASS terminal recovery | Both canonical CSV results/artifacts unchanged, one admission/dispatch/model launch each |
| Mandatory output omitted | PASS expected failure | `ut-3364752a81741b5e0e54`, `run_caf880bb-ce25-441f-99b8-9b1aec48f9e3`; task failed/finished, one failed attempt, `ARTIFACTS_MISSING`, zero artifacts |
| Real Telegram ingress/delivery | BLOCKED | Rotated test bot, allowed chat/user and webhook handoff pending |
| Real Google Sheet and monthly follow-up | BLOCKED | Dedicated approved Sheet and live scoped MCP activation pending |

Both successful CSV outputs have 35 bytes, SHA-256
`8072bf3523ee80345e5a10a08070f0d50779c65cb5d3b611702cbab39ea95da6`,
and category totals food 150 / travel 275. Immutable output commits are
`77ec55a8bbc2a095d9fca5bc66bd6250ee9980ab` and
`fb763ab56643a2acde9457b73978fecfd8325de3`. Engine durations were 27.3 and 63.3
seconds; these exclude workflow admission, routing and transport recovery.

The failure case stores terminal failure metadata, without a durable user answer
or delivery. Gateway terminal reconciliation supplies its deterministic failure
message; real Telegram delivery still requires its separate acceptance test.

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

- Test bot credentials must be rotated after the diagnostic disclosure; share only
  their Secret Manager reference. Obtain the test chat/user allowlist and explicit
  webhook handoff before configuring the isolated gateway.
- Use an empty owner-approved Sheet shared to the dedicated test service account.
  Configure trusted per-task owner authorization and scoped HTTPS MCP forwarding
  before agent admission; credentials and owner authorization stay on the host.
- Provider attestation exercised real account authentication and zero Google
  artifact calls. Automatic provider-form handoff and Sheet work remain separate gates.
- Recovery currently changes Runner result timestamps. Artifact identity and launch
  counts survive; recovered timestamps cannot measure original engine execution.
- The shared legacy native gateway remains outside the owned strong-claim changes.
  Production needs least-privilege operator credentials and stable hosting.
- Full Telegram/Google acceptance remains open in issue 140.
