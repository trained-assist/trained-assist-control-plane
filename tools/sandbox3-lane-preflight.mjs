#!/usr/bin/env node

const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const CP_WORKER = 'trained-assist-cp-sandbox3';
const TG_WORKER = 'trained-assist-tg-sandbox3';
const CP_URL = `https://${CP_WORKER}.skillset-apply.workers.dev`;
const D1_ID = '1e1b8108-9186-43e2-8e50-436598233165';
const WORKFLOW = 'ta-cp-sandbox3-task-workflow';
const OTHER_GATEWAYS = ['trained-assist-tg-ux-sandbox', 'trained-assist-tg-shturman-sandbox'];

const binding = (bindings, name) => bindings.find(item => item.name === name);
const value = (bindings, name) => {
  const item = binding(bindings, name);
  return item?.type === 'plain_text' ? item.text : null;
};
const stateIds = bindings => bindings
  .filter(item => ['durable_object_namespace', 'kv_namespace'].includes(item.type))
  .map(item => item.id ?? item.namespace_id)
  .filter(Boolean);

export function evaluateSandbox3Lane({ cpBindings, tgBindings, otherGatewayBindings, counts, principalRows, cpHealth,
  expectedCpSha = null }) {
  const otherState = new Set(otherGatewayBindings.flatMap(stateIds));
  const tgState = stateIds(tgBindings);
  const checks = {
    cpLiveness: cpHealth?.service === 'trained-assist-control-plane'
      && cpHealth?.check === 'liveness' && /^[a-f0-9]{40}$/.test(cpHealth?.buildSha ?? '')
      && (!expectedCpSha || cpHealth.buildSha === expectedCpSha) ? 'PASS' : 'BLOCKED',
    cpD1: binding(cpBindings, 'DB')?.type === 'd1'
      && binding(cpBindings, 'DB')?.id === D1_ID ? 'PASS' : 'BLOCKED',
    cpWorkflow: binding(cpBindings, 'TASK_WORKFLOW')?.type === 'workflow'
      && binding(cpBindings, 'TASK_WORKFLOW')?.workflow_name === WORKFLOW ? 'PASS' : 'BLOCKED',
    cpStateEmpty: counts.tasks === 0 && counts.executions === 0 ? 'PASS' : 'BLOCKED',
    cpPrincipal: principalRows.length === 1 && principalRows[0].principal_id === 'integration-sandbox3-v1'
      && principalRows[0].profile_id === 'integration-sandbox3-v1' && principalRows[0].enabled === 1
      && ['tasks:intake', 'tasks:read', 'tasks:control', 'tasks:signal']
        .every(scope => principalRows[0].scopes.includes(scope)) ? 'PASS' : 'BLOCKED',
    tgStateIsolated: tgState.length >= 3 && new Set(tgState).size === tgState.length
      && tgState.every(id => !otherState.has(id)) ? 'PASS' : 'BLOCKED',
    tgRoute: value(tgBindings, 'CONTROL_PLANE_URL') === CP_URL
      && value(tgBindings, 'CONTROL_PLANE_PRINCIPAL') === 'integration-sandbox3-v1'
      && value(tgBindings, 'CONTROL_PLANE_PROFILE') === 'integration-sandbox3-v1' ? 'PASS' : 'BLOCKED',
    cpPrincipalSecret: binding(cpBindings, 'PRINCIPAL_SECRET_SANDBOX3')?.type === 'secret_text' ? 'PASS' : 'BLOCKED',
    tgPrincipalSignature: binding(tgBindings, 'CONTROL_PLANE_PRINCIPAL_SIGNATURE')?.type === 'secret_text' ? 'PASS' : 'BLOCKED',
    agentApiBindings: Boolean(value(cpBindings, 'RUNNER_API_URL'))
      && binding(cpBindings, 'RUNNER_API_KEY_AGENT_API')?.type === 'secret_text'
      && binding(cpBindings, 'RUNNER_PROFILE_DELEGATION_SECRET')?.type === 'secret_text' ? 'PASS' : 'BLOCKED',
    executionEnabled: value(cpBindings, 'PREVIEW_ONLY') === 'false'
      && value(cpBindings, 'PILOT_ENABLED') === 'true'
      && value(cpBindings, 'ROUTER_AGENT_ALLOWED') === 'true' ? 'PASS' : 'BLOCKED',
  };
  return {
    lane: 'sandbox3',
    outcome: Object.values(checks).every(status => status === 'PASS') ? 'CONFIGURED' : 'BLOCKED',
    cpBuildSha: /^[a-f0-9]{40}$/.test(cpHealth?.buildSha ?? '') ? cpHealth.buildSha : null,
    expectedCpSha,
    checks,
    runnerAdmissionJournal: 'NOT_VERIFIED',
    realTelegramE2E: 'NOT_RUN',
  };
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
  if (!token || process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT_ID) {
    throw new Error('expected_sandbox_account_token_required');
  }
  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
  async function api(path, init = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) throw new Error(`cloudflare_read_failed:${response.status}`);
    return data.result;
  }
  const workerBindings = async name => (await api(`/workers/scripts/${name}/settings`)).bindings ?? [];
  const queryCount = async table => {
    const result = await api(`/d1/database/${D1_ID}/query`, {
      method: 'POST', body: JSON.stringify({ sql: `SELECT COUNT(*) AS n FROM ${table}` }),
    });
    if (result?.[0]?.meta?.changed_db !== false || result?.[0]?.meta?.rows_written !== 0) {
      throw new Error('d1_read_only_contract_failed');
    }
    return Number(result[0]?.results?.[0]?.n);
  };
  const queryPrincipals = async () => {
    const result = await api(`/d1/database/${D1_ID}/query`, {
      method: 'POST', body: JSON.stringify({
        sql: 'SELECT principal_id, profile_id, scopes, enabled FROM admission_principals',
      }),
    });
    if (result?.[0]?.meta?.changed_db !== false || result?.[0]?.meta?.rows_written !== 0) {
      throw new Error('d1_read_only_contract_failed');
    }
    return (result[0]?.results ?? []).map(row => ({ ...row,
      scopes: (() => { try { return JSON.parse(row.scopes); } catch { return []; } })(),
    }));
  };
  const [cpBindings, tgBindings, ...otherGatewayBindings] = await Promise.all([
    workerBindings(CP_WORKER), workerBindings(TG_WORKER), ...OTHER_GATEWAYS.map(workerBindings),
  ]);
  const [tasks, principalRows, executions, healthResponse] = await Promise.all([
    queryCount('durable_tasks'), queryPrincipals(), queryCount('executions'),
    fetch(`${CP_URL}/healthz`, { signal: AbortSignal.timeout(15_000) }),
  ]);
  const cpHealth = healthResponse.ok ? await healthResponse.json().catch(() => ({})) : {};
  const report = evaluateSandbox3Lane({ cpBindings, tgBindings, otherGatewayBindings,
    counts: { tasks, executions }, principalRows, cpHealth,
    expectedCpSha: process.env.EXPECTED_CP_SHA ?? null });
  console.log(JSON.stringify(report, null, 2));
  if (report.outcome !== 'CONFIGURED') process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(JSON.stringify({ lane: 'sandbox3', outcome: 'BLOCKED', reasonCode: error.message }));
    process.exitCode = 1;
  });
}
