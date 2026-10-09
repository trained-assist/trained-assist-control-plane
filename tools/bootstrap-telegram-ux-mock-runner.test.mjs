import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const secret = 'synthetic-bootstrap-secret-for-tests-0123456789';
async function exercise(mode, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cp-bootstrap-test-'));
  try {
    const bin = join(root, 'bin');
    await mkdir(bin);
    for (const tool of ['npx', 'ssh', 'gh']) {
      const stub = join(bin, `${tool}.mjs`);
      await writeFile(stub, `import fs from 'node:fs';
const args=process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG,JSON.stringify({tool:'${tool}',args})+'\\n');
if('${tool}'==='gh') { console.error('Resource not accessible by integration '+process.env.CF_API_TOKEN);process.exit(1); }
if('${tool}'==='ssh') {
 if(args.at(-1)==='hostname -s') console.log(process.env.TEST_HOST ?? 'vmi3617957');
 else console.log(JSON.stringify({status:'registered',principalId:'integration-telegram-ux-v1-mock-test',profileId:'integration-telegram-ux-v1-mock-test',tenantId:'integration-telegram-ux-v1-mock-test'}));
} else if(args.includes('whoami')) console.log('d740a05e9442c1d0feacae2dfc673e93');
else if(args.includes('execute')) {
 if(process.env.TEST_DENIED){console.error('permission denied '+process.env.CF_API_TOKEN);process.exit(1);}
 console.log(JSON.stringify([{success:true,results:fs.readdirSync('migrations').filter(x=>x.endsWith('.sql')).map(name=>({name}))}]));
}`);
      await writeFile(join(bin, tool), `#!/bin/sh\nexec '${process.execPath}' '${stub}' "$@"\n`, { mode: 0o700 });
    }
    const preload = join(root, 'fetch.mjs');
    await writeFile(preload, `globalThis.fetch=async url=>{
 if(url.startsWith('https://raw.githubusercontent.com/')) return new Response('tampered-script');
 if(url.endsWith('/healthz')) return Response.json({service:'trained-assist-control-plane',check:'liveness',buildSha:process.env.GITHUB_SHA});
 if(url.endsWith('/internal/sandbox/readiness')){const count=Number(process.env.TEST_BUSY??0);return Response.json({ok:count===0,principalId:'integration-telegram-ux-v1',profileId:process.env.TEST_PROFILE??'integration-telegram-ux-v1',reasonCode:count?'sandbox_lane_has_nonterminal_task':null,nonterminalTaskCount:count},{status:count?409:200});}
 if(url.endsWith('/internal/runner/profile-health')) return Response.json({runnerApi:'reachable',profileId:'integration-telegram-ux-v1'});
 if(url.endsWith('/internal/sandbox/runner-mock-probe')) return Response.json({ok:true,runnerState:'succeeded',answer:'pong',runnerOutcome:'succeeded',runId:'synthetic_run',sideEffects:{runnerAdmissionPersisted:true,cpTaskCreated:false,workerOrModelCalled:false}});
 throw new Error('unexpected request');
};`);
    const log = join(root, 'commands.jsonl');
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', preload,
      'tools/bootstrap-telegram-ux-mock-runner.mjs', mode], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_WORKSPACE: root,
        GITHUB_SHA: 'a'.repeat(40), CF_API_TOKEN: secret, CP_TELEGRAM_UX_PRINCIPAL_SECRET: secret,
        VM2_SSH_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----',
        RUNNER_MOCK_KEY_SEED: '', TEST_LOG: log, ...overrides },
      encoding: 'utf8', timeout: 20_000,
    });
    assert.ifError(result.error);
    const evidence = JSON.parse(await readFile(join(root, 'sandbox-bootstrap-evidence.json'), 'utf8'));
    const commands = (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
    assert.equal(`${result.stdout}${result.stderr}${JSON.stringify(evidence)}`.includes(secret), false);
    return { result, evidence, commands };
  } finally { await rm(root, { recursive: true, force: true }); }
}
function assertReadOnly(commands) {
  for (const { tool, args } of commands) {
    if (tool === 'ssh') assert.equal(args.at(-1), 'hostname -s');
    else if (args.includes('execute')) assert.equal(args[args.indexOf('--command') + 1], 'SELECT name FROM d1_migrations');
    else assert.deepEqual(args, ['wrangler', 'whoami']);
  }
}
test('preflight verifies existing boundaries without provisioning a key or mutating shared state', async () => {
  const { result, evidence, commands } = await exercise('--preflight');
  assert.equal(result.status, 0);
  assert.equal(evidence.outcome, 'preflight_passed');
  assert.equal(evidence.pendingMigrationCount, 0);
  for (const name of ['sandboxMigrationRead', 'runnerSshIdentity', 'authenticatedLaneReadiness', 'authenticatedProfileHealth']) assert.equal(evidence.boundaries[name], 'PASS');
  for (const name of ['sandboxMigrations', 'sandboxDeploy', 'runnerPrincipalProvisioning', 'cpMockKeySync', 'authenticatedCpToRunnerProbe']) assert.equal(evidence.boundaries[name], 'NOT_RUN');
  assertReadOnly(commands);
});
test('busy shared lane blocks reuse while independent profile diagnostics still run', async () => {
  const { result, evidence, commands } = await exercise('--preflight', { TEST_BUSY: '55' });
  assert.equal(result.status, 1);
  assert.equal(evidence.failure.reasonCode, 'sandbox_lane_has_nonterminal_task');
  assert.equal(evidence.nonterminalTaskCount, 55);
  assert.equal(evidence.boundaries.authenticatedProfileHealth, 'PASS');
  assertReadOnly(commands);
});
test('D1 access failure identifies the read boundary without leaking output', async () => {
  const { evidence, commands } = await exercise('--preflight', { TEST_DENIED: '1' });
  assert.deepEqual(evidence.failure, { boundary: 'sandboxMigrationRead', reasonCode: 'cloudflare_permission_denied:npx:1' });
  assert.equal(evidence.boundaries.runnerSshIdentity, 'PASS');
  assertReadOnly(commands);
});
test('SSH host mismatch is blocked while independent authenticated reads continue', async () => {
  const { evidence, commands } = await exercise('--preflight', { TEST_HOST: 'wrong-host' });
  assert.equal(evidence.failure.reasonCode, 'runner_ssh_host_identity_mismatch');
  assert.equal(evidence.boundaries.authenticatedProfileHealth, 'PASS');
  assertReadOnly(commands);
});
test('unknown mode refuses before network commands', async () => {
  const { evidence, commands } = await exercise('--anything');
  assert.equal(evidence.failure.reasonCode, 'sandbox_bootstrap_mode_invalid');
  assert.deepEqual(commands, []);
});
test('authenticated readiness for a different durable profile fails closed', async () => {
  const { evidence, commands } = await exercise('--preflight', { TEST_PROFILE: 'other-profile' });
  assert.equal(evidence.failure.reasonCode, 'sandbox_lane_identity_mismatch');
  assertReadOnly(commands);
});
test('explicit bootstrap retains paired-key provisioning and the mock probe', async () => {
  const { result, evidence, commands } = await exercise('--bootstrap', { RUNNER_MOCK_KEY_SEED: secret });
  assert.equal(result.status, 0);
  assert.equal(evidence.outcome, 'passed');
  assert.equal(evidence.boundaries.authenticatedCpToRunnerProbe, 'PASS');
  assert.equal(commands.some(x => x.args.includes('deploy')), true);
  assert.equal(commands.some(x => x.args.includes('secret')), true);
});
test('inventory refuses a substituted operator helper before sending any script over SSH', async () => {
  const { evidence, commands } = await exercise('--inventory');
  assert.equal(evidence.failure.reasonCode, 'runner_inventory_script_digest_mismatch');
  assert.equal(evidence.boundaries.runnerAdmissionInventory, 'BLOCKED');
  assertReadOnly(commands);
});

test('explicit permission repair verifies helper bytes before mutation and still runs inventory', async () => {
  const { evidence, commands } = await exercise('--repair-permissions');
  assert.equal(evidence.mode, 'repair-permissions');
  assert.equal(evidence.failure.boundary, 'runnerInventoryPermissions');
  assert.equal(evidence.boundaries.runnerInventoryPermissions, 'BLOCKED');
  assert.equal(evidence.boundaries.runnerAdmissionInventory, 'BLOCKED');
  assertReadOnly(commands);
});

test('candidate preflight identifies cross-repository artifact access without server mutation', async () => {
  const { evidence, commands } = await exercise('--candidate-preflight');
  assert.equal(evidence.mode, 'candidate-preflight');
  assert.equal(evidence.failure.boundary, 'runnerCandidateVerification');
  assert.equal(evidence.failure.reasonCode, 'github_permission_denied:gh:1');
  assert.equal(evidence.boundaries.runnerAdmissionInventory, 'NOT_RUN');
  assertReadOnly(commands.filter(x => x.tool !== 'gh'));
  assert.deepEqual(commands.filter(x => x.tool === 'gh').map(x => x.args.slice(0, 2)), [['run', 'view']]);
});
