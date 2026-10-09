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
  try {
    if (typeof apiKey !== 'string' || apiKey.length < 32) throw new Error('key');
    const response = await fetchImpl(`${BASE}/v1/capabilities`, {
      redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${apiKey}`, 'cache-control': 'no-store' },
    });
    const body = await response.json();
    if (response.status !== 200 || body?.contract?.name !== 'ai-agent-runner/serverless-agent-api'
      || body?.placement !== 'cloudflare-worker') throw new Error('auth');
    return true;
  } catch { throw new Error('sandbox3_runner_principal_not_authorized'); }
}
