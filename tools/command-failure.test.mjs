import test from 'node:test';
import assert from 'node:assert/strict';
import { commandFailureReason } from './command-failure.mjs';

test('classifies common Wrangler and D1 failures without returning raw output', () => {
  const secretText = 'invalid API token ta_secret_value_should_never_escape';
  const reason = commandFailureReason('npx', { status: 1, stdout: '', stderr: secretText });
  assert.equal(reason, 'cloudflare_authentication_failed:npx:1');
  assert.equal(reason.includes(secretText), false);
  assert.equal(reason.includes('ta_secret_value_should_never_escape'), false);
});

test('classifies D1 target, migration, network, and permission errors', () => {
  assert.equal(commandFailureReason('npx', { status: 1, stderr: 'database does not exist' }),
    'd1_target_unavailable:npx:1');
  assert.equal(commandFailureReason('npx', { status: 1, stderr: 'failed to apply migration' }),
    'd1_migration_failed:npx:1');
  assert.equal(commandFailureReason('npx', { status: 1, stderr: 'fetch failed: ECONNRESET' }),
    'cloudflare_api_unreachable:npx:1');
  assert.equal(commandFailureReason('npx', { status: 1, stderr: 'permission denied' }),
    'cloudflare_permission_denied:npx:1');
});

test('uses safe command and spawn failure codes', () => {
  assert.equal(commandFailureReason('not-a-command', { status: 1, stderr: 'anything' }),
    'command_failed:command:1');
  assert.equal(commandFailureReason('npx', { error: { code: 'ENOENT' } }), 'command_unavailable:npx');
  assert.equal(commandFailureReason('ssh', { error: { code: 'EACCES', message: 'private detail' } }),
    'command_spawn_failed:ssh');
  assert.equal(commandFailureReason('ssh', { status: 255, stderr: 'Permission denied (publickey)' }),
    'runner_ssh_authentication_failed:ssh:255');
  assert.equal(commandFailureReason('ssh', { status: 255, stderr: 'Connection timed out' }),
    'runner_ssh_unreachable:ssh:255');
});

test('verified installer failure precedes incidental curl errors and strips output', () => {
  const result = { status: 1, stderr: 'curl: connection refused\n[sandbox3-api] ERROR: API did not become healthy\nprivate-secret' };
  assert.equal(commandFailureReason('ssh', result), 'sandbox3_api_unhealthy:ssh:1');
  assert.equal(commandFailureReason('ssh', { status: 1, stderr: '[sandbox3-api] ERROR: private-secret' }), 'command_failed:ssh:1');
});
