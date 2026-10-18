import type { RunnerApiAdapter, RunnerStatusView } from '../runner-adapter/runner-api-adapter';
import { RunnerConflictError, RunnerNotFoundError, RunnerStaleGenerationError, RunnerUnavailableError } from '../runner-adapter/errors';
import type { TaskStore } from '../taskstore';
import type { CpStopTarget, CpStopWindowRow } from '../taskstore';
import { isRunnerRunId } from '../runner-adapter/run-id';
export type { NativeStopEvidence } from '../taskstore/types';

export interface ExternalStopContext {
  taskId: string;
  profileId: string;
  attemptId: string;
  runId: string | null;
  ownerGeneration: number;
  idempotencyKey?: string;
  reason?: string;
}

export type ExternalStopOutcome =
  | { state: 'stopped'; runnerStatus: RunnerStatusView; idempotencyKey?: string }
  | { state: 'cancelled_before_admission'; userTaskId: string; ownerGeneration: number; idempotencyKey: string }
  | { state: 'pending' | 'rejected' | 'unknown'; diagnosticCode?: ExternalStopDiagnosticCode };

/** Sanitized reason for an unconfirmed stop; never includes provider error text. */
export type ExternalStopDiagnosticCode =
  | 'run_id_invalid'
  | 'cancel_rejected'
  | 'cancel_ack_unrecognized'
  | 'status_identity_mismatch'
  | 'status_connection_lost'
  | 'status_nonterminal'
  | 'cancel_runner_unavailable'
  | 'cancel_runner_not_found'
  | 'cancel_stale_generation'
  | 'cancel_runner_conflict'
  | 'cancel_transport_error'
  | 'status_runner_unavailable'
  | 'status_runner_not_found'
  | 'status_stale_generation'
  | 'status_runner_conflict'
  | 'status_transport_error'
  | 'external_stop_unclassified';

export interface ExternalStopPort {
  stop(context: ExternalStopContext): Promise<ExternalStopOutcome>;
}

export function confirmedExternalStop(context: ExternalStopContext, outcome: ExternalStopOutcome): boolean {
  if (outcome.state === 'cancelled_before_admission') return context.runId === null
    && typeof context.idempotencyKey === 'string' && outcome.idempotencyKey === context.idempotencyKey
    && outcome.userTaskId === context.taskId && outcome.ownerGeneration === context.ownerGeneration;
  if (outcome.state === 'stopped' && 'runnerStatus' in outcome) {
    const status = outcome.runnerStatus;
    return !status.connectionLost && isRunnerRunId(status.runId)
      && status.userTaskId === context.taskId && status.ownerGeneration === context.ownerGeneration
      && ['succeeded', 'failed', 'cancelled'].includes(status.state)
      && (context.runId === null
        ? typeof context.idempotencyKey === 'string' && outcome.idempotencyKey === context.idempotencyKey
        : context.runId === status.runId);
  }
  return false;
}

export function runnerExternalStopPort(adapter: Pick<RunnerApiAdapter, 'cancel' | 'status'> & Partial<Pick<RunnerApiAdapter, 'cancelByIdempotencyKey'>>): ExternalStopPort {
  return {
    async stop(context) {
      if (context.runId === null) {
        if (!context.idempotencyKey || !adapter.cancelByIdempotencyKey) return { state: 'unknown', diagnosticCode: 'run_id_invalid' };
        try {
          const acknowledgement = await adapter.cancelByIdempotencyKey({ userTaskId: context.taskId,
            idempotencyKey: context.idempotencyKey, ownerGeneration: context.ownerGeneration });
          if (acknowledgement.userTaskId !== context.taskId || acknowledgement.ownerGeneration !== context.ownerGeneration) {
            return { state: 'unknown', diagnosticCode: 'status_identity_mismatch' };
          }
          if (acknowledgement.status === 'cancelled_before_admission') return { state: 'cancelled_before_admission',
            userTaskId: context.taskId, ownerGeneration: context.ownerGeneration, idempotencyKey: context.idempotencyKey };
          if (!['stop_pending', 'already_terminal'].includes(acknowledgement.status) || !isRunnerRunId(acknowledgement.runId)) {
            return { state: 'unknown', diagnosticCode: 'cancel_ack_unrecognized' };
          }
          const runId = acknowledgement.runId;
          const status = await adapter.status(runId);
          if (status.runId !== runId || status.userTaskId !== context.taskId || status.ownerGeneration !== context.ownerGeneration) {
            return { state: 'unknown', diagnosticCode: 'status_identity_mismatch' };
          }
          if (status.connectionLost) return { state: 'unknown', diagnosticCode: 'status_connection_lost' };
          if (!['succeeded', 'failed', 'cancelled'].includes(status.state)) return { state: 'pending', diagnosticCode: 'status_nonterminal' };
          const outcome: ExternalStopOutcome = { state: 'stopped', runnerStatus: status,
            idempotencyKey: context.idempotencyKey };
          return confirmedExternalStop(context, outcome) ? outcome
            : { state: 'unknown', diagnosticCode: 'status_identity_mismatch' };
        } catch { return { state: 'unknown', diagnosticCode: 'cancel_transport_error' }; }
      }
      if (!isRunnerRunId(context.runId)) return { state: 'unknown', diagnosticCode: 'run_id_invalid' };
      let stage: 'cancel' | 'status' = 'cancel';
      try {
        const acknowledgement = await adapter.cancel(context.runId, { ownerGeneration: context.ownerGeneration, reason: context.reason });
        if (['rejected', 'stale_generation', 'not_found'].includes(acknowledgement.status)) {
          return { state: 'rejected', diagnosticCode: 'cancel_rejected' };
        }
        if (!['stop_pending', 'already_terminal'].includes(acknowledgement.status)) {
          return { state: 'unknown', diagnosticCode: 'cancel_ack_unrecognized' };
        }
        stage = 'status';
        const status = await adapter.status(context.runId);
        if (status.runId !== context.runId || status.userTaskId !== context.taskId
          || status.ownerGeneration !== context.ownerGeneration) return { state: 'unknown', diagnosticCode: 'status_identity_mismatch' };
        if (status.connectionLost) return { state: 'unknown', diagnosticCode: 'status_connection_lost' };
        if (!['succeeded', 'failed', 'cancelled'].includes(status.state)) return { state: 'pending', diagnosticCode: 'status_nonterminal' };
        const outcome: ExternalStopOutcome = { state: 'stopped', runnerStatus: status };
        return confirmedExternalStop(context, outcome) ? outcome
          : { state: 'unknown', diagnosticCode: 'status_identity_mismatch' };
      } catch (error) {
        const stagePrefix = stage;
        const suffix = error instanceof RunnerUnavailableError ? 'runner_unavailable'
          : error instanceof RunnerNotFoundError ? 'runner_not_found'
            : error instanceof RunnerStaleGenerationError ? 'stale_generation'
              : error instanceof RunnerConflictError ? 'runner_conflict' : 'transport_error';
        const diagnosticCode = `${stagePrefix}_${suffix}` as ExternalStopDiagnosticCode;
        return { state: 'unknown', diagnosticCode };
      }
    },
  };
}

