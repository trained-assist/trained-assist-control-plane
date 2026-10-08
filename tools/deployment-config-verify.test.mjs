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
