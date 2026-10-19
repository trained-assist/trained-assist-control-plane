# Short-lived agent profile tokens

The protected `Issue or revoke an agent profile token` workflow issues a bearer
for one Runner profile. The workflow must run from `main` in the `production`
GitHub Environment. The Control Plane verifies GitHub's signed OIDC token and
pins it to this repository, workflow file, environment, event, and protected
branch. It uses its existing `PRINCIPAL_SECRET` binding to sign an 8-hour token;
the signing key is never sent to Actions.

To issue, dispatch the workflow with `action=issue` and the exact Runner
`profile_id` (for example `flexi-consult`). The issuer checks that the profile
has a trusted Runner runtime, adds a unique admission principal with the fixed
task scopes, and records lease ID, profile, GitHub actor, workflow run, scopes,
and expiry in D1. The bearer is returned once in a private Actions artifact
with one-day retention. It is excluded from logs and the run summary. Anyone
with repository read access can download that artifact; dispatch requires
repository write access. The bearer can call ordinary Control Plane routes
using `Authorization: Bearer <token>` and is limited by its admission scopes
and profile binding.

To revoke early, dispatch with `action=revoke` and the lease ID. The issuing
actor or a repository owner can revoke it; the principal is disabled in D1, so
the bearer stops authorizing requests immediately. Expired/revoked lease
records remain as audit evidence. Normal `PRINCIPAL_SECRET` HMAC principals
and their authentication format are unchanged.

Issuing a token proves that the profile runtime is configured. It does not by
itself prove that the remote Runner has usable credentials for that account or
that a task can complete; verify those separately with a task scoped to the
lease profile. Never copy the artifact token into issues, PR comments, or
workflow summaries.
