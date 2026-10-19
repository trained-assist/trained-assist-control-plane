import { resolveProfileRuntime } from '../run-spec/profile-runtime';
import { signPrincipalLease } from './principal-lease';
import { verifyGithubActionsIdentity } from './github-actions-oidc';

export const PRINCIPAL_LEASE_TTL_SECONDS = 8 * 60 * 60;
export const PRINCIPAL_LEASE_SCOPES = ['tasks:intake', 'tasks:read', 'tasks:signal', 'tasks:control'];
const REPO = 'trained-assist/trained-assist-control-plane';
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export async function issueGithubPrincipalLease(
  db: D1Database,
  env: Record<string, string | undefined>,
  secret: string | null,
  input: unknown,
  githubToken: string,
) {
  const identity = await verifyGithubActionsIdentity(githubToken);
  if (!secret) throw new Error('principal_lease_signer_not_configured');
  const profileId = (input as { profileId?: unknown } | null)?.profileId;
  if (typeof profileId !== 'string' || !PROFILE_ID.test(profileId)) throw new Error('invalid_profile_id');
  let runtime;
  try { runtime = resolveProfileRuntime(env, profileId); }
  catch { throw new Error('profile_runner_not_configured'); }
  if (!runtime.adapter) throw new Error('profile_runner_not_configured');

  const now = Math.floor(Date.now() / 1000);
  const leaseId = crypto.randomUUID();
  const principalId = `gha-${leaseId}`;
  const expiresAt = now + PRINCIPAL_LEASE_TTL_SECONDS;
  const scopes = [...PRINCIPAL_LEASE_SCOPES];
  const token = await signPrincipalLease(secret, { iss: 'trained-assist-control-plane', aud: 'control-plane-principal',
    principalId, profileId, leaseId, issuedBy: identity.actor, runId: identity.runId, iat: now, exp: expiresAt });
  await db.batch([
    db.prepare(`INSERT INTO admission_principals
      (principal_id, profile_id, scopes, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`)
      .bind(principalId, profileId, JSON.stringify(scopes), now * 1000, now * 1000),
    db.prepare(`INSERT INTO principal_token_leases
    (lease_id, principal_id, profile_id, scopes_json, issued_by, repository, workflow_run_id, run_attempt, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(leaseId, principalId, profileId, JSON.stringify(scopes), identity.actor, REPO,
      identity.runId, identity.runAttempt, now * 1000, expiresAt * 1000),
  ]);
  return { token, leaseId, principalId, profileId, scopes, issuedBy: identity.actor,
    repository: REPO, runId: identity.runId, runAttempt: identity.runAttempt,
    issuedAt: now, expiresAt };
}

export async function revokeGithubPrincipalLease(
  db: D1Database,
  input: unknown,
  githubToken: string,
) {
  const identity = await verifyGithubActionsIdentity(githubToken);
  const leaseId = (input as { leaseId?: unknown } | null)?.leaseId;
  if (typeof leaseId !== 'string' || !/^[0-9a-f-]{36}$/i.test(leaseId)) throw new Error('invalid_lease_id');
  const row = await db.prepare(`SELECT lease_id, principal_id, profile_id, issued_by, expires_at, revoked_at
    FROM principal_token_leases WHERE lease_id = ?`).bind(leaseId).first<{
      lease_id: string; principal_id: string; profile_id: string; issued_by: string; expires_at: number; revoked_at: number | null;
    }>();
  if (!row) throw new Error('lease_not_found');
  if (row.revoked_at !== null) return { leaseId, principalId: row.principal_id, profileId: row.profile_id, revokedAt: row.revoked_at, alreadyRevoked: true };
  if (row.issued_by !== identity.actor && identity.repositoryOwnerId !== '322037969') throw new Error('lease_revoke_forbidden');
  const now = Date.now();
  await db.batch([
    db.prepare(`UPDATE admission_principals SET enabled = 0, scopes = '[]', updated_at = ? WHERE principal_id = ?`)
      .bind(now, row.principal_id),
    db.prepare(`UPDATE principal_token_leases SET revoked_at = ?, revoked_by = ?, revoke_run_id = ? WHERE lease_id = ? AND revoked_at IS NULL`)
      .bind(now, identity.actor, identity.runId, leaseId),
  ]);
  return { leaseId, principalId: row.principal_id, profileId: row.profile_id, revokedAt: now, revokedBy: identity.actor };
}
