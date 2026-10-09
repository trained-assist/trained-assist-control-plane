import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox3CpProbeRequest } from './sandbox3-cp-probe-request.mjs';

const denied = () => Response.json({ ok: false, reasonCode: 'authentication_failed' }, { status: 401 });
function harness(responses) {
  let time = 0;
  const requests = [];
  return { requests, dependencies: {
    now: () => time,
    sleep: async ms => { time += ms; },
    fetcher: async (url, options) => {
      requests.push({ url, options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  } };
}
test('fresh credential propagation can recover before any admission', async () => {
  const h = harness([denied(), denied(), Response.json({ ok: true, runId: 'fixed-mock-run' })]);
  const options = { method: 'POST', body: '{}', headers: { 'x-principal-sig': 'synthetic' }, redirect: 'error' };
  const result = await sandbox3CpProbeRequest('https://sandbox.invalid/probe', options, h.dependencies);
  assert.equal(result.body.runId, 'fixed-mock-run');
  assert.equal(h.requests.length, 3);
  for (const { options: sent } of h.requests) {
    assert.equal(sent.body, '{}');
    assert.equal(sent.headers['x-principal-sig'], 'synthetic');
    assert.equal(sent.redirect, 'error');
    assert.ok(sent.signal instanceof AbortSignal);
  }
});
test('persistent pre-admission rejection terminates within the shared deadline', async () => {
  const h = harness(Array.from({ length: 20 }, denied));
  const result = await sandbox3CpProbeRequest('https://sandbox.invalid/probe', {}, h.dependencies);
  assert.equal(result.response.status, 401);
  assert.equal(h.requests.length, 15);
});
test('ambiguous admissions and unrelated denials are never replayed', async () => {
  for (const response of [
    Response.json({ ok: false, reasonCode: 'sandbox_runner_mock_probe_failed' }, { status: 503 }),
    Response.json({ ok: false, reasonCode: 'upstream_authentication_failed' }, { status: 401 }),
    Response.json({ ok: false, reasonCode: 'authentication_failed' }, { status: 403 }),
    Response.json({ ok: true, reasonCode: 'authentication_failed' }, { status: 401 }),
  ]) {
    const h = harness([response]);
    await sandbox3CpProbeRequest('https://sandbox.invalid/probe', {}, h.dependencies);
    assert.equal(h.requests.length, 1);
  }
});
test('connection loss and invalid response bodies preserve the unknown outcome', async () => {
  for (const outcome of [new Error('connection_lost'), new Response('invalid', { status: 401 })]) {
    const h = harness([outcome]);
    await assert.rejects(sandbox3CpProbeRequest('https://sandbox.invalid/probe', {}, h.dependencies));
    assert.equal(h.requests.length, 1);
  }
});
