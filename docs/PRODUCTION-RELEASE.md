# Production release path

The Control Plane repository owns the production release sequence. After staging
checks pass, its protected `main` workflow checks out the pinned source revision
of `trained-assist/ai-agent-runner`, runs the Runner tests and production dry-run,
provisions paired Runner/CP credentials, deploys the standalone Cloudflare Runner
API, and verifies `/healthz`, the exact `/version` SHA, and an authenticated
delegated `/v1/capabilities` probe. The version check retries transient route
publication for up to 75 seconds. Only then does it apply CP production D1
migrations, pair CP to Runner API, and deploy CP. The CP production environment's
Cloudflare credential is used by the job; a second copy of that credential is
not required in the Runner repository.

The Runner API is a separate serverless Worker with its own production Durable
Object namespace. Its production engine defaults to the France VM worker. CP
submits runs to Runner API; CP does not call France VM or a GHA worker directly.
The GHA engine remains a Runner API capability and does not change France as the
default policy.

The pinned Runner SHA lives in `.github/workflows/ci.yml`. Updating Runner source
for production requires reviewing and changing that pin in a CP change. A
authenticated capability probe verifies API-key and profile delegation
admission; it does not by itself prove user-facing Telegram routing.

`PREVIEW_ONLY=false`, `PILOT_ENABLED=true`, and `ROUTER_AGENT_ALLOWED=true` let
production accept and route tasks for every profile. This exposes integration
errors in the live production endpoint. Runner production now allows only
`trained-assist/ai-agent-runner` and `LLM_LADDER_TOKEN`, with France as the
default engine and mock disabled. A real run still requires the production API
principal, paired CP key/profile delegation, and France worker credentials. The
standard production release provisions these from the CP repository's protected
production environment and repository secrets. Keep the launch encryption key
with its ciphertext across recovery.
