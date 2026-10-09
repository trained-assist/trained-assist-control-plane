import { createHash } from 'node:crypto';

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
