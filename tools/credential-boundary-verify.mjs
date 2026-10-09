import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const maximumBytes = 1024 * 1024;
const reference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
const canonicalRun = value => typeof value === 'string' && (
  /^run_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  || /^run_[a-f0-9]{64}_[a-f0-9]{24}$/.test(value)
);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireCondition = (condition, reason) => { if (!condition) throw new Error(reason); };
const exact = (actual, expected) => record(actual) && Object.keys(actual).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, value]) => actual[key] === value);
const parseObject = text => {
  const value = JSON.parse(text);
  requireCondition(record(value), 'invalid_json_object');
  return value;
};

export function validateExpectation(expected) {
  const keys = ['version', 'cpOrigin', 'statusMethod', 'taskId', 'profileId', 'hostPrincipalId', 'conversationRef',
    'awaitingInputId', 'provider', 'bindingRef', 'providerSessionRef', 'eventId', 'generation', 'waitVersion', 'runId', 'orchestrationEngine', 'nativeEngine'];
  requireCondition(record(expected) && Object.keys(expected).length === keys.length && keys.every(key => Object.hasOwn(expected, key)), 'invalid_expectation');
  requireCondition(expected.version === 'credential-boundary-verify-v2' && expected.profileId === 'integration-v1'
    && expected.hostPrincipalId === 'integration-v1-google-host' && expected.provider === 'google'
    && ['GET', 'POST'].includes(expected.statusMethod) && expected.orchestrationEngine === 'cloudflare-workflows'
    && expected.nativeEngine === 'dynamic-ip-azure-agent-run'
    && ['taskId', 'conversationRef', 'awaitingInputId', 'bindingRef', 'providerSessionRef', 'eventId'].every(key => reference(expected[key]))
    && canonicalRun(expected.runId) && Number.isSafeInteger(expected.generation) && expected.generation > 0
    && Number.isSafeInteger(expected.waitVersion) && expected.waitVersion > 0, 'invalid_expectation');
  const origin = new URL(expected.cpOrigin);
  requireCondition(origin.protocol === 'https:' && origin.origin === expected.cpOrigin && !origin.username && !origin.password,
    'invalid_pinned_origin');
  return expected;
}

