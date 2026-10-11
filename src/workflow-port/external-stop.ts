import type { RunnerApiAdapter, RunnerResult } from '../runner-adapter/runner-api-adapter';
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
  reason?: string;
}

export type ExternalStopOutcome =
  | { state: 'stopped'; result: RunnerResult }
  | { state: 'pending' | 'rejected' | 'unknown'; diagnosticCode?: ExternalStopDiagnosticCode };

/** Sanitized reason for an unconfirmed stop; never includes provider error text. */
export type ExternalStopDiagnosticCode =
  | 'run_id_invalid'
  | 'cancel_rejected'
  | 'cancel_ack_unrecognized'
  | 'status_identity_mismatch'
  | 'status_connection_lost'
  | 'status_nonterminal'
  | 'result_identity_mismatch'
  | 'result_outcome_mismatch'
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
  | 'result_runner_unavailable'
  | 'result_runner_not_found'
  | 'result_stale_generation'
  | 'result_runner_conflict'
  | 'result_transport_error'
  | 'external_stop_unclassified';

export interface ExternalStopPort {
  stop(context: ExternalStopContext): Promise<ExternalStopOutcome>;
}

export function confirmedExternalStop(context: ExternalStopContext, outcome: ExternalStopOutcome): boolean {
  // Runner API records a terminal `preflight_refused` result only when the
  // France worker rejected the launch before issuing an execution receipt.
  // In that case there is no process exit to observe, but the authenticated
  // terminal result is definitive proof that nothing remains to stop.
  const preAdmissionRefusal = outcome.state === 'stopped' && outcome.result.outcome === 'failed'
    && outcome.result.exitObserved === false && outcome.result.exitReason === 'preflight_refused'
    && outcome.result.failure?.failureClass === 'preflight' && outcome.result.failure.retryable === false
    && /^WORKER_[A-Z0-9_]{1,80}$/.test(outcome.result.failure.code);
  return outcome.state === 'stopped' && context.runId !== null
    && isRunnerRunId(context.runId)
    && outcome.result.runId === context.runId && outcome.result.userTaskId === context.taskId
    && outcome.result.profileId === context.profileId && outcome.result.ownerGeneration === context.ownerGeneration
    && (outcome.result.exitObserved === true || preAdmissionRefusal)
    && ['succeeded', 'failed', 'cancelled'].includes(outcome.result.outcome);
}

export function runnerExternalStopPort(adapter: Pick<RunnerApiAdapter, 'cancel' | 'status' | 'result'>): ExternalStopPort {
  return {
    async stop(context) {
      if (!isRunnerRunId(context.runId)) return { state: 'unknown', diagnosticCode: 'run_id_invalid' };
      let stage: 'cancel' | 'status' | 'result' = 'cancel';
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
        stage = 'result';
        const result = await adapter.result(context.runId);
        const outcome: ExternalStopOutcome = { state: 'stopped', result };
        if (result.runId !== context.runId || result.userTaskId !== context.taskId || result.profileId !== context.profileId
          || result.ownerGeneration !== context.ownerGeneration) return { state: 'unknown', diagnosticCode: 'result_identity_mismatch' };
        return confirmedExternalStop(context, outcome) && result.outcome === status.state
          ? outcome : { state: 'unknown', diagnosticCode: 'result_outcome_mismatch' };
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
