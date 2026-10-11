import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSandbox3Lane, sandbox3FailureReason, SANDBOX3_RUNNER_URL } from './sandbox3-lane-preflight.mjs';

const plain = (name, text) => ({ name, type: 'plain_text', text });
const state = (name, id, type = 'kv_namespace') => ({ name, type, id });
const ready = () => ({
  cpHealth: { service: 'trained-assist-control-plane', check: 'liveness', buildSha: 'a'.repeat(40) },
  cpBindings: [
    { name: 'DB', type: 'd1', id: '1e1b8108-9186-43e2-8e50-436598233165' },
    { name: 'TASK_WORKFLOW', type: 'workflow', workflow_name: 'ta-cp-sandbox3-task-workflow' },
    { name: 'RUNNER_API_SERVICE', type: 'service', service: 'trained-assist-runner-api-sandbox3' },
    { name: 'COMMUNICATION_SERVICE', type: 'service', service: 'trained-assist-communication-v1-sandbox' },
    { name: 'PRINCIPAL_SECRET_SANDBOX3', type: 'secret_text' },
    plain('RUNNER_API_URL', SANDBOX3_RUNNER_URL),
    plain('COMMUNICATION_API_URL', 'https://trained-assist-communication-v1-sandbox.skillset-apply.workers.dev'),
    plain('COMMUNICATION_TIMEOUT_MS', '20000'),
    { name: 'RUNNER_API_KEY_AGENT_API', type: 'secret_text' },
    { name: 'RUNNER_PROFILE_DELEGATION_SECRET', type: 'secret_text' },
    plain('RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID', 'sandbox3-agent-api-principal'),
    plain('RUNNER_PROFILE_DELEGATION_TENANT_ID', 'sandbox3-acceptance-a-20261008'),
    plain('SANDBOX_RUNNER_MOCK_TEST_URL', 'https://trained-assist-runner-api-cp-sandbox3.skillset-apply.workers.dev'),
    { name: 'RUNNER_API_KEY_SANDBOX3_MOCK_TEST', type: 'secret_text' },
    plain('PREVIEW_ONLY', 'false'), plain('PILOT_ENABLED', 'true'),
    plain('PILOT_ACTIVATED_AT', '2026-10-11T00:00:00Z'), plain('PILOT_COHORT_PROFILE_IDS', 'integration-sandbox3-v1'),
    plain('ROUTER_AGENT_ALLOWED', 'true'),
    plain('ROUTER_SELECTOR', 'communication_v1'), plain('ROUTER_SELECTOR_NAMES_ONLY', 'false'),
    plain('ROUTER_CONTINUATION_ENABLED', 'true'), plain('RUNNER_API_ENGINE_SELECTION', 'agent_api'),
  ],
  cpSecretNames: ['COMMUNICATION_TOKEN'],
  tgBindings: [
    state('INTAKE', 'sandbox3-do', 'durable_object_namespace'), state('SESSIONS', 'sandbox3-kv'),
    state('TG_SLICE', 'sandbox3-slice'),
    plain('CONTROL_PLANE_URL', 'https://trained-assist-cp-sandbox3.skillset-apply.workers.dev'),
    plain('CONTROL_PLANE_PRINCIPAL', 'integration-sandbox3-v1'),
    plain('CONTROL_PLANE_PROFILE', 'integration-sandbox3-v1'),
    { name: 'CONTROL_PLANE_PRINCIPAL_SIGNATURE', type: 'secret_text' },
  ],
  otherGatewayBindings: [[state('SESSIONS', 'other-kv')]],
  counts: { tasks: 0, executions: 0, nonterminalTasks: 0, foreignProfileTasks: 0, nonterminalExecutions: 0 },
  principalRows: [{ principal_id: 'integration-sandbox3-v1', profile_id: 'integration-sandbox3-v1',
    scopes: ['tasks:intake', 'tasks:read', 'tasks:control', 'tasks:signal'], enabled: 1 }],
});

test('configured resources still report that Runner journal and real E2E are unverified', () => {
  const report = evaluateSandbox3Lane(ready());
  assert.equal(report.outcome, 'CONFIGURED');
  assert.equal(report.runnerAdmissionJournal, 'NOT_VERIFIED');
  assert.equal(report.realTelegramE2E, 'NOT_RUN');
});

