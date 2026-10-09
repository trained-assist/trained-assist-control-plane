const BASE = 'https://169-58-15-230.sslip.io/runner-sandbox3';
export async function verifySandbox3PublicRoute(fetchImpl = fetch) {
  try {
    const results = await Promise.allSettled(['/healthz', '/v1/capabilities'].map(path => fetchImpl(`${BASE}${path}`, {
      redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'cache-control': 'no-store' },
    })));
    if (results.some(result => result.status !== 'fulfilled')) throw new Error('unreachable');
    const [health, auth] = results.map(result => result.value);
    const healthBody = await health.json(); const authBody = await auth.json();
    if (health.status !== 200 || healthBody?.status !== 'ok' || auth.status !== 401 || authBody?.error?.code !== 'UNAUTHENTICATED') {
      throw new Error('contract');
    }
    return { publicRouteVerified: true, tlsVerified: true, healthStatus: 200, anonymousCapabilitiesStatus: 401,
      authenticatedContractVerified: false, realTelegramE2E: false };
  } catch { throw new Error('sandbox3_public_route_not_verified'); }
}
