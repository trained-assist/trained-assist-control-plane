import { readFile } from 'node:fs/promises';

const REQUIRED_PASS = [
  'cpLiveness', 'cpD1', 'cpWorkflow', 'cpHasNoDirectExecutorBinding', 'cpStateReusable',
  'cpPrincipal', 'tgStateIsolated', 'tgRoute', 'cpPrincipalSecret', 'tgPrincipalSignature',
  'agentApiBindings', 'mockProbeBindings', 'runnerApiBoundary',
];

export function assertSandbox3LiveAuthReady(report) {
  if (report?.lane !== 'sandbox3' || report.outcome !== 'BLOCKED'
    || !report.checks || !REQUIRED_PASS.every(name => report.checks[name] === 'PASS')
    || report.checks.executionEnabled !== 'BLOCKED'
    || report.stateCounts?.tasks !== 0 || report.stateCounts?.executions !== 0
    || report.stateCounts?.nonterminalTasks !== 0 || report.stateCounts?.foreignProfileTasks !== 0
    || report.stateCounts?.nonterminalExecutions !== 0
    || report.runnerAdmissionJournal !== 'NOT_VERIFIED' || report.realTelegramE2E !== 'NOT_RUN') {
    throw new Error('sandbox3_live_auth_readiness_mismatch');
  }
  return {
    lane: 'sandbox3',
    cpBuildSha: report.cpBuildSha,
    credentialsBound: true,
    executionFlagsRemainDisabled: true,
    cpTasks: 0,
    cpExecutions: 0,
    runnerAdmissionJournal: 'NOT_VERIFIED',
    realTelegramE2E: 'NOT_RUN',
  };
}

if (process.argv[1]?.endsWith('/assert-sandbox3-live-auth-ready.mjs')) {
  try {
    const raw = await readFile(process.argv[2], 'utf8');
    console.log(JSON.stringify(assertSandbox3LiveAuthReady(JSON.parse(raw))));
  } catch {
    console.error('sandbox3_live_auth_readiness_mismatch');
    process.exitCode = 1;
  }
}
