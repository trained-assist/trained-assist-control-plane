#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const DATABASE_ID = '01d17f46-63e2-46bc-947d-9eda3e0bb697';
const DATABASE_NAME = 'ta-integration-telegram-ux-v1-taskstore';
const PROFILE_ID = 'integration-telegram-ux-v1';
const PRINCIPAL_ID = PROFILE_ID;
const TENANT_ID = 'telegram-ux-sandbox-20261009';
const RUNNER_API = 'https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev';
const OUTPUT = 'telegram-ux-state-cleanup-evidence.json';

const INVENTORY_SQL = `SELECT
  (SELECT COUNT(*) FROM durable_tasks WHERE profile_id = ?) AS durable_tasks,
  (SELECT COUNT(*) FROM conversations WHERE profile_id = ?) AS conversations,
  (SELECT COUNT(*) FROM task_events e JOIN durable_tasks t ON t.id = e.user_task_id WHERE t.profile_id = ?) AS task_events,
  (SELECT COUNT(*) FROM task_signals s JOIN durable_tasks t ON t.id = s.user_task_id WHERE t.profile_id = ?) AS task_signals,
  (SELECT COUNT(*) FROM awaiting_inputs a JOIN durable_tasks t ON t.id = a.user_task_id WHERE t.profile_id = ?) AS awaiting_inputs,
  (SELECT COUNT(*) FROM executions e JOIN durable_tasks t ON t.id = e.task_id WHERE t.profile_id = ?) AS executions,
  (SELECT COUNT(*) FROM deliveries d JOIN durable_tasks t ON t.id = d.user_task_id WHERE t.profile_id = ?) AS deliveries,
  (SELECT COUNT(*) FROM task_artifacts a JOIN durable_tasks t ON t.id = a.user_task_id WHERE t.profile_id = ?) AS task_artifacts,
  (SELECT COUNT(*) FROM credential_completions c WHERE c.profile_id = ?) AS credential_completions,
  (SELECT COUNT(*) FROM pending_inputs WHERE profile_id = ?) AS pending_inputs,
  (SELECT COUNT(*) FROM schedules WHERE profile_id = ?) AS schedules,
  (SELECT COUNT(*) FROM schedule_occurrences WHERE profile_id = ?) AS schedule_occurrences,
  (SELECT COUNT(*) FROM gtd_records WHERE profile_id = ?) AS gtd_records,
  (SELECT COUNT(*) FROM gtd_outcomes WHERE profile_id = ?) AS gtd_outcomes,
  (SELECT COUNT(*) FROM gtd_progressions p WHERE EXISTS (SELECT 1 FROM gtd_records g WHERE g.gtd_id = p.gtd_id AND g.profile_id = ?)) AS gtd_progressions,
  (SELECT COUNT(*) FROM gtd_conditions c WHERE EXISTS (SELECT 1 FROM gtd_records g WHERE g.gtd_id = c.gtd_id AND g.profile_id = ?)) AS gtd_conditions,
  (SELECT COUNT(*) FROM cp_stop_windows WHERE profile_id = ?) AS cp_stop_windows,
  (SELECT COUNT(*) FROM stuck_input_alerts) AS stuck_input_alerts`;
const PROFILE_PARAMS = Array.from({ length: 17 }, () => PROFILE_ID);

function safeErrorCode(value, fallback) {
  return typeof value === 'string' && /^[a-z0-9_:.-]+$/.test(value) ? value : fallback;
}

function assertCountRecord(value) {
  if (!value || typeof value !== 'object') throw new Error('cleanup_inventory_invalid');
  for (const [key, count] of Object.entries(value)) {
    if (!/^[a-z_]+$/.test(key) || !Number.isSafeInteger(count) || count < 0) throw new Error('cleanup_inventory_invalid');
  }
  return value;
}

function assertReadOnly(result) {
  if (result?.meta?.changed_db !== false || (result?.meta?.changes !== undefined && result.meta.changes !== 0)) throw new Error('cleanup_read_only_contract_failed');
}

