#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { TELEGRAM_UX_SANDBOX, validateTelegramUxSandboxConfig } from '../src/deployment/telegram-ux-sandbox.ts';

const configPath = 'wrangler.telegram-ux-v1.jsonc';
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error('sandbox_command_failed');
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

async function main(args = process.argv.slice(2)) {
  if (!['--preflight', '--deploy'].includes(args[0]) || args.length !== 1) {
    throw new Error('usage: node tools/deploy-telegram-ux-sandbox.mjs --preflight|--deploy');
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  validateTelegramUxSandboxConfig(config);
  await validateAccount();
  const secret = await keychainSecret();
  if (args[0] === '--preflight') {
    console.log(JSON.stringify({ ok: true, mode: 'preflight', worker: TELEGRAM_UX_SANDBOX.workerName,
      principalId: TELEGRAM_UX_SANDBOX.principalId }));
    return;
  }

  const secretPut = spawnSync('npx', ['wrangler', 'secret', 'put', 'PRINCIPAL_SECRET_TELEGRAM_UX', '--config', configPath], {
    input: secret,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (secretPut.error || secretPut.status !== 0) throw new Error('sandbox_secret_sync_failed');

  run('npx', ['wrangler', 'deploy', '--config', configPath], { stdio: 'inherit' });

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
