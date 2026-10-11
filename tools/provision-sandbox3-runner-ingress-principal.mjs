#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const accountId = 'd740a05e9442c1d0feacae2dfc673e93';
const principalId = 'sandbox3-vm2-ingress-reader-v1';
const profileId = 'integration-sandbox3-v1';
const database = 'ta-sandbox3-taskstore';

if (!process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_ACCOUNT_ID !== accountId) {
  throw new Error('sandbox3_cloudflare_credentials_or_account_invalid');
}

function wrangler(args) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    env: process.env,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('sandbox3_runner_ingress_principal_d1_operation_failed');
  return result.stdout;
}

function query(sql) {
  let output;
  try {
    output = JSON.parse(wrangler([
      'd1', 'execute', database, '--remote', '--json', '--config', 'wrangler.sandbox3.jsonc', '--command', sql,
    ]));
  } catch {
    throw new Error('sandbox3_runner_ingress_principal_d1_response_invalid');
  }
  if (!Array.isArray(output) || output.length !== 1 || output[0].success !== true || !Array.isArray(output[0].results)) {
    throw new Error('sandbox3_runner_ingress_principal_d1_response_invalid');
  }
  return output[0].results;
}

const select = `SELECT principal_id, profile_id, scopes, enabled FROM admission_principals WHERE principal_id = '${principalId}'`;
let rows = query(select);
if (rows.length === 0) {
  const now = Date.now();
  query(`INSERT INTO admission_principals (principal_id, profile_id, scopes, enabled, created_at, updated_at) VALUES ('${principalId}', '${profileId}', '["tasks:read"]', 1, ${now}, ${now})`);
  rows = query(select);
}

if (rows.length !== 1) throw new Error('sandbox3_runner_ingress_principal_not_unique');
const row = rows[0];
let scopes;
try { scopes = JSON.parse(row.scopes); } catch { throw new Error('sandbox3_runner_ingress_principal_scope_invalid'); }
if (row.profile_id !== profileId || row.enabled !== 1 || JSON.stringify(scopes) !== '["tasks:read"]') {
  throw new Error('sandbox3_runner_ingress_principal_existing_binding_mismatch');
}

process.stdout.write(`Provisioned ${principalId} for ${profileId} with tasks:read only.\n`);
