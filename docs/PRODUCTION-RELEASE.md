# Production release path

The Control Plane repository owns the production release sequence. After staging
checks pass, its protected `main` workflow checks out the pinned source revision
of `trained-assist/ai-agent-runner`, runs the Runner tests and production dry-run,
deploys the standalone Cloudflare Runner API, and verifies `/healthz` plus the
exact `/version` SHA. Only then does it apply CP production D1 migrations and
deploy CP. The CP production environment's Cloudflare credential is used by the
job; a second copy of that credential is not required in the Runner repository.

The Runner API is a separate serverless Worker with its own production Durable
Object namespace. Its production engine defaults to the France VM worker. CP
submits runs to Runner API; CP does not call France VM or a GHA worker directly.
The GHA engine remains a Runner API capability and does not change France as the
default policy.

The pinned Runner SHA lives in `.github/workflows/ci.yml`. Updating Runner source
for production requires reviewing and changing that pin in a CP change. A
successful Worker health check proves deployment and placement only; it does not
prove that user admission is configured.

`PREVIEW_ONLY=false` lets production scheduler and readiness code run. User run
admission remains closed while `PILOT_ENABLED=false`,
`ROUTER_AGENT_ALLOWED=false`, and the Runner production repository allowlist is
empty. Opening admission requires a separate validated CP principal/profile
mapping, paired Runner key and delegation secret, France worker credentials,
and stable launch encryption key. Keep the launch encryption key with its
ciphertext across recovery.
