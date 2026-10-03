# Repository map

Source: `trained-assist/trained-assist-control-plane@c04348fa087529d25a48e376fd9f7bffa0e11f5f`

Generated structurally, without LLM. This index is incomplete by design; open source before changing behavior.
Code details: `repo-compressed.xml` (Tree-sitter). Manifest: `manifest.json`.

## Start here

- [README.md](https://github.com/trained-assist/trained-assist-control-plane/blob/c04348fa087529d25a48e376fd9f7bffa0e11f5f/README.md)
- [AGENTS.md](https://github.com/trained-assist/trained-assist-control-plane/blob/c04348fa087529d25a48e376fd9f7bffa0e11f5f/AGENTS.md)

## Tracked source index

Paths and Markdown headings; generated data and sensitive paths excluded.

- `.github/workflows/ci-fix-cleanup.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/pr-autofix.yml`
- `.github/workflows/repo-context.yml`
- `.gitignore`
- `.repo-context/.gitignore`
- `.repo-context/repomix.config.json`
- `AGENTS.md` — Repository entry point
- `README.md` — trained-assist-control-plane; Что здесь лежит; Как запустить локально
- `docs/M1-PILOT-ROLLBACK-RUNBOOK.md` — M1 Пилот и Rollback — Runbook; Область применения; Архитектура пилота
- `docs/M1-STEP7-WEB-SLICE.md` — M1, шаг 7 — Sandbox Web и сквозная приёмка; Что здесь лежит; Принципы
- `docs/P22-SCHEDULE-VIRTUAL-CLOCK-TRANSCRIPT.md` — P22 — Schedule без обязательного GTD: transcript на виртуальных часах; Как воспроизвести; Санитизация evidence
- `docs/P23-GTD-OPTIN-BOUNDED-CONTROL-TRANSCRIPT.md` — P23 — GTD opt-in и bounded control: transcript на виртуальных часах; Как воспроизвести; Санитизация evidence
- `docs/e2e/m1-step7-live-report.json`
- `migrations/0001_task_store_v1.sql`
- `migrations/0002_task_admission.sql`
- `migrations/0003_run_executions.sql`
- `migrations/0004_delivery_and_artifacts.sql`
- `migrations/0005_awaiting_purpose_and_engine_refs.sql`
- `migrations/0006_schedule_v1.sql`
- `migrations/0007_gtd_v1.sql`
- `package.json`
- `src/awaiting/index.ts`
- `src/awaiting/purpose.ts`
- `src/awaiting/wait-for-answer.ts`
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
- `src/intake/intake-service.ts`
- `src/logging/structured-log.ts`
- `src/pilot/index.ts`
- `src/pilot/pilot-config.ts`
- `src/pilot/pilot-router.ts`
- `src/reporting/index.ts`
- `src/run-spec/run-spec.ts`
- `src/runner-adapter/await-runner-result.ts`
- `src/runner-adapter/engine-text.ts`
- `src/runner-adapter/errors.ts`
- `src/runner-adapter/index.ts`
- `src/runner-adapter/runner-api-adapter.ts`
- `src/schedule/cron.ts`
- `src/schedule/index.ts`
- `src/schedule/schedule-service.ts`
- `src/schedule/schedule-store.ts`
- `src/schedule/types.ts`
- `src/schedule/virtual-clock.ts`
- `src/taskstore/errors.ts`
- `src/taskstore/index.ts`
- `src/taskstore/task-store.ts`
- `src/taskstore/types.ts`
- `src/workflow-port/conversation-plan.ts`
- `src/workflow-port/delivery-worker.ts`
- `src/workflow-port/index.ts`
- `src/workflow-port/step-ctx.ts`
- `src/workflow-port/workflow-port.ts`
- `tests/env.ts`
- `tests/intake-receipt.test.ts`
- `tests/m06-cancel-delivery.test.ts`
- `tests/m1-step5-awaiting-input.test.ts`
- `tests/m122-runner-adapter.test.ts`
- `tests/migrations.test.ts`
- `tests/own-api-one-shot.test.ts`
- `tests/own-api-reporting.test.ts`
- `tests/own-api-run-spec.test.ts`
- `tests/p05-p06-status-recovery.test.ts`
- `tests/p12-primitive-io.test.ts`
- `tests/p22-schedule.test.ts`
- `tests/p23-gtd.test.ts`
- `tests/pilot-rollback.test.ts`
- `tests/scaffold.test.ts`
- `tests/setup.ts`
- `tests/taskstore-fencing.test.ts`
- `tests/taskstore-signals.test.ts`
- `tests/taskstore-terminal-guard.test.ts`
- `tests/taskstore-transitions.test.ts`
- `tests/web-conversation.test.ts`
- `tests/web-e2e-controlled-failure.test.ts`
- `tests/workflow-port.test.ts`
- `tools/local-smoke.sh`
- `tools/repo-context/.gitignore`
- `tools/repo-context/map.py`
- `tools/repo-context/package.json`
- `tools/runner-live-smoke.sh`
- `tsconfig.json`
- `vitest.config.ts`
- `web/app.ts`
- `web/config.ts`
- `web/contract.ts`
- `web/control-plane-client.ts`
- `web/conversation.ts`
- `web/e2e/run-m1-web-slice-e2e.mjs`
- `web/fake-control-plane.ts`
- `web/index.ts`
- `web/log.ts`
- `web/page.ts`
- `web/wrangler.web.jsonc`
- `wrangler.jsonc`

Omitted from short index: 0 paths. Full inventory is in manifest.json.
