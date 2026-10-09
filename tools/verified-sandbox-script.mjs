import { createHash, createHmac } from 'node:crypto';

/** Download only the pinned public operator helper, verifying bytes before SSH. */
export async function verifiedSandboxScript(url, expectedDigest, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error('runner_inventory_script_unreachable'); }
  if (!response.ok || !response.body) throw new Error('runner_inventory_script_unavailable');
  const reader = response.body.getReader();
  let bytes = Buffer.alloc(0);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes = Buffer.concat([bytes, value]);
      if (bytes.length > 64 * 1024) {
        await reader.cancel();
        throw new Error('runner_inventory_script_too_large');
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'runner_inventory_script_too_large') throw error;
    throw new Error('runner_inventory_script_read_failed');
  } finally { reader.releaseLock(); }
  if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest) {
    throw new Error('runner_inventory_script_digest_mismatch');
  }
  return bytes;
}

/** Keep the result contract independent from any service-held data in stdout. */
export function sanitizedRunnerInventory(result) {
  if (result?.schemaVersion !== 1 || result.target !== 'agent-runner-api-mcp-test'
    || typeof result.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(result.sourceSha)) {
    throw new Error('runner_inventory_response_invalid');
  }
  const output = { schemaVersion: 1, target: result.target, sourceSha: result.sourceSha };
  for (const name of ['admissionCount', 'nonterminalAdmissionCount', 'unknownOutcomeCount', 'launchRecordedCount']) {
    if (!Number.isSafeInteger(result[name]) || result[name] < 0 || result[name] > 1_000_000) {
      throw new Error('runner_inventory_response_invalid');
    }
    output[name] = result[name];
  }
  if (output.nonterminalAdmissionCount > output.admissionCount
    || output.unknownOutcomeCount > output.nonterminalAdmissionCount
    || output.launchRecordedCount > output.admissionCount) throw new Error('runner_inventory_response_invalid');
  for (const name of ['journalTerminalOnly', 'serviceActive', 'sandboxMode', 'mockTestEnabled',
    'journalTargetMatches', 'registryTargetMatches', 'portMatches', 'profileOwnerIsSandbox', 'ladderCredentialConfigured']) {
    if (typeof result[name] !== 'boolean') throw new Error('runner_inventory_response_invalid');
    output[name] = result[name];
  }
  if (output.journalTerminalOnly !== (output.nonterminalAdmissionCount === 0)) {
    throw new Error('runner_inventory_response_invalid');
  }
  const allowed = ['dynamic-ip-azure-agent-run', 'azure-dynamic-ip-agent-run', 'eu-vm-agent-run', 'ru-vm-agent-run', 'mock-test'];
  if (!Array.isArray(result.workerEngines) || result.workerEngines.some(name => !allowed.includes(name))) {
    throw new Error('runner_inventory_response_invalid');
  }
  output.workerEngines = [...new Set(result.workerEngines)].sort();
  const bindings = ['AGENT_API_WORKERS', 'EXTERNAL_WORKER_URL', 'EXTERNAL_WORKER_TOKEN',
    'AGENT_API_PROFILE_WORKSPACE_ROOT', 'AGENT_API_PROFILE_OWNER', 'AGENT_API_PROFILE_GITHUB_TOKEN',
    'AGENT_API_PROFILE_TENANT_ROUTES_JSON', 'AGENT_API_PROFILE_DELEGATION_SECRET', 'AGENT_API_PUBLIC_URL',
    'GCS_BUCKET', 'GOOGLE_APPLICATION_CREDENTIALS'];
  output.bindingPresence = {};
  for (const name of bindings) {
    if (typeof result.bindingPresence?.[name] !== 'boolean') throw new Error('runner_inventory_response_invalid');
    output.bindingPresence[name] = result.bindingPresence[name];
  }
  return output;
}

/** Project mode-only repair evidence without retaining service-held values. */
export function sanitizedRunnerPermissions(result) {
  if (result?.schemaVersion !== 1 || result.target !== 'agent-runner-api-mcp-test'
    || !['restricted', 'already_private'].includes(result.components?.environment)
    || !['restricted', 'already_private'].includes(result.components?.journal)) {
    throw new Error('runner_permissions_response_invalid');
  }
  return { schemaVersion: 1, target: result.target, components: {
    environment: result.components.environment, journal: result.components.journal,
  } };
}

export function sanitizedRunnerFileMetadata(value) {
  if (!value || typeof value !== 'object') throw new Error('runner_file_metadata_invalid');
  const result = {};
  for (const component of ['environment', 'journal']) {
    const entry = value[component];
    if (typeof entry?.exists !== 'boolean') throw new Error('runner_file_metadata_invalid');
    result[component] = { exists: entry.exists };
    if (!entry.exists) continue;
    if (!['root', 'sandbox', 'other'].includes(entry.owner)) throw new Error('runner_file_metadata_invalid');
    result[component].owner = entry.owner;
    for (const name of ['regular', 'unique', 'privateMode', 'serviceCanRead', 'serviceCanWrite']) {
      if (typeof entry[name] !== 'boolean') throw new Error('runner_file_metadata_invalid');
      result[component][name] = entry[name];
    }
  }
  return result;
}

export function sanitizedSandbox3Namespace(value) {
  if (value?.schemaVersion !== 1 || value.target !== 'agent-runner-api-sandbox3') throw new Error('sandbox3_operator_response_invalid');
  const output = { schemaVersion: 1, target: value.target };
  for (const name of ['serviceActive', 'serviceExecSourceVerified', 'realExecutionVerified']) {
    if (typeof value[name] !== 'boolean') throw new Error('sandbox3_operator_response_invalid');
    output[name] = value[name];
  }
  if (value.runtimeSourceSha !== null && (typeof value.runtimeSourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(value.runtimeSourceSha))) {
    throw new Error('sandbox3_operator_response_invalid');
  }
  output.runtimeSourceSha = value.runtimeSourceSha;
  output.componentsExist = {}; output.proxyServicesActive = {};
  for (const name of ['environment', 'registry', 'unit', 'state', 'runtime']) {
    if (typeof value.componentsExist?.[name] !== 'boolean') throw new Error('sandbox3_operator_response_invalid');
    output.componentsExist[name] = value.componentsExist[name];
  }
  for (const name of ['caddy', 'nginx']) {
    if (typeof value.proxyServicesActive?.[name] !== 'boolean') throw new Error('sandbox3_operator_response_invalid');
    output.proxyServicesActive[name] = value.proxyServicesActive[name];
  }
  return output;
}

export function sandbox3Credentials(seed) {
  if (typeof seed !== 'string' || new TextEncoder().encode(seed).length < 32) throw new Error('sandbox3_operator_seed_invalid');
  const derive = role => createHmac('sha256', seed).update(`trained-assist/agent-runner-api-sandbox3/bootstrap/v1/${role}`).digest('base64url');
  return { apiKey: `ta_sb3_${derive('api-key')}`, delegationSecret: derive('profile-delegation') };
}
