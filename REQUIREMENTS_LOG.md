# Integration v1 requirements

Source: trained-assist/trained-agent-architecture#140, owner request 2026-10-05.

| ID | Status | Requirement | Validation |
|---|---|---|---|
| V1-01 | active | Explicit ROUTER_SELECTOR=communication_v1; fixture routing stays default. Ordinary text uses resolve_user_intent with only system_health, catalog.brief, agent. | Selector and HTTP tests |
| V1-02 | active | Preserve complete durable conversation input/result context. Invalid, unavailable or oversized classification falls back to agent with original input. | Failure and context tests |
| V1-03 | active | Health proves component reachability only. Capabilities describe catalog/grants and distinguish unverified integration readiness. | Handler tests |
| V1-04 | active | Task Store owns selection/result and generation fencing; Output starts the accepted task without resume. Concurrent repeats share selection and run. | D1 concurrency tests |
| V1-05 | active | Commit/push and draft PR only; parent owns deployment and Telegram harness. | Handoff |
| V1-06 | active | Shared writer renders verified facts once with deterministic fallback; host config selects the actual Runner engine. Defaults bound selector/writer/probe within 50 seconds. | Writer and host-engine HTTP tests |
| V1-07 | active | Start at the first broken boundary; parent handles the critical path while independent workers implement and review in parallel. Existing VM/GCP capacity is optional, not a reason to block on new infrastructure. | Same-task transport recovery and parallel review |
| V1-08 | active | Reconcile unknown submissions before retry. Preserve accepted task/generation and stable request identity; explicit workflow replay must name the first safe cached step. Never replace an uncertain run with a new case. | Native CSV generation 1, one successful attempt after pre-admission transport recovery |
| V1-09 | active | Trusted readiness requires fresh actual provider verification. Ordinary answers/preflight do not attest credentials; root credentials stay outside model and Task Store. Provider-attestation CSV work does not count as Telegram or Google Sheet acceptance. | Eight operator tests; live negative wait probes, OAuth/Drive account verification and identical event replay |
| V1-10 | active | Reusable credential-boundary verification is read-only: independently pinned host origin/scope, existing typed answered wait/checkpoint and exactly one successful canonical native attempt. No ready/start/route/recover or provider requests; immutable CSV readback is a separate same-task/run/generation check. | tools/credential-boundary-verify.mjs, 43 synthetic Node tests and CI; docs/CREDENTIAL-BOUNDARY-VERIFY.md |
