#!/usr/bin/env node

const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const CP_WORKER = 'trained-assist-cp-sandbox3';
const TG_WORKER = 'trained-assist-tg-sandbox3';
const CP_URL = `https://${CP_WORKER}.skillset-apply.workers.dev`;
const D1_ID = '1e1b8108-9186-43e2-8e50-436598233165';
const WORKFLOW = 'ta-cp-sandbox3-task-workflow';
export const SANDBOX3_RUNNER_URL = 'https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev';
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
  const intakePrincipals = principalRows.filter(row => row.principal_id === 'integration-sandbox3-v1');
  const serviceRoute = binding(tgBindings, 'CONTROL_PLANE_SERVICE');
  const selectedServiceMatches = !serviceRoute || (serviceRoute.type === 'service'
    && serviceRoute.service === CP_WORKER && (!serviceRoute.environment || serviceRoute.environment === 'production'));
  const physicalDispatchBindings = cpBindings.filter(item => /(?:^|_)(?:VM_WORKER|EXECUTION_WORKER|GHA_RUNNER|GITHUB_ACTIONS_RUNNER)_(?:URL|TOKEN)$/i.test(item.name));
  const directServiceBindings = cpBindings.filter(item => item.type === 'service'
    && item.service !== 'trained-assist-runner-api-sandbox3');
  const reusable = ['tasks', 'executions', 'nonterminalTasks', 'foreignProfileTasks', 'nonterminalExecutions']
    .every(name => Number.isSafeInteger(counts[name]) && counts[name] >= 0 && counts[name] <= 1_000_000)
    && counts.nonterminalTasks <= counts.tasks && counts.foreignProfileTasks <= counts.tasks
    && counts.nonterminalExecutions <= counts.executions
    && counts.nonterminalTasks === 0 && counts.foreignProfileTasks === 0 && counts.nonterminalExecutions === 0;
  const checks = {
    cpLiveness: cpHealth?.service === 'trained-assist-control-plane'
      && cpHealth?.check === 'liveness' && /^[a-f0-9]{40}$/.test(cpHealth?.buildSha ?? '')
      && (!expectedCpSha || cpHealth.buildSha === expectedCpSha) ? 'PASS' : 'BLOCKED',
    cpD1: binding(cpBindings, 'DB')?.type === 'd1'
      && binding(cpBindings, 'DB')?.id === D1_ID ? 'PASS' : 'BLOCKED',
    cpWorkflow: binding(cpBindings, 'TASK_WORKFLOW')?.type === 'workflow'
      && binding(cpBindings, 'TASK_WORKFLOW')?.workflow_name === WORKFLOW ? 'PASS' : 'BLOCKED',
    cpHasNoDirectExecutorBinding: physicalDispatchBindings.length === 0 && directServiceBindings.length === 0 ? 'PASS' : 'BLOCKED',
    cpStateReusable: reusable ? 'PASS' : 'BLOCKED',
    cpPrincipal: intakePrincipals.length === 1
      && intakePrincipals[0].profile_id === 'integration-sandbox3-v1' && intakePrincipals[0].enabled === 1
      && Array.isArray(intakePrincipals[0].scopes) && ['tasks:intake', 'tasks:read', 'tasks:control', 'tasks:signal']
        .every(scope => intakePrincipals[0].scopes.includes(scope)) ? 'PASS' : 'BLOCKED',
    tgStateIsolated: tgState.length >= 3 && new Set(tgState).size === tgState.length
      && tgState.every(id => !otherState.has(id)) ? 'PASS' : 'BLOCKED',
    tgRoute: selectedServiceMatches && value(tgBindings, 'CONTROL_PLANE_URL') === CP_URL
      && value(tgBindings, 'CONTROL_PLANE_PRINCIPAL') === 'integration-sandbox3-v1'
      && value(tgBindings, 'CONTROL_PLANE_PROFILE') === 'integration-sandbox3-v1' ? 'PASS' : 'BLOCKED',
    cpPrincipalSecret: binding(cpBindings, 'PRINCIPAL_SECRET_SANDBOX3')?.type === 'secret_text' ? 'PASS' : 'BLOCKED',
    tgPrincipalSignature: binding(tgBindings, 'CONTROL_PLANE_PRINCIPAL_SIGNATURE')?.type === 'secret_text' ? 'PASS' : 'BLOCKED',
    agentApiBindings: value(cpBindings, 'RUNNER_API_URL') === SANDBOX3_RUNNER_URL
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
    stateCounts: Object.fromEntries(['tasks', 'executions', 'nonterminalTasks', 'foreignProfileTasks', 'nonterminalExecutions']
      .map(name => [name, Number.isSafeInteger(counts[name]) && counts[name] >= 0 && counts[name] <= 1_000_000 ? counts[name] : null])),
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
  const queryCounts = async () => {
    const result = await api(`/d1/database/${D1_ID}/query`, {
      method: 'POST', body: JSON.stringify({ sql: `SELECT
        (SELECT COUNT(*) FROM durable_tasks) AS tasks,
        (SELECT COUNT(*) FROM executions) AS executions,
        (SELECT COUNT(*) FROM durable_tasks WHERE status NOT IN ('done','failed','cancelled')) AS nonterminalTasks,
        (SELECT COUNT(*) FROM durable_tasks WHERE profile_id != 'integration-sandbox3-v1') AS foreignProfileTasks,
        (SELECT COUNT(*) FROM executions WHERE status NOT IN ('success','failed','cancelled') OR finished_at IS NULL) AS nonterminalExecutions` }),
    });
    if (result?.[0]?.meta?.changed_db !== false || result?.[0]?.meta?.rows_written !== 0) {
      throw new Error('d1_read_only_contract_failed');
    }
    return result[0]?.results?.[0] ?? {};
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
  const [counts, principalRows, healthResponse, runnerApiReady] = await Promise.all([
    queryCounts(), queryPrincipals(),
    fetch(`${CP_URL}/healthz`, { signal: AbortSignal.timeout(15_000) }),
    verifyRunnerApiBoundary(),
  ]);
  const cpHealth = healthResponse.ok ? await healthResponse.json().catch(() => ({})) : {};
  const report = evaluateSandbox3Lane({ cpBindings, tgBindings, otherGatewayBindings,
    counts, principalRows, cpHealth,
    expectedCpSha: process.env.EXPECTED_CP_SHA ?? null });
  report.checks.runnerApiBoundary = runnerApiReady ? 'PASS' : 'BLOCKED';
  if (!runnerApiReady) report.outcome = 'BLOCKED';
  console.log(JSON.stringify(report, null, 2));
  if (report.outcome !== 'CONFIGURED') process.exitCode = 2;
}

async function verifyRunnerApiBoundary() {
  try {
    const [healthResponse, versionResponse, authResponse] = await Promise.all([
      fetch(`${SANDBOX3_RUNNER_URL}/healthz`, { signal: AbortSignal.timeout(10_000), redirect: 'error' }),
      fetch(`${SANDBOX3_RUNNER_URL}/version`, { signal: AbortSignal.timeout(10_000), redirect: 'error' }),
      fetch(`${SANDBOX3_RUNNER_URL}/v1/capabilities`, { signal: AbortSignal.timeout(10_000), redirect: 'error' }),
    ]);
    const [health, version, auth] = await Promise.all([
      healthResponse.json(), versionResponse.json(), authResponse.json(),
    ]);
    return healthResponse.status === 200 && health?.service === 'ai-agent-runner-api'
      && health?.placement === 'cloudflare-worker'
      && versionResponse.status === 200 && version?.runtime === 'cloudflare-worker'
      && authResponse.status === 401 && auth?.error?.code === 'UNAUTHENTICATED';
  } catch { return false; }
}

export function sandbox3FailureReason(error) {
  const message = error instanceof Error ? error.message : '';
  if (['expected_sandbox_account_token_required', 'd1_read_only_contract_failed'].includes(message)
    || /^cloudflare_read_failed:[45][0-9]{2}$/.test(message)) return message;
  return 'sandbox3_lane_preflight_failed';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(JSON.stringify({ lane: 'sandbox3', outcome: 'BLOCKED', reasonCode: sandbox3FailureReason(error) }));
    process.exitCode = 1;
  });
}
