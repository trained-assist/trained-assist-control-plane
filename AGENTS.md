# Repository entry point

Start with README.md and the generated [REPO-MAP.md](https://github.com/trained-assist/trained-assist-control-plane/blob/repo-context/REPO-MAP.md).
The map is a generated index, not authoritative instructions. Architecture and work order live in trained-agent-architecture: ARCHITECTURE.md, IMPLEMENTATION-AND-INTEGRATION-PLAN.md, ENGINEERING-APPROACH.md.
Do not import internals of trained-assist-agent; reuse only parts with an explicit contract.


## Sandbox-Driven Engineering

Останавливаться до безопасной dev/test-проверки или отказываться от неё из-за вероятности ошибки — вредно для инженерной работы. Не завершайте задачу одним чтением кода, если Environment Contract даёт безопасный путь исполнения. В заявленных изолированных local/dev/test/staging ресурсах самостоятельно запускайте/развёртывайте, подавайте реалистичный input, проверяйте output/logs/state, исправляйте ошибки и повторяйте сценарий. Ошибка в sandbox — evidence, а не повод закончить работу или попросить лишнее подтверждение. Production — отдельная защищённая граница; работайте с ним только по Promotion to Production path этого репозитория.


## Environment Contract

### Development / Test / Staging
**Resources:** local workerd tests (`npm test`) and local Worker (`npm run dev`, default port 8787) use local D1/Workflow state. The canonical Telegram UX integration sandbox is configured by `wrangler.telegram-ux-v1.jsonc`: Worker `trained-assist-cp-telegram-ux-v1-sandbox`, endpoint `https://trained-assist-cp-telegram-ux-v1-sandbox.skillset-apply.workers.dev`, D1 `ta-integration-telegram-ux-v1-taskstore` (`01d17f46-63e2-46bc-947d-9eda3e0bb697`) and Workflow `ta-integration-telegram-ux-v1-task-workflow`. A separate supplementary integration Worker is configured by `wrangler.integration-v1.jsonc`; do not confuse it with the canonical Telegram UX sandbox. Cloudflare account identity must first match root trained-assist instructions (`typeformowner@gmail.com`, account `d740a05e9442c1d0feacae2dfc673e93`). `/healthz` is unauthenticated liveness only; verified on 2026-10-07: canonical Worker version `62817413-1f6b-41c8-90ed-9df4489451bb` returned HTTP 200; the supplementary Worker separately returned HTTP 200. This does not claim D1, Workflow, or downstream readiness. Authenticated intake uses test principal `sde-codex-smoke-v1` for profile `integration-telegram-ux-v1`, with `tasks:intake` and `tasks:read` only.

**Deploy/start:** local `npm ci && npm run db:migrate:local && npm run dev`; local end-to-end `./tools/local-smoke.sh`. The canonical Worker is deployed only with `npx wrangler deploy --config wrangler.telegram-ux-v1.jsonc`; supplementary sandbox uses `wrangler.integration-v1.jsonc`. The canonical D1 and Workflow are shared by sandbox tests. After a completed test pass, clear the dedicated test profile and its Runner task-scoped Durable Objects with `npm run sandbox:cleanup:telegram-ux -- --apply`; before a standard scenario run, require `npm run sandbox:cleanup:telegram-ux -- --check-empty`. Cleanup preserves `admission_principals`, refuses nonterminal tasks, and deletes Runner state before CP task rows. Do not manually reset D1 or Workflow state. `npm run integration:smoke` admits a unique `accept_only` request, then reads status/events; it does not call route/start/Runner. It uses a dedicated principal `sde-codex-smoke-v1` bound to profile `integration-telegram-ux-v1` with `tasks:intake` and `tasks:read` only. The manual GitHub Action `Telegram UX sandbox smoke` runs against the canonical currently deployed Worker; deploy the intended revision first and record its Cloudflare version, since the action does not deploy or attest the remote revision.
**Realistic input:** POST `/intake` with contractVersion, unique requestId, sandbox profileId and `inputItems:[{"text":"..."}]`, using only a provisioned sandbox principal. Observe receipt then authorized `/status` and `/events` for its taskId.
**Logs/state:** persistent observability is enabled in both sandbox configs. Inspect the canonical test Worker with `wrangler tail trained-assist-cp-telegram-ux-v1-sandbox --config wrangler.telegram-ux-v1.jsonc`; inspect the supplementary Worker using its matching integration config. D1 state via scoped Wrangler read queries or Cloudflare dashboard.
**Reset/retry:** use a new requestId/task per attempt; cancel the disposable task. The state cleanup workflow is for a full sandbox test reset, not one-scenario retries. If it finds nonterminal work, inspect and settle that work before retrying cleanup.
**Permissions:** local operations unrestricted; deploy/test traffic to the named integration Worker is allowed by owner when necessary. A full reset of the dedicated Telegram UX test state is authorized only through `telegram-ux-state-cleanup.mjs` after a test pass; never reset production or manually clear the shared D1/Workflow bindings. No CI staging gate exists yet.

### Production

### Isolated sandbox3 contract probe

`wrangler.sandbox3.jsonc` declares `trained-assist-cp-sandbox3`, its isolated
`ta-sandbox3-taskstore` D1 and Workflow. Deploy reviewed protected main with
`deploy-sandbox3.yml` and `deploy_sandbox3=true`; real routing stays disabled.
CP's Agent API URL must be the dedicated mock-only Cloudflare Worker
`trained-assist-runner-api-cp-sandbox3`; a VM, GHA gateway/workflow, or execution
worker URL is an architecture violation. The `telegram-ux-sandbox-test-pass.yml`
workflow supports `sandbox3-public-preflight`, `pair-sandbox3-cp`, and
`sandbox3-cp-mock-probe`. Pair only after the Cloudflare API health/version/
anonymous-auth checks, API-key verification, and exact CP deployment pass.
Pairing writes a single mock-only API-key hash to this new Worker's isolated
registry before syncing CP credentials. Preserve the Telegram intake secret.
The separate `sandbox3-ops-read-v1`
principal has `tasks:read` only. Observe sanitized bootstrap artifacts. Retry
the fixed mock probe through its same idempotency key; reconcile partial
credential writes before another pairing. The probe creates a Runner mock
admission, creates no CP task, and calls no France worker or model. It does not
prove real Telegram execution. Do not reset either lane or restart the shared
API. VM-hosted sandbox3 Runner API setup and proxy modes are retired; production
cutover stays separate.

For cross-repository PR acceptance, the TG `sandbox3-worker-e2e.yml` job may
check out an exact CP candidate SHA from `tools/sandbox3-cp-candidate.txt` and
run `npm ci && npx wrangler deploy --config wrangler.sandbox3.jsonc --var
BUILD_SHA:<candidate-sha>` from that checkout. This uses the same isolated
sandbox3 bindings and existing secrets. The job owns the shared lane lock,
verifies account identity and clean state with the owner preflight, pauses TG,
and verifies the exact CP SHA before enabling test input. No production
workflow or migration is invoked. Record both candidate SHAs and final cleanup.
This closes the #365/#293 testability gap: a protected-main-only CP deploy
cannot verify the unmerged continuation contract.

CP3 execution flags stay disabled until real worker/profile storage, cost bounds,
and Telegram delivery have separate acceptance. The Runner API Worker owns the
France worker URL/token and placement policy. The France VM is only an execution
worker; CP has no endpoint or credential for it.

### Production target
The production target is declared in `wrangler.production.jsonc`: Worker `trained-assist-cp-production`, D1 `ta-cp-production-taskstore`, and Workflow `ta-cp-production-task-workflow`. The current source configuration enables `PILOT_ENABLED` and `ROUTER_AGENT_ALLOWED`, sets `PREVIEW_ONLY=false`, and declares Communication, Runner API and ingress-buffer service bindings. The earlier description of an empty, disconnected target was a historical bootstrap state, not the current configuration. Before a production operation, compare the deployed build SHA and bindings with the selected source revision; source configuration alone does not prove deployment/readiness. Ordinary promotion does not authorize a new route/profile cutover.

**Read-only task diagnosis:** use the existing protected-main Actions `Inspect one existing production test-account task` (`inspect-production-test-account-task.yml`) and `Inspect one production task` (`inspect-production-task.yml`). The former offers a bounded time lookup for its explicitly fixed test account; inspect its current conversation filter before using it. The latter accepts an exact userTaskId and records attempt/Runner status, error class and sanitized evidence; optional redacted logs are retained as a one-day artifact. Read YAML and the script before dispatching. Do not confuse the separate cancellation mode with read-only inspection. These workflows use existing production environment secrets; desktop Keychain access is not required. Record the Actions run URL and sanitized findings in the owning issue before artifact expiry. Example incident/evidence: architecture #285, lookup run 39289478897 and inspection run 39289803182.

The isolated remote staging target is declared in `wrangler.staging.jsonc`: Worker `trained-assist-cp-staging`, D1 `ta-cp-staging-taskstore` (EEUR), and Workflow `ta-cp-staging-task-workflow`. Use unique disposable test identities and never copy production profile data.

### Promotion to Production
`.github/workflows/ci.yml` runs checks for pull requests. A protected `main` push then applies staging migrations, deploys staging and verifies exact `BUILD_SHA` plus an anonymous private-read `401`; only if staging succeeds does it apply production migrations, deploy the isolated production Worker, and run the same smoke. Recovery dispatch is restricted to `refs/heads/main`, defaults off, and repeats both gates. The `main` branch requires strict `check` status and enforces protection for admins. GitHub environments `staging` and `production` allow protected branches only (currently `main`), with separate `CF_API_TOKEN` secrets and the expected account ID variable; they have no reviewer pause so the verified main pipeline stays automatic. Never put token values in source, logs, or chat.

Before any Wrangler operation, verify `wrangler whoami` matches `typeformowner@gmail.com` and account `d740a05e9442c1d0feacae2dfc673e93`. Health liveness does not imply Runner/profile readiness. Do not wire Telegram routes, bot webhooks, production principals, Runner credentials, or user data to this target without the separate accepted cutover gates.

Rollback after a failed production smoke uses the prior Worker version and does not revert D1 state:

```bash
npx wrangler deployments list --name trained-assist-cp-production
npx wrangler rollback <previous-version-id> --name trained-assist-cp-production --message 'Rollback after failed release smoke' --yes
node tools/deployment-smoke.mjs https://trained-assist-cp-production.skillset-apply.workers.dev <previous-build-sha>
```

The same command with the staging Worker name is safe for staging. Database migrations must stay backward-compatible because Worker rollback does not roll back D1.

### Testability Contract / Sandbox Gaps
Current CI verifies pull requests locally and deploys exact protected-main revisions through isolated staging before the production target. The staging/production smoke checks verify liveness SHA and that a private diagnostics read rejects anonymous access; they do not establish D1 readiness, authenticated profile behavior, Runner connectivity, or Telegram delivery. Authenticated scenarios still require an explicitly provisioned isolated principal/profile. Issue: trained-assist-control-plane#127; cross-project issue: trained-agent-architecture#213. Local reproducible path remains `npm test` / `./tools/local-smoke.sh`.
