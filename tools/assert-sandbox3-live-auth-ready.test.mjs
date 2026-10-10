import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSandbox3LiveAuthReady } from './assert-sandbox3-live-auth-ready.mjs';

const checks = () => ({
  ...Object.fromEntries([
    'cpLiveness', 'cpD1', 'cpWorkflow', 'cpHasNoDirectExecutorBinding', 'cpStateReusable', 'cpPrincipal',
    'tgStateIsolated', 'tgRoute', 'cpPrincipalSecret', 'tgPrincipalSignature', 'agentApiBindings',
    'mockProbeBindings', 'runnerApiBoundary',
  ].map(name => [name, 'PASS'])),
  executionEnabled: 'BLOCKED',
});
const report = () => ({
  lane: 'sandbox3', outcome: 'BLOCKED', cpBuildSha: 'a'.repeat(40),
  checks: checks(),
  stateCounts: { tasks: 0, executions: 0, nonterminalTasks: 0, foreignProfileTasks: 0, nonterminalExecutions: 0 },
  runnerAdmissionJournal: 'NOT_VERIFIED', realTelegramE2E: 'NOT_RUN',
});

test('auth pairing accepts only an empty isolated CP lane with credentials bound and execution still disabled', () => {
  assert.deepEqual(assertSandbox3LiveAuthReady(report()), {
    lane: 'sandbox3', cpBuildSha: 'a'.repeat(40), credentialsBound: true, executionFlagsRemainDisabled: true,
    cpTasks: 0, cpExecutions: 0, runnerAdmissionJournal: 'NOT_VERIFIED', realTelegramE2E: 'NOT_RUN',
  });
  for (const mutate of [
    value => { value.checks.agentApiBindings = 'BLOCKED'; },
    value => { value.checks.executionEnabled = 'PASS'; },
    value => { value.stateCounts.nonterminalTasks = 1; },
    value => { value.stateCounts.foreignProfileTasks = 1; },
    value => { value.runnerAdmissionJournal = 'PASS'; },
  ]) {
    const invalid = report();
    mutate(invalid);
    assert.throws(() => assertSandbox3LiveAuthReady(invalid), /^Error: sandbox3_live_auth_readiness_mismatch$/);
  }
});
