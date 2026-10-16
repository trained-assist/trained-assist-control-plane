import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const config = (path) => JSON.parse(readFileSync(new URL(path, `file://${process.cwd()}/`), 'utf8'));

test('staging stays isolated while production scheduler and CP admissions are enabled', () => {
    const staging = config('wrangler.staging.jsonc');
    const production = config('wrangler.production.jsonc');

    assert.equal(staging.name, 'trained-assist-cp-staging');
    assert.equal(production.name, 'trained-assist-cp-production');
    assert.equal(staging.d1_databases[0].binding, 'DB');
    assert.equal(staging.d1_databases[0].database_name, 'ta-cp-staging-taskstore');
    assert.equal(production.d1_databases[0].binding, 'DB');
    assert.equal(production.d1_databases[0].database_name, 'ta-cp-production-taskstore');
    assert.notEqual(staging.d1_databases[0].database_id, production.d1_databases[0].database_id);
    assert.equal(staging.workflows[0].name, 'ta-cp-staging-task-workflow');
    assert.equal(production.workflows[0].name, 'ta-cp-production-task-workflow');

    assert.deepEqual(staging.services ?? [], []);
    assert.deepEqual(production.services, [
      { binding: 'COMMUNICATION_SERVICE', service: 'trained-assist-communication-skills' },
      { binding: 'RUNNER_API_SERVICE', service: 'trained-assist-runner-api-production' },
      { binding: 'INGRESS_BUFFER', service: 'trained-assist-ingress-buffer-production' },
    ]);
    for (const target of [staging, production]) assert.deepEqual(target.r2_buckets ?? [], []);
    assert.equal(staging.vars.PREVIEW_ONLY, 'true');
    assert.equal(staging.vars.PILOT_ENABLED, 'false');
    assert.equal(staging.vars.ROUTER_AGENT_ALLOWED, 'false');
    assert.equal(production.vars.PREVIEW_ONLY, 'false');
    assert.equal(production.vars.PILOT_ENABLED, 'true');
    assert.equal(production.vars.PILOT_ACTIVATED_AT, '2026-10-12T00:00:00.000Z');
    assert.equal(production.vars.PILOT_COHORT_PROFILE_IDS, undefined);
    assert.equal(production.vars.PILOT_LEGACY_PROFILE_IDS, undefined);
    assert.equal(production.vars.ROUTER_AGENT_ALLOWED, 'true');
    assert.equal(production.vars.ROUTER_CONTINUATION_ENABLED, 'true');
    assert.equal(production.vars.ROUTER_SELECTOR, 'communication_v1');
    assert.equal(production.vars.ROUTER_SELECTOR_NAMES_ONLY, 'false');
    assert.equal(production.vars.COMMUNICATION_API_URL, 'https://trained-assist-communication-skills.skillset-apply.workers.dev');
    assert.equal(production.vars.COMMUNICATION_TIMEOUT_MS, '20000');
    assert.equal(production.vars.COMMUNICATION_WRITER_TIMEOUT_MS, '20000');
    assert.equal(production.vars.RUNNER_API_ENGINE_SELECTION, 'agent_api');
    assert.equal(production.vars.RUNNER_API_URL, 'https://trained-assist-runner-api-production.skillset-apply.workers.dev');
    assert.equal(production.vars.RUN_SPEC_ENV_ALLOWLIST, 'LLM_LADDER_TOKEN');
    assert.equal(production.vars.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID, 'cp-production-runner');
    assert.equal(production.vars.RUNNER_PROFILE_DELEGATION_TENANT_ID, 'trained-assist-production');
});

