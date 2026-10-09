import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySandbox3PublicRoute } from './sandbox3-public-route.mjs';
test('public probe proves TLS route and auth refusal without carrying credentials', async () => {
  const calls = [];
  const result = await verifySandbox3PublicRoute(async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/healthz') ? Response.json({ status: 'ok', workers: [{ baseUrl: 'private-secret' }] })
      : Response.json({ error: { code: 'UNAUTHENTICATED', message: 'private-secret' } }, { status: 401 });
  });
  assert.equal(result.publicRouteVerified, true);
  assert.equal(result.authenticatedContractVerified, false);
  assert.equal(JSON.stringify(result).includes('private-secret'), false);
  for (const { url, options } of calls) {
    assert.ok(url.startsWith('https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev/'));
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, undefined);
  }
});
test('404, generic auth refusal, bad JSON and TLS failures never claim a public route', async () => {
  for (const mode of ['404', 'foreign', 'bad-json', 'tls']) {
    await assert.rejects(() => verifySandbox3PublicRoute(async url => {
      if (mode === 'tls') throw new Error('private-secret');
      if (mode === 'bad-json') return new Response('private-secret');
      if (mode === '404') return Response.json({ status: 'ok' }, { status: 404 });
      return url.endsWith('/healthz') ? Response.json({ status: 'ok' }) : Response.json({ code: 'other' }, { status: 401 });
    }), /^Error: sandbox3_public_route_not_verified$/);
  }
});
