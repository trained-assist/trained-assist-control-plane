#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { TELEGRAM_UX_SANDBOX, isSandboxReadinessEndpointMissing, validateSandboxBuildSha, validateTelegramUxSandboxConfig } from '../src/deployment/telegram-ux-sandbox.ts';

const configPath = 'wrangler.telegram-ux-v1.jsonc';
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`sandbox_command_failed:${command}`);
  return result.stdout ?? '';
}

async function keychainSecret() {
  if (process.platform !== 'darwin') throw new Error('macos_keychain_required');
  const secret = execFileSync('security', ['find-generic-password', '-s', TELEGRAM_UX_SANDBOX.keychainService, '-a', TELEGRAM_UX_SANDBOX.principalId, '-w'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (secret.length < 32) throw new Error('sandbox_keychain_secret_invalid');
  return secret;
}

async function validateAccount() {
  const output = run('npx', ['wrangler', 'whoami']);
  if (!output.includes(TELEGRAM_UX_SANDBOX.accountId) || !output.includes(TELEGRAM_UX_SANDBOX.accountEmail)) {
    throw new Error('cloudflare_account_mismatch');
  }
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

  const secretPut = spawnSync('npx', ['wrangler', 'secret', 'put', 'PRINCIPAL_SECRET_TELEGRAM_UX', '--config', configPath], {
    input: secret,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (secretPut.error || secretPut.status !== 0) throw new Error('sandbox_secret_sync_failed');
  run('npx', ['wrangler', 'deploy', '--config', configPath, '--var', `BUILD_SHA:${sourceSha}`], { stdio: 'inherit' });
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
    },
  });
  if (smoke.stdout) process.stdout.write(smoke.stdout);
  if (smoke.error || smoke.status !== 0) throw new Error('sandbox_post_deploy_smoke_failed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