test('shared Telegram route, reused state and disabled execution block the lane', () => {
  const input = ready();
  input.tgBindings.find(item => item.name === 'CONTROL_PLANE_URL').text =
    'https://trained-assist-cp-telegram-ux-v1-sandbox.skillset-apply.workers.dev';
  input.tgBindings.find(item => item.name === 'SESSIONS').id = 'other-kv';
  input.cpBindings.find(item => item.name === 'PREVIEW_ONLY').text = 'true';
  const report = evaluateSandbox3Lane(input);
  assert.equal(report.outcome, 'BLOCKED');
  assert.equal(report.checks.tgRoute, 'BLOCKED');
  assert.equal(report.checks.tgStateIsolated, 'BLOCKED');
  assert.equal(report.checks.executionEnabled, 'BLOCKED');
});

test('execution readiness is restricted to one sandbox3 profile and requires activation time', () => {
  for (const [name, value] of [
    ['PILOT_COHORT_PROFILE_IDS', 'integration-sandbox3-v1,production-profile'],
    ['PILOT_COHORT_PROFILE_IDS', 'other-profile'],
    ['PILOT_ACTIVATED_AT', 'not-a-timestamp'],
  ]) {
    const input = ready();
    input.cpBindings.find(item => item.name === name).text = value;
    const report = evaluateSandbox3Lane(input);
    assert.equal(report.checks.executionEnabled, 'BLOCKED');
    assert.equal(report.outcome, 'BLOCKED');
  }
});

test('sandbox3 blocks the legacy router and missing communication credentials', () => {
  const input = ready();
  input.cpBindings.find(item => item.name === 'ROUTER_SELECTOR').text = 'legacy';
  input.cpBindings = input.cpBindings.filter(item => item.name !== 'COMMUNICATION_SERVICE');
  input.cpSecretNames = [];
  const report = evaluateSandbox3Lane(input);
  assert.equal(report.checks.communicationV1Routing, 'BLOCKED');
  assert.equal(report.outcome, 'BLOCKED');
});

test('sandbox3 blocks physical engine pinning in CP and requires Agent API mode', () => {
  const input = ready();
  input.cpBindings = input.cpBindings.filter(item => item.name !== 'RUNNER_API_ENGINE_SELECTION');
  input.cpBindings.push(plain('ROUTER_AGENT_ENGINE', 'eu-vm-agent-run'));
  const report = evaluateSandbox3Lane(input);
  assert.equal(report.checks.communicationV1Routing, 'BLOCKED');
  assert.equal(report.checks.agentApiBindings, 'BLOCKED');
});

test('live Runner bindings reject a mismatched delegated principal or tenant', () => {
  for (const [name, value] of [
    ['RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID', 'canonical-telegram-ux'],
    ['RUNNER_PROFILE_DELEGATION_TENANT_ID', 'canonical-telegram-tenant'],
  ]) {
    const input = ready();
    input.cpBindings.find(item => item.name === name).text = value;
    const report = evaluateSandbox3Lane(input);
    assert.equal(report.checks.agentApiBindings, 'BLOCKED');
  }
});

test('expected deployment SHA mismatch blocks readiness even when health is live', () => {
  const report = evaluateSandbox3Lane({ ...ready(), expectedCpSha: 'b'.repeat(40) });
  assert.equal(report.checks.cpLiveness, 'BLOCKED');
  assert.equal(report.cpBuildSha, 'a'.repeat(40));
});

test('absent or foreign principal blocks the lane without leaking scope values', () => {
  const input = ready();
  input.principalRows = [{ principal_id: 'integration-telegram-ux-v1',
    profile_id: 'integration-telegram-ux-v1', scopes: ['tasks:read'], enabled: 1 }];
  assert.equal(evaluateSandbox3Lane(input).checks.cpPrincipal, 'BLOCKED');
});