export type CpStopReason = 'admission_unknown' | 'receipt_missing' | 'identity_mismatch'
  | 'snapshot_conflict' | 'native_stop_pending' | 'native_stop_unknown';

export interface CpStopTargetsInput {
  profileId: string;
  conversationId: string;
  /** Stable id for this stop intent; explicit restart supplies a new one. */
  windowId: string;
  admissionBarrierComplete: boolean;
  admissionRequestIds: string[];
  restart: boolean;
}

export interface CpStopTargetsResponse {
  snapshotId: string | null;
  profileId: string;
  conversationId: string;
  tasks: CpStopTarget[];
  unresolved: boolean;
  reason: CpStopReason | null;
  stopConfirmed: boolean;
}

export interface CpStopPort {
  cancel(taskId: string, opts?: { reason?: string; stopPin?: { target: CpStopTarget; snapshotId: string } }): Promise<{
    stopConfirmed: boolean;
    nativeStopState?: 'pending' | 'rejected' | 'unknown';
  }>;
}

export type CpStopTargetsInputResult =
  | { ok: true; input: CpStopTargetsInput }
  | { ok: false; error: string };

export function cpStopTargetsInputOf(raw: unknown): CpStopTargetsInputResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'body must be an object' };
  const value = raw as Record<string, unknown>;
  const profileId = typeof value.profileId === 'string' ? value.profileId.trim() : '';
  const conversationId = typeof value.conversationId === 'string' ? value.conversationId.trim() : '';
  const windowId = typeof value.windowId === 'string' ? value.windowId.trim() : '';
  if (!profileId || profileId.length > 200) return { ok: false, error: 'profileId must be 1..200 chars' };
  if (!conversationId || conversationId.length > 200) return { ok: false, error: 'conversationId must be 1..200 chars' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(windowId)) return { ok: false, error: 'windowId must be a safe id' };
  if (typeof value.admissionBarrierComplete !== 'boolean') return { ok: false, error: 'admissionBarrierComplete must be boolean' };
  if (!Array.isArray(value.admissionRequestIds) || value.admissionRequestIds.length > 256
    || value.admissionRequestIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)) {
    return { ok: false, error: 'admissionRequestIds must be an array of at most 256 non-empty IDs' };
  }
  const admissionRequestIds = (value.admissionRequestIds as string[]).map(id => id.trim());
  if (new Set(admissionRequestIds).size !== admissionRequestIds.length) {
    return { ok: false, error: 'admissionRequestIds must be unique' };
  }
  if (value.restart !== undefined && typeof value.restart !== 'boolean') return { ok: false, error: 'restart must be boolean' };
  return { ok: true, input: { profileId, conversationId, windowId,
    admissionBarrierComplete: value.admissionBarrierComplete, admissionRequestIds, restart: value.restart === true } };
}

/** CP-owned snapshot orchestration; the caller must hold input until confirmed. */
export class CpStopTargetsService {
  constructor(private readonly store: TaskStore, private readonly port: CpStopPort) {}

