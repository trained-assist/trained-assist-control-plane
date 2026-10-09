const BASE = 'https://trained-assist-runner-api-cp-sandbox3.skillset-apply.workers.dev';
export async function verifySandbox3PublicRoute(fetchImpl = fetch) {
  try {
    const results = await Promise.allSettled(['/healthz', '/version', '/v1/capabilities'].map(path => fetchImpl(`${BASE}${path}`, {
      redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'cache-control': 'no-store' },
    })));
    if (results.some(result => result.status !== 'fulfilled')) throw new Error('unreachable');
    const [health, version, auth] = results.map(result => result.value);
    const [healthBody, versionBody, authBody] = await Promise.all([health.json(), version.json(), auth.json()]);
    if (health.status !== 200 || healthBody?.status !== 'ok' || healthBody?.service !== 'ai-agent-runner-api'
      || healthBody?.placement !== 'cloudflare-worker' || version.status !== 200
      || versionBody?.runtime !== 'cloudflare-worker' || auth.status !== 401 || authBody?.error?.code !== 'UNAUTHENTICATED') {
      throw new Error('contract');
    }
    return { publicRouteVerified: true, runnerApiPlacement: 'cloudflare-worker', healthStatus: 200, versionStatus: 200, anonymousCapabilitiesStatus: 401,
      authenticatedContractVerified: false, realTelegramE2E: false };
  } catch { throw new Error('sandbox3_public_route_not_verified'); }
}

export async function verifySandbox3RunnerPrincipal(apiKey, fetchImpl = fetch) {
  if (typeof apiKey !== 'string' || apiKey.length < 32) throw new Error('sandbox3_runner_principal_not_authorized');
  let response;
  try {
    response = await fetchImpl(`${BASE}/v1/capabilities`, {
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

export async function waitForSandbox3RunnerPrincipal(apiKey, fetchImpl = fetch, { attempts = 15, intervalMs = 2_000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await verifySandbox3RunnerPrincipal(apiKey, fetchImpl); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'sandbox3_runner_principal_not_authorized' || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
}
