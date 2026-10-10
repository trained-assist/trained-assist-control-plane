import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupTelegramUxState } from './telegram-ux-state-cleanup.mjs';

const zeroInventory = Object.fromEntries([
  'durable_tasks', 'conversations', 'task_events', 'task_signals', 'awaiting_inputs', 'executions',
  'deliveries', 'task_artifacts', 'credential_completions', 'pending_inputs', 'schedules',
  'schedule_occurrences', 'gtd_records', 'gtd_outcomes', 'gtd_progressions', 'gtd_conditions', 'cp_stop_windows', 'stuck_input_alerts',
].map(key => [key, 0]));

function mockFetch({ taskRows = [], onRunnerCall = () => {} } = {}) {
  const calls = [];
  let rows = [...taskRows];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://trained-assist-runner-api-')) {
      onRunnerCall(url, init, calls);
      calls.push({ kind: 'runner', url, init });
      return Response.json({ status: 'cleaned', deletedRuns: 1 });
    }
    const { sql, params } = JSON.parse(init.body);
    calls.push({ kind: 'd1', sql, params });
    if (sql.startsWith('SELECT\n')) {
      const counts = { ...zeroInventory, durable_tasks: rows.length };
      return Response.json({ success: true, result: [{ results: [counts], meta: { changed_db: false, changes: 0 } }] });
    }
    if (sql.startsWith('SELECT id, status')) return Response.json({ success: true, result: [{ results: rows, meta: { changed_db: false, changes: 0 } }] });
    if (sql.startsWith('SELECT batch_id')) return Response.json({ success: true, result: [{ results: [], meta: { changed_db: false, changes: 0 } }] });
    const changes = sql.startsWith('DELETE FROM durable_tasks') ? rows.length : 0;
    if (sql.startsWith('DELETE FROM durable_tasks')) rows = [];
    return Response.json({ success: true, result: [{ results: [], meta: { changed_db: changes > 0, changes } }] });
  };
  return { fetchImpl, calls };
}

const baseEnv = {
  CF_API_TOKEN: 'cf-test-token', CLOUDFLARE_ACCOUNT_ID: 'd740a05e9442c1d0feacae2dfc673e93',
  RUNNER_API_KEY_AGENT_API: 'runner-test-key', RUNNER_PROFILE_DELEGATION_SECRET: 'delegation-test-secret',
};

test('check-empty fails closed when any profile buffer has rows', async () => {
  const { fetchImpl } = mockFetch({ taskRows: [{ id: 'task-a', status: 'done' }] });
  await assert.rejects(cleanupTelegramUxState({ env: baseEnv, mode: 'check-empty', fetchImpl }), /sandbox_buffers_not_empty/);
});

test('apply clears Runner state before deleting terminal CP records and verifies empty state', async () => {
  const { fetchImpl, calls } = mockFetch({ taskRows: [{ id: 'task-a', status: 'done' }] });
  const report = await cleanupTelegramUxState({ env: baseEnv, mode: 'apply', fetchImpl });
  const runnerIndex = calls.findIndex(call => call.kind === 'runner');
  const deleteIndex = calls.findIndex(call => call.kind === 'd1' && call.sql.startsWith('DELETE FROM'));
  assert.ok(runnerIndex >= 0 && runnerIndex < deleteIndex);
  assert.deepEqual(report, {
    lane: 'telegram-ux-v1', database: 'ta-integration-telegram-ux-v1-taskstore', mode: 'apply', empty: true,
    terminalTasksFound: 1, runnerTasksCleaned: 1, pendingBatchesFound: 0, cpRowsDeleted: 1, counts: zeroInventory,
  });
  const cleanup = calls[runnerIndex];
  assert.equal(cleanup.init.headers['x-agent-profile-id'], 'integration-telegram-ux-v1');
  assert.equal(JSON.parse(cleanup.init.body).userTaskId, 'task-a');
  assert.ok(!JSON.stringify(report).includes('task-a'));
});

test('apply refuses nonterminal tasks before touching Runner or D1 state', async () => {
  const { fetchImpl, calls } = mockFetch({ taskRows: [{ id: 'task-active', status: 'active' }] });
  await assert.rejects(cleanupTelegramUxState({ env: baseEnv, mode: 'apply', fetchImpl }), /nonterminal_test_tasks_present/);
  assert.equal(calls.some(call => call.kind === 'runner'), false);
  assert.equal(calls.some(call => call.kind === 'd1' && call.sql.startsWith('DELETE FROM')), false);
});
