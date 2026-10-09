const COMMAND_NAMES = new Set(['git', 'npx', 'ssh']);

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

/** Return a stable, allowlisted reason code without retaining command output. */
export function commandFailureReason(command, result) {
  const safeCommand = COMMAND_NAMES.has(command) ? command : 'command';
  if (result?.error) {
    return result.error.code === 'ENOENT'
      ? `command_unavailable:${safeCommand}`
      : `command_spawn_failed:${safeCommand}`;
  }

  const output = `${typeof result?.stdout === 'string' ? result.stdout : ''}\n${typeof result?.stderr === 'string' ? result.stderr : ''}`;
  const patterns = safeCommand === 'npx' ? WRANGLER_FAILURE_PATTERNS
    : safeCommand === 'ssh' ? SSH_FAILURE_PATTERNS : [];
  const classification = patterns.find(([pattern]) => pattern.test(output))?.[1] ?? 'command_failed';
  const exitCode = Number.isInteger(result?.status) ? result.status : 'unknown';
  return `${classification}:${safeCommand}:${exitCode}`;
}
