const profileId = 'integration-v1';
const hostPrincipalId = 'integration-v1-google-host';
const sourceSha = 'a4acd6c1f428d56abb1fdb6610889528f3049fb5';
const reference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
const requireCondition = (condition, reason) => { if (!condition) throw new Error(reason); };
const maxResponseBytes = 1024 * 1024;

async function boundedJson(response) {
  requireCondition(response.body && Number(response.headers.get('content-length') ?? 0) <= maxResponseBytes, 'cp_response_too_large');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw new Error('cp_response_too_large');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    const body = JSON.parse(text + decoder.decode());
    requireCondition(body && typeof body === 'object' && !Array.isArray(body), 'invalid_cp_json_response');
    return body;
  } finally { reader.releaseLock(); }
}

export function privateClient(binding, fetchImpl = fetch) {
  requireCondition(binding.profileId === profileId && reference(binding.principalId)
    && typeof binding.principalSignature === 'string' && /^[0-9a-f]{64}$/.test(binding.principalSignature), 'invalid_private_binding');
  const base = new URL(binding.baseUrl);
  requireCondition(base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash, 'invalid_cp_origin');
  return {
    principalId: binding.principalId,
    origin: base.origin,
    async call(method, path, body) {
      requireCondition((method === 'POST' && ['/intake', '/awaiting', '/signal'].includes(path))
        || (method === 'POST' && /^\/awaiting\/[A-Za-z0-9._:-]+\/answer$/.test(path))
        || (method === 'GET' && (/^\/status\?taskId=/.test(path) || /^\/awaiting\/[A-Za-z0-9._:-]+$/.test(path))), 'operator_endpoint_forbidden');
      const response = await fetchImpl(`${base.origin}${path}`, {
        method, redirect: 'error', headers: { 'x-principal': binding.principalId, 'x-principal-sig': binding.principalSignature,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90000),
      });
      return { status: response.status, body: await boundedJson(response) };
    },
  };
}

