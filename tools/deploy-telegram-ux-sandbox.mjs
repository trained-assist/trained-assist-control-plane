#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { TELEGRAM_UX_SANDBOX, isExpectedTelegramUxCloudflareAccount, isSandboxReadinessEndpointMissing, validateSandboxBuildSha, validateTelegramUxSandboxConfig } from '../src/deployment/telegram-ux-sandbox.ts';

const configPath = 'wrangler.telegram-ux-v1.jsonc';
const RUNNER_API_URL = 'https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev';
const RUNNER_DELEGATION_TENANT = 'telegram-ux-sandbox-20261009';
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`sandbox_command_failed:${command}`);
  return result.stdout ?? '';
}

async function keychainSecret() {
  if (process.platform !== 'darwin') throw new Error('macos_keychain_required');
  const service = JSON.stringify(TELEGRAM_UX_SANDBOX.keychainService);
  const account = JSON.stringify(TELEGRAM_UX_SANDBOX.principalId);
  const swift = `import Foundation
import Security
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: ${service},
  kSecAttrAccount as String: ${account},
  kSecReturnData as String: true,
  kSecMatchLimit as String: kSecMatchLimitOne,
]
var item: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &item)
guard status == errSecSuccess, let data = item as? Data,
  let secret = String(data: data, encoding: .utf8) else {
  fputs("keychain_read_failed\\n", stderr)
  exit(1)
}
print(secret)`;
  const result = spawnSync('swift', ['-e', swift], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('sandbox_keychain_read_failed');
  const secret = result.stdout.trim();
  if (secret.length < 32) throw new Error('sandbox_keychain_secret_invalid');
  return secret;
}

async function validateAccount() {
  const output = run('npx', ['wrangler', 'whoami']);
  if (!isExpectedTelegramUxCloudflareAccount(output)) throw new Error('cloudflare_account_mismatch');
}

function optionalSecret(name) {
  const value = process.env[name]?.trim();
  if (!value || value.length < 32) throw new Error(`sandbox_runner_secret_missing:${name}`);
  return value;
}

function putWorkerSecret(name, value) {
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', name, '--config', configPath], {
    input: `${value}\n`, encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`sandbox_worker_secret_sync_failed:${name}`);
}

