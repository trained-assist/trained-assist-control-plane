# Live quick-answer acceptance

Parent: [architecture #140](https://github.com/trained-assist/trained-agent-architecture/issues/140).

```bash
INTEGRATION_BINDINGS_FILE=/private/client-bindings.json \
INTEGRATION_REPORT_FILE=/private/quick-answer-evidence.json \
  node tools/communication-v1-live-smoke.mjs
```

The binding file supplies a scoped principal signature, not the control-plane root secret. Required keys are `CONTROL_PLANE_URL`, `CONTROL_PLANE_PRINCIPAL`, `CONTROL_PLANE_PRINCIPAL_SIGNATURE` and `CONTROL_PLANE_PROFILE`. Never commit the binding file.

This calls real intake, selector, factual quick-answer handlers, common writer and Task Store. It verifies durable receipt replay, identical route replay, persisted terminal answer and absence of engine runs. It does not infer Telegram delivery from a stored answer. Failures are reported as failures, with any known accepted task ID retained for reconciliation; the script never silently starts replacement tasks or retries external mutations.

The isolated deployment uses service bindings for same-account Workers. Runner network checks use a temporary authenticated HTTPS tunnel during development because Worker fetch to a direct IP is rejected. The tunnel is not production infrastructure; final release needs a stable operator-managed hostname or named tunnel, independent of an integrator laptop.
