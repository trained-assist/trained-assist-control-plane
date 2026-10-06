# Health diagnostics v1

The Control Plane exposes public `GET /health` for liveness only. It does not
claim that Runner, the channel, tools, or end-to-end execution are ready.

Operator diagnostics are protected by `HEALTH_DIAGNOSTICS_TOKEN` and the
`Authorization: Bearer …` header:

- `GET /internal/health/catalogue` returns the trusted deployment inventory.
- `GET /internal/health/summary` performs bounded live/ready probes and caches
  the result briefly. Both accept exact `environment`, `region`, and `serviceId`
  filters.

`HEALTH_CATALOGUE_JSON` is an operator-controlled JSON array, never accepted
from a request. Entries use `serviceId`, `environment`, `region`, `repositoryUrl`,
`contractVersion: 1`, `healthUrl`, optional `readinessUrl`, deployment evidence
(`deployedRevision`, `buildId`, `providerDeploymentId`, `deployedAt`) and typed
`logSources`. Probe/repository/log URLs must be HTTPS; redirects are not followed.
Missing deployment evidence remains `null` and yields
`deployed_revision_unknown`; `main` is never substituted for deployed code.

Probe limits are bounded through `HEALTH_PROBE_TIMEOUT_MS` (100–10000 ms) and
`HEALTH_CACHE_TTL_MS` (1000–60000 ms). The summary runs at most four probes at
once, applies a shared aggregate deadline, marks failures `unknown` or worse,
and never returns target response bodies. Log links are metadata only; this API
does not read or proxy log contents. Public `/health` and the current user-facing
`system_health` remain separate safe surfaces; this MVP does not yet project the
catalogue into `system_health`. Neither surface may expose inventory, internal
origins, credentials, or other users' data.

This API is an MVP contract, not proof of component deployment. Until a
deployment pipeline stamps a revision/provider deployment ID into a trusted
descriptor, those fields deliberately remain `unknown`.
