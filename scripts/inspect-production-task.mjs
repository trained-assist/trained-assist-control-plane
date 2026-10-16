import { readFile } from 'node:fs/promises';

const RUNNER_API = 'https://trained-assist-runner-api-production.skillset-apply.workers.dev';
const RUNNER_RUN_ID = /^run_[A-Za-z0-9_-]{20,160}$/;
const TASK_ID = /^ut-[A-Za-z0-9_-]{8,100}$/;
const MAX_EVENT_PAGES = 10;
const MAX_LOG_CHARS = 100_000;
const MAX_LOG_SOURCE_BYTES = 2 * 1024 * 1024;

export function redactDiagnosticText(text) {
  return String(text)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(?:cfat_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})\b/g, '[REDACTED_API_KEY]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)["']?[^\s"',;}]+["']?/gi, '$1[REDACTED]');
}

async function readCappedText(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) return { text: '', bytes: 0, truncated: true };
  if (!response.body) return { text: '', bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - bytes;
    const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
    bytes += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
    if (chunk.byteLength !== value.byteLength) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  text += decoder.decode();
  return { text, bytes, truncated };
}

export async function inspectProductionTask({ taskId, accountId, apiToken, runnerApiKey, databaseId, includeLogs = false, fetchImpl = fetch }) {
  if (!TASK_ID.test(taskId ?? '')) throw new Error('invalid_task_id');
  if (!/^[a-f0-9]{32}$/.test(accountId ?? '') || (apiToken?.length ?? 0) < 20) throw new Error('cloudflare_d1_credentials_missing');
  if ((runnerApiKey?.length ?? 0) < 32) throw new Error('runner_api_key_missing');

  let resolvedDatabaseId = databaseId;
  if (!resolvedDatabaseId) {
    const config = JSON.parse(await readFile(new URL('../wrangler.production.jsonc', import.meta.url), 'utf8'));
    resolvedDatabaseId = config.d1_databases?.find((entry) => entry.binding === 'DB')?.database_id;
  }
  if (typeof resolvedDatabaseId !== 'string') throw new Error('production_taskstore_binding_missing');
  const d1Url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${resolvedDatabaseId}/query`;

  const query = async (sql, params) => {
    const response = await fetchImpl(d1Url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(15_000),
    });
    let body;
    try { body = await response.json(); } catch { throw new Error(`cloudflare_d1_http_${response.status}`); }
    if (!response.ok || body?.success !== true || body?.result?.[0]?.success !== true) throw new Error(`cloudflare_d1_query_failed_${response.status}`);
    return body.result[0].results ?? [];
  };

  const attempts = await query(
    `SELECT id, session_id, engine, status, generation, started_at, finished_at, error_class
       FROM executions WHERE task_id = ? ORDER BY started_at, id`,
    [taskId],
  );
  const runnerHeaders = { authorization: `Bearer ${runnerApiKey}` };
  const runnerGet = async (runId, endpoint) => {
    const response = await fetchImpl(`${RUNNER_API}/v1/runs/${encodeURIComponent(runId)}/${endpoint}`, {
      headers: runnerHeaders,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { diagnosticError: `runner_http_${response.status}` };
    try { return await response.json(); } catch { return { diagnosticError: 'runner_invalid_json' }; }
  };
  const inspected = [];
  for (const attempt of attempts) {
    const runnerRunId = RUNNER_RUN_ID.test(attempt.session_id ?? '') ? attempt.session_id : null;
    const report = {
      controlPlaneAttemptId: attempt.id,
      generation: attempt.generation,
      engine: attempt.engine ?? null,
      controlPlaneStatus: attempt.status,
      startedAt: attempt.started_at ? new Date(attempt.started_at).toISOString() : null,
      finishedAt: attempt.finished_at ? new Date(attempt.finished_at).toISOString() : null,
      errorClass: attempt.error_class ?? null,
      runnerRunId,
    };
    if (!runnerRunId) {
      inspected.push({ ...report, diagnosticError: attempt.session_id ? 'runner_run_id_not_recognized' : 'runner_run_id_not_attached' });
      continue;
    }
    const [status, result, artifactManifest] = await Promise.all([
      runnerGet(runnerRunId, 'status'), runnerGet(runnerRunId, 'result'), runnerGet(runnerRunId, 'artifacts'),
    ]);
    let savedLog = { fetched: false, host: null, httpStatus: null, bytes: null, truncated: false, error: null };
    const rawLogUrl = typeof artifactManifest.logUrl === 'string' ? artifactManifest.logUrl : null;
    if (includeLogs && rawLogUrl) {
      try {
        const logUrl = new URL(rawLogUrl);
        const storageHost = logUrl.hostname === 'storage.googleapis.com'
          || logUrl.hostname.endsWith('.storage.googleapis.com')
          || logUrl.hostname === 'storage.cloud.google.com'
          || logUrl.hostname.endsWith('.storage.cloud.google.com');
        savedLog = { ...savedLog, host: logUrl.hostname };
        if (logUrl.protocol !== 'https:' || !storageHost || logUrl.username || logUrl.password) {
          savedLog = { ...savedLog, error: 'log_host_not_allowlisted' };
        } else {
          const response = await fetchImpl(logUrl, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
          savedLog = { ...savedLog, httpStatus: response.status };
          if (response.ok) {
            const content = await readCappedText(response, MAX_LOG_SOURCE_BYTES);
            const redacted = redactDiagnosticText(content.text);
            savedLog = { ...savedLog, fetched: true, bytes: content.bytes,
              truncated: content.truncated || redacted.length > MAX_LOG_CHARS,
              text: redacted.slice(0, MAX_LOG_CHARS) };
          }
        }
      } catch {
        savedLog = { ...savedLog, error: 'log_fetch_failed' };
      }
    }
    const events = [];
    let cursor = 0;
    let eventPageResetRequired = false;
    let eventPagesRead = 0;
    let eventReadError = null;
    for (; eventPagesRead < MAX_EVENT_PAGES;) {
      const page = await runnerGet(runnerRunId, `events?cursor=${cursor}&limit=500`);
      if (page.diagnosticError) { eventReadError = page.diagnosticError; break; }
      eventPagesRead += 1;
      if (page.resetRequired === true) eventPageResetRequired = true;
      if (Array.isArray(page.events)) events.push(...page.events);
      if (!page.hasMore || !Number.isSafeInteger(page.cursor) || page.cursor <= cursor) break;
      cursor = page.cursor;
    }
    const logEvents = events.filter((event) => event.type === 'log' && event.payload && typeof event.payload === 'object');
    const eventCounts = {};
    for (const event of events) eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    let remainingLogChars = MAX_LOG_CHARS;
    const safeLogEvents = logEvents.map((event) => {
      let message = typeof event.payload.message === 'string' ? redactDiagnosticText(event.payload.message) : null;
      const truncated = message !== null && message.length > Math.min(4000, remainingLogChars);
      if (message !== null) {
        message = message.slice(0, Math.min(4000, remainingLogChars));
        remainingLogChars -= message.length;
      }
      return { sequence: event.sequence, timestamp: event.timestamp, stream: event.payload.stream ?? null,
        level: event.payload.level ?? null, message, truncated };
    });
    const attemptReport = {
      ...report,
      runner: {
        state: status.state ?? null,
        engine: status.engine ?? null,
        routeMode: status.routeMode ?? null,
        workerStartPhase: status.workerStartPhase ?? null,
        workerStartAttempts: status.workerStartAttempts ?? null,
        connectionLost: status.connectionLost ?? null,
        lastHeartbeatAt: status.lastHeartbeatAt ?? null,
        result: {
          outcome: result.outcome ?? null,
          exitReason: result.exitReason ?? null,
          exitCode: result.exitCode ?? null,
          exitSignal: result.exitSignal ?? null,
          exitObserved: result.exitObserved ?? null,
          failure: result.failure && typeof result.failure === 'object' ? {
            code: result.failure.code ?? null,
            failureClass: result.failure.failureClass ?? null,
            safeSummary: typeof result.failure.safeSummary === 'string' ? redactDiagnosticText(result.failure.safeSummary).slice(0, 2000) : null,
            retryable: result.failure.retryable ?? null,
          } : null,
        },
        eventCounts,
        eventPageResetRequired,
        eventPagesRead,
        eventReadError,
        logEvents: safeLogEvents,
        artifactCount: Array.isArray(artifactManifest.artifacts) ? artifactManifest.artifacts.length : null,
        logAvailable: typeof artifactManifest.logUrl === 'string' && artifactManifest.logUrl.length > 0,
        ...(includeLogs ? { savedLog } : {}),
      },
    };
    if (!includeLogs) attemptReport.runner.logEvents = attemptReport.runner.logEvents.map(({ message, ...metadata }) => ({ ...metadata, messageAvailable: Boolean(message) }));
    inspected.push(attemptReport);
  }
  return { schemaVersion: 1, taskId, attemptCount: inspected.length, includesRedactedLogText: includeLogs, attempts: inspected };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const taskId = process.env.TASK_ID?.trim();
  const includeLogs = process.env.INCLUDE_REDACTED_LOGS === 'true';
  const report = await inspectProductionTask({ taskId, accountId: process.env.CF_ACCOUNT_ID?.trim(),
    apiToken: process.env.CF_API_TOKEN?.trim(), runnerApiKey: process.env.RUNNER_API_KEY_AGENT_API?.trim(), includeLogs });
  const path = process.env.DIAGNOSTICS_OUTPUT_PATH?.trim() || 'production-task-diagnostics.json';
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ taskId, attemptCount: report.attemptCount, includesRedactedLogText: includeLogs, artifactPath: path }));
}
