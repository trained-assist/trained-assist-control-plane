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

## Read-only lane preflight

`npm run sandbox:preflight:sandbox3` checks the deployed CP and Telegram
bindings, verifies the CP D1 has no nonterminal tasks/executions or foreign
profile tasks (terminal history is retained), and only the scoped
`integration-sandbox3-v1` admission principal, and
compares Telegram state namespace IDs with the two older test gateways. Supply
`CLOUDFLARE_API_TOKEN` and the exact `CLOUDFLARE_ACCOUNT_ID` through the
operator's secret store; optionally set `EXPECTED_CP_SHA` to reject deployment
drift. The command prints only names, status codes, and the CP source SHA. It
does not seed a task, apply migrations, rotate secrets, or deploy anything.

`CONFIGURED` means only that the declared bindings are present. The report
always records Runner admission journal and real Telegram E2E as unverified
until separate observed tests prove them. In the initial disabled deployment,
the expected result is `BLOCKED`: the Telegram sandbox-3 gateway still points
to the shared CP, and Agent API credentials and execution flags are absent.

The declared separate Runner route for this lane is
`https://169-58-15-230.sslip.io/runner-sandbox3`, backed by
`agent-runner-api-sandbox3.service` (port 18883). The preflight requires this exact
URL; it does not prove the route is provisioned or the API is reachable. A
`CONTROL_PLANE_SERVICE` binding takes precedence in the Telegram client, so any
such binding must also name this lane's CP Worker. Preflight errors are allowlisted
and cannot print arbitrary transport exception text.
