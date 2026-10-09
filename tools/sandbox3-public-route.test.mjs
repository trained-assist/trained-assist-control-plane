import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySandbox3PublicRoute, verifySandbox3RunnerPrincipal } from './sandbox3-public-route.mjs';
test('public probe proves TLS route and auth refusal without carrying credentials', async () => {
  const calls = [];
  const result = await verifySandbox3PublicRoute(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/healthz')) return Response.json({ status: 'ok', service: 'ai-agent-runner-api', placement: 'cloudflare-worker' });
    if (url.endsWith('/version')) return Response.json({ runtime: 'cloudflare-worker' });
    return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'private-secret' } }, { status: 401 });
  });
  assert.equal(result.publicRouteVerified, true);
  assert.equal(result.runnerApiPlacement, 'cloudflare-worker');
  assert.equal(result.authenticatedContractVerified, false);
  assert.equal(JSON.stringify(result).includes('private-secret'), false);
  for (const { url, options } of calls) {
    assert.ok(url.startsWith('https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev/'));
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, undefined);
  }
});
test('sandbox API key is validated against the Cloudflare Runner API before CP pairing writes', async () => {
  const result = await verifySandbox3RunnerPrincipal('test-api-key-that-is-long-enough-for-validation', async (url, options) => {
    assert.ok(url.startsWith('https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev/'));
    assert.equal(options.headers.authorization, 'Bearer test-api-key-that-is-long-enough-for-validation');
    return Response.json({ contract: { name: 'ai-agent-runner/serverless-agent-api' }, placement: 'cloudflare-worker' });
  });
  assert.equal(result, true);
  await assert.rejects(() => verifySandbox3RunnerPrincipal('test-api-key-that-is-long-enough-for-validation', async () =>
    Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 })), /^Error: sandbox3_runner_principal_not_authorized$/);
});
test('404, generic auth refusal, bad JSON and TLS failures never claim a public route', async () => {
  for (const mode of ['404', 'foreign', 'bad-json', 'tls']) {
    await assert.rejects(() => verifySandbox3PublicRoute(async url => {
      if (mode === 'tls') throw new Error('private-secret');
      if (mode === 'bad-json') return new Response('private-secret');
      if (mode === '404') return Response.json({ status: 'ok' }, { status: 404 });
      if (url.endsWith('/healthz')) return Response.json({ status: 'ok', service: 'ai-agent-runner-api', placement: 'cloudflare-worker' });
      if (url.endsWith('/version')) return Response.json({ runtime: 'not-cloudflare' });
      return Response.json({ code: 'other' }, { status: 401 });
    }), /^Error: sandbox3_public_route_not_verified$/);
  }
});
