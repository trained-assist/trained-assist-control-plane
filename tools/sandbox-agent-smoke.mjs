import { pathToFileURL } from 'node:url';
import { runControlPlaneAgentSmoke } from './control-plane-agent-smoke.mjs';

export const SANDBOX_AGENT_SMOKE = {
  baseUrl: 'https://trained-assist-cp-telegram-ux-v1-sandbox.skillset-apply.workers.dev',
  principal: 'integration-telegram-ux-v1',
  profile: 'integration-telegram-ux-v1',
  secretEnv: 'CP_TELEGRAM_UX_PRINCIPAL_SECRET',
  requestPrefix: 'sandbox-agent-smoke',
  runnerApiUrl: 'https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev',
  runnerPrincipal: 'integration-telegram-ux-v1',
  runnerTenant: 'telegram-ux-sandbox-20261009',
  runnerProfile: 'integration-telegram-ux-v1',
  expectedExecutionWorker: 'eu-vm-agent-run',
  inputText: 'Use the connected MCP server mem-gpt and call identity.whoami. Reply with exactly the returned userId and nothing else. Do not guess the userId; if the tool call fails, say so.',
  expectedRunnerResultIncludes: 'trained-assist-product-owner',
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runControlPlaneAgentSmoke(SANDBOX_AGENT_SMOKE);
  console.log(JSON.stringify(report));
  if (report.outcome !== 'passed') process.exitCode = 1;
}
