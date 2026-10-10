import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { TELEGRAM_UX_SANDBOX_CREDENTIALS } from '../src/deployment/telegram-ux-sandbox.ts';
import { FRANCE_WORKER, planAllowlistReconciliation, remoteProgram, safeSshFailure } from './reconcile-telegram-ux-france-worker.mjs';

const current = [
  'VM_WORKER_ALLOWED_REPOSITORIES=trained-assist/ai-agent-runner,trained-assist/other-test',
  'VM_WORKER_ALLOWED_CALLBACK_ORIGINS=https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev,https://other-sandbox.example.workers.dev',
  'VM_WORKER_TOKEN=do-not-read-or-copy-this-value',
].join('\n') + '\n';

test('adds Telegram UX allowlist entries while retaining all sandbox3 and unrelated entries', () => {
  const plan = planAllowlistReconciliation(current);
  assert.equal(plan.changed, true);
  assert.match(plan.text, /VM_WORKER_ALLOWED_REPOSITORIES=trained-assist\/ai-agent-runner,trained-assist\/other-test,vovalikessmoothy-png\/cp-telegram-ux-runner-sandbox\n/);
  assert.match(plan.text, /VM_WORKER_ALLOWED_CALLBACK_ORIGINS=https:\/\/trained-assist-runner-api-sandbox3\.skillset-apply\.workers\.dev,https:\/\/other-sandbox\.example\.workers\.dev,https:\/\/trained-assist-runner-api-telegram-ux-v1-sandbox\.skillset-apply\.workers\.dev\n/);
  assert.match(plan.text, /VM_WORKER_TOKEN=do-not-read-or-copy-this-value\n/);
  assert.equal(plan.counts.VM_WORKER_ALLOWED_REPOSITORIES.added, true);
});

test('is idempotent after the exact entries are present', () => {
  const once = planAllowlistReconciliation(current);
  const twice = planAllowlistReconciliation(once.text);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);
});

test('fails closed if an existing sandbox3 repository or callback origin is missing', () => {
  assert.throws(() => planAllowlistReconciliation(current.replace('trained-assist/ai-agent-runner,', '')), /worker_env_sandbox3_entry_missing/);
  assert.throws(() => planAllowlistReconciliation(current.replace('https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev,', '')), /worker_env_sandbox3_entry_missing/);
});

test('requires unique plain allowlist assignments and never modifies credentials', () => {
  assert.throws(() => planAllowlistReconciliation(current + 'VM_WORKER_ALLOWED_REPOSITORIES=another/repo\n'), /worker_env_duplicate/);
  assert.throws(() => planAllowlistReconciliation(current.replace('VM_WORKER_ALLOWED_REPOSITORIES=', 'VM_WORKER_ALLOWED_REPOSITORIES="')), /worker_env_value_not_plain_list/);
  assert.equal(FRANCE_WORKER.additions.VM_WORKER_ALLOWED_CALLBACK_ORIGINS, 'https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev');
});

test('remote Node payload is syntactically valid and includes fixed, sandbox-only values', () => {
  assert.doesNotThrow(() => new Script(remoteProgram));
  assert.match(remoteProgram, /workerId !== 'eu-vm2-sandbox'/);
  assert.match(remoteProgram, /worker_env_sandbox3_entry_missing/);
  assert.match(remoteProgram, /ai-agent-vm-worker/);
  assert.equal(FRANCE_WORKER.knownHost, TELEGRAM_UX_SANDBOX_CREDENTIALS.vm2SshKnownHostEntry);
});

test('SSH failures are reduced to a safe bounded diagnostic code', () => {
  assert.equal(safeSshFailure('worker_not_idle_and_ready\n', 1), 'remote_reconcile_failed:worker_not_idle_and_ready');
  assert.equal(safeSshFailure('Permission denied (publickey).\n', 255), 'ssh_authentication_rejected');
  assert.equal(safeSshFailure('Host key verification failed.\n', 255), 'ssh_host_key_rejected');
  assert.equal(safeSshFailure('arbitrary output containing a secret\n', 1), 'ssh_or_remote_failed_exit_1');
});