export async function prepareBoundary({ user, host, goal, csvRef, csvOwnerRepo, bindingRef, providerSessionRef, nonce, checkpoint = async () => {} }) {
  requireCondition(host.principalId === hostPrincipalId && user.principalId !== hostPrincipalId
    && user.origin === host.origin, 'host_user_binding_mismatch');
  requireCondition([bindingRef, providerSessionRef, nonce].every(reference), 'invalid_boundary_refs');
  requireCondition(typeof goal === 'string' && goal.trim() && typeof csvRef === 'string' && csvRef.trim(), 'actual_csv_input_required');
  requireCondition(typeof csvOwnerRepo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(csvOwnerRepo)
    && csvRef === `https://raw.githubusercontent.com/${csvOwnerRepo}/${sourceSha}/fixtures/integration-v1/category-source.csv`,
    'immutable_csv_source_a4acd6c_required');
  const requestId = `credential-csv-${nonce}`;
  const conversationRef = `credential-csv-conversation-${nonce}`;
  requireCondition(requestId.length <= 200 && conversationRef.length <= 200, 'nonce_too_long');
  const envelope = { contractVersion: 1, profileId, requestId, conversationRef,
    inputItems: [{ text: `${goal}\nUse only the public immutable CSV fixture ${csvRef} (sourceSha ${sourceSha}). Download it, then read the downloaded file before computing results. This is CSV work and a provider-attestation subboundary, not Google Sheet acceptance.` }] };
  const accepted = await user.call('POST', '/intake', envelope);
  requireCondition(accepted.status === 201 && accepted.body.durable === true && accepted.body.duplicate === false
    && accepted.body.profileId === profileId && reference(accepted.body.userTaskId), 'fresh_durable_receipt_required');
  const taskId = accepted.body.userTaskId;
  const record = { version: 'credential-boundary-prepare-v1', phase: 'accepted', taskId, profileId,
    requestId, conversationRef, provider: 'google', bindingRef, providerSessionRef,
    eventId: `google-ready-${nonce}`, providerVerified: false, readyEventSent: false };
  await checkpoint(record);
  const repeat = await user.call('POST', '/intake', envelope);
  requireCondition(repeat.status === 200 && repeat.body.durable === true && repeat.body.duplicate === true
    && repeat.body.userTaskId === taskId, 'receipt_retry_identity_changed');
  const status = async () => {
    const result = await host.call('GET', `/status?taskId=${encodeURIComponent(taskId)}`);
    requireCondition(result.status === 200 && result.body.taskStore.id === taskId
      && result.body.taskStore.generation === 1 && result.body.taskStore.conversation_id === conversationRef
      && result.body.runs.length === 0, 'preexecution_same_task_generation_required');
    return result.body;
  };
  await status();
  const opened = await host.call('POST', '/awaiting', { taskId, purpose: 'credential',
    question: 'Awaiting independently verified isolated Google connection; CSV boundary only.', respondentScope: profileId,
    credential: { provider: 'google', bindingRef, providerSessionRef } });
  requireCondition(opened.status === 201 && reference(opened.body.awaitingInputId)
    && opened.body.generation === 1 && Number.isSafeInteger(opened.body.version) && opened.body.version > 0, 'registered_credential_wait_required');
  Object.assign(record, { phase: 'registered', awaitingInputId: opened.body.awaitingInputId, generation: 1, waitVersion: opened.body.version });
  await checkpoint(record);
  const assertOpen = async () => {
    const current = await status();
    requireCondition(current.taskStore.status === 'awaiting_input'
      && current.taskStore.awaiting_input_id === record.awaitingInputId, 'wait_projection_changed');
    const wait = await host.call('GET', `/awaiting/${record.awaitingInputId}`);
    requireCondition(wait.status === 200 && wait.body.status === 'open' && wait.body.purpose === 'credential'
      && wait.body.generation === 1 && wait.body.version === record.waitVersion && wait.body.answer_json === null, 'credential_wait_resolved_without_verification');
    const requirement = JSON.parse(wait.body.schema_json).credential;
    requireCondition(requirement.hostPrincipalId === hostPrincipalId && requirement.provider === 'google'
      && requirement.bindingRef === bindingRef && requirement.providerSessionRef === providerSessionRef, 'stored_binding_mismatch');
    return JSON.stringify({ signals: current.taskStore.signals, history: current.taskStore.history });
  };
  const before = await assertOpen();
  const answer = await user.call('POST', `/awaiting/${record.awaitingInputId}/answer`, {
    idempotencyKey: `negative-answer-${nonce}`, answer: { answer: 'ready' } });
  requireCondition(answer.status === 409, 'generic_answer_not_refused');
  const signal = await user.call('POST', '/signal', { taskId, type: 'user_reply',
    payload: { answer: 'ready' }, idempotencyKey: `negative-text-${nonce}` });
  requireCondition(signal.status === 200 && signal.body.delivered === false
    && signal.body.reason === 'verified_credential_event_required', 'generic_text_not_refused');
  requireCondition(await assertOpen() === before, 'negative_probe_changed_durable_state');
  record.phase = 'prepared_no_verification_or_event';
  await checkpoint(record);
  return record;
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const { readFile, open } = await import('node:fs/promises');
    const { randomUUID } = await import('node:crypto');
    const [command, userPath, hostPath, inputPath, outputPath] = process.argv.slice(2);
    requireCondition(command === 'prepare' && outputPath, 'usage_prepare_user_binding_host_binding_input_private_output');
    const input = JSON.parse(await readFile(inputPath, 'utf8'));
    const user = privateClient(JSON.parse(await readFile(userPath, 'utf8')));
    const host = privateClient(JSON.parse(await readFile(hostPath, 'utf8')));
    const output = await open(outputPath, 'wx', 0o600);
    try {
      await prepareBoundary({ ...input, nonce: randomUUID(), user, host, checkpoint: async record => {
        await output.truncate(0);
        await output.write(JSON.stringify(record, null, 2), 0, 'utf8');
        await output.sync();
      } });
      console.log('prepared: receipt and refusal probes passed; no verification, ready event or Runner dispatch');
    } finally { await output.close(); }
  } catch {
    console.error('credential boundary preparation refused; inspect private checkpoint and operator prerequisites');
    process.exitCode = 1;
  }
}
