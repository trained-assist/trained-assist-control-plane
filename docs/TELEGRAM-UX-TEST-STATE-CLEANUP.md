# Telegram UX sandbox test state cleanup

The canonical test profile is `integration-telegram-ux-v1`. Before standard quick-answer scenarios, the workflow runs `tools/telegram-ux-state-cleanup.mjs --check-empty`; any remaining CP rows fail the run before a new test starts.

After each test pass, including a failed test, the workflow runs the same script with `--apply`. It enumerates terminal CP tasks, clears each task's state through the authenticated sandbox Runner API cleanup route, then deletes the profile's CP task, conversation, intake, schedule, delivery, credential, and GTD test records. It verifies the CP buffers are empty afterward. Active or unknown Runner runs are never deleted. `admission_principals` and the Workflows binding are preserved.

The cleanup script is intentionally pinned to the canonical sandbox account, D1 database, Runner API endpoint, test profile, and delegation tenant. It requires sandbox credentials from GitHub Actions; it does not read or write production configuration. Use `npm run sandbox:cleanup:telegram-ux -- --check-empty` to verify and `npm run sandbox:cleanup:telegram-ux -- --apply` to clear a completed test pass.
