/**
 * Проверка прав приёма (P04: «профиль/права»; AC-65: «без права → отказ ДО запуска
 * Run»). Проверка ДО любой записи в Task Store: неавторизованный приём не создаёт
 * ни строки задачи, ни события.
 *
 * Секреты (API keys, C13) не проверяются здесь — control plane работает по
 * проверенному principalId, который выдаёт credential broker/gateway.
 */
import type { AdmissionScope, PrincipalRow, TaskStore } from '../taskstore';
import { PrincipalForbiddenError, PrincipalUnauthorizedError } from './errors';

export interface AdmissionIdentity {
  principalId: string;
}

/** Шаг 1: проверить личность. Неизвестный/отключённый принципал -> 401. */
export async function resolvePrincipal(store: TaskStore, identity: AdmissionIdentity): Promise<PrincipalRow> {
  const principalId = identity.principalId?.trim() ?? '';
  const principal = principalId ? await store.getPrincipal(principalId) : null;
  if (!principal || !principal.enabled) throw new PrincipalUnauthorizedError(principalId);
  return principal;
}

/** Шаг 2: проверить права — профиль и scope. Отказ -> 403. */
export function requirePermission(
  principal: PrincipalRow,
  profileId: string,
  scope: AdmissionScope,
): void {
  if (principal.profileId !== profileId) {
    throw new PrincipalForbiddenError(principal.principalId, profileId, scope, 'profile_mismatch');
  }
  if (!principal.scopes.includes(scope)) {
    throw new PrincipalForbiddenError(principal.principalId, profileId, scope, 'scope_missing');
  }
}

/** Личность + права одним вызовом (для маршрутов с известным профилем). */
export async function authorizeIntake(
  store: TaskStore,
  identity: AdmissionIdentity,
  profileId: string,
  scope: AdmissionScope,
): Promise<PrincipalRow> {
  const principal = await resolvePrincipal(store, identity);
  requirePermission(principal, profileId, scope);
  return principal;
}