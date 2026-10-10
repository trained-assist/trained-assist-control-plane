import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const FRANCE_WORKER = {
  host: '169.58.15.230',
  user: 'root',
  knownHost: '169.58.15.230 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIqY97L/HqL+EjcMNau36t5E2BgVprJsPu18ZsGztv/f',
  service: 'ai-agent-vm-worker',
  envPath: '/etc/ai-agent-runner/worker.env',
  localUrl: 'http://127.0.0.1:8788',
  additions: {
    VM_WORKER_ALLOWED_REPOSITORIES: 'vovalikessmoothy-png/cp-telegram-ux-runner-sandbox',
    VM_WORKER_ALLOWED_CALLBACK_ORIGINS: 'https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev',
  },
  requiredExisting: {
    VM_WORKER_ALLOWED_REPOSITORIES: 'trained-assist/ai-agent-runner',
    VM_WORKER_ALLOWED_CALLBACK_ORIGINS: 'https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev',
  },
};

const evidencePath = process.env.GITHUB_WORKSPACE
  ? join(process.env.GITHUB_WORKSPACE, 'france-worker-allowlist-reconcile-evidence.json')
  : join(process.cwd(), 'france-worker-allowlist-reconcile-evidence.json');

export function planAllowlistReconciliation(envText, { additions = FRANCE_WORKER.additions, requiredExisting = FRANCE_WORKER.requiredExisting } = {}) {
  const lines = envText.split(/(?<=\n)/);
  const updated = new Map();
  const counts = {};
  for (const key of Object.keys(additions)) {
    const matching = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (new RegExp(`^${key}=`).test(lines[index])) matching.push(index);
    }
    if (matching.length !== 1) throw new Error(`worker_env_${matching.length ? 'duplicate' : 'missing'}:${key}`);
    const index = matching[0];
    const line = lines[index];
    const newline = line.endsWith('\n') ? '\n' : '';
    const rawValue = line.slice(key.length + 1, newline ? -1 : undefined).trim();
    if (!rawValue || /["'\s]/.test(rawValue)) throw new Error(`worker_env_value_not_plain_list:${key}`);
    const values = rawValue.split(',');
    if (values.some((item) => !item)) throw new Error(`worker_env_empty_list_item:${key}`);
    if (!values.includes(requiredExisting[key])) throw new Error(`worker_env_sandbox3_entry_missing:${key}`);
    const additionsForKey = additions[key].split(',');
    if (additionsForKey.some((item) => !item)) throw new Error(`worker_env_invalid_requested_addition:${key}`);
    const nextValues = [...values];
    for (const value of additionsForKey) if (!nextValues.includes(value)) nextValues.push(value);
    lines[index] = `${key}=${nextValues.join(',')}${newline}`;
    updated.set(key, nextValues.length);
    counts[key] = { currentCount: values.length, nextCount: nextValues.length, added: nextValues.length !== values.length };
  }
  return { text: lines.join(''), changed: [...updated.values()].some((next, index) => {
    const key = Object.keys(additions)[index];
    return counts[key].currentCount !== next;
  }), counts };
}

export function safeSshFailure(stderr, exitCode) {
  const lines = String(stderr ?? '').split(/\r?\n/).map((line) => line.trim());
  const remoteCode = lines.find((line) => /^worker_[a-z0-9_:-]{1,100}$/.test(line));
  if (remoteCode) return `remote_reconcile_failed:${remoteCode}`;
  if (/host key verification failed|remote host identification has changed/i.test(stderr ?? '')) return 'ssh_host_key_rejected';
  if (/permission denied \(publickey|permission denied, please try again/i.test(stderr ?? '')) return 'ssh_authentication_rejected';
  if (/a password is required|not allowed to execute|sudo:.*sorry/i.test(stderr ?? '')) return 'ssh_privilege_rejected';
  if (/connection timed out|no route to host|could not resolve hostname|connection refused/i.test(stderr ?? '')) return 'ssh_host_unreachable';
  if (/node: command not found|node: not found/i.test(stderr ?? '')) return 'vm_node_runtime_missing';
  return `ssh_or_remote_failed_exit_${Number.isInteger(exitCode) ? exitCode : 'unknown'}`;
}

// Sent to the VM over SSH stdin. The host only emits sanitized status metadata.
export const remoteProgram = String.raw`
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { join, dirname } = require('node:path');
const { randomBytes } = require('node:crypto');
const cfg = ${JSON.stringify(FRANCE_WORKER)};
function fail(code) { const error = new Error(code); error.safeCode = code; throw error; }
function plan(text) {
  const lines = text.split(/(?<=\n)/);
  const counts = {};
  for (const key of Object.keys(cfg.additions)) {
    const matches = [];
    for (let i = 0; i < lines.length; i++) if (new RegExp('^' + key + '=').test(lines[i])) matches.push(i);
    if (matches.length !== 1) fail('worker_env_' + (matches.length ? 'duplicate:' : 'missing:') + key);
    const i = matches[0], line = lines[i], nl = line.endsWith('\n') ? '\n' : '';
    const raw = line.slice(key.length + 1, nl ? -1 : undefined).trim();
    if (!raw || /["'\s]/.test(raw)) fail('worker_env_value_not_plain_list:' + key);
    const values = raw.split(',');
    if (values.some((v) => !v)) fail('worker_env_empty_list_item:' + key);
    if (!values.includes(cfg.requiredExisting[key])) fail('worker_env_sandbox3_entry_missing:' + key);
    const additions = cfg.additions[key].split(',');
    if (additions.some((v) => !v)) fail('worker_env_invalid_requested_addition:' + key);
    const next = [...values];
    for (const value of additions) if (!next.includes(value)) next.push(value);
    lines[i] = key + '=' + next.join(',') + nl;
    counts[key] = { currentCount: values.length, nextCount: next.length, added: next.length !== values.length };
  }
  return { text: lines.join(''), counts, changed: Object.values(counts).some((item) => item.added) };
}
async function get(path) {
  const response = await fetch(cfg.localUrl + path, { signal: AbortSignal.timeout(4000) });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, body };
}
async function ready() {
  const { ok, body } = await get('/readyz');
  return Boolean(ok && body?.ready === true && body?.checks?.activeRuns === 0 && body?.checks?.capacity?.activeReservations === 0);
}
function systemctl() {
  const result = spawnSync('systemctl', ['restart', cfg.service], { encoding: 'utf8', timeout: 30000, maxBuffer: 4096 });
  if (result.error || result.status !== 0) fail('worker_service_restart_failed');
}
async function waitReady(expectedSource, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await ready()) {
        const version = await get('/version');
        const source = version.body?.build?.sourceCommit;
        if (version.ok && source === expectedSource) return true;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}
async function atomicWrite(originalStat, text) {
  const temp = join(dirname(cfg.envPath), '.worker.env.reconcile-' + randomBytes(8).toString('hex'));
  try {
    await fs.writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    await fs.chown(temp, originalStat.uid, originalStat.gid);
    await fs.chmod(temp, originalStat.mode & 0o777);
    await fs.rename(temp, cfg.envPath);
  } finally { await fs.rm(temp, { force: true }); }
}
async function main() {
  const before = await get('/version');
  if (!before.ok || before.body?.worker?.workerId !== 'eu-vm2-sandbox' || !before.body?.build?.sourceCommit) fail('worker_identity_or_version_unavailable');
  const expectedSource = before.body.build.sourceCommit;
  if (!await ready()) fail('worker_not_idle_and_ready');
  const stat = await fs.stat(cfg.envPath);
  if (stat.uid !== 0 || (stat.mode & 0o077) !== 0) fail('worker_env_file_permissions_unexpected');
  const original = await fs.readFile(cfg.envPath, 'utf8');
  const result = plan(original);
  if (result.changed) {
    await atomicWrite(stat, result.text);
    try {
      systemctl();
      if (!await waitReady(expectedSource)) fail('worker_failed_post_restart_readiness');
    } catch (error) {
      await atomicWrite(stat, original);
      systemctl();
      if (!await waitReady(expectedSource)) fail('worker_rollback_readiness_failed');
      throw error;
    }
  }
  const finalReady = await ready();
  if (!finalReady) fail('worker_final_readiness_failed');
  process.stdout.write(JSON.stringify({ outcome: result.changed ? 'reconciled' : 'already_configured', workerId: 'eu-vm2-sandbox', sourceCommit: expectedSource, activeRuns: 0, activeReservations: 0, allowlists: result.counts, secretsIncluded: false }) + '\n');
}
if (process.env.WORKER_RECONCILE_EXECUTE === '1') main().catch((error) => {
  process.stderr.write((error.safeCode || 'worker_allowlist_reconcile_failed') + '\n');
  process.exitCode = 1;
});
`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 90_000, ...options });
  if (result.error || result.status !== 0) {
    if (command === 'ssh') throw new Error(safeSshFailure(result.stderr, result.status));
    throw new Error(`sandbox_reconcile_command_failed:${command}`);
  }
  return result.stdout ?? '';
}

