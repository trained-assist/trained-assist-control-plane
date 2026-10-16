# Inspecting a production task

The Control Plane production workflow `Inspect one production task` accepts a Control Plane `userTaskId` such as `ut-…`. It maps every execution attempt to its Runner `runId`, then records the selected route, worker start phase, terminal exit code/reason, safe failure classification, event counts, and log availability in a private GitHub Actions artifact. For GHA runs it also joins the gateway D1 journal to report the exact GitHub Actions repository, workflow run URL, and `session-log-<run_id>` artifact name without selecting prompt, credentials, or raw `run_json`.

The default report contains no stdout/stderr text. To include logs for an investigation, enable `include_redacted_logs`; the workflow reads only allowlisted Google Cloud Storage log URLs, redacts common credentials, and caps included text at 100 KB (source download: 2 MB maximum). It never prints signed URLs or log content to the Actions console. The resulting artifact is private to the repository and expires after one day. Do not use the log option for routine monitoring.

The workflow only runs from `main` and uses the `production` GitHub Environment. It reads attempt metadata from the production D1 Task Store, the minimal GHA mapping fields from the gateway D1 journal, and fetches run details with the existing production Runner API credential. Task prompts and raw D1 event payloads are never selected or printed.

Runner lifecycle events are also copied into the task's existing `/events` journal while execution is active. Consumers can use that cursor-based stream for live progress; the one-off inspector is for post-failure diagnosis.