  async stop(input: CpStopTargetsInput): Promise<CpStopTargetsResponse> {
    const base = { profileId: input.profileId, conversationId: input.conversationId };
    if (!input.admissionBarrierComplete) {
      return { snapshotId: null, ...base, tasks: [], unresolved: true,
        reason: 'admission_unknown', stopConfirmed: false };
    }

    const existing = await this.store.cpStopWindow(input.profileId, input.conversationId);
    if (existing?.window_id === input.windowId) {
      const requestIds = JSON.stringify([...input.admissionRequestIds].sort());
      if (existing.admission_request_ids_json !== requestIds) {
        return this.conflict(input, existing);
      }
      return this.pollWindow(input, existing);
    }

    const resolution = await this.store.resolveCpStopTargets({
      profileId: input.profileId,
      conversationId: input.conversationId,
      admissionRequestIds: input.admissionRequestIds,
    });
    if (!resolution.ok) {
      return { snapshotId: null, ...base, tasks: [], unresolved: true,
        reason: resolution.reason, stopConfirmed: false };
    }

    const opened = await this.store.openCpStopWindow({
      profileId: input.profileId,
      conversationId: input.conversationId,
      windowId: input.windowId,
      admissionRequestIds: input.admissionRequestIds,
      targets: resolution.targets,
      restart: input.restart,
    });
    if (!opened.ok) {
      const current = await this.store.cpStopWindow(input.profileId, input.conversationId);
      return this.conflict(input, current);
    }
    return this.pollWindow(input, opened.window);
  }

  private conflict(input: CpStopTargetsInput, current: CpStopWindowRow | null): CpStopTargetsResponse {
    return { snapshotId: current?.snapshot_id ?? null, profileId: input.profileId,
      conversationId: input.conversationId, tasks: current ? this.targetsOf(current) ?? [] : [],
      unresolved: true, reason: 'snapshot_conflict', stopConfirmed: false };
  }

  private targetsOf(window: CpStopWindowRow): CpStopTarget[] | null {
    try {
      const targets = JSON.parse(window.targets_json) as CpStopTarget[];
      return Array.isArray(targets) && targets.every(target => target && typeof target.requestId === 'string'
        && typeof target.userTaskId === 'string' && typeof target.profileId === 'string'
        && target.profileId === window.profile_id && typeof target.receiptId === 'string'
        && Number.isSafeInteger(target.taskGeneration) && target.taskGeneration > 0
        && Array.isArray(target.attempts) && target.attempts.every(attempt => attempt
          && typeof attempt.attemptId === 'string' && attempt.attemptId.length > 0
          && Number.isSafeInteger(attempt.ownerGeneration) && attempt.ownerGeneration > 0
          && (attempt.runId === null || isRunnerRunId(attempt.runId))
          && typeof attempt.idempotencyKey === 'string')
        && new Set(target.attempts.map(attempt => attempt.attemptId)).size === target.attempts.length) ? targets : null;
    } catch { return null; }
  }

  private async pollWindow(input: CpStopTargetsInput, window: CpStopWindowRow): Promise<CpStopTargetsResponse> {
    const tasks = this.targetsOf(window);
    if (tasks === null) {
      return { snapshotId: window.snapshot_id, profileId: input.profileId, conversationId: input.conversationId,
        tasks: [], unresolved: true, reason: 'identity_mismatch', stopConfirmed: false };
    }
    if (tasks.length === 0) {
      const saved = await this.store.updateCpStopWindow({ ...input, snapshotId: window.snapshot_id,
        expectedTargetsJson: window.targets_json,
        stopConfirmed: true, reason: null });
      return { snapshotId: window.snapshot_id, profileId: input.profileId, conversationId: input.conversationId,
        tasks, unresolved: !saved, reason: saved ? null : 'snapshot_conflict', stopConfirmed: !!saved };
    }

    let pending = false;
    let unknown = false;
    for (const target of tasks) {
      let outcome: { stopConfirmed: boolean; nativeStopState?: 'pending' | 'rejected' | 'unknown' };
      try { outcome = await this.port.cancel(target.userTaskId, { reason: `cp_stop_window:${window.snapshot_id}`,
        stopPin: { target, snapshotId: window.snapshot_id } }); }
      catch { outcome = { stopConfirmed: false, nativeStopState: 'unknown' }; }
      if (!outcome.stopConfirmed) {
        if (outcome.nativeStopState === 'pending') pending = true;
        else unknown = true;
      }
    }
    const stopConfirmed = !pending && !unknown;
    const reason: CpStopReason | null = stopConfirmed ? null : pending ? 'native_stop_pending' : 'native_stop_unknown';
    const saved = await this.store.updateCpStopWindow({ ...input, snapshotId: window.snapshot_id,
      expectedTargetsJson: window.targets_json,
      stopConfirmed, reason });
    return { snapshotId: window.snapshot_id, profileId: input.profileId, conversationId: input.conversationId,
      tasks, unresolved: !saved || !stopConfirmed, reason: saved ? reason : 'snapshot_conflict',
      stopConfirmed: !!saved && stopConfirmed };
  }
}