test('production release deploys the pinned Runner API and checks its revision before CP', () => {
    const workflow = readFileSync(new URL('.github/workflows/ci.yml', `file://${process.cwd()}/`), 'utf8');
    const runnerSha = workflow.match(/RUNNER_PRODUCTION_SOURCE_SHA: ([0-9a-f]{40})/)?.[1];
    assert.equal(runnerSha, '5d511fe071253ac13cb3ae3bcd9b151fae7519dd');
    assert.match(workflow, /repository: trained-assist\/ai-agent-runner/);
    assert.match(workflow, /--config wrangler\.production\.jsonc --var BUILD_SHA:"\$RUNNER_PRODUCTION_SOURCE_SHA"/);
    assert.match(workflow, /for attempt in \$\(seq 1 30\)/);
    assert.match(workflow, /sleep 0\.5/);
    const runnerDeploy = workflow.indexOf('Provision paired production Runner credentials');
    const runnerHealth = workflow.indexOf('Verify production Runner health and exact source revision');
    const communicationPreflight = workflow.indexOf('Verify production Communication resolver credential and tool');
    const cpMigration = workflow.indexOf('Apply production migrations');
    const cpDeploy = workflow.indexOf('Deploy production');
    assert.ok(runnerDeploy >= 0 && runnerDeploy < runnerHealth && runnerHealth < cpMigration && cpMigration < cpDeploy);
    assert.ok(communicationPreflight >= 0 && communicationPreflight < cpDeploy);
    const runnerHealthStep = workflow.slice(runnerHealth, cpMigration);
    assert.match(runnerHealthStep, /GHA_WORKER_TOKEN_PRODUCTION_AGENT_API: \$\{\{ secrets\.GHA_WORKER_TOKEN_PRODUCTION_AGENT_API \}\}/);
    assert.match(workflow, /Provision paired production Runner credentials/);
    assert.match(workflow, /Pair Control Plane with production Runner API/);
    assert.match(workflow, /production Runner authenticated capability probe failed/);
    assert.match(workflow, /RUNNER_API_KEYS_PRODUCTION/);
    assert.match(workflow, /EU_VM_WORKER_URL: \$\{\{ vars\.EU_VM_WORKER_URL \}\}/);
    assert.match(workflow, /EU_VM_WORKER_TOKEN: \$\{\{ secrets\.EU_VM_WORKER_TOKEN \}\}/);
    assert.match(workflow, /GHA_WORKER_TOKEN_PRODUCTION_AGENT_API: \$\{\{ secrets\.GHA_WORKER_TOKEN_PRODUCTION_AGENT_API \}\}/);
    assert.match(workflow, /engines: \['eu-vm-agent-run', 'azure-cloud'\]/);
    assert.match(workflow, /GHA_WORKER_TOKEN: process\.env\.GHA_WORKER_TOKEN_PRODUCTION_AGENT_API/);
    assert.match(workflow, /const ghaExpected = Boolean\(process\.env\.GHA_WORKER_TOKEN_PRODUCTION_AGENT_API\)/);
    assert.match(workflow, /const ghaUnavailable = body\.routes\?\.gha\?\.available === false/);
    assert.match(workflow, /process\.env\.GHA_WORKER_TOKEN_PRODUCTION_AGENT_API \? \{ GHA_WORKER_TOKEN:/);
    assert.match(workflow, /COMMUNICATION_PRODUCTION_TOKEN: \$\{\{ secrets\.COMMUNICATION_PRODUCTION_TOKEN \}\}/);
    assert.match(workflow, /COMMUNICATION_TOKEN: process\.env\.COMMUNICATION_PRODUCTION_TOKEN/);
    assert.match(workflow, /production-agent-smoke-v1/);
    assert.match(workflow, /DELETE FROM admission_principals WHERE principal_id='production-e2e-telegram-v1'/);
    assert.doesNotMatch(workflow, /VALUES \('production-e2e-telegram-v1', 'production-e2e-telegram-v1'/);
});

test('production agent smoke is channel-neutral, isolated and cannot deploy', () => {
    const workflow = readFileSync(new URL('.github/workflows/production-agent-smoke.yml', `file://${process.cwd()}/`), 'utf8');
    const smoke = readFileSync(new URL('tools/production-agent-smoke.mjs', `file://${process.cwd()}/`), 'utf8');
    const sharedSmoke = readFileSync(new URL('tools/control-plane-agent-smoke.mjs', `file://${process.cwd()}/`), 'utf8');
    const release = readFileSync(new URL('.github/workflows/ci.yml', `file://${process.cwd()}/`), 'utf8');
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /environment: production/);
    assert.match(workflow, /contents: read/);
    assert.doesNotMatch(workflow, /CF_API_TOKEN|wrangler deploy|recovery_deploy/);
    assert.match(workflow, /PRODUCTION_AGENT_SMOKE_PRINCIPAL_SECRET: \$\{\{ secrets\.PRODUCTION_E2E_PRINCIPAL_SECRET \}\}/);
    assert.match(smoke, /principal: 'production-agent-smoke-v1'/);
    assert.match(smoke, /profile: 'production-agent-smoke-v1'/);
    assert.match(smoke, /runnerRouteMode: 'gha'/);
    assert.match(smoke, /expectedRouteMode: 'gha'/);
    assert.match(sharedSmoke, /health\.buildSha !== expectedBuildSha/);
    assert.match(sharedSmoke, /runner_route_mode_mismatch/);
    assert.match(sharedSmoke, /continue: true/);
    assert.match(sharedSmoke, /run\.status === 'success'.*run\.session_id/);
    assert.match(sharedSmoke, /captureWorkerTail/);
    assert.doesNotMatch(smoke, /telegram|Telegram/i);
    assert.match(release, /production-agent-smoke-v1/);
    assert.match(release, /DELETE FROM admission_principals WHERE principal_id='production-e2e-telegram-v1'/);
    assert.doesNotMatch(release, /VALUES \('production-e2e-telegram-v1', 'production-e2e-telegram-v1'/);
});

test('sandbox agent smoke exercises CP-to-Runner path without deployment or Telegram delivery', () => {
    const workflow = readFileSync(new URL('.github/workflows/sandbox-agent-smoke.yml', `file://${process.cwd()}/`), 'utf8');
    const smoke = readFileSync(new URL('tools/sandbox-agent-smoke.mjs', `file://${process.cwd()}/`), 'utf8');
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /environment: sandbox/);
    assert.match(workflow, /contents: read/);
    assert.match(workflow, /CP_TELEGRAM_UX_PRINCIPAL_SECRET: \$\{\{ secrets\.CP_TELEGRAM_UX_PRINCIPAL_SECRET \}\}/);
    assert.match(workflow, /Require clean dedicated sandbox lane/);
    assert.match(workflow, /Clear the completed sandbox test lane/);
    assert.doesNotMatch(workflow, /wrangler deploy|PRODUCTION_AGENT_SMOKE|TELEGRAM_BOT_TOKEN/);
    assert.match(smoke, /profile: 'integration-telegram-ux-v1'/);
    assert.match(smoke, /integration-telegram-ux-v1/);
});

test('sandbox-3 target uses isolated state and enables only its isolated Telegram E2E profile', () => {
    const sandbox3 = config('wrangler.sandbox3.jsonc');
    const sharedTelegram = config('wrangler.telegram-ux-v1.jsonc');

    assert.equal(sandbox3.name, 'trained-assist-cp-sandbox3');
    assert.equal(sandbox3.d1_databases.length, 1);
    assert.equal(sandbox3.d1_databases[0].binding, 'DB');
    assert.equal(sandbox3.d1_databases[0].database_name, 'ta-sandbox3-taskstore');
    assert.equal(sandbox3.d1_databases[0].database_id, '1e1b8108-9186-43e2-8e50-436598233165');
    assert.equal(sandbox3.workflows.length, 1);
    assert.equal(sandbox3.workflows[0].name, 'ta-cp-sandbox3-task-workflow');
    assert.deepEqual(sandbox3.services ?? [], [
      { binding: 'COMMUNICATION_SERVICE', service: 'trained-assist-communication-v1-sandbox' },
      { binding: 'RUNNER_API_SERVICE', service: 'trained-assist-runner-api-sandbox3' },
      { binding: 'INGRESS_BUFFER', service: 'trained-assist-ingress-buffer-sandbox' },
    ]);
    assert.deepEqual(sandbox3.r2_buckets ?? [], []);
    assert.equal(sandbox3.vars.DEPLOYMENT_ENV, 'sandbox3');
    assert.equal(sandbox3.vars.RUNNER_API_ENGINE_SELECTION, 'agent_api');
    assert.equal(sandbox3.vars.NATIVE_CANCEL_CONFIRMATION, 'true');
    assert.equal(sandbox3.vars.COMMUNICATION_API_URL, 'https://trained-assist-communication-v1-sandbox.skillset-apply.workers.dev');
    assert.equal(sandbox3.vars.COMMUNICATION_TIMEOUT_MS, '20000');
    assert.equal(sandbox3.vars.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID, 'sandbox3-agent-api-principal');
    assert.equal(sandbox3.vars.RUNNER_PROFILE_DELEGATION_TENANT_ID, 'sandbox3-acceptance-a-20261008');
    assert.equal(sandbox3.vars.RUNNER_API_URL, 'https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev');
    assert.equal(sandbox3.vars.SANDBOX_RUNNER_MOCK_TEST_URL, 'https://trained-assist-runner-api-cp-sandbox3.skillset-apply.workers.dev');
    assert.equal(sandbox3.vars.RUNNER_API_URL.includes('sslip.io'), false);
    assert.equal(sandbox3.vars.SANDBOX_RUNNER_MOCK_PROBE_ENABLED, 'true');
    assert.equal(sandbox3.vars.SANDBOX_RUNNER_MOCK_PROBE_PROFILE, 'integration-sandbox3-v1');
    assert.equal(sandbox3.vars.RUNNER_API_KEY_AGENT_API, undefined);
    assert.equal(sandbox3.vars.RUNNER_API_KEY_SANDBOX3_MOCK_TEST, undefined);
    assert.equal(sandbox3.vars.RUNNER_PROFILE_DELEGATION_SECRET, undefined);
    assert.equal(sandbox3.vars.PREVIEW_ONLY, 'false');
    assert.equal(sandbox3.vars.PILOT_ENABLED, 'true');
    assert.equal(sandbox3.vars.PILOT_ACTIVATED_AT, '2026-10-11T00:00:00Z');
    assert.equal(sandbox3.vars.PILOT_COHORT_PROFILE_IDS, 'integration-sandbox3-v1');
    assert.equal(sandbox3.vars.ROUTER_SELECTOR, 'communication_v1');
    assert.equal(sandbox3.vars.ROUTER_SELECTOR_NAMES_ONLY, 'false');
    assert.equal(sandbox3.vars.ROUTER_CONTINUATION_ENABLED, 'true');
    assert.equal(sandbox3.vars.ROUTER_AGENT_ENGINE, undefined);
    assert.equal(sandbox3.vars.ROUTER_AGENT_ALLOWED, 'true');
    assert.equal(sharedTelegram.vars.RUNNER_API_ENGINE_SELECTION, 'agent_api');
    assert.equal(sharedTelegram.vars.RUNNER_API_URL, 'https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev');
    assert.equal(sharedTelegram.vars.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID, 'integration-telegram-ux-v1');
    assert.equal(sharedTelegram.vars.ROUTER_AGENT_ENGINE, undefined);
    assert.equal(sharedTelegram.vars.RUN_SPEC_REPOSITORY, undefined);
});
