# Production release path

The Control Plane repository owns the production release sequence. After staging
checks pass, its protected `main` workflow checks out the pinned source revision
of `trained-assist/ai-agent-runner`, runs the Runner tests and production dry-run,
deploys the standalone Cloudflare Runner API, and verifies `/healthz` plus the
exact `/version` SHA. The version check retries transient route publication for
up to 75 seconds. Only then does it apply CP production D1 migrations and deploy
CP. The CP production environment's Cloudflare credential is used by the job; a
second copy of that credential is not required in the Runner repository.

The Runner API is a separate serverless Worker with its own production Durable
Object namespace. Its production engine defaults to the France VM worker. CP
submits runs to Runner API; CP does not call France VM or a GHA worker directly.
The GHA engine remains a Runner API capability and does not change France as the
default policy.

The pinned Runner SHA lives in `.github/workflows/ci.yml`. Updating Runner source
for production requires reviewing and changing that pin in a CP change. A
successful Worker health check proves deployment and placement only; it does not
prove that user admission is configured.

`PREVIEW_ONLY=false`, `PILOT_ENABLED=true`, and `ROUTER_AGENT_ALLOWED=true` let
production accept and route tasks for every profile. This exposes integration
errors in the live production endpoint. Runner production's repository
allowlist is still empty and CP production does not yet have its paired Runner
API key/profile delegation bindings, so a real run can still fail explicitly at
that boundary. Configure those credentials next; keep the launch encryption key
with its ciphertext across recovery.
