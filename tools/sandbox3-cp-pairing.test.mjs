import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox3OperatorSecret, verifySandbox3PairingBindings, verifySandbox3OperatorPrincipal, SANDBOX3_PAIRING_SECRETS } from './sandbox3-cp-pairing.mjs';
const bindings = () => [
  ...Object.entries({ DEPLOYMENT_ENV: 'sandbox3', PREVIEW_ONLY: 'true', PILOT_ENABLED: 'false', ROUTER_AGENT_ALLOWED: 'false',
    RUNNER_API_URL: 'https://trained-assist-runner-api-cp-sandbox3.skillset-apply.workers.dev', SANDBOX_RUNNER_MOCK_PROBE_ENABLED: 'true',
    SANDBOX_RUNNER_MOCK_PROBE_PROFILE: 'integration-sandbox3-v1' }).map(([name, text]) => ({ name, text, type: 'plain_text' })),
  { name: 'PRINCIPAL_SECRET_SANDBOX3', type: 'secret_text' },
];
test('pairing requires disabled execution and exact profile/route, and allows idempotent credential repair', () => {
  assert.equal(verifySandbox3PairingBindings(bindings()), true);
  assert.equal(verifySandbox3PairingBindings([...bindings(), ...SANDBOX3_PAIRING_SECRETS.map(name => ({ name, type: 'secret_text' }))]), true);
  assert.throws(() => verifySandbox3PairingBindings([...bindings(), bindings()[0]]));
  for (const name of SANDBOX3_PAIRING_SECRETS) assert.throws(() => verifySandbox3PairingBindings([...bindings(), { name, type: 'secret_text' }]), /sandbox3_cp_pairing_bindings_partial/);
  assert.throws(() => verifySandbox3PairingBindings([...bindings(), ...SANDBOX3_PAIRING_SECRETS.map(name => ({ name, type: 'plain_text', text: 'unsafe' }))]), /sandbox3_cp_pairing_bindings_invalid/);
  for (const [name, text] of [['DEPLOYMENT_ENV', 'production'], ['PILOT_ENABLED', 'true'], ['PREVIEW_ONLY', 'false'], ['RUNNER_API_URL', 'https://foreign.invalid'], ['SANDBOX_RUNNER_MOCK_PROBE_PROFILE', 'foreign']]) {
    assert.throws(() => verifySandbox3PairingBindings(bindings().map(binding => binding.name === name ? { ...binding, text } : binding)));
  }
  assert.throws(() => verifySandbox3PairingBindings(bindings().filter(binding => binding.name !== 'PRINCIPAL_SECRET_SANDBOX3')));
});
test('operator identity is read-only and restricted to the fixed sandbox profile', () => {
  const row = { profile_id: 'integration-sandbox3-v1', enabled: 1, scopes: '["tasks:read"]' };
  assert.equal(verifySandbox3OperatorPrincipal(row), true);
  for (const change of [{ profile_id: 'foreign' }, { enabled: 0 }, { scopes: '["tasks:read","tasks:intake"]' }, { scopes: 'invalid' }]) assert.throws(() => verifySandbox3OperatorPrincipal({ ...row, ...change }));
});
test('operator signature secret is repeatable, bounded and independent of runner key roles', () => {
  const seed = 'synthetic-seed-0123456789-abcdefghijk';
  assert.equal(sandbox3OperatorSecret(seed), sandbox3OperatorSecret(seed));
  assert.match(sandbox3OperatorSecret(seed), /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => sandbox3OperatorSecret('short'));
});
