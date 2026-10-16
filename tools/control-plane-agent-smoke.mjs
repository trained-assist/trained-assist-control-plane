import { createHmac, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const safeCode = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_:-]{0,79}$/.test(value) ? value : null;

function fail(code) { const error = new Error(code); error.code = code; throw error; }

export function classifyMcpDiagnostic(value) {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (/\b401\b|unauthori[sz]ed|invalid (?:credential|token|proof)|signature (?:invalid|mismatch)/.test(text)) return 'mcp_auth';
  if (/\b403\b|forbidden|permission denied|not authorized/.test(text)) return 'mcp_permission';
  if (/timeout|timed out|deadline exceeded/.test(text)) return 'mcp_timeout';
  if (/econn|enotfound|fetch failed|network error|connection refused|connection reset/.test(text)) return 'mcp_transport';
  if (/unknown tool|no such tool|tool not found|tool.{0,20}not available/.test(text)) return 'mcp_tool_missing';
  if (/\bmcp\b/.test(text) && /error|failed|unavailable|unable/.test(text)) return 'mcp_other';
  return 'none';
}

export async function runControlPlaneAgentSmoke(config, environment = process.env, fetchImpl = fetch) {
  const { baseUrl, principal, profile, secretEnv, requestPrefix, runnerApiUrl, runnerPrincipal, runnerTenant,
    runnerProfile, expectedExecutionWorker, maxWaitMs = 8 * 60_000, inputText,
    expectedRunnerResultIncludes, expectedToolName, runnerRouteMode, expectedRouteMode } = config;
  const expectedBuildSha = environment.CONTROL_PLANE_EXPECTED_BUILD_SHA;
  const secret = typeof environment[secretEnv] === 'string' ? environment[secretEnv].trim() : '';
  const reportFile = environment.INTEGRATION_REPORT_FILE;
  const runKey = environment.GITHUB_RUN_ID ?? randomUUID();
  const report = { outcome: 'failed', principal, profile, startedAt: new Date().toISOString(), expectedBuildSha,
    runnerRunId: null, controlPlaneEventTail: [], runnerEventTail: [] };
  const save = () => { if (reportFile) writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 }); };
  let taskId;
  let taskCompleted = false;
  let runnerRequest;

  try {
    if (!validSha(expectedBuildSha)) fail('expected_build_sha_invalid');
    if (secret.length < 32) fail('principal_secret_missing');
    if (!reportFile) fail('report_file_missing');
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) fail('control_plane_url_invalid');
    const runnerBase = new URL(runnerApiUrl);
    if (runnerBase.protocol !== 'https:' || runnerBase.username || runnerBase.password || runnerBase.search || runnerBase.hash) fail('runner_api_url_invalid');
    const runnerApiKey = typeof environment.RUNNER_API_KEY_AGENT_API === 'string' ? environment.RUNNER_API_KEY_AGENT_API.trim() : '';
    const delegationSecret = typeof environment.RUNNER_PROFILE_DELEGATION_SECRET === 'string' ? environment.RUNNER_PROFILE_DELEGATION_SECRET.trim() : '';
    if (!runnerApiKey || !delegationSecret) fail('runner_api_credentials_missing');
    const signature = createHmac('sha256', secret).update(principal).digest('hex');
    const requestId = `${requestPrefix}-${runKey}-${environment.GITHUB_RUN_ATTEMPT ?? '1'}`;

    runnerRequest = async (path, timeoutMs = 20_000) => {
      const expiresAt = String(Date.now() + 60_000);
      const message = `${runnerPrincipal}\0${runnerTenant}\0${runnerProfile}\0${expiresAt}`;
      const runnerSignature = createHmac('sha256', delegationSecret).update(message).digest('hex');
      let response;
      try {
        response = await fetchImpl(new URL(path, runnerBase), { method: 'GET', redirect: 'error',
          headers: { authorization: `Bearer ${runnerApiKey}`, 'x-agent-profile-id': runnerProfile,
            'x-agent-profile-tenant': runnerTenant, 'x-agent-profile-exp': expiresAt, 'x-agent-profile-sig': runnerSignature },
          signal: AbortSignal.timeout(timeoutMs) });
      } catch { fail(`runner${path.split('?')[0].replaceAll('/', '_')}_request_failed`); }
      if (!response.ok) fail(`runner${path.split('?')[0].replaceAll('/', '_')}_http_${response.status}`);
      try {
        const parsed = await response.json();
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('runner_response_invalid');
        return parsed;
      } catch (error) { if (error?.code) throw error; fail('runner_response_invalid_json'); }
    };

    const call = async (path, body, timeoutMs = 20_000) => {
      let response;
      try {
        response = await fetchImpl(new URL(path, base), {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error',
          headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            'x-principal': principal, 'x-principal-sig': signature },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch { fail(`${path.replace(/[?].*/, '')}_request_failed`); }
      if (!response.ok) {
        let classification = 'request_rejected';
        try {
          const details = await response.clone().json();
          if (response.status === 401 && details?.name === 'PrincipalUnauthorizedError') {
            classification = typeof details.error === 'string' && details.error.endsWith('(missing)')
              ? 'principal_signature_rejected' : 'principal_not_registered';
          } else if (response.status === 403 && details?.name === 'PrincipalForbiddenError') {
            classification = 'principal_scope_or_profile_mismatch';
          }
        } catch { /* do not retain or print response bodies */ }
        fail(`${path.split('?')[0]}_http_${response.status}_${classification}`);
      }
      let parsed;
      try { parsed = await response.json(); } catch { fail(`${path.split('?')[0]}_invalid_json`); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`${path.split('?')[0]}_invalid_response`);
      return parsed;
    };

    const health = await call('/healthz');
    if (health.service !== 'trained-assist-control-plane' || health.status !== 'healthy') fail('control_plane_unhealthy');
    if (health.buildSha !== expectedBuildSha) fail('control_plane_build_sha_mismatch');
    report.deployedBuildSha = health.buildSha;

    let runnerHealth;
    let runnerVersion;
    try {
      const [healthResponse, versionResponse] = await Promise.all([
        fetchImpl(new URL('/healthz', runnerBase), { redirect: 'error', signal: AbortSignal.timeout(15_000) }),
        fetchImpl(new URL('/version', runnerBase), { redirect: 'error', signal: AbortSignal.timeout(15_000) }),
      ]);
      if (!healthResponse.ok || !versionResponse.ok) fail('runner_api_preflight_unavailable');
      [runnerHealth, runnerVersion] = await Promise.all([healthResponse.json(), versionResponse.json()]);
    } catch (error) { if (error?.code) throw error; fail('runner_api_preflight_failed'); }
    if (runnerHealth?.service !== 'ai-agent-runner-api' || runnerHealth?.placement !== 'cloudflare-worker'
        || runnerHealth?.executionWorker !== expectedExecutionWorker) fail('runner_execution_mapping_mismatch');
    if (runnerVersion?.runtime !== 'cloudflare-worker' || !validSha(runnerVersion?.buildSha)) fail('runner_api_version_invalid');
    report.runnerApiUrl = runnerBase.origin;
    report.runnerApiBuildSha = runnerVersion.buildSha;
    report.executionWorker = runnerHealth.executionWorker;

    const envelope = { contractVersion: 1, requestId, profileId: profile,
      conversationRef: requestId, sessionId: requestId,
      ...(runnerRouteMode ? { runnerRouteMode } : {}),
      inputItems: [{ text: inputText ?? 'Составь три коротких нейтральных вопроса для собеседования. Не используй инструменты.' }] };
    const receipt = await call('/intake', envelope, 60_000);
    if (receipt.durable !== true || typeof receipt.userTaskId !== 'string' || !receipt.userTaskId
        || receipt.profileId !== profile) fail('intake_receipt_profile_mismatch');
    taskId = receipt.userTaskId;
    report.userTaskId = taskId;

    const route = await call('/route', { taskId, continue: true, ...(runnerRouteMode ? { runnerRouteMode } : {}) }, 90_000);
    if (route.route !== 'agent' || route.continuation?.issued !== true) fail('route_not_agent_or_not_started');
    report.route = route.route;
    report.routeReasonCode = safeCode(route.reasonCode);
    report.continuationIssued = true;

    const deadline = Date.now() + maxWaitMs;
    let state;
    while (Date.now() < deadline) {
      state = await call('/status', { taskId }, 30_000);
      const task = state.taskStore;
      const sessionRuns = Array.isArray(state.runs) ? state.runs.filter(run => typeof run.session_id === 'string' && run.session_id.length > 0) : [];
      if (sessionRuns.length === 1) report.runnerRunId = sessionRuns[0].session_id;
      if (task?.profile_id !== profile) fail('task_profile_mismatch');
      if (task?.status === 'done') {
        taskCompleted = true;
        const successful = Array.isArray(state.runs)
          ? state.runs.filter(run => run.status === 'success' && typeof run.session_id === 'string' && run.session_id.length > 0) : [];
        if (successful.length !== 1) fail('successful_runner_session_count_mismatch');
        report.runnerRunId = successful[0].session_id;
        report.taskStatus = task.status;
        report.runCount = state.runs.length;
        report.runnerSessionObserved = true;
        break;
      }
      if (['failed', 'cancelled'].includes(task?.status)) {
        report.taskStatus = task.status;
        fail(`agent_task_${task.status}`);
      }
      await sleep(3_000);
    }
    if (!taskCompleted) {
      report.taskStatus = state?.taskStore?.status ?? 'unknown';
      fail('agent_task_deadline_exceeded');
    }

    if (!await captureWorkerTail(call, runnerRequest, taskId, report, expectedRunnerResultIncludes, expectedToolName, expectedRouteMode)) fail('runner_run_not_successful');
    report.outcome = 'passed';
  } catch (error) {
    report.reason = error?.code ?? safeCode(error?.message) ?? 'agent_smoke_failed';
    if (taskId && !taskCompleted) {
      try {
        const tail = await captureWorkerTail(async (path, body) => {
          const base = new URL(baseUrl);
          const signature = createHmac('sha256', secret).update(principal).digest('hex');
          const response = await fetchImpl(new URL(path, base), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
            headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-principal': principal, 'x-principal-sig': signature },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
          if (!response.ok) fail(`worker_tail_http_${response.status}`);
          return response.json();
        }, runnerRequest, taskId, report, expectedRunnerResultIncludes, expectedToolName, expectedRouteMode);
        if (!tail && report.workerTailCapture !== 'captured') report.workerTailCapture = 'failed';
      } catch { report.workerTailCapture = 'failed'; }
      try {
        const base = new URL(baseUrl);
        const signature = createHmac('sha256', secret).update(principal).digest('hex');
        const response = await fetchImpl(new URL('/cancel', base), { method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', 'x-principal': principal, 'x-principal-sig': signature },
          body: JSON.stringify({ taskId, reason: 'sandbox_agent_smoke_deadline_or_failure' }), signal: AbortSignal.timeout(20_000) });
        report.cancelRequested = response.ok;
      } catch { report.cancelRequested = false; }
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    save();
  }
  return report;
}

async function captureWorkerTail(call, runnerRequest, taskId, report, expectedRunnerResultIncludes, expectedToolName, expectedRouteMode) {
  const page = await call(`/events?taskId=${encodeURIComponent(taskId)}&limit=500`);
  if (!Array.isArray(page.events)) fail('worker_event_tail_invalid');
  const events = page.events.map(event => ({
    sequence: Number.isSafeInteger(event.sequence) ? event.sequence : null,
    type: safeCode(event.type), kind: safeCode(event.kind),
    runId: typeof event.runId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(event.runId) ? event.runId : null,
  }));
  report.controlPlaneEventCount = page.events.length;
  report.controlPlaneEventTail = events.slice(-20);
  if (!report.runnerRunId) fail('runner_session_missing_before_tail');
  const encodedRunId = encodeURIComponent(report.runnerRunId);
  const status = await runnerRequest(`/v1/runs/${encodedRunId}/status`);
  if (status.runId !== report.runnerRunId || !['queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(status.state)) fail('runner_status_mapping_mismatch');
  const eventsPage = await runnerRequest(`/v1/runs/${encodedRunId}/events?cursor=0&limit=500`);
  if (!Array.isArray(eventsPage.events)) fail('runner_event_tail_invalid');
  const runnerOutput = eventsPage.snapshot?.output && typeof eventsPage.snapshot.output === 'object'
    ? eventsPage.snapshot.output : {};
  const stdout = typeof runnerOutput.stdout === 'string' ? runnerOutput.stdout : '';
  const stderr = typeof runnerOutput.stderr === 'string' ? runnerOutput.stderr : '';
  const outputEvents = stdout.split(/\r?\n/).flatMap(line => {
    try {
      const event = JSON.parse(line);
      return event && typeof event === 'object' && !Array.isArray(event) ? [event] : [];
    } catch { return []; }
  });
  const toolCalls = outputEvents.filter(event => event.type === 'tool_use' && event.part?.tool === expectedToolName);
  const toolStates = toolCalls.map(event => event.part?.state).filter(state => state && typeof state === 'object');
  report.runnerState = status.state;
  report.runnerRouteMode = safeCode(status.routeMode);
  if (expectedRouteMode && status.routeMode !== expectedRouteMode) fail('runner_route_mode_mismatch');
  report.runnerEventCount = eventsPage.events.length;
  report.runnerOutputEvidence = {
    stdoutChars: stdout.length,
    stderrChars: stderr.length,
    identityToolNameObserved: `${stdout}\n${stderr}`.includes(expectedToolName ?? 'mem-gpt_identity_whoami'),
    expectedUserIdObserved: typeof expectedRunnerResultIncludes === 'string'
      && `${stdout}\n${stderr}`.includes(expectedRunnerResultIncludes),
    identityToolCallCount: toolCalls.length,
    identityToolCompletedCount: toolStates.filter(state => state.status === 'completed').length,
    identityToolErrorCount: toolStates.filter(state => state.status === 'error').length,
    identityToolResultContainsExpectedUserId: typeof expectedRunnerResultIncludes === 'string'
      && toolStates.some(state => JSON.stringify(state).includes(expectedRunnerResultIncludes)),
    stderrClass: classifyMcpDiagnostic(stderr),
  };
  report.runnerEventTail = eventsPage.events.slice(-20).map(event => ({
    sequence: Number.isSafeInteger(event.sequence) ? event.sequence : null,
    type: safeCode(event.type),
    code: safeCode(event.payload?.code),
    phase: safeCode(event.payload?.phase),
    status: safeCode(event.payload?.status),
  }));
  report.workerTailCapture = 'captured';
  if (report.runnerRunId && !events.some(event => event.runId === report.runnerRunId)) fail('worker_tail_missing_runner_run');
  if (['queued', 'starting', 'running', 'unknown'].includes(status.state)) {
    report.runnerOutcome = status.state === 'unknown' ? 'unknown' : 'pending';
    return false;
  }
  const result = await runnerRequest(`/v1/runs/${encodedRunId}/result`);
  if (result.runId !== report.runnerRunId || !['succeeded', 'failed', 'cancelled'].includes(result.outcome)) fail('runner_result_mapping_mismatch');
  report.runnerOutcome = result.outcome;
  report.runnerExitReason = safeCode(result.exitReason);
  if (status.state === 'succeeded' && result.outcome === 'succeeded' && typeof expectedRunnerResultIncludes === 'string') {
    const answer = typeof result.text === 'string' ? result.text : '';
    report.runnerResultTextChars = answer.length;
    report.runnerResultTextEvidence = {
      mentionsMcp: /\bmcp\b/i.test(answer),
      mentionsTool: /\btool\b/i.test(answer),
      saysUnavailable: /unavailable|not available|could not|cannot|can't/i.test(answer),
    };
    report.expectedResultMatched = answer.includes(expectedRunnerResultIncludes);
    if (!report.expectedResultMatched) fail(answer ? 'expected_runner_result_mismatch' : 'expected_runner_result_empty');
  }
  return status.state === 'succeeded' && result.outcome === 'succeeded';
}
