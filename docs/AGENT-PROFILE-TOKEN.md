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
and expiry in D1. The bearer is returned once in an Actions artifact
with one-day retention. It is excluded from logs and the run summary. Anyone
with repository read access can download that artifact; dispatch requires
repository write access. The bearer can call ordinary Control Plane routes
using `Authorization: Bearer <token>` and is limited by its admission scopes
and profile binding.

Optionally provide `task_prompt` on an issue run to immediately execute one
real Runner task under the newly issued profile lease. The workflow first
publishes the lease artifact, then calls Control Plane intake and start with
`autoRun=false`, and polls the task report. This submits a RunSpec to that
profile's configured Runner adapter; it is distinct from the Control Plane's
`autoRun=true` terminal path. A separate sanitized evidence artifact records
the task ID, Control Plane run ID, Runner run ID, terminal state, and answer.
The lease bearer is not included in task evidence, logs, or summaries. Anyone
with repository write access can dispatch the task; the prompt is visible in
the Actions run inputs, so do not put secrets there. Task prompts are limited
to 8,000 characters. Omit `task_prompt` to issue a lease without launching a
task.

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


### Inspecting Runner/session logs

The `Inspect one production task` workflow reads the saved Control Plane and Runner
attempt. With `include_redacted_logs=true`, it emits the redacted Runner event log and
available session log text directly into the Actions job log, then retains the
same sanitized diagnostics as a one-day artifact. This makes the output readable
through the Actions log tools as well as downloadable by the operator. The option is
off by default; Actions logs and artifacts follow repository visibility.
