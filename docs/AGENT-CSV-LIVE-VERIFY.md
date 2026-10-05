# Read-only CSV result verification

Parent: [architecture #140](https://github.com/trained-assist/trained-agent-architecture/issues/140).

This checks an already accepted CSV fixture task; it never submits, replays or resumes an execution. The known fixture has category totals `food=150`, `travel=275`, with declared output `outputs/category-results.csv`.

```bash
INTEGRATION_BINDINGS_FILE=/private/client-bindings.json \
INTEGRATION_TASK_ID=EXISTING_TASK_ID \
INTEGRATION_REPORT_FILE=/private/agent-csv-evidence.json \
  node tools/agent-csv-live-verify.mjs
```

Bindings are the scoped principal and URL described in `COMMUNICATION-V1-LIVE-SMOKE.md`, not the control-plane root secret. The verifier requires terminal success, one completed attempt tied to the canonical Runner ID, a persisted nonempty answer, immutable GitHub output, exact fixture readback and matching Task Store/manifest sizes and SHA-256. A workflow receipt, engine exit zero or publication link alone is not sufficient. An unfinished task is reported as failure, not polled into a replacement run.

The script does not verify Google operations or Telegram delivery. It downloads only the immutable public GitHub artifact selected by the persisted manifest; it sends no control-plane credentials to the artifact host. The report contains verification metadata, never answer text or credentials.

## Fresh file-input execution

The sandbox must already use the intended native Runner, provider model allowlist, worker claim authentication and declared CSV output policy. To intentionally create one new case:

```bash
INTEGRATION_BINDINGS_FILE=/private/client-bindings.json \
INTEGRATION_REQUEST_ID=YOUR_STABLE_NEW_CASE_ID \
INTEGRATION_REPORT_FILE=/private/csv-file-submission.json \
  node tools/agent-csv-file-live-run.mjs
```

The model receives an immutable public CSV fixture URL and must download, save, read and process that file. Intake and route are replayed with the same identity. The command records the request before network access, then the accepted task before dispatch. Its final phase is `dispatched_not_verified`, never computational or delivery success. Run the read-only verifier against that task after completion. Independently inspect native tool evidence to establish actual input-file read, not just matching totals.

The submitted goal specifies the output header/path and category sorting, but
does not disclose expected totals. Expected fixture values remain exclusively
in the independent verifier. Existing checkpoints with the older answer-bearing
goal are not silently changed or resumed with a different envelope.

If transport fails, reconcile the checkpoint's existing request/task. Never silently generate a replacement case for an unknown in-flight execution; explicitly reuse `INTEGRATION_REQUEST_ID` only when receipt/attempt reconciliation establishes that replay is safe. This fixture is an intermediate file scenario, not the Google Sheet scenario.

`INTEGRATION_REQUEST_ID` is mandatory; no ID is generated. A fresh run exclusively
creates a mode-0600 checkpoint and refuses any existing report.
Fresh intake must not report a duplicate; an already accepted ID requires explicit
checkpoint-based reconciliation/resume before routing. Checkpoints bind
the exact envelope, request ID, CP origin, authenticated principal and profile.
Writes are atomic under an exclusive sibling `.lock`; an existing lock is never
removed automatically. After a crashed process, the owner must reconcile before
removing a stale lock. Legacy/unversioned reports require manual reconciliation,
not automatic migration or overwriting.

For an explicitly reconciled retry, use the same bindings, ID and checkpoint:

```bash
INTEGRATION_BINDINGS_FILE=/private/client-bindings.json \
INTEGRATION_REQUEST_ID=THE_SAME_STABLE_CASE_ID \
INTEGRATION_REPORT_FILE=/private/csv-file-submission.json \
INTEGRATION_RESUME=true node tools/agent-csv-file-live-run.mjs
```

An intake ACK loss retries only the identical intake envelope. Before routing,
resume requires the same task/conversation at generation 1 and at most one
running attempt with a live workflow; unknown/interrupted/terminal states are
not rerouted. Routing ACK loss reconciles that existing attempt and must retain
its ID. Nonempty decision/run IDs and issued native generation-1 continuation
are required on both routing responses: absent IDs cannot count as equal.
An already dispatched checkpoint performs only a status read, never dispatch.
None of these checks proves CSV computation or delivery; use the separate verifier.

Offline regressions: `node --test tools/agent-csv-file-live-run.test.mjs`.