export async function cleanupTelegramUxState({ env = process.env, mode = 'check-empty', fetchImpl = fetch }) {
  if (!['check-empty', 'apply'].includes(mode)) throw new Error('cleanup_mode_invalid');
  const token = env.CF_API_TOKEN?.trim() ?? '';
  if (!token || env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT_ID) throw new Error('cleanup_account_or_token_invalid');
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;
  const query = async (sql, params = []) => {
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success !== true) throw new Error(`cleanup_d1_query_failed:${response.status}`);
    return body.result?.[0];
  };
  const inventory = async () => {
    const result = await query(INVENTORY_SQL, PROFILE_PARAMS);
    assertReadOnly(result);
    return assertCountRecord(result.results?.[0]);
  };
  const before = await inventory();
  const tasksResult = await query(`SELECT t.id, t.status, t.request_id,
      (SELECT COUNT(*) FROM executions e WHERE e.task_id = t.id) AS execution_count
    FROM durable_tasks t WHERE t.profile_id = ? ORDER BY t.id`, [PROFILE_ID]);
  assertReadOnly(tasksResult);
  const tasks = tasksResult.results;
  if (!Array.isArray(tasks) || tasks.some(task => typeof task.id !== 'string' || typeof task.status !== 'string'
      || !Number.isSafeInteger(task.execution_count) || task.execution_count < 0)) throw new Error('cleanup_task_inventory_invalid');
  if (mode === 'check-empty') {
    if (Object.values(before).some(count => count !== 0)) throw new Error('sandbox_buffers_not_empty');
    return { lane: 'telegram-ux-v1', database: DATABASE_NAME, mode, empty: true, counts: before };
  }
  const terminal = task => ['done', 'failed', 'cancelled'].includes(task.status);
  const safeUnstartedIntentProbe = task => !terminal(task)
    && task.execution_count === 0
    && /^live-v1-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}:agent-intent$/.test(task.request_id ?? '');
  const strandedProbes = tasks.filter(safeUnstartedIntentProbe);
  if (tasks.some(task => !terminal(task) && !safeUnstartedIntentProbe(task))) throw new Error('nonterminal_test_tasks_present');

  const runnerKey = env.RUNNER_API_KEY_AGENT_API?.trim() ?? '';
  const delegationSecret = env.RUNNER_PROFILE_DELEGATION_SECRET?.trim() ?? '';
  const runnerTasks = tasks.filter(task => task.execution_count > 0);
  if (runnerTasks.length && (!runnerKey || !delegationSecret)) throw new Error('runner_cleanup_credentials_missing');
  let runnerTasksCleaned = 0;
  for (const task of runnerTasks) {
    const expiresAt = String(Date.now() + 60_000);
    const payload = `${PRINCIPAL_ID}\0${TENANT_ID}\0${PROFILE_ID}\0${expiresAt}`;
    const signature = createHmac('sha256', delegationSecret).update(payload).digest('hex');
    const response = await fetchImpl(`${RUNNER_API}/v1/sandbox/cleanup-task`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${runnerKey}`, 'content-type': 'application/json',
        'x-agent-profile-id': PROFILE_ID, 'x-agent-profile-tenant': TENANT_ID,
        'x-agent-profile-exp': expiresAt, 'x-agent-profile-sig': signature },
      body: JSON.stringify({ userTaskId: task.id }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || !['cleaned', 'already-empty'].includes(result.status)) throw new Error(`runner_cleanup_failed:${response.status}`);
    runnerTasksCleaned += 1;
  }

  const pendingResult = await query('SELECT batch_id FROM pending_inputs WHERE profile_id = ?', [PROFILE_ID]);
  assertReadOnly(pendingResult);
  const batches = pendingResult.results;
  if (!Array.isArray(batches) || batches.some(row => typeof row.batch_id !== 'string')) throw new Error('cleanup_pending_inventory_invalid');

  const deletes = [
    ['DELETE FROM credential_completions WHERE profile_id = ?', [PROFILE_ID]],
    ['DELETE FROM gtd_outcomes WHERE profile_id = ?', [PROFILE_ID]],
    ['DELETE FROM gtd_progressions WHERE EXISTS (SELECT 1 FROM gtd_records g WHERE g.gtd_id = gtd_progressions.gtd_id AND g.profile_id = ?)', [PROFILE_ID]],
    ['DELETE FROM gtd_conditions WHERE EXISTS (SELECT 1 FROM gtd_records g WHERE g.gtd_id = gtd_conditions.gtd_id AND g.profile_id = ?)', [PROFILE_ID]],
    ['DELETE FROM gtd_records WHERE profile_id = ?', [PROFILE_ID]],
    ['DELETE FROM schedule_occurrences WHERE profile_id = ?', [PROFILE_ID]],
    ['DELETE FROM schedules WHERE profile_id = ?', [PROFILE_ID]],
    ['DELETE FROM pending_inputs WHERE profile_id = ?', [PROFILE_ID]],
    ['DELETE FROM cp_stop_windows WHERE profile_id = ?', [PROFILE_ID]],
    ['DELETE FROM stuck_input_alerts', []],
    ['DELETE FROM durable_tasks WHERE profile_id = ?', [PROFILE_ID]],
    ['DELETE FROM conversations WHERE profile_id = ?', [PROFILE_ID]],
  ];
  let cpRowsDeleted = 0;
  for (const [sql, params] of deletes) {
    const result = await query(sql, params);
    const changes = result?.meta?.changes;
    if (!Number.isSafeInteger(changes) || changes < 0 || (changes > 0 && result.meta.changed_db !== true)) throw new Error('cleanup_write_contract_failed');
    cpRowsDeleted += changes;
  }
  const after = await inventory();
  if (Object.values(after).some(count => count !== 0)) throw new Error('sandbox_buffers_not_empty_after_cleanup');
  return { lane: 'telegram-ux-v1', database: DATABASE_NAME, mode, empty: true,
    terminalTasksFound: tasks.filter(terminal).length, unstartedIntentProbesCleared: strandedProbes.length,
    runnerTasksCleaned, pendingBatchesFound: batches.length, cpRowsDeleted, counts: after };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check-empty', '--apply'].includes(args[0])) throw new Error('cleanup_arguments_invalid');
  const report = await cleanupTelegramUxState({ mode: args[0] === '--apply' ? 'apply' : 'check-empty' });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(OUTPUT, serialized, { mode: 0o600 });
  console.log(serialized.trimEnd());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : '';
    console.error(JSON.stringify({ lane: 'telegram-ux-v1', outcome: 'cleanup_failed', reasonCode: safeErrorCode(message, 'cleanup_failed') }));
    process.exitCode = 1;
  });
}