test('the paired read-only operator does not invalidate the Telegram intake identity', () => {
  const input = ready();
  input.principalRows.push({ principal_id: 'sandbox3-ops-read-v1', profile_id: 'integration-sandbox3-v1',
    scopes: ['tasks:read'], enabled: 1 });
  assert.equal(evaluateSandbox3Lane(input).checks.cpPrincipal, 'PASS');
  for (const patch of [{ enabled: 0 }, { profile_id: 'foreign' }, { scopes: ['tasks:read'] }]) {
    const changed = { ...input, principalRows: [{ ...input.principalRows[0], ...patch }, input.principalRows[1]] };
    assert.equal(evaluateSandbox3Lane(changed).checks.cpPrincipal, 'BLOCKED');
  }
  input.principalRows.push(input.principalRows[0]);
  assert.equal(evaluateSandbox3Lane(input).checks.cpPrincipal, 'BLOCKED');
});

test('terminal history permits repeat tests while nonterminal/foreign state blocks reuse', () => {
  const input = ready();
  input.counts = { tasks: 3, executions: 3, nonterminalTasks: 0, foreignProfileTasks: 0, nonterminalExecutions: 0 };
  assert.equal(evaluateSandbox3Lane(input).checks.cpStateReusable, 'PASS');
  for (const key of ['nonterminalTasks', 'foreignProfileTasks', 'nonterminalExecutions']) {
    assert.equal(evaluateSandbox3Lane({ ...input, counts: { ...input.counts, [key]: 1 } }).checks.cpStateReusable, 'BLOCKED');
  }
  assert.equal(evaluateSandbox3Lane({ ...input, counts: { tasks: 0, executions: 0 } }).checks.cpStateReusable, 'BLOCKED');
});

test('service binding override cannot redirect a passing URL route to shared CP', () => {
  const input = ready();
  input.tgBindings.push({ name: 'CONTROL_PLANE_SERVICE', type: 'service', service: 'trained-assist-cp-telegram-ux-v1-sandbox' });
  assert.equal(evaluateSandbox3Lane(input).checks.tgRoute, 'BLOCKED');
  input.tgBindings.at(-1).service = 'trained-assist-cp-sandbox3';
  assert.equal(evaluateSandbox3Lane(input).checks.tgRoute, 'PASS');
  input.tgBindings.at(-1).environment = 'foreign';
  assert.equal(evaluateSandbox3Lane(input).checks.tgRoute, 'BLOCKED');
});

test('Runner API binding names the France-dispatch Cloudflare Worker and rejects mock/VM endpoints', () => {
  const input = ready();
  for (const url of [
    'https://trained-assist-runner-api-cp-sandbox3.skillset-apply.workers.dev',
    'https://169-58-15-230.sslip.io/runner-sandbox3', 'https://production.example.test', '',
  ]) {
    input.cpBindings.find(item => item.name === 'RUNNER_API_URL').text = url;
    assert.equal(evaluateSandbox3Lane(input).checks.agentApiBindings, 'BLOCKED');
  }
  input.cpBindings.find(item => item.name === 'RUNNER_API_URL').text = SANDBOX3_RUNNER_URL;
  input.cpBindings.find(item => item.name === 'RUNNER_API_SERVICE').service = 'trained-assist-runner-api-cp-sandbox3';
  assert.equal(evaluateSandbox3Lane(input).checks.agentApiBindings, 'BLOCKED');
});

test('CP has no VM/GHA execution endpoint or service binding', () => {
  const input = ready();
  assert.equal(evaluateSandbox3Lane(input).checks.cpHasNoDirectExecutorBinding, 'PASS');
  input.cpBindings.push(plain('VM_WORKER_URL', 'https://vm.example.test'));
  assert.equal(evaluateSandbox3Lane(input).checks.cpHasNoDirectExecutorBinding, 'BLOCKED');
  input.cpBindings.pop();
  input.cpBindings.push({ name: 'EXECUTION', type: 'service', service: 'trained-assist-native-worker-sandbox3' });
  assert.equal(evaluateSandbox3Lane(input).checks.cpHasNoDirectExecutorBinding, 'BLOCKED');
});

test('preflight failures never emit arbitrary exception text', () => {
  assert.equal(sandbox3FailureReason(new Error('private-secret')), 'sandbox3_lane_preflight_failed');
  assert.equal(sandbox3FailureReason(new Error('cloudflare_read_failed:403')), 'cloudflare_read_failed:403');
  assert.equal(sandbox3FailureReason(new Error('d1_read_only_contract_failed')), 'd1_read_only_contract_failed');
});