async function main() {
  const privateKey = process.env.VM2_SSH_PRIVATE_KEY;
  if (!privateKey?.includes('PRIVATE KEY')) throw new Error('vm2_ssh_private_key_missing');
  const directory = await mkdtemp(join(tmpdir(), 'ta-france-worker-reconcile-'));
  const keyPath = join(directory, 'id_ed25519');
  const knownHostsPath = join(directory, 'known_hosts');
  try {
    await writeFile(keyPath, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, { mode: 0o600 });
    await writeFile(knownHostsPath, `${FRANCE_WORKER.knownHost}\n`, { mode: 0o600 });
    const remote = run('ssh', [
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${knownHostsPath}`, '-o', 'ConnectTimeout=10', '-i', keyPath,
      `${FRANCE_WORKER.user}@${FRANCE_WORKER.host}`, 'sudo -n env WORKER_RECONCILE_EXECUTE=1 node -',
    ], { input: remoteProgram });
    let result;
    try { result = JSON.parse(remote.trim()); } catch { throw new Error('worker_reconcile_response_invalid'); }
    if (!['reconciled', 'already_configured'].includes(result.outcome)
      || result.workerId !== 'eu-vm2-sandbox' || result.activeRuns !== 0 || result.activeReservations !== 0
      || result.secretsIncluded !== false) throw new Error('worker_reconcile_response_mismatch');
    const evidence = { schemaVersion: 1, ...result, host: FRANCE_WORKER.host, envPath: FRANCE_WORKER.envPath, service: FRANCE_WORKER.service, callbackOrigin: FRANCE_WORKER.additions.VM_WORKER_ALLOWED_CALLBACK_ORIGINS, repository: FRANCE_WORKER.additions.VM_WORKER_ALLOWED_REPOSITORIES };
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ outcome: evidence.outcome, workerId: evidence.workerId, sourceCommit: evidence.sourceCommit, activeRuns: 0, activeReservations: 0, allowlists: evidence.allowlists, secretsIncluded: false })}\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    const code = /^(?:sandbox_reconcile_command_failed:|remote_reconcile_failed:|ssh_(?:host_key_rejected|authentication_rejected|privilege_rejected|host_unreachable|or_remote_failed_exit_))|^vm_node_runtime_missing$/.test(error.message)
      ? error.message : 'france_worker_allowlist_reconcile_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
