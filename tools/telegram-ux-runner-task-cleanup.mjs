import { createHmac } from 'node:crypto';

export const TELEGRAM_UX_RUNNER_API = 'https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev';
export const TELEGRAM_UX_PROFILE = 'integration-telegram-ux-v1';
export const TELEGRAM_UX_PRINCIPAL = 'integration-telegram-ux-v1';
export const TELEGRAM_UX_TENANT = 'telegram-ux-sandbox-20261009';

export async function cleanupTelegramUxRunnerTask({ userTaskId, env = process.env, fetchImpl = fetch }) {
  if (typeof userTaskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userTaskId)) throw new Error('cleanup_task_id_invalid');
  const apiKey = env.RUNNER_API_KEY_AGENT_API?.trim() ?? '';
  const delegationSecret = env.RUNNER_PROFILE_DELEGATION_SECRET?.trim() ?? '';
  if (!apiKey || !delegationSecret) throw new Error('cleanup_credentials_missing');
  const expiresAt = String(Date.now() + 60_000);
  const message = `${TELEGRAM_UX_PRINCIPAL}\0${TELEGRAM_UX_TENANT}\0${TELEGRAM_UX_PROFILE}\0${expiresAt}`;
  const signature = createHmac('sha256', delegationSecret).update(message).digest('hex');
  let response;
  try {
    response = await fetchImpl(`${TELEGRAM_UX_RUNNER_API}/v1/sandbox/cleanup-task`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json',
        'x-agent-profile-id': TELEGRAM_UX_PROFILE, 'x-agent-profile-tenant': TELEGRAM_UX_TENANT,
        'x-agent-profile-exp': expiresAt, 'x-agent-profile-sig': signature },
      body: JSON.stringify({ userTaskId }),
    });
  } catch { throw new Error('runner_cleanup_request_failed'); }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || !['cleaned', 'already-empty'].includes(result.status)
      || !Number.isSafeInteger(result.deletedRuns) || result.deletedRuns < 0) {
    const code = typeof result?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(result.error.code)
      ? result.error.code : `HTTP_${response.status}`;
    throw new Error(`runner_cleanup_rejected:${code}`);
  }
  return { status: result.status, deletedRuns: result.deletedRuns };
}
