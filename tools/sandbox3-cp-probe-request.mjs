import { setTimeout as delay } from 'node:timers/promises';

// Secret updates can take time to reach the serving isolate. Only CP's explicit
// pre-admission authentication rejection is safe to repeat. Unknown outcomes,
// including an upstream Runner failure, must be reconciled by the operator.
export async function sandbox3CpProbeRequest(url, options, {
  fetcher = fetch, sleep = delay, now = Date.now,
} = {}) {
  const deadline = now() + 30_000;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('sandbox3_cp_auth_propagation_timeout');
    const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(remaining) });
    const body = await response.json();
    if (response.status !== 401 || body?.ok !== false || body.reasonCode !== 'authentication_failed'
      || attempt >= 15 || deadline - now() <= 2_000) return { response, body };
    await sleep(2_000);
  }
}
