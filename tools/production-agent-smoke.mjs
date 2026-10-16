import { pathToFileURL } from 'node:url';
import { runControlPlaneAgentSmoke } from './control-plane-agent-smoke.mjs';

export const PRODUCTION_AGENT_SMOKE = {
  baseUrl: 'https://trained-assist-cp-production.skillset-apply.workers.dev',
  principal: 'production-agent-smoke-v1',
  profile: 'production-agent-smoke-v1',
  secretEnv: 'PRODUCTION_AGENT_SMOKE_PRINCIPAL_SECRET',
  requestPrefix: 'production-agent-smoke',
  runnerApiUrl: 'https://trained-assist-runner-api-production.skillset-apply.workers.dev',
  runnerPrincipal: 'cp-production-runner',
  runnerTenant: 'trained-assist-production',
  runnerProfile: 'production-agent-smoke-v1',
  expectedExecutionWorker: 'eu-vm-agent-run',
  runnerRouteMode: 'gha',
  expectedRouteMode: 'gha',
};

export function runProductionAgentSmoke(environment = process.env, fetchImpl = fetch) {
  const requestedRouteMode = environment.PRODUCTION_AGENT_SMOKE_ROUTE_MODE?.trim() || PRODUCTION_AGENT_SMOKE.runnerRouteMode;
  if (!['gha', 'france'].includes(requestedRouteMode)) {
    return Promise.resolve({
      outcome: 'failed',
      reason: 'runner_route_mode_invalid',
      runnerRouteMode: requestedRouteMode,
    });
  }
  return runControlPlaneAgentSmoke({
    ...PRODUCTION_AGENT_SMOKE,
    runnerRouteMode: requestedRouteMode,
    expectedRouteMode: requestedRouteMode,
  }, environment, fetchImpl);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runProductionAgentSmoke();
  console.log(JSON.stringify(report));
  if (report.outcome !== 'passed') process.exitCode = 1;
}
