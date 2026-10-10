# Live quick-answer acceptance

Parent: [architecture #140](https://github.com/trained-assist/trained-agent-architecture/issues/140).

```bash
INTEGRATION_BINDINGS_FILE=/private/client-bindings.json \
INTEGRATION_REPORT_FILE=/private/quick-answer-evidence.json \
  node tools/communication-v1-live-smoke.mjs
```

The binding file supplies a scoped principal signature, not the control-plane root secret. Required keys are `CONTROL_PLANE_URL`, `CONTROL_PLANE_PRINCIPAL`, `CONTROL_PLANE_PRINCIPAL_SIGNATURE` and `CONTROL_PLANE_PROFILE`. Never commit the binding file.

For the canonical Telegram UX sandbox, manual GitHub workflow `Verify Telegram UX quick answers in sandbox` derives the scoped principal signature in memory from the sandbox environment secret `CP_TELEGRAM_UX_PRINCIPAL_SECRET`. It requires the exact deployed Worker build SHA as an input, verifies healthy liveness and SHA before admitting either synthetic scenario, and uploads only sanitized evidence. The secret and signature are never written to the report or workflow log.

The CP URL must be HTTPS without userinfo/query/fragment; the signature must be
64 lowercase hexadecimal characters. Signed requests reject redirects and bound
object-shaped JSON responses to 4 MiB. Errors use fixed phase codes, never raw
assertion messages, response bodies or configuration values.

`INTEGRATION_REPORT_FILE` is required and exclusively created mode 0600; an
existing report is refused, never overwritten by a new case. Atomic checkpoints
record the scenario request before intake and accepted task before routing.
Because classification can fall back to an agent, a failed route can have an
in-flight execution: the tool stops without retrying or starting the next scenario.
Reconcile the stored task/request manually; this tool has no automatic resume.
Report success still requires both persisted quick answers and zero engine runs.

Offline transport/checkpoint tests:
`node --test tools/communication-v1-live-smoke.test.mjs`.

This calls real intake, selector, factual quick-answer handlers, common writer and Task Store. It verifies durable receipt replay, identical route replay, persisted terminal answer and absence of engine runs. It does not infer Telegram delivery from a stored answer. Failures are reported as failures, with any known accepted task ID retained for reconciliation; the script never silently starts replacement tasks or retries external mutations.

The isolated deployment uses service bindings for same-account Workers. Runner network checks use a temporary authenticated HTTPS tunnel during development because Worker fetch to a direct IP is rejected. The tunnel is not production infrastructure; final release needs a stable operator-managed hostname or named tunnel, independent of an integrator laptop.
