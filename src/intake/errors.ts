import type { AdmissionScope } from '../taskstore';

/** Принципал не найден или отключён — HTTP 401. */
export class PrincipalUnauthorizedError extends Error {
  constructor(public readonly principalId: string) {
    super(`unauthorized principal: ${principalId || '(missing)'}`);
    this.name = 'PrincipalUnauthorizedError';
  }
}

/** Принципал есть, но не может этого: чужой профиль или нет scope — HTTP 403. */
export class PrincipalForbiddenError extends Error {
  constructor(
    public readonly principalId: string,
    public readonly profileId: string,
    public readonly scope: AdmissionScope,
    public readonly reason: 'profile_mismatch' | 'scope_missing',
  ) {
    super(`forbidden: principal=${principalId} profile=${profileId} scope=${scope} (${reason})`);
    this.name = 'PrincipalForbiddenError';
  }
}

/** Тот же requestId с другим payload — HTTP 409 (C01). */
export class EnvelopeConflictError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly userTaskId: string,
    public readonly storedEnvelopeHash: string,
    public readonly incomingEnvelopeHash: string,
  ) {
    super(`conflict: requestId=${requestId} already accepted with a different payload (task ${userTaskId})`);
    this.name = 'EnvelopeConflictError';
  }
}