import { createHmac } from 'node:crypto';

const LIVE_BASE = 'https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev';
const MOCK_BASE = 'https://trained-assist-runner-api-cp-sandbox3.skillset-apply.workers.dev';
const LIVE_PRINCIPAL = 'sandbox3-agent-api-principal';
const LIVE_TENANT = 'sandbox3-acceptance-a-20261008';
const LIVE_PROFILE = 'integration-sandbox3-v1';
export async function verifySandbox3PublicRoute(fetchImpl = fetch, base = LIVE_BASE) {
  try {
    const liveRunner = base === LIVE_BASE;
    const results = await Promise.allSettled(['/healthz', '/version', '/v1/capabilities'].map(path => fetchImpl(`${base}${path}`, {
      redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'cache-control': 'no-store' },
    })));
    if (results.some(result => result.status !== 'fulfilled')) throw new Error('unreachable');
    const [health, version, auth] = results.map(result => result.value);
    const [healthBody, versionBody, authBody] = await Promise.all([health.json(), version.json(), auth.json()]);
    if (health.status !== 200 || healthBody?.status !== 'ok' || healthBody?.service !== 'ai-agent-runner-api'
      || healthBody?.placement !== 'cloudflare-worker' || (liveRunner && healthBody?.executionWorker !== 'eu-vm-agent-run') || version.status !== 200
      || versionBody?.runtime !== 'cloudflare-worker' || auth.status !== 401 || authBody?.error?.code !== 'UNAUTHENTICATED') {
      throw new Error('contract');
    }
    return { publicRouteVerified: true, runnerApiPlacement: 'cloudflare-worker', healthStatus: 200, versionStatus: 200, anonymousCapabilitiesStatus: 401,
      authenticatedContractVerified: false, realTelegramE2E: false };
  } catch { throw new Error('sandbox3_public_route_not_verified'); }
}
export const verifySandbox3MockPublicRoute = fetchImpl => verifySandbox3PublicRoute(fetchImpl, MOCK_BASE);

export async function verifySandbox3RunnerPrincipal(apiKey, fetchImpl = fetch, base = LIVE_BASE) {
  if (typeof apiKey !== 'string' || apiKey.length < 32) throw new Error('sandbox3_runner_principal_not_authorized');
  let response;
  try {
    response = await fetchImpl(`${base}/v1/capabilities`, {
      redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${apiKey}`, 'cache-control': 'no-store' },
    });
  } catch { throw new Error('sandbox3_runner_principal_check_failed'); }
  if (response.status === 401) throw new Error('sandbox3_runner_principal_not_authorized');
  let body;
  try { body = await response.json(); } catch { throw new Error('sandbox3_runner_contract_mismatch'); }
  if (response.status !== 200 || body?.contract?.name !== 'ai-agent-runner/serverless-agent-api'
    || body?.placement !== 'cloudflare-worker') throw new Error('sandbox3_runner_contract_mismatch');
  return true;
}

export async function verifySandbox3DelegatedProfile(apiKey, delegationSecret, fetchImpl = fetch, base = LIVE_BASE) {
  if (typeof apiKey !== 'string' || apiKey.length < 32
    || typeof delegationSecret !== 'string' || Buffer.byteLength(delegationSecret) < 32) {
    throw new Error('sandbox3_profile_credentials_invalid');
  }
  const expiresAt = String(Date.now() + 60_000);
  const message = `${LIVE_PRINCIPAL}\0${LIVE_TENANT}\0${LIVE_PROFILE}\0${expiresAt}`;
  const signature = createHmac('sha256', delegationSecret).update(message).digest('hex');
  let response;
  try {
    response = await fetchImpl(`${base}/v1/capabilities`, {
      redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${apiKey}`,
        'x-agent-profile-id': LIVE_PROFILE,
        'x-agent-profile-tenant': LIVE_TENANT,
        'x-agent-profile-exp': expiresAt,
        'x-agent-profile-sig': signature,
        'cache-control': 'no-store',
      },
    });
  } catch { throw new Error('sandbox3_profile_delegation_probe_failed'); }
  if (response.status === 503) throw new Error('sandbox3_profile_delegation_unconfigured');
  let body;
  try { body = await response.json(); } catch { throw new Error('sandbox3_profile_delegation_contract_mismatch'); }
  if (response.status === 403) throw new Error('sandbox3_profile_delegation_refused');
  if (response.status !== 200 || body?.contract?.name !== 'ai-agent-runner/serverless-agent-api'
    || body?.placement !== 'cloudflare-worker') throw new Error('sandbox3_profile_delegation_contract_mismatch');
  return true;
}

export async function waitForSandbox3RunnerPrincipal(apiKey, fetchImpl = fetch, { attempts = 15, intervalMs = 2_000, base = LIVE_BASE } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await verifySandbox3RunnerPrincipal(apiKey, fetchImpl, base); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'sandbox3_runner_principal_not_authorized' || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
}
