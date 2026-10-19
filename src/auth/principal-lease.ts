const ISSUER = 'trained-assist-control-plane';
const AUDIENCE = 'control-plane-principal';
const enc = new TextEncoder();

const b64url = (value: Uint8Array): string => btoa(String.fromCharCode(...value))
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')
  + '='.repeat((4 - value.length % 4) % 4)), ch => ch.charCodeAt(0));
const encodeJson = (value: unknown): string => b64url(enc.encode(JSON.stringify(value)));

async function keyFromSecret(secret: string, usages: Array<'sign' | 'verify'>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export interface PrincipalLeaseClaims {
  iss: string;
  aud: string;
  principalId: string;
  profileId: string;
  leaseId: string;
  issuedBy: string;
  runId: string;
  iat: number;
  exp: number;
}

export async function signPrincipalLease(secret: string, claims: PrincipalLeaseClaims): Promise<string> {
  const head = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJson(claims);
  const signature = await crypto.subtle.sign('HMAC', await keyFromSecret(secret, ['sign']), enc.encode(`${head}.${payload}`));
  return `${head}.${payload}.${b64url(new Uint8Array(signature))}`;
}

export async function verifyPrincipalLease(token: string, secret: string | null, now = Math.floor(Date.now() / 1000)):
  Promise<PrincipalLeaseClaims | null> {
  if (!secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, signature] = parts;
  if (!head || !body || !signature) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(decode(head))) as Record<string, unknown>;
    const claims = JSON.parse(new TextDecoder().decode(decode(body))) as PrincipalLeaseClaims;
    if (header.alg !== 'HS256' || header.typ !== 'JWT' || claims.iss !== ISSUER || claims.aud !== AUDIENCE
      || typeof claims.principalId !== 'string' || typeof claims.profileId !== 'string'
      || typeof claims.leaseId !== 'string' || !Number.isSafeInteger(claims.iat)
      || !Number.isSafeInteger(claims.exp) || claims.iat > now + 60 || claims.exp <= now
      || claims.exp - claims.iat > 8 * 60 * 60) return null;
    const key = await keyFromSecret(secret, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, decode(signature), enc.encode(`${head}.${body}`));
    return valid ? claims : null;
  } catch {
    return null;
  }
}
