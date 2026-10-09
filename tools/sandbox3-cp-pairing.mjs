import { createHmac } from 'node:crypto';
export const SANDBOX3_PAIRING_SECRETS = ['RUNNER_API_KEY_AGENT_API', 'RUNNER_PROFILE_DELEGATION_SECRET', 'PRINCIPAL_SECRET_SANDBOX3_OPS'];
export function sandbox3OperatorSecret(seed) {
  if (typeof seed !== 'string' || Buffer.byteLength(seed) < 32) throw new Error('sandbox3_operator_seed_invalid');
  return createHmac('sha256', seed).update('trained-assist/agent-runner-api-sandbox3/bootstrap/v1/cp-read-operator').digest('base64url');
}
export function verifySandbox3PairingBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length > 100) throw new Error('sandbox3_cp_pairing_bindings_invalid');
  if (bindings.some(binding => !binding || typeof binding.name !== 'string')
    || new Set(bindings.map(binding => binding.name)).size !== bindings.length) throw new Error('sandbox3_cp_pairing_bindings_invalid');
  const values = new Map(bindings.map(binding => [binding.name, binding]));
  for (const [name, text] of Object.entries({ DEPLOYMENT_ENV: 'sandbox3', PREVIEW_ONLY: 'true', PILOT_ENABLED: 'false',
    ROUTER_AGENT_ALLOWED: 'false', RUNNER_API_URL: 'https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev',
    SANDBOX_RUNNER_MOCK_PROBE_ENABLED: 'true', SANDBOX_RUNNER_MOCK_PROBE_PROFILE: 'integration-sandbox3-v1' })) {
    if (values.get(name)?.type !== 'plain_text' || values.get(name)?.text !== text) throw new Error('sandbox3_cp_pairing_flags_invalid');
  }
  if (values.get('PRINCIPAL_SECRET_SANDBOX3')?.type !== 'secret_text') throw new Error('sandbox3_cp_intake_binding_missing');
  if (SANDBOX3_PAIRING_SECRETS.some(name => values.has(name))) throw new Error('sandbox3_cp_pairing_bindings_occupied');
  return true;
}
export function verifySandbox3OperatorPrincipal(row) {
  if (!row || row.profile_id !== 'integration-sandbox3-v1' || row.enabled !== 1) throw new Error('sandbox3_cp_operator_principal_invalid');
  let scopes; try { scopes = JSON.parse(row.scopes); } catch { throw new Error('sandbox3_cp_operator_principal_invalid'); }
  if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== 'tasks:read') throw new Error('sandbox3_cp_operator_principal_invalid');
  return true;
}
