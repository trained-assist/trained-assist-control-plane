# Isolated CP sandbox-3 target

This target supports the isolated E2E lane tracked by
[trained-agent-architecture#193](https://github.com/trained-assist/trained-agent-architecture/issues/193).

## Resources

- Worker: `trained-assist-cp-sandbox3`
- Workflow: `ta-cp-sandbox3-task-workflow`
- D1: `ta-sandbox3-taskstore` (`1e1b8108-9186-43e2-8e50-436598233165`)
- Worker URL: `https://trained-assist-cp-sandbox3.skillset-apply.workers.dev`

The D1 database existed before this target was added. Its existing 14 migrations
were inspected read-only; it had zero durable tasks, admission principals, and
executions. The sandbox-3 deployment does not apply migrations or seed rows.

## Deployment boundary

Use **Deploy isolated CP sandbox-3** from protected `main` with its confirmation
input enabled. The workflow uses the protected `staging` GitHub environment
credentials and checks the expected Cloudflare account before deploying. It
pins the source SHA in `BUILD_SHA` and performs the read-only `/healthz` and
anonymous private-catalogue smoke.

The config declares Agent API-owned engine/profile selection, but deliberately
has no Agent API URL or credentials yet. It remains fail-closed:
`PREVIEW_ONLY=true`, `PILOT_ENABLED=false`, `ROUTER_AGENT_ALLOWED=false`. No
service bindings, principal secrets, registration, intake, Runner/provider
calls, or Telegram delivery are configured. Do not enable execution until
profile delegation and bounded reservation/settlement acceptance are complete.
Do not bind the shared Telegram UX D1 or the staging/production D1 databases
here.
