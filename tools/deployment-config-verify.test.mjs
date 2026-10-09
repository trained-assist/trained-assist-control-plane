import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const config = (path) => JSON.parse(readFileSync(new URL(path, `file://${process.cwd()}/`), 'utf8'));

test('isolated staging and production targets stay distinct and execution-disabled', () => {
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

    for (const target of [staging, production]) {
      assert.deepEqual(target.services ?? [], []);
      assert.deepEqual(target.r2_buckets ?? [], []);
      assert.equal(target.vars.PREVIEW_ONLY, 'true');
      assert.equal(target.vars.PILOT_ENABLED, 'false');
      assert.equal(target.vars.ROUTER_AGENT_ALLOWED, 'false');
    }
});

test('sandbox-3 target uses only its existing isolated D1 and remains execution-disabled', () => {
    const sandbox3 = config('wrangler.sandbox3.jsonc');
    const sharedTelegram = config('wrangler.telegram-ux-v1.jsonc');

    assert.equal(sandbox3.name, 'trained-assist-cp-sandbox3');
    assert.equal(sandbox3.d1_databases.length, 1);
    assert.equal(sandbox3.d1_databases[0].binding, 'DB');
    assert.equal(sandbox3.d1_databases[0].database_name, 'ta-sandbox3-taskstore');
    assert.equal(sandbox3.d1_databases[0].database_id, '1e1b8108-9186-43e2-8e50-436598233165');
    assert.equal(sandbox3.workflows.length, 1);
    assert.equal(sandbox3.workflows[0].name, 'ta-cp-sandbox3-task-workflow');
    assert.deepEqual(sandbox3.services ?? [], []);
    assert.deepEqual(sandbox3.r2_buckets ?? [], []);
    assert.equal(sandbox3.vars.DEPLOYMENT_ENV, 'sandbox3');
    assert.equal(sandbox3.vars.RUNNER_API_ENGINE_SELECTION, 'agent_api');
    assert.equal(sandbox3.vars.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID, 'sandbox3-agent-api-principal');
    assert.equal(sandbox3.vars.RUNNER_PROFILE_DELEGATION_TENANT_ID, 'sandbox3-acceptance-a-20261008');
    assert.equal(sandbox3.vars.RUNNER_API_URL, 'https://trained-assist-runner-api-cp-sandbox3.skillset-apply.workers.dev');
    assert.equal(sandbox3.vars.RUNNER_API_URL.includes('sslip.io'), false);
    assert.equal(sandbox3.vars.SANDBOX_RUNNER_MOCK_PROBE_ENABLED, 'true');
    assert.equal(sandbox3.vars.SANDBOX_RUNNER_MOCK_PROBE_PROFILE, 'integration-sandbox3-v1');
    assert.equal(sandbox3.vars.RUNNER_API_KEY_AGENT_API, undefined);
    assert.equal(sandbox3.vars.RUNNER_PROFILE_DELEGATION_SECRET, undefined);
    assert.equal(sandbox3.vars.PREVIEW_ONLY, 'true');
    assert.equal(sandbox3.vars.PILOT_ENABLED, 'false');
    assert.equal(sandbox3.vars.ROUTER_AGENT_ALLOWED, 'false');
    assert.equal(sharedTelegram.vars.RUNNER_API_ENGINE_SELECTION, 'agent_api');
    assert.equal(sharedTelegram.vars.RUNNER_API_URL, 'https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev');
    assert.equal(sharedTelegram.vars.RUNNER_PROFILE_DELEGATION_PRINCIPAL_ID, 'integration-telegram-ux-v1');
    assert.equal(sharedTelegram.vars.ROUTER_AGENT_ENGINE, 'dynamic-ip-azure-agent-run');
    assert.ok(sharedTelegram.vars.RUN_SPEC_REPOSITORY);
});
