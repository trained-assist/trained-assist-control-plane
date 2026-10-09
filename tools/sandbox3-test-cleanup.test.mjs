import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSandbox3TestTasks, SANDBOX3_TEST_CLEANUP_SQL } from './sandbox3-test-cleanup.mjs';

function response(result, status = 200) {
  return new Response(JSON.stringify({ success: status === 200, result: [result] }), { status });
}

test('dry run only inspects explicitly tagged sandbox3 terminal test tasks', async () => {
  const calls = [];
  const report = await cleanSandbox3TestTasks({ token: 'test-token', accountId: 'd740a05e9442c1d0feacae2dfc673e93',
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return response({ meta: { changed_db: false, rows_written: 0 }, results: [{
        tagged: 3, terminal: 2, nonterminal: 1, terminal_with_external_refs: 0,
      }] });
    } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /profile_id = \?/);
  assert.match(calls[0].sql, /request_id GLOB \?/);
  assert.deepEqual(calls[0].params, ['integration-sandbox3-v1', 'sandbox3-test-*']);
  assert.equal(report.mode, 'dry_run');
  assert.equal(report.deletedTasks, 0);
  assert.equal(report.retainedNonterminalTasks, 1);
});

test('apply deletes only terminal tagged tasks without non-cascading references', async () => {
  const calls = [];
  const report = await cleanSandbox3TestTasks({ token: 'test-token', accountId: 'd740a05e9442c1d0feacae2dfc673e93', apply: true,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); calls.push(body);
      return calls.length === 1
        ? response({ meta: { changed_db: false, rows_written: 0 }, results: [{ tagged: 2, terminal: 2, nonterminal: 0, terminal_with_external_refs: 1 }] })
        : response({ meta: { changed_db: true, rows_written: 1, changes: 2 } });
    } });
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /status IN \('done','failed','cancelled'\)/);
  assert.match(calls[1].sql, /NOT EXISTS \(SELECT 1 FROM gtd_records/);
  assert.equal(report.deletedTasks, 1);
  assert.equal(report.retainedTerminalTasksWithExternalReferences, 1);
});

test('refuses any profile/account mismatch and rejects unexpectedly large delete counts', async () => {
  await assert.rejects(cleanSandbox3TestTasks({ token: 'x', accountId: 'other' }), /account_or_token_invalid/);
  await assert.rejects(cleanSandbox3TestTasks({ token: 'x', accountId: 'd740a05e9442c1d0feacae2dfc673e93', apply: true,
    fetchImpl: async (_url, init) => response(JSON.parse(init.body).sql === SANDBOX3_TEST_CLEANUP_SQL.inspect
      ? { meta: { changed_db: false, rows_written: 0 }, results: [{ tagged: 1, terminal: 1, nonterminal: 0, terminal_with_external_refs: 0 }] }
      : { meta: { changed_db: true, rows_written: 2 } }) }), /write_contract_failed/);
});
