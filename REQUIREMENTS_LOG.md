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
