const [baseUrl, expectedSha] = process.argv.slice(2);

if (!baseUrl || !expectedSha || !/^https:\/\//.test(baseUrl) || /[?#]/.test(baseUrl)) {
  console.error('usage: node tools/deployment-smoke.mjs https://worker.example <expected-sha>');
  process.exit(2);
}

let health;
let lastResponse;
for (let attempt = 0; attempt < 12; attempt += 1) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/healthz`, {
      headers: { 'user-agent': 'trained-assist-cp-release-smoke/1' },
    });
    lastResponse = response;
    if (response.ok) {
      health = await response.json();
      if (health.buildSha === expectedSha) break;
    }
  } catch {
    // Cloudflare version propagation can briefly leave the previous deployment active.
  }
  await new Promise(resolve => setTimeout(resolve, 5_000));
}

if (!lastResponse?.ok || health?.service !== 'trained-assist-control-plane'
  || health?.status !== 'healthy' || health?.check !== 'liveness' || health?.buildSha !== expectedSha) {
  console.error(JSON.stringify({
    outcome: 'failed',
    status: lastResponse?.status ?? null,
    service: health?.service ?? null,
    buildSha: health?.buildSha ?? null,
    expectedSha,
  }));
  process.exit(1);
}

const anonymous = await fetch(`${baseUrl.replace(/\/$/, '')}/internal/health/catalogue`, {
  headers: { 'user-agent': 'trained-assist-cp-release-smoke/1' },
});

if (anonymous.status !== 401) {
  console.error(JSON.stringify({ outcome: 'failed', buildSha: expectedSha, anonymousStatus: anonymous.status }));
  process.exit(1);
}

console.log(JSON.stringify({
  outcome: 'passed',
  service: health.service,
  buildSha: health.buildSha,
  liveness: health.status,
  anonymousPrivateReadStatus: anonymous.status,
}));
