import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSandbox3CpAgentApiBindings } from './provision-sandbox3-cp-agent-api.mjs';

const bindings = [
  { name: 'DEPLOYMENT_ENV', type: 'plain_text', text: 'sandbox3' },
  { name: 'RUNNER_API_URL', type: 'plain_text', text: 'https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev' },
  { name: 'RUNNER_API_SERVICE', type: 'service', service: 'trained-assist-runner-api-sandbox3' },
  { name: 'RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID', type: 'plain_text', text: 'sandbox3-agent-api-principal' },
  { name: 'RUNNER_PROFILE_DELEGATION_TENANT_ID', type: 'plain_text', text: 'sandbox3-acceptance-a-20261008' },
  { name: 'PREVIEW_ONLY', type: 'plain_text', text: 'true' },
  { name: 'PILOT_ENABLED', type: 'plain_text', text: 'false' },
  { name: 'ROUTER_AGENT_ALLOWED', type: 'plain_text', text: 'false' },
  { name: 'PRINCIPAL_SECRET_SANDBOX3', type: 'secret_text' },
];

test('CP live Runner auth binding precondition pins sandbox3 and requires disabled execution flags', () => {
  assert.equal(validateSandbox3CpAgentApiBindings(bindings), true);
  for (const [name, field, value] of [
    ['RUNNER_API_URL', 'text', 'https://foreign.example'],
    ['RUNNER_API_SERVICE', 'service', 'trained-assist-runner-api-cp-sandbox3'],
    ['RUNNER_PROFILE_DELEGATION_TENANT_ID', 'text', 'foreign-tenant'],
    ['PREVIEW_ONLY', 'text', 'false'],
    ['PILOT_ENABLED', 'text', 'true'],
    ['ROUTER_AGENT_ALLOWED', 'text', 'true'],
    ['PRINCIPAL_SECRET_SANDBOX3', 'type', 'plain_text'],
  ]) {
    const changed = structuredClone(bindings);
    changed.find(binding => binding.name === name)[field] = value;
    assert.throws(() => validateSandbox3CpAgentApiBindings(changed), /^Error: sandbox3_cp_runtime_contract_mismatch$/);
  }
});
