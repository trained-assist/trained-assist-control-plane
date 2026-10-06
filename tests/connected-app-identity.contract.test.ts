import { describe, expect, it } from 'vitest';
import contract from '../contracts/connected-app-identity-v1.contract.json';
import schema from '../contracts/connected-app-identity-v1.response.schema.json';

// Invented in-memory issuer. This file cannot mint production credentials.
const now = 1_780_739_200;
const issuer = 'https://agent.example.invalid';
type Audience = keyof typeof contract.audiences;
type Session = { user: string; profile: string; id: string; audience: Audience;
  scopes: string[]; enabled: boolean; selectedProfile: string; expires: number };
const session = (): Session => ({ user: 'user_demo_001', profile: 'profile_demo_001',
  selectedProfile: 'profile_demo_001', id: 'session_demo_001', audience: 'recruiting-web',
  scopes: ['recruiting.responses.read'], enabled: true, expires: now + 300 });
function introspect(s: Session, audience: Audience, at = now) {
  if (!s.enabled || s.profile !== s.selectedProfile || s.audience !== audience ||
      s.expires <= at || s.scopes.length === 0 ||
      s.scopes.some(scope => !(contract.audiences[audience] as string[]).includes(scope)))
    return { active: false as const };
  return { active: true as const, iss: issuer, aud: audience, sub: s.user,
    profileId: s.profile, sessionId: s.id, nbf: at - 1, exp: s.expires, scopes: s.scopes };
}

describe('connected app identity v1 offline contract', () => {
  it('pins the app vocabulary and fail-closed wire shape', () => {
    expect(contract.version).toBe(1);
    expect(contract.status).toBe('offline_contract_only');
    expect(contract.token.agentRunRequired).toBe(false);
    expect(contract.token.legacyAgentCookieAllowed).toBe(false);
    expect(contract.rules.oldWebJwtOrRunTokenAccepted).toBe(false);
    expect(contract.introspection.inactiveResponse).toEqual({ active: false });
    expect(contract.audiences['recruiting-web']).toContain('recruiting.responses.read');
    expect(contract.audiences['recruiting-web']).toContain('recruiting.reports.read');
    expect(contract.audiences['recruiting-web']).toContain('recruiting.reports.create');
    expect(contract.audiences['recruiting-web']).toContain('recruiting.reports.review');
    expect(contract.audiences['recruiting-web']).toContain('recruiting.assignment.review');
    expect(contract.audiences['recruiting-web']).toContain('recruiting.candidateSearch');
    expect(contract.audiences['crm-web']).toContain('crm.catalog.read');
    expect(contract.audiences['crm-web']).toContain('crm.deals.read');
    expect(contract.audiences['crm-web']).toContain('crm.deals.create');
    expect(contract.agentProfileAuthority).toMatchObject({
      urn: 'urn:trained-assist:agent-profile-context:v1', version: 1,
      owner: 'trained-assist-agent',
      sourceRevision: '3cc6358b052a466410c3b45e3355ec3f7548dd30',
      contextFields: ['principalId', 'profileId', 'sessionId', 'profileGeneration'],
      runtimeStatus: 'opt_in_cp_hosted_bootstrap_prototype',
    });
    expect(schema.oneOf[1]?.required).toEqual(contract.introspection.activeResponseFields);
  });

  it('keeps R-03, response and report grants separate without an Agent Run', () => {
    const s = session();
    const active = introspect(s, 'recruiting-web');
    expect(active).toMatchObject({ active: true, profileId: 'profile_demo_001',
      scopes: ['recruiting.responses.read'] });
    expect(active).not.toHaveProperty('runId');
    expect(active).not.toHaveProperty('token');
    expect(active.active && active.scopes.includes('recruiting.reports.read')).toBe(false);
    s.scopes = ['recruiting.candidateSearch'];
    expect(introspect(s, 'recruiting-web')).toMatchObject({ active: true,
      scopes: ['recruiting.candidateSearch'] });
    expect(introspect(s, 'crm-web')).toEqual({ active: false });
  });

  it.each(['profile switch', 'logout', 'scope removal', 'expiry', 'audience mismatch'])(
    '%s invalidates on the next introspection', reason => {
      const s = session();
      expect(introspect(s, 'recruiting-web').active).toBe(true);
      if (reason === 'profile switch') s.selectedProfile = 'profile_demo_002';
      if (reason === 'logout') s.enabled = false;
      if (reason === 'scope removal') s.scopes = [];
      if (reason === 'expiry') s.expires = now;
      if (reason === 'audience mismatch') s.audience = 'crm-web';
      expect(introspect(s, 'recruiting-web')).toEqual({ active: false });
    });
});
