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

If transport fails, reconcile the checkpoint's existing request/task. Never silently generate a replacement case for an unknown in-flight execution; explicitly reuse `INTEGRATION_REQUEST_ID` only when receipt/attempt reconciliation establishes that replay is safe. This fixture is an intermediate file scenario, not the Google Sheet scenario.
