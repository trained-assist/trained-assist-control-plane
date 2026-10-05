# Text-only Runner result persistence

Runner `RunResult.persistence` describes exported outputs, not a blanket acknowledgement of workspace publication. Its contract defines `not_required` for runs without declared outputs. Native external-worker mapping returns this value when no artifacts are reported; it must not invent a persisted artifact or cloud-user file for a text-only answer.

The control plane accepts successful `not_required` results only when its host-built submitted RunSpec declared no output paths and both Runner output references and artifact manifests are empty. Missing declaration evidence, declared outputs, inconsistent artifact references, `pending`, and `failed` still fail closed with `export_not_persisted`. Existing `persisted` handling is unchanged.

The final native answer is read from Runner status and committed into the durable task result together with its canonical run identity and generation. This does not prove that a profile workspace or run branch was published. Tasks requiring those contracts still need their own publication evidence; this change supplies none and does not relax required-output persistence.

Regression tests use the real Runner HTTP adapter and D1 task store, suspend after submit, resume with the same cached receipt, and assert one task generation, one attempt, one submit, exact answer provenance, and terminal replay without another launch. No historical failed task is rewritten or replayed by this change.
