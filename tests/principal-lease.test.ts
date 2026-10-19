import { afterEach, describe, expect, it, vi } from 'vitest';
import { signPrincipalLease, verifyPrincipalLease } from '../src/auth/principal-lease';
import { verifyGithubActionsIdentity } from '../src/auth/github-actions-oidc';

const SECRET = 'test principal signing secret with enough entropy';
const claims = {
  iss: 'trained-assist-control-plane',
  aud: 'control-plane-principal',
  principalId: 'gha-lease-123',
  profileId: 'flexi-consult',
  leaseId: 'lease-123',
  issuedBy: 'repo-user',
  runId: '1234567',
  iat: 2_000_000_000,
  exp: 2_000_028_800,
};

const b64url = (value: Uint8Array | string) => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
};

describe('short-lived principal leases', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a correctly signed lease until expiry and rejects wrong keys or tampering', async () => {
    const token = await signPrincipalLease(SECRET, claims);
    expect(await verifyPrincipalLease(token, SECRET, claims.iat + 30)).toMatchObject({
      principalId: claims.principalId, profileId: claims.profileId, leaseId: claims.leaseId,
    });
    expect(await verifyPrincipalLease(token, 'wrong secret', claims.iat + 30)).toBeNull();
    expect(await verifyPrincipalLease(token, SECRET, claims.exp)).toBeNull();
    const [header, payload, signature] = token.split('.');
    const changed = `${header}.${b64url(JSON.stringify({ ...claims, profileId: 'other-profile' }))}.${signature}`;
    expect(await verifyPrincipalLease(changed, SECRET, claims.iat + 30)).toBeNull();
  });

  it('rejects leases longer than eight hours', async () => {
    const token = await signPrincipalLease(SECRET, { ...claims, exp: claims.iat + 8 * 60 * 60 + 1 });
    expect(await verifyPrincipalLease(token, SECRET, claims.iat + 1)).toBeNull();
  });

  it('accepts only the protected main-branch GitHub workflow identity', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey & { kid?: string; use?: string; alg?: string };
    publicJwk.kid = 'test-key';
    publicJwk.use = 'sig';
    publicJwk.alg = 'RS256';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 })));
    const now = Math.floor(Date.now() / 1000);
    const oidcClaims = {
      iss: 'https://token.actions.githubusercontent.com',
      aud: 'https://trained-assist-cp-production.skillset-apply.workers.dev/principal-lease',
      repository: 'trained-assist/trained-assist-control-plane', repository_owner_id: '322037969',
      ref: 'refs/heads/main',
      workflow_ref: 'trained-assist/trained-assist-control-plane/.github/workflows/agent-profile-token.yml@refs/heads/main',
      environment: 'production', event_name: 'workflow_dispatch',
      actor: 'repo-user', run_id: '1001', run_attempt: '1', iat: now, exp: now + 300,
    };
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' }));
    const payload = b64url(JSON.stringify(oidcClaims));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey,
      new TextEncoder().encode(`${head}.${payload}`));
    const identity = await verifyGithubActionsIdentity(`${head}.${payload}.${b64url(new Uint8Array(signature))}`);
    expect(identity).toMatchObject({ actor: 'repo-user', runId: '1001', repositoryOwnerId: '322037969' });
    const wrongBranchPayload = b64url(JSON.stringify({ ...oidcClaims, ref: 'refs/heads/feature' }));
    const wrongBranchSignature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey,
      new TextEncoder().encode(`${head}.${wrongBranchPayload}`));
    await expect(verifyGithubActionsIdentity(`${head}.${wrongBranchPayload}.${b64url(new Uint8Array(wrongBranchSignature))}`))
      .rejects.toThrow('github_workflow_not_authorized');
  });
});
