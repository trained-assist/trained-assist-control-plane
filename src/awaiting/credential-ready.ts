import { AnswerRejectedError } from '../taskstore/errors';

export interface CredentialRequirement {
  hostPrincipalId: string;
  provider: string;
  bindingRef: string;
  providerSessionRef: string;
}

export interface CredentialReadyEvent extends CredentialRequirement {
  eventId: string;
  awaitingInputId: string;
  userTaskId: string;
  profileId: string;
  generation: number;
  version: number;
}

export interface CredentialCompletionRow {
  host_principal_id: string;
  event_id: string;
  awaiting_input_id: string;
  user_task_id: string;
  profile_id: string;
  provider: string;
  binding_ref: string;
  provider_session_ref: string;
  generation: number;
  wait_version: number;
  created_at: number;
  continuation_status: 'pending' | 'woken' | 'stale';
  dispatched_at: number | null;
}

const reference = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);

export function validateCredentialRequirement(value: CredentialRequirement): void {
  if (![value.hostPrincipalId, value.provider, value.bindingRef, value.providerSessionRef].every(reference)) {
    throw new AnswerRejectedError('credential', 'invalid_binding_refs');
  }
}

export function validateCredentialReadyEvent(value: CredentialReadyEvent): void {
  validateCredentialRequirement(value);
  if (![value.eventId, value.awaitingInputId, value.userTaskId, value.profileId].every(reference)
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new AnswerRejectedError(value.awaitingInputId, 'invalid_completion_refs');
  }
}
