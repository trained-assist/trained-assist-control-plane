import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { cleanupTelegramUxRunnerTask, parseTelegramUxRunnerTaskIds, TELEGRAM_UX_PROFILE, TELEGRAM_UX_PRINCIPAL, TELEGRAM_UX_TENANT } from './telegram-ux-runner-task-cleanup.mjs';

const env = { RUNNER_API_KEY_AGENT_API: 'test-api-key', RUNNER_PROFILE_DELEGATION_SECRET: 'test-delegation-secret' };

test('uses the signed profile capability and clears exactly the requested task', async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev/v1/sandbox/cleanup-task');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { userTaskId: 'sandbox3-free-123' });
    assert.equal(init.headers.authorization, 'Bearer test-api-key');
    assert.equal(init.headers['x-agent-profile-id'], TELEGRAM_UX_PROFILE);
    assert.equal(init.headers['x-agent-profile-tenant'], TELEGRAM_UX_TENANT);
    const expiresAt = init.headers['x-agent-profile-exp'];
    const expected = createHmac('sha256', env.RUNNER_PROFILE_DELEGATION_SECRET)
      .update(`${TELEGRAM_UX_PRINCIPAL}\0${TELEGRAM_UX_TENANT}\0${TELEGRAM_UX_PROFILE}\0${expiresAt}`).digest('hex');
    assert.equal(init.headers['x-agent-profile-sig'], expected);
    return Response.json({ status: 'cleaned', userTaskId: 'sandbox3-free-123', deletedRuns: 1 });
  };
  assert.deepEqual(await cleanupTelegramUxRunnerTask({ userTaskId: 'sandbox3-free-123', env, fetchImpl }), { status: 'cleaned', deletedRuns: 1 });
});

test('keeps failures sanitized when a run is still active', async () => {
  await assert.rejects(cleanupTelegramUxRunnerTask({ userTaskId: 'sandbox3-free-123', env,
    fetchImpl: async () => Response.json({ error: { code: 'RUN_NOT_TERMINAL', message: 'private details' } }, { status: 409 }) }),
  /runner_cleanup_rejected:RUN_NOT_TERMINAL/);
});

test('rejects invalid IDs and missing credentials before a request', async () => {
  let called = false;
  await assert.rejects(cleanupTelegramUxRunnerTask({ userTaskId: '../other', env,
    fetchImpl: async () => { called = true; return Response.json({}); } }), /cleanup_task_id_invalid/);
  await assert.rejects(cleanupTelegramUxRunnerTask({ userTaskId: 'task-a', env: {},
    fetchImpl: async () => { called = true; return Response.json({}); } }), /cleanup_credentials_missing/);
  assert.equal(called, false);
});

test('parses only bounded, explicit task IDs and removes duplicates', () => {
  assert.deepEqual(parseTelegramUxRunnerTaskIds('ut-one, ut-two,ut-one'), ['ut-one', 'ut-two']);
  assert.throws(() => parseTelegramUxRunnerTaskIds(''), /cleanup_task_ids_invalid/);
  assert.throws(() => parseTelegramUxRunnerTaskIds('../other'), /cleanup_task_ids_invalid/);
  assert.throws(() => parseTelegramUxRunnerTaskIds(Array.from({ length: 21 }, (_, i) => `task-${i}`).join(',')), /cleanup_task_ids_invalid/);
});