export async function readPrivateJson(file) {
  requireCondition(typeof file === 'string' && isAbsolute(file), 'private_configuration_required');
  const parent = await lstat(dirname(file));
  const selected = await lstat(file);
  requireCondition(parent.isDirectory() && (parent.mode & 0o777) === 0o700 && selected.isFile()
    && (selected.mode & 0o777) === 0o600 && parent.uid === process.getuid() && selected.uid === process.getuid(), 'unsafe_private_configuration');
  const descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await descriptor.stat();
    requireCondition(opened.isFile() && opened.dev === selected.dev && opened.ino === selected.ino
      && (opened.mode & 0o777) === 0o600 && opened.uid === process.getuid(), 'unsafe_private_configuration');
    const bytes = Buffer.alloc(maximumBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const chunk = await descriptor.read(bytes, size, bytes.length - size, null);
      if (chunk.bytesRead === 0) break;
      size += chunk.bytesRead;
    }
    requireCondition(size <= maximumBytes, 'configuration_too_large');
    return parseObject(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally { await descriptor.close(); }
}

async function boundedJson(response) {
  if (response.status !== 200 || !response.body) {
    if (response.body) await response.body.cancel();
    throw new Error('read_transport_refused');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      requireCondition(size <= maximumBytes, 'response_too_large');
      chunks.push(Buffer.from(chunk.value));
    }
    return parseObject(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export function readOnlyClient(binding, expectation, fetchImpl = fetch) {
  const expected = structuredClone(validateExpectation(expectation));
  requireCondition(record(binding) && binding.profileId === expected.profileId && binding.principalId === expected.hostPrincipalId
    && typeof binding.principalSignature === 'string' && /^[a-f0-9]{64}$/.test(binding.principalSignature), 'invalid_host_binding');
  const base = new URL(binding.baseUrl);
  requireCondition(base.origin === expected.cpOrigin && base.protocol === 'https:' && !base.username && !base.password
    && !base.search && !base.hash && base.pathname === '/', 'host_origin_mismatch');
  const headers = { 'x-principal': binding.principalId, 'x-principal-sig': binding.principalSignature };
  return {
    async call(method, route, body) {
      const awaiting = method === 'GET' && route === `/awaiting/${expected.awaitingInputId}` && body === undefined;
      const statusGet = method === 'GET' && expected.statusMethod === 'GET'
        && route === `/status?taskId=${encodeURIComponent(expected.taskId)}` && body === undefined;
      const statusPost = method === 'POST' && expected.statusMethod === 'POST' && route === '/status' && exact(body, { taskId: expected.taskId });
      requireCondition(awaiting || statusGet || statusPost, 'read_only_endpoint_forbidden');
      const response = await fetchImpl(`${expected.cpOrigin}${route}`, { method, redirect: 'error',
        headers: { ...headers, ...(statusPost ? { 'content-type': 'application/json' } : {}) },
        ...(statusPost ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
      return boundedJson(response);
    },
  };
}

function validateCheckpoint(checkpoint, expected) {
  requireCondition(record(checkpoint) && checkpoint.version === 'credential-boundary-prepare-v1'
    && checkpoint.phase === 'verified_event_delivered_not_work_verified' && checkpoint.providerVerified === true
    && checkpoint.readyEventSent === true && ['taskId', 'profileId', 'conversationRef', 'awaitingInputId', 'provider',
      'bindingRef', 'providerSessionRef', 'eventId', 'generation', 'waitVersion'].every(key => checkpoint[key] === expected[key]), 'checkpoint_scope_mismatch');
  requireCondition(exact(checkpoint.event, { status: 'ready', eventId: expected.eventId, userTaskId: expected.taskId,
    profileId: expected.profileId, provider: expected.provider, bindingRef: expected.bindingRef,
    providerSessionRef: expected.providerSessionRef, generation: expected.generation, version: expected.waitVersion }), 'checkpoint_event_mismatch');
  for (const [key, duplicate] of [['firstCompletion', false], ['repeatedCompletion', true]]) {
    const completion = checkpoint[key];
    requireCondition(completion?.status === 200 && completion.body?.awaitingInputId === expected.awaitingInputId
      && completion.body.duplicate === duplicate && completion.body.delivered === true, 'checkpoint_delivery_unconfirmed');
  }
}

export async function verifyBoundary({ expected: expectation, checkpoint, client }) {
  const expected = structuredClone(validateExpectation(expectation));
  validateCheckpoint(checkpoint, expected);
  const wait = await client.call('GET', `/awaiting/${expected.awaitingInputId}`);
  requireCondition(wait.awaiting_input_id === expected.awaitingInputId && wait.user_task_id === expected.taskId
    && wait.purpose === 'credential' && wait.status === 'answered' && wait.respondent_scope === expected.profileId
    && wait.generation === expected.generation && wait.version === expected.waitVersion && wait.checkpoint_ref === null
    && Number.isSafeInteger(wait.answered_at) && wait.answered_at > 0 && Number.isSafeInteger(wait.answer_signal_id)
    && wait.answer_signal_id > 0, 'durable_wait_mismatch');
  const schema = parseObject(wait.schema_json);
  requireCondition(exact(schema.credential, { hostPrincipalId: expected.hostPrincipalId, provider: expected.provider,
    bindingRef: expected.bindingRef, providerSessionRef: expected.providerSessionRef }), 'durable_schema_mismatch');
  const ready = { status: 'ready', bindingRef: expected.bindingRef, provider: expected.provider, eventId: expected.eventId,
    generation: expected.generation, version: expected.waitVersion };
  requireCondition(exact(parseObject(wait.answer_json), ready) && exact(wait.answer, ready), 'typed_ready_answer_required');
  const status = expected.statusMethod === 'GET'
    ? await client.call('GET', `/status?taskId=${encodeURIComponent(expected.taskId)}`)
    : await client.call('POST', '/status', { taskId: expected.taskId });
  const task = status.taskStore;
  requireCondition(task?.id === expected.taskId && task.conversation_id === expected.conversationRef
    && task.generation === expected.generation && task.status === 'done' && task.awaiting_input_id === null, 'same_task_terminal_success_required');
  requireCondition(task.awaiting?.id === expected.awaitingInputId && task.awaiting.status === 'answered', 'status_wait_projection_mismatch');
  requireCondition(Array.isArray(task.signals), 'typed_ready_signal_required');
  const signals = task.signals.filter(signal => signal.type === 'credential_ready');
  requireCondition(signals.length === 1 && signals[0].step === expected.awaitingInputId
    && signals[0].id === wait.answer_signal_id && signals[0].consumed > 0
    && signals[0].rejected === null && exact(parseObject(signals[0].payload), {
      status: 'ready', bindingRef: expected.bindingRef, provider: expected.provider }), 'typed_ready_signal_required');
  const result = task.result;
  requireCondition(result?.ok === true && result.mode === 'engine' && result.persistence === 'persisted'
    && result.runId === expected.runId && result.ownerGeneration === expected.generation && result.exitReason === 'completed'
    && result.engineText?.source === 'runner_status_answer' && typeof result.answer === 'string' && result.answer.trim(), 'persisted_native_result_required');
  requireCondition(Array.isArray(status.runs) && status.runs.length === 1, 'one_workflow_attempt_required');
  const attempt = status.runs[0];
  requireCondition(attempt.task_id === expected.taskId && attempt.generation === expected.generation
    && attempt.session_id === expected.runId && attempt.engine === expected.orchestrationEngine && attempt.status === 'success'
    && Number.isSafeInteger(attempt.started_at) && attempt.started_at >= wait.answered_at
    && Number.isSafeInteger(attempt.finished_at) && attempt.finished_at >= attempt.started_at && attempt.error_class === null, 'workflow_attempt_mismatch');
  return { outcome: 'pass', taskId: expected.taskId, runId: expected.runId, generation: expected.generation,
    answeredTypedReady: true, identicalReplayCheckpointConfirmed: true, successfulWorkflowAttemptCount: 1,
    workflowStartedAfterReadiness: true, nativeFinalAnswerChannelVerified: true,
    nativeEngineVerified: false, nativeLaunchTimeVerified: false,
    providerReverified: false, csvReadbackVerified: false, googleSheetsVerified: false, telegramDelivered: false };
}

export async function runCli(args, { fetchImpl = fetch, write = text => console.log(text) } = {}) {
  try {
    requireCondition(args.length === 4 && args[0] === 'verify', 'invalid_configuration');
    const expected = validateExpectation(await readPrivateJson(args[1]));
    const binding = await readPrivateJson(args[2]);
    const checkpoint = await readPrivateJson(args[3]);
    const client = readOnlyClient(binding, expected, fetchImpl);
    write(JSON.stringify(await verifyBoundary({ expected, checkpoint, client })));
    return 0;
  } catch {
    write(JSON.stringify({ outcome: 'refused', reason: 'credential_boundary_verification_refused',
      nativeEngineVerified: false, nativeLaunchTimeVerified: false, providerReverified: false,
      csvReadbackVerified: false, googleSheetsVerified: false, telegramDelivered: false }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
