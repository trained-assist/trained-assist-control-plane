import { readFile, writeFile } from 'node:fs/promises';

const profileId = process.env.PROFILE_ID;
const prompt = process.env.TASK_PROMPT;
const apiBase = process.env.PRINCIPAL_LEASE_API_URL;
const leasePath = process.env.LEASE_OUTPUT_FILE;
const evidencePath = process.env.TASK_EVIDENCE_OUTPUT;
const workflowRunId = process.env.GITHUB_RUN_ID;
if (!profileId || !prompt || !apiBase || !leasePath || !evidencePath || !workflowRunId) {
  throw new Error('profile_task_configuration_missing');
}
if (prompt.length > 8000) throw new Error('task_prompt_too_long');

const lease = JSON.parse(await readFile(leasePath, 'utf8'));
if (lease.profileId !== profileId || typeof lease.token !== 'string' || !lease.token
    || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt * 1000 <= Date.now()) {
  throw new Error('profile_lease_invalid_or_expired');
}
const bearer = lease.token;
const requestId = `gha-profile-task-${workflowRunId}`;
const evidence = {
  schemaVersion: 1,
  workflowRunId,
  leaseRunId: lease.runId,
  leaseId: lease.leaseId,
  leaseExpiresAt: new Date(lease.expiresAt * 1000).toISOString(),
  profileId,
  requestId,
  userTaskId: null,
  controlPlaneRunId: null,
  agentRunId: null,
  state: 'starting',
  stage: null,
  answer: null,
  events: [],
  diagnostics: null,
  error: null,
};

const redact = (value) => String(value)
  .replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g, '[redacted]')
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');

function sanitize(value, depth = 0) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redact(value).slice(0, 20_000);
  if (depth >= 8) return '[depth_limited]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100)
      .filter(([key]) => !/token|secret|authorization|bearer|credential/i.test(key))
      .map(([key, item]) => [key.slice(0, 120), sanitize(item, depth + 1)]));
  }
  return String(value);
}

async function saveEvidence() {
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

async function request(method, route, body) {
  const response = await fetch(new URL(route, apiBase), {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof value?.error === 'string' ? value.error : `http_${response.status}`;
    throw new Error(`control_plane_${redact(code).slice(0, 160)}`);
  }
  return value;
}

try {
  const accepted = await request('POST', '/intake', {
    contractVersion: 1,
    requestId,
    profileId,
    inputItems: [{ text: prompt }],
    workStyle: 'explore',
    workStyleSource: 'explicit',
  });
  if (accepted.profileId !== profileId || typeof accepted.userTaskId !== 'string') {
    throw new Error('intake_identity_mismatch');
  }
  evidence.userTaskId = accepted.userTaskId;
  await saveEvidence();

  // autoRun:true is a control-plane no-op/terminal path. Leave it false so the
  // Workflow Port submits a real RunSpec through the selected profile adapter.
  const started = await request('POST', '/start', {
    taskId: accepted.userTaskId,
    profileId,
    goal: prompt,
    autoRun: false,
  });
  evidence.controlPlaneRunId = typeof started.runId === 'string' ? started.runId : null;
  await saveEvidence();

  const deadline = Date.now() + 12 * 60_000;
  let report;
  let history;
  while (Date.now() < deadline) {
    report = await request('GET', `/report?taskId=${encodeURIComponent(accepted.userTaskId)}`);
    const state = report?.snapshot?.status;
    if (['done', 'failed', 'cancelled'].includes(state)) break;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  const [history, trace] = await Promise.all([
    request('GET', `/report/history?taskId=${encodeURIComponent(accepted.userTaskId)}`),
    request('GET', `/trace/${encodeURIComponent(accepted.userTaskId)}`),
  ]);
  const events = history?.events ?? [];
  evidence.state = report?.snapshot?.status ?? 'poll_timeout';
  evidence.stage = report?.snapshot?.stage ?? null;
  evidence.answer = typeof report?.snapshot?.answer === 'string'
    ? redact(report.snapshot.answer).slice(0, 20_000) : null;
  evidence.events = events.map(event => ({ kind: event.kind, occurredAt: event.occurredAt }));
  evidence.diagnostics = sanitize({
    snapshot: report?.snapshot ?? null,
    trace,
    events: events.map(event => ({ sequence: event.sequence, kind: event.kind,
      occurredAt: event.occurredAt, payload: event.payload ?? null })),
  });
  const agentRuns = events.filter(event => event.kind === 'run_started')
    .map(event => event.payload?.runId).filter(value => typeof value === 'string');
  evidence.agentRunId = [...agentRuns].reverse()
    .find(runId => runId !== evidence.controlPlaneRunId) ?? null;
  await saveEvidence();

  console.log(JSON.stringify({
    ok: evidence.state === 'done' && Boolean(evidence.agentRunId) && Boolean(evidence.answer),
    profileId,
    userTaskId: evidence.userTaskId,
    controlPlaneRunId: evidence.controlPlaneRunId,
    agentRunId: evidence.agentRunId,
    state: evidence.state,
    stage: evidence.stage,
    answerPresent: Boolean(evidence.answer),
    diagnostics: evidence.diagnostics,
    evidencePath,
  }));
  if (evidence.state !== 'done' || !evidence.agentRunId || !evidence.answer) {
    throw new Error('agent_run_or_answer_not_proven');
  }
} catch (error) {
  evidence.error = error instanceof Error ? redact(error.message).slice(0, 200) : 'unknown_error';
  evidence.state = evidence.state === 'starting' ? 'failed' : evidence.state;
  await saveEvidence();
  console.error(evidence.error);
  throw error;
}
