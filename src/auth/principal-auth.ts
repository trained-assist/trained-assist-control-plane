/**
 * Проверяющая аутентификация принципала (закрывает дыру #23: «principalOf
 * доверяет x-principal»).
 *
 * Заголовок клиента — не доказательство личности: любой может прислать
 * `X-Principal: someone-else`. Поэтому личность подтверждается подписью, а
 * секрет живёт ТОЛЬКО в binding воркера (GCP SM / GitHub Secrets) и в запросе не
 * передаётся:
 *
 *   x-principal:     <principalId>
 *   x-principal-sig: <hex HMAC-SHA256(secret, principalId)>
 *
 * Секрет читается из binding `PRINCIPAL_SECRET`. Если он не задан — доступ
 * закрыт полностью (fail closed): нельзя «случайно» получить публичный
 * незащищённый endpoint.
 *
 * Подпись доказывает владение секретом, но не права: профиль и scope по-прежнему
 * берутся из `admission_principals` в Task Store (`resolvePrincipal` +
 * `requirePermission`). Подмена `x-principal` без секрета даёт 401, а не чужой
 * профиль.
 */
import { logStructured } from '../logging/structured-log';

export const PRINCIPAL_HEADER = 'x-principal';
export const PRINCIPAL_SIGNATURE_HEADER = 'x-principal-sig';

export interface PrincipalAuth {
  /** Секрет из binding; null = доступ закрыт (fail closed). */
  readonly secret: string | null;
}

const PRINCIPAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export function principalAuthOf(env: Record<string, string | undefined>): PrincipalAuth {
  const secret = env.PRINCIPAL_SECRET?.trim();
  return { secret: secret ? secret : null };
}

/** Подпись для клиента: HMAC-SHA256(secret, principalId) в hex. */
export async function signPrincipal(principalId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(principalId));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * Проверить личность по заголовкам. Возвращает principalId или null.
 * null = доступ запрещён: нет секрета, нет подписи, подпись не сошлась,
 * principalId небезопасен.
 */
export async function verifyPrincipal(req: Request, auth: PrincipalAuth): Promise<string | null> {
  const principalId = req.headers.get(PRINCIPAL_HEADER)?.trim() ?? '';
  const signature = req.headers.get(PRINCIPAL_SIGNATURE_HEADER)?.trim() ?? '';

  if (!auth.secret) {
    logStructured({ event: 'auth.principal_rejected', level: 'warn', reason: 'secret_not_configured' });
    return null;
  }
  if (!PRINCIPAL_ID.test(principalId)) {
    logStructured({ event: 'auth.principal_rejected', level: 'warn', reason: 'principal_id_malformed' });
    return null;
  }
  if (!HEX_64.test(signature)) {
    logStructured({ event: 'auth.principal_rejected', level: 'warn', reason: 'signature_malformed', principalId });
    return null;
  }

  const expected = await signPrincipal(principalId, auth.secret);
  if (!timingSafeEqual(expected, signature)) {
    logStructured({ event: 'auth.principal_rejected', level: 'warn', reason: 'signature_mismatch', principalId });
    return null;
  }
  return principalId;
}
