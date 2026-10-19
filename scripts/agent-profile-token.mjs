import { chmod, writeFile } from 'node:fs/promises';

const action = process.env.LEASE_ACTION;
const workflowTokenUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const workflowRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
const apiBase = process.env.PRINCIPAL_LEASE_API_URL;
const outputPath = process.env.LEASE_OUTPUT_FILE;
if (!['issue', 'revoke'].includes(action) || !workflowTokenUrl || !workflowRequestToken || !apiBase) {
  throw new Error('workflow_oidc_configuration_missing');
}

const audience = 'https://trained-assist-cp-production.skillset-apply.workers.dev/principal-lease';
const oidcUrl = new URL(workflowTokenUrl);
oidcUrl.searchParams.set('audience', audience);
const oidcResponse = await fetch(oidcUrl, {
  headers: { authorization: `Bearer ${workflowRequestToken}` }, signal: AbortSignal.timeout(10000),
});
if (!oidcResponse.ok) throw new Error(`github_oidc_request_failed_${oidcResponse.status}`);
const oidc = await oidcResponse.json();
if (typeof oidc.value !== 'string' || !oidc.value) throw new Error('github_oidc_token_missing');

const endpoint = action === 'issue' ? '/auth/agent-profile-lease/issue' : '/auth/agent-profile-lease/revoke';
const body = action === 'issue' ? { profileId: process.env.PROFILE_ID } : { leaseId: process.env.LEASE_ID };
const response = await fetch(new URL(endpoint, apiBase), {
  method: 'POST', headers: { authorization: `Bearer ${oidc.value}`, 'content-type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
});
const data = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(`principal_lease_${action}_failed_${response.status}_${String(data.error || 'unknown')}`);

if (action === 'issue') {
  if (!data.token || !data.leaseId || !data.profileId || !data.expiresAt) throw new Error('lease_response_incomplete');
  await writeFile(outputPath, JSON.stringify({ token: data.token, leaseId: data.leaseId,
    principalId: data.principalId, profileId: data.profileId, scopes: data.scopes,
    issuedBy: data.issuedBy, repository: data.repository, runId: data.runId,
    runAttempt: data.runAttempt, issuedAt: data.issuedAt, expiresAt: data.expiresAt }, null, 2),
  { mode: 0o600, flag: 'wx' });
  await chmod(outputPath, 0o600);
  const lines = ['# Agent profile lease issued', '', `- Profile: \`${data.profileId}\``,
    `- Issued by: \`${data.issuedBy}\``, `- GitHub run: \`${data.runId}\`, attempt \`${data.runAttempt}\``,
    `- Lease ID: \`${data.leaseId}\``, `- Scopes: ${data.scopes.map(scope => `\`${scope}\``).join(', ')}`,
    `- Expires: \`${new Date(data.expiresAt * 1000).toISOString()}\``, '',
    'The bearer is in this run’s private Actions artifact and is not printed in logs or this summary.',
    'Repository readers can download the artifact. The bearer expires in 8 hours; use the revoke action to invalidate it early.'].join('\n');
  await writeFile(process.env.GITHUB_STEP_SUMMARY, `${lines}\n`, { flag: 'a' });
  console.log(JSON.stringify({ ok: true, action, leaseId: data.leaseId, profileId: data.profileId,
    issuedBy: data.issuedBy, runId: data.runId, expiresAt: data.expiresAt, scopes: data.scopes }));
} else {
  const lines = ['# Agent profile lease revoked', '', `- Profile: \`${data.profileId}\``,
    `- Lease ID: \`${data.leaseId}\``, `- Revoked by: \`${data.revokedBy}\``,
    `- Revoked at: \`${new Date(data.revokedAt).toISOString()}\``].join('\n');
  await writeFile(process.env.GITHUB_STEP_SUMMARY, `${lines}\n`, { flag: 'a' });
  console.log(JSON.stringify({ ok: true, action, leaseId: data.leaseId, profileId: data.profileId, revokedBy: data.revokedBy }));
}
