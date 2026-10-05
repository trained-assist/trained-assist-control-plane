# Native cancellation confirmation hook (source only)

`CfWorkflowPort` accepts an optional fourth constructor argument `ExternalStopPort`
from `src/workflow-port/external-stop.ts`. Parent wiring must select a trusted,
profile-aware Runner adapter; no HTTP request may supply this port or credentials.
No entrypoint/index or runtime configuration is changed by this implementation.

Parent composition imports the helper directly (no index/barrel change):

```ts
import { runnerExternalStopPort } from './workflow-port/external-stop';

const port = new CfWorkflowPort(workflow, store, credentialExecution,
  ownNativeCancelFlag && trustedProfileRunnerAdapter
    ? runnerExternalStopPort(trustedProfileRunnerAdapter) : undefined);
```

The new own-only flag/profile policy and adapter construction belong to parent;
keep old deployments unchanged. At source base `5c8879d`, there is no
`engine_job_ref` column or parser. Actual receipt binding is `executions.session_id`
written by `attachRunnerRun`; native owner generation is `executions.generation`.
Do not parse or guess a job reference from task text, `execution_session_id`, or
the newer CP cancel generation. A later job-reference schema needs an explicit
versioned contract before wiring; this hook does not invent one.

Contract: `stop({taskId, profileId, attemptId, runId, ownerGeneration, reason})`
returns `{state:'stopped', result:RunnerResult}` or a pending/rejected/unknown state.
`ownerGeneration` is the admitted attempt generation, not the incremented CP cancel
fence. Missing native run identity is unknown, never proof of no external job.

`runnerExternalStopPort(adapter)` sends Runner cancel, then reads authoritative
status and terminal result for the same run/task/generation/profile. A request
acknowledgement is not a stop confirmation. Terminal succeeded/failed/cancelled
status must agree with the result outcome and `exitObserved:true`; connection loss,
identity mismatch, rejection, nonterminal status or any transport failure refuses
confirmation. A job already terminal proves it is no longer running, not that a
kill caused its exit. There is no new job, retry loop, provider call or automatic
resume in this hook. Pending cancellation can be reconciled by a later explicit
cancel call against the same stored native run identity.

Workflow termination alone remains sufficient only for existing Workflow-only
usage without an external hook or bound unfinished Runner attempt. A bound native
attempt without a hook refuses confirmation. With a hook, every unfinished attempt
requires matching terminal evidence; unknown or missing receipt remains open.
Only then may the task and attempts become cancelled. The current generation and
attempt identities are rechecked, and TaskStore confirmation includes an atomic
generation fence. Exceptions never finalize the attempt; diagnostics contain a
fixed classification, not provider response bodies/tokens.

Without configured native hook, an unbound attempt cannot distinguish a pure
Workflow from an ambiguous native submission. Parent must wire the hook for native
profiles before claiming cancellation acceptance. In-flight submit/receipt loss
with no durable run identity requires admission reconciliation, not a new launch
or a guessed ID. No runtime native cancellation or constructor wiring was performed.

Offline validation:

```sh
npm run typecheck
npx vitest run tests/native-cancel-confirmation.test.ts tests/workflow-port.test.ts
```
