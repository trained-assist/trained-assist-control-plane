const COMMAND_NAMES = new Set(['git', 'npx', 'ssh', 'gh']);

const WRANGLER_FAILURE_PATTERNS = [
  [/invalid api token|authentication error|not authenticated|authentication failed/i, 'cloudflare_authentication_failed'],
  [/not authorized|permission denied|insufficient permissions|missing permission/i, 'cloudflare_permission_denied'],
  [/database .*not found|unknown database|database does not exist/i, 'd1_target_unavailable'],
  [/migration .*failed|failed to apply migration|sqlite error/i, 'd1_migration_failed'],
  [/fetch failed|network request failed|econnreset|econnrefused|etimedout|enotfound/i, 'cloudflare_api_unreachable'],
];

const SSH_FAILURE_PATTERNS = [
  [/permission denied|publickey|authentication failed/i, 'runner_ssh_authentication_failed'],
  [/connection timed out|connection refused|connection reset|no route to host/i, 'runner_ssh_unreachable'],
];

const GITHUB_FAILURE_PATTERNS = [
  [/HTTP 403|Resource not accessible|permission denied|insufficient permission/i, 'github_permission_denied'],
  [/HTTP 401|authentication failed|not logged|GH_TOKEN/i, 'github_authentication_failed'],
  [/HTTP 404|no artifact matches|artifact.*expired|not found/i, 'github_artifact_unavailable'],
];

/** Return a stable, allowlisted reason code without retaining command output. */
export function commandFailureReason(command, result) {
  const safeCommand = COMMAND_NAMES.has(command) ? command : 'command';
  if (result?.error) {
    return result.error.code === 'ENOENT'
      ? `command_unavailable:${safeCommand}`
      : `command_spawn_failed:${safeCommand}`;
  }

  const output = `${typeof result?.stdout === 'string' ? result.stdout : ''}\n${typeof result?.stderr === 'string' ? result.stderr : ''}`;
  if (safeCommand === 'ssh') {
    const installationFailures = new Map([
      ['API did not become healthy', 'sandbox3_api_unhealthy'],
      ['API service is not active', 'sandbox3_service_inactive'],
      ['installation requires an inactive fenced service', 'sandbox3_service_active_install_refused'],
      ['admission journal contains unfinished or invalid runs', 'sandbox3_journal_not_terminal'],
      ['a new run appeared during deployment', 'sandbox3_admission_during_install'],
      ['wrong isolated service account', 'sandbox3_service_account_mismatch'],
      ['wrong runtime executable', 'sandbox3_runtime_executable_mismatch'],
      ['current candidate is unhealthy', 'sandbox3_current_candidate_unhealthy'],
      ['candidate release already exists with a different current pointer', 'sandbox3_candidate_pointer_mismatch'],
    ]);
    for (const line of output.split(/\r?\n/)) {
      const reason = installationFailures.get(line.startsWith('[sandbox3-api] ERROR: ') ? line.slice(22) : '');
      if (reason) return `${reason}:ssh:${Number.isInteger(result?.status) ? result.status : 'unknown'}`;
    }
  }
  const patterns = safeCommand === 'npx' ? WRANGLER_FAILURE_PATTERNS
    : safeCommand === 'ssh' ? SSH_FAILURE_PATTERNS : safeCommand === 'gh' ? GITHUB_FAILURE_PATTERNS : [];
  const classification = patterns.find(([pattern]) => pattern.test(output))?.[1] ?? 'command_failed';
  const exitCode = Number.isInteger(result?.status) ? result.status : 'unknown';
  return `${classification}:${safeCommand}:${exitCode}`;
}
