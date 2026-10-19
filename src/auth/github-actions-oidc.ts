const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'https://trained-assist-cp-production.skillset-apply.workers.dev/principal-lease';
const REPOSITORY = 'trained-assist/trained-assist-control-plane';
const REPOSITORY_OWNER_ID = '322037969';
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/agent-profile-token.yml@refs/heads/main`;
const enc = new TextEncoder();
let cachedKeys: { expiresAt: number; keys: JsonWebKey[] } | null = null;

interface GithubJwk extends JsonWebKey { kid?: string; use?: string; alg?: string }

const decode = (value: string): Uint8Array => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')
  + '='.repeat((4 - value.length % 4) % 4)), ch => ch.charCodeAt(0));

export interface GithubActionsIdentity {
  actor: string;
  runId: string;
  runAttempt: string;
  repositoryOwnerId: string;
}

async function signingKeys(): Promise<JsonWebKey[]> {
  if (cachedKeys && cachedKeys.expiresAt > Date.now()) return cachedKeys.keys;
  const response = await fetch(`${ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('github_jwks_unavailable');
  const body = await response.json() as { keys?: JsonWebKey[] };
  if (!Array.isArray(body.keys)) throw new Error('github_jwks_invalid');
  cachedKeys = { keys: body.keys, expiresAt: Date.now() + 10 * 60_000 };
  return body.keys;
}

export async function verifyGithubActionsIdentity(token: string): Promise<GithubActionsIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('invalid_github_oidc');
  const [head, payload, signature] = parts;
  if (!head || !payload || !signature) throw new Error('invalid_github_oidc');
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(decode(head))) as Record<string, unknown>;
    claims = JSON.parse(new TextDecoder().decode(decode(payload))) as Record<string, unknown>;
  } catch { throw new Error('invalid_github_oidc'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('invalid_github_oidc');
  const jwk = (await signingKeys() as GithubJwk[]).find((key) => key.kid === header.kid && key.use === 'sig');
  if (!jwk) throw new Error('github_signing_key_unknown');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(signature), enc.encode(`${head}.${payload}`));
  if (!valid) throw new Error('invalid_github_oidc');
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER || claims.aud !== AUDIENCE || claims.repository !== REPOSITORY
    || String(claims.repository_owner_id) !== REPOSITORY_OWNER_ID || claims.ref !== 'refs/heads/main'
    || claims.workflow_ref !== WORKFLOW_REF || claims.environment !== 'production'
    || claims.event_name !== 'workflow_dispatch' || !claims.actor || !claims.run_id
    || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
    || Number(claims.iat) > now + 60 || Number(claims.exp) <= now) {
    throw new Error('github_workflow_not_authorized');
  }
  return { actor: String(claims.actor), runId: String(claims.run_id),
    runAttempt: String(claims.run_attempt || '1'), repositoryOwnerId: String(claims.repository_owner_id || '') };
}