async function livenessProbe(expectedBuildSha = null) {
  let response;
  try {
    response = await fetch('https://trained-assist-cp-telegram-ux-v1-sandbox.skillset-apply.workers.dev/healthz', {
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('sandbox_worker_unreachable');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.service !== 'trained-assist-control-plane' || body.check !== 'liveness') {
    throw new Error('sandbox_worker_liveness_failed');
  }
  const buildSha = typeof body.buildSha === 'string' ? body.buildSha : null;
  if (expectedBuildSha && buildSha !== expectedBuildSha) throw new Error('sandbox_worker_build_sha_mismatch');
  return { status: 'PASS', buildSha };
}

async function readinessProbe(secret, { allowBlocked = false, allowMissing = false } = {}) {
  const signature = createHmac('sha256', secret).update(TELEGRAM_UX_SANDBOX.principalId).digest('hex');
  let response;
  try {
    response = await fetch('https://trained-assist-cp-telegram-ux-v1-sandbox.skillset-apply.workers.dev/internal/sandbox/readiness', {
      headers: { 'x-principal': TELEGRAM_UX_SANDBOX.principalId, 'x-principal-sig': signature },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('sandbox_readiness_unreachable');
  }
  const body = await response.json().catch(() => ({}));
  if (allowMissing && isSandboxReadinessEndpointMissing(response.status, body)) return { lane: 'not_deployed' };
  if ((!response.ok || body?.ok !== true) && !(allowBlocked && response.status === 409 && body?.reasonCode === 'sandbox_lane_has_nonterminal_task')) {
    throw new Error(body?.reasonCode || 'sandbox_readiness_failed');
  }
  return { buildSha: typeof body.buildSha === 'string' ? body.buildSha : null,
    principalId: body.principalId, profileId: body.profileId, scopes: body.scopes,
    lane: body.ok ? 'clear' : 'blocked', taskCount: body.taskCount ?? null,
    nonterminalTaskCount: body.nonterminalTaskCount ?? null };
}

async function cleanupSmokeTask(userTaskId, requestId) {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{8,100}$/.test(userTaskId)
    || !/^sde-[0-9]{14}-[0-9a-f-]{36}$/.test(requestId)) {
    throw new Error('sandbox_smoke_cleanup_input_invalid');
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${TELEGRAM_UX_SANDBOX.accountId}`
    + `/d1/database/${TELEGRAM_UX_SANDBOX.databaseId}/query`;
  const eligible = `id = ? AND profile_id = ? AND request_id = ?
    AND (goal = 'Sandbox contract smoke ' || request_id)
    AND status IN ('active','failed','done','cancelled') AND stage = 'queued'
    AND execution_session_id IS NULL
    AND EXISTS (SELECT 1 FROM task_events e WHERE e.user_task_id = durable_tasks.id
      AND e.kind = 'task_accepted' AND json_extract(e.payload_json, '$.requestId') = durable_tasks.request_id
      AND json_extract(e.payload_json, '$.principalId') = 'integration-telegram-ux-v1'
      AND json_extract(e.payload_json, '$.requestedExecutionPolicy') = 'accept_only')
    AND NOT EXISTS (SELECT 1 FROM executions x WHERE x.task_id = durable_tasks.id)
    AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.user_task_id = durable_tasks.id)
    AND NOT EXISTS (SELECT 1 FROM task_artifacts a WHERE a.user_task_id = durable_tasks.id)
    AND NOT EXISTS (SELECT 1 FROM credential_completions c WHERE c.user_task_id = durable_tasks.id)
    AND NOT EXISTS (SELECT 1 FROM awaiting_inputs a WHERE a.user_task_id = durable_tasks.id)
    AND NOT EXISTS (SELECT 1 FROM pending_inputs p WHERE p.user_task_id = durable_tasks.id)
    AND NOT EXISTS (SELECT 1 FROM gtd_records g WHERE g.user_task_id = durable_tasks.id)
    AND NOT EXISTS (SELECT 1 FROM gtd_outcomes g WHERE g.user_task_id = durable_tasks.id)
    AND NOT EXISTS (SELECT 1 FROM gtd_progressions g WHERE g.user_task_id = durable_tasks.id)
    AND NOT EXISTS (SELECT 1 FROM gtd_conditions g WHERE g.user_task_id = durable_tasks.id)
    AND NOT EXISTS (SELECT 1 FROM schedule_occurrences s WHERE s.user_task_id = durable_tasks.id)`;
  const query = async (sql, params) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success !== true) throw new Error(`sandbox_smoke_cleanup_query_failed:${response.status}`);
    return body.result?.[0];
  };
  const inspect = await query(`SELECT id FROM durable_tasks WHERE ${eligible}`,
    [userTaskId, TELEGRAM_UX_SANDBOX.principalId, requestId]);
  if (inspect?.meta?.changed_db !== false || inspect?.meta?.rows_written !== 0) {
    throw new Error('sandbox_smoke_cleanup_read_only_contract_failed');
  }
  const rows = inspect.results ?? [];
  if (rows.length === 0) return { deleted: false, reason: 'not_an_isolated_accept_only_smoke' };
  if (rows.length !== 1 || rows[0].id !== userTaskId) throw new Error('sandbox_smoke_cleanup_scope_failed');

  const removed = await query(`DELETE FROM durable_tasks WHERE ${eligible}`,
    [userTaskId, TELEGRAM_UX_SANDBOX.principalId, requestId]);
  if (removed?.meta?.changed_db !== true || removed?.meta?.rows_written !== 1) {
    throw new Error('sandbox_smoke_cleanup_write_contract_failed');
  }
  const verified = await query('SELECT COUNT(*) AS remaining FROM durable_tasks WHERE id = ?', [userTaskId]);
  if (verified?.meta?.changed_db !== false || verified?.meta?.rows_written !== 0
    || verified.results?.[0]?.remaining !== 0) throw new Error('sandbox_smoke_cleanup_verify_failed');
  return { deleted: true, reason: 'isolated_accept_only_smoke' };
}

async function main(args = process.argv.slice(2)) {
  if (!['--preflight', '--deploy'].includes(args[0]) || args.length !== 1) {
    throw new Error('usage: node tools/deploy-telegram-ux-sandbox.mjs --preflight|--deploy');
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  validateTelegramUxSandboxConfig(config);
  const sourceSha = validateSandboxBuildSha(run('git', ['rev-parse', 'HEAD']).trim());
  await validateAccount();
  const secret = await keychainSecret();
  if (args[0] === '--preflight') {
    const liveness = await livenessProbe();
    const readiness = await readinessProbe(secret, { allowBlocked: true, allowMissing: true });
    console.log(JSON.stringify({ ok: readiness.lane !== 'blocked', mode: 'preflight',
      worker: TELEGRAM_UX_SANDBOX.workerName, secretName: 'PRINCIPAL_SECRET_TELEGRAM_UX',
      liveness, authenticatedReadiness: readiness.lane, ...readiness }));
    if (readiness.lane === 'blocked') throw new Error('sandbox_lane_has_nonterminal_task');
    return;
  }
  await livenessProbe();

  const apiKey = optionalSecret('RUNNER_API_KEY_AGENT_API');
  const delegationSecret = optionalSecret('RUNNER_PROFILE_DELEGATION_SECRET');
  for (const [name, value] of [['RUNNER_API_KEY_AGENT_API', apiKey],
    ['RUNNER_PROFILE_DELEGATION_SECRET', delegationSecret]]) putWorkerSecret(name, value);

  const secretPut = spawnSync('npx', ['wrangler', 'secret', 'put', 'PRINCIPAL_SECRET_TELEGRAM_UX', '--config', configPath], {
    input: secret,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (secretPut.error || secretPut.status !== 0) throw new Error('sandbox_secret_sync_failed');
  run('npx', ['wrangler', 'deploy', '--config', configPath, '--var', `BUILD_SHA:${sourceSha}`,
    '--var', 'RUNNER_API_ENGINE_SELECTION:agent_api', '--var', `RUNNER_API_URL:${RUNNER_API_URL}`,
    '--var', `RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID:${TELEGRAM_UX_SANDBOX.principalId}`,
    '--var', `RUNNER_PROFILE_DELEGATION_TENANT_ID:${RUNNER_DELEGATION_TENANT}`], { stdio: 'inherit' });
  const liveness = await livenessProbe(sourceSha);
  const readiness = await readinessProbe(secret);
  console.log(JSON.stringify({ ok: true, mode: 'deploy', worker: TELEGRAM_UX_SANDBOX.workerName,
    sourceSha, secretName: 'PRINCIPAL_SECRET_TELEGRAM_UX', liveness, ...readiness }));

  // The legacy smoke admits a new durable task, so it stays an explicit post-readiness check.
  const smoke = spawnSync(process.execPath, ['tools/integration-v1-smoke.mjs'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      CP_INTEGRATION_V1_URL: 'https://trained-assist-cp-telegram-ux-v1-sandbox.skillset-apply.workers.dev',
      CP_INTEGRATION_V1_PRINCIPAL_ID: TELEGRAM_UX_SANDBOX.principalId,
      CP_INTEGRATION_V1_PRINCIPAL_SECRET: secret,
      CP_INTEGRATION_V1_PROFILE_ID: TELEGRAM_UX_SANDBOX.principalId,
      CP_INTEGRATION_V1_RUNNER_PROBE: process.env.CP_INTEGRATION_V1_RUNNER_PROBE ?? 'true',
    },
  });
  const smokeOutput = `${smoke.stdout ?? ''}\n${smoke.stderr ?? ''}`;
  const taskMatch = smokeOutput.match(/"userTaskId":"([A-Za-z0-9_-]+)"/);
  const requestMatch = smokeOutput.match(/"requestId":"(sde-[0-9]{14}-[0-9a-f-]{36})"/);
  if (taskMatch && requestMatch) {
    const cleanup = await cleanupSmokeTask(taskMatch[1], requestMatch[1]);
    console.log(JSON.stringify({ sandboxSmokeCleanup: cleanup }));
  }
  if (smoke.stdout) process.stdout.write(smoke.stdout);
  if (smoke.error || smoke.status !== 0) {
    if (smoke.stderr) process.stderr.write(smoke.stderr);
    throw new Error('sandbox_post_deploy_smoke_failed');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
