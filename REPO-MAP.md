# Repository map

Source: `trained-assist/trained-assist-control-plane@d2f564fe7566d0e6fcbc45defa36f1ae25a39049`

Generated structurally, without LLM. This index is incomplete by design; open source before changing behavior.
Code details: `repo-compressed.xml` (Tree-sitter). Manifest: `manifest.json`.

## Start here

- [README.md](https://github.com/trained-assist/trained-assist-control-plane/blob/d2f564fe7566d0e6fcbc45defa36f1ae25a39049/README.md)
- [AGENTS.md](https://github.com/trained-assist/trained-assist-control-plane/blob/d2f564fe7566d0e6fcbc45defa36f1ae25a39049/AGENTS.md)

## Tracked source index

Paths and Markdown headings; generated data and sensitive paths excluded.

- `.github/workflows/ci-fix-cleanup.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/communication-v1-quick-answer-smoke.yml`
- `.github/workflows/deploy-sandbox3.yml`
- `.github/workflows/deploy-telegram-ux-sandbox.yml`
- `.github/workflows/integration-v1.yml`
- `.github/workflows/pr-autofix.yml`
- `.github/workflows/reconcile-telegram-ux-france-worker.yml`
- `.github/workflows/repo-context.yml`
- `.github/workflows/sandbox-status-probe.yml`
- `.github/workflows/telegram-ux-sandbox-test-pass.yml`
- `.gitignore`
- `.repo-context/.gitignore`
- `.repo-context/repomix.config.json`
- `AGENTS.md` — Repository entry point; Sandbox-Driven Engineering; Environment Contract
- `README.md` — trained-assist-control-plane; Что здесь лежит; Как запустить локально
- `REQUIREMENTS_LOG.md` — Integration v1 requirements
- `docs/AGENT-CSV-LIVE-VERIFY.md` — Read-only CSV result verification; Fresh file-input execution
- `docs/AGENT-GOOGLE-SHEET-LIVE-RUN.md` — Two-phase Google Sheet operator; Prepare contract: acceptance without execution; Parent-owned activation and explicit start
- `docs/COMMUNICATION-V1-LIVE-SMOKE.md` — Live quick-answer acceptance
- `docs/COMMUNICATION-V1.md` — Communication selector v1; Bindings and authenticated entry; Facts, context and failures
- `docs/CP-STOP-RUN-PIN.md` — Immutable CP stop execution pins; Remaining wire and ownership requirements; Review follow-up
- `docs/CREDENTIAL-BOUNDARY-OPERATOR.md` — Private credential boundary preparation; Parent-owned prerequisites; Prepare only
- `docs/CREDENTIAL-BOUNDARY-VERIFY.md` — Read-only credential-boundary verification; Inputs and command; Verified boundary and limitations
- `docs/CREDENTIAL-READY-V1.md` — Credential readiness boundary v1; Registration; Verified host completion
- `docs/HEALTH-DIAGNOSTICS.md` — Health diagnostics v1
- `docs/HOST-MCP-ROUTING-COMPOSITION.md` — Test-gated host MCP routing composition; Routing contract; Test runtime boundary
- `docs/INGRESS-ARTIFACT-MANIFEST-V1.md` — Ingress artifact manifest v1; Intake shape; Buffer verification
- `docs/INTEGRATION-V1-HANDOFF.md` — Integration v1 test handoff; Deployed components; Observed scenarios
- `docs/M1-PILOT-ROLLBACK-RUNBOOK.md` — M1 Пилот и Rollback — Runbook; Область применения; Архитектура пилота
- `docs/M1-STEP7-WEB-SLICE.md` — M1, шаг 7 — Sandbox Web и сквозная приёмка; Что здесь лежит; Принципы
- `docs/MCP-TEST-DISCOVERY-TELEGRAM-UX-V1.md` — Test MCP discovery contract for Telegram UX v1; Discovery before Runner submit; Selection and RunSpec handoff
- `docs/NATIVE-CANCEL-CONFIRMATION.md` — Native cancellation confirmation hook (source only)
- `docs/P22-SCHEDULE-VIRTUAL-CLOCK-TRANSCRIPT.md` — P22 — Schedule без обязательного GTD: transcript на виртуальных часах; Как воспроизвести; Санитизация evidence
- `docs/P23-GTD-OPTIN-BOUNDED-CONTROL-TRANSCRIPT.md` — P23 — GTD opt-in и bounded control: transcript на виртуальных часах; Как воспроизвести; Санитизация evidence
- `docs/PROFILE-RUNTIME-POLICY.md` — Trusted profile runtime policy; Ownership and routing order; Provisioning gate
- `docs/ROLLOUT-COHORT-FLAG-OWNER-ROLLBACK.md` — Rollout: конкретный cohort, routing flag, owner и rollback; 1. Routing flag — текущие и предлагаемые значения; 2. Cohort
- `docs/RUNNER-LATE-RESULT-RECONCILIATION.md` — Late Runner result reconciliation
- `docs/SANDBOX-3-TARGET.md` — Isolated CP sandbox-3 target; Resources; Runtime boundary
- `docs/TEXT-ONLY-RUNNER-PERSISTENCE.md` — Text-only Runner result persistence
- `docs/WATCHDOG-ACCEPTANCE-RUNBOOK.md` — Приёмка watchdog «принято, но дальше тишина» — runbook; Что доказываем; Предварительное состояние (проверено 04.10.2026)
- `docs/e2e/m1-step7-live-report.json`
- `docs/evidence/P16-SANDBOX-TRANSCRIPT.md` — P16 · sanitized transcript песочницы Task Router; Изоляция прогона; Что проверялось
- `docs/evidence/P20-BRIEF-TRANSCRIPT.md` — P20 · sanitized transcript песочницы Brief builder; Изоляция прогона; Что проверялось
- `docs/evidence/p16-sandbox-events.jsonl`
- `docs/evidence/p20-brief-events.jsonl`
- `docs/evidence/snapshot-ref-sandbox/README.md` — Snapshot/input ref через публичный Task API — первый сквозной прогон (issue #52 шаг 1); Что доказано; Что пришлось добавить в control plane
- `docs/evidence/snapshot-ref-sandbox/snap-e2e.mjs`
- `docs/evidence/snapshot-ref-sandbox/transcript.sha256`
- `docs/evidence/snapshot-ref-sandbox/transcript.txt`
- `eval/fast-replies/corpus.snapshot.json`
- `eval/fast-replies/decisions/p16-route-policy.v1.jsonl`
- `eval/fast-replies/dialogs.v1.jsonl`
- `migrations/0001_task_store_v1.sql`
- `migrations/0002_task_admission.sql`
- `migrations/0003_run_executions.sql`
- `migrations/0004_delivery_and_artifacts.sql`
- `migrations/0005_awaiting_purpose_and_engine_refs.sql`
- `migrations/0006_schedule_v1.sql`
- `migrations/0007_gtd_v1.sql`
- `migrations/0008_start_deadline.sql`
- `migrations/0009_pending_inputs.sql`
- `migrations/0010_backfill_start_deadline.sql`
- `migrations/0011_watchdog_health.sql`
- `migrations/0012_stuck_input_alerts.sql`
- `migrations/0013_credential_ready.sql`
- `migrations/0014_stop_window_snapshots.sql`
- `package.json`
- `src/auth/principal-auth.ts`
- `src/awaiting/credential-ready.ts`
- `src/awaiting/index.ts`
- `src/awaiting/purpose.ts`
- `src/awaiting/wait-for-answer.ts`
- `src/deployment/sandbox3.ts`
- `src/deployment/telegram-ux-sandbox.ts`
- `src/diagnostics/health-catalogue.ts`
- `src/diagnostics/trace.ts`
- `src/events/c02-event-envelope.ts`
- `src/events/index.ts`
- `src/gtd/errors.ts`
- `src/gtd/gtd-service.ts`
- `src/gtd/gtd-store.ts`
- `src/gtd/index.ts`
- `src/gtd/types.ts`
- `src/index.ts`
- `src/intake/authorization.ts`
- `src/intake/envelope.ts`
- `src/intake/errors.ts`
- `src/intake/index.ts`
- `src/intake/ingress-artifact-verifier.ts`
- `src/intake/input-artifact-manifest.ts`
- `src/intake/intake-service.ts`
- `src/intake/stuck-input-scheduler.ts`
- `src/intake/stuck-input-watchdog.ts`
- `src/logging/error-publisher.ts`
- `src/logging/index.ts`
- `src/logging/structured-log.ts`
- `src/pilot/index.ts`
- `src/pilot/pilot-config.ts`
- `src/pilot/pilot-router.ts`
- `src/reporting/index.ts`
- `src/router/authorization.ts`
- `src/router/brief/brief-types.ts`
- `src/router/brief/cache.ts`
- `src/router/brief/compiler.ts`
- `src/router/brief/execution-context.ts`
- `src/router/brief/index.ts`
- `src/router/brief/service.ts`
- `src/router/brief/summary.ts`
- `src/router/catalog.ts`
- `src/router/communication-client.ts`
- `src/router/communication-v1.ts`
- `src/router/corpus-replay.ts`
- `src/router/events.ts`
- `src/router/handlers.ts`
- `src/router/host-mcp-routing.ts`
- `src/router/index.ts`
- `src/router/mcp-catalogue-types.ts`
- `src/router/mcp-catalogue.ts`
- `src/router/policy.ts`
- `src/router/recipe/decision-contract.ts`
- `src/router/recipe/fixed-model.ts`
- `src/router/recipe/host-data.ts`

Omitted from short index: 168 paths. Full inventory is in manifest.json.
