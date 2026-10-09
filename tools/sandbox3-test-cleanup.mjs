#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const DATABASE_ID = '1e1b8108-9186-43e2-8e50-436598233165';
const DATABASE_NAME = 'ta-sandbox3-taskstore';
const PROFILE_ID = 'integration-sandbox3-v1';
const TEST_REQUEST_GLOB = 'sandbox3-test-*';

export const SANDBOX3_TEST_CLEANUP_SQL = Object.freeze({
  inspect: `SELECT
    COUNT(*) AS tagged,
    COALESCE(SUM(CASE WHEN status IN ('done','failed','cancelled') THEN 1 ELSE 0 END), 0) AS terminal,
    COALESCE(SUM(CASE WHEN status NOT IN ('done','failed','cancelled') THEN 1 ELSE 0 END), 0) AS nonterminal,
    COALESCE(SUM(CASE WHEN status IN ('done','failed','cancelled') AND (
      EXISTS (SELECT 1 FROM credential_completions c WHERE c.user_task_id = durable_tasks.id)
      OR EXISTS (SELECT 1 FROM gtd_records g WHERE g.user_task_id = durable_tasks.id)
      OR EXISTS (SELECT 1 FROM gtd_outcomes g WHERE g.user_task_id = durable_tasks.id)
      OR EXISTS (SELECT 1 FROM gtd_progressions g WHERE g.user_task_id = durable_tasks.id)
      OR EXISTS (SELECT 1 FROM gtd_conditions g WHERE g.user_task_id = durable_tasks.id)
      OR EXISTS (SELECT 1 FROM pending_inputs p WHERE p.user_task_id = durable_tasks.id)
      OR EXISTS (SELECT 1 FROM schedule_occurrences s WHERE s.user_task_id = durable_tasks.id)
    ) THEN 1 ELSE 0 END), 0) AS terminal_with_external_refs
    FROM durable_tasks
    WHERE profile_id = ? AND request_id GLOB ?`,
  deleteTerminal: `DELETE FROM durable_tasks
    WHERE profile_id = ? AND request_id GLOB ? AND status IN ('done','failed','cancelled')
      AND NOT EXISTS (SELECT 1 FROM credential_completions c WHERE c.user_task_id = durable_tasks.id)
      AND NOT EXISTS (SELECT 1 FROM gtd_records g WHERE g.user_task_id = durable_tasks.id)
      AND NOT EXISTS (SELECT 1 FROM gtd_outcomes g WHERE g.user_task_id = durable_tasks.id)
      AND NOT EXISTS (SELECT 1 FROM gtd_progressions g WHERE g.user_task_id = durable_tasks.id)
      AND NOT EXISTS (SELECT 1 FROM gtd_conditions g WHERE g.user_task_id = durable_tasks.id)
      AND NOT EXISTS (SELECT 1 FROM pending_inputs p WHERE p.user_task_id = durable_tasks.id)
      AND NOT EXISTS (SELECT 1 FROM schedule_occurrences s WHERE s.user_task_id = durable_tasks.id)`,
});

function assertReadOnly(result) {
  if (result?.meta?.changed_db !== false || result?.meta?.rows_written !== 0) {
    throw new Error('sandbox3_cleanup_read_only_contract_failed');
  }
}

export async function cleanSandbox3TestTasks({ token, accountId, apply = false, fetchImpl = fetch }) {
  if (!token || accountId !== ACCOUNT_ID) throw new Error('sandbox3_cleanup_account_or_token_invalid');
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;
  const query = async (sql, params) => {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success !== true) throw new Error(`sandbox3_cleanup_query_failed:${response.status}`);
    return body.result?.[0];
  };

  const inspected = await query(SANDBOX3_TEST_CLEANUP_SQL.inspect, [PROFILE_ID, TEST_REQUEST_GLOB]);
  assertReadOnly(inspected);
  const counts = inspected.results?.[0] ?? {};
  for (const key of ['tagged', 'terminal', 'nonterminal', 'terminal_with_external_refs']) {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) throw new Error('sandbox3_cleanup_count_invalid');
  }

  let deleted = 0;
  if (apply && counts.terminal > 0) {
    const result = await query(SANDBOX3_TEST_CLEANUP_SQL.deleteTerminal, [PROFILE_ID, TEST_REQUEST_GLOB]);
    if (result?.meta?.changed_db !== (result.meta.rows_written > 0)
      || !Number.isSafeInteger(result.meta.rows_written) || result.meta.rows_written < 0
      || result.meta.rows_written > counts.terminal) throw new Error('sandbox3_cleanup_write_contract_failed');
    deleted = result.meta.rows_written;
  }
  return {
    lane: 'sandbox3',
    database: DATABASE_NAME,
    mode: apply ? 'apply' : 'dry_run',
    taggedTasks: counts.tagged,
    terminalTasksFound: counts.terminal,
    deletedTasks: deleted,
    retainedNonterminalTasks: counts.nonterminal,
    retainedTerminalTasksWithExternalReferences: counts.terminal_with_external_refs,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(value => value !== '--apply') || args.length > 1) throw new Error('sandbox3_cleanup_arguments_invalid');
  const report = await cleanSandbox3TestTasks({
    token: process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apply: args.includes('--apply'),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile('sandbox3-test-cleanup-evidence.json', serialized, { mode: 0o600 });
  console.log(serialized.trimEnd());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : '';
    console.error(JSON.stringify({ lane: 'sandbox3', outcome: 'cleanup_failed',
      reasonCode: /^[a-z0-9_:.-]+$/.test(message) ? message : 'sandbox3_cleanup_failed' }));
    process.exitCode = 1;
  });
}
