import type { RunnerApiAdapter, RunnerResult } from '../runner-adapter/runner-api-adapter';
import type { TaskStore } from '../taskstore';
import type { CpStopTarget, CpStopWindowRow } from '../taskstore';
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
  | { state: 'pending' | 'rejected' | 'unknown' };

export interface ExternalStopPort {
  stop(context: ExternalStopContext): Promise<ExternalStopOutcome>;
}

export function confirmedExternalStop(context: ExternalStopContext, outcome: ExternalStopOutcome): boolean {
  return outcome.state === 'stopped' && context.runId !== null
    && /^run_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(context.runId)
    && outcome.result.runId === context.runId && outcome.result.userTaskId === context.taskId
    && outcome.result.profileId === context.profileId && outcome.result.ownerGeneration === context.ownerGeneration
    && outcome.result.exitObserved === true && ['succeeded', 'failed', 'cancelled'].includes(outcome.result.outcome);
}

export function runnerExternalStopPort(adapter: Pick<RunnerApiAdapter, 'cancel' | 'status' | 'result'>): ExternalStopPort {
  return {
    async stop(context) {
      if (!context.runId || !/^run_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(context.runId)) return { state: 'unknown' };
      try {
        const acknowledgement = await adapter.cancel(context.runId, { ownerGeneration: context.ownerGeneration, reason: context.reason });
        if (['rejected', 'stale_generation', 'not_found'].includes(acknowledgement.status)) return { state: 'rejected' };
        if (!['stop_pending', 'already_terminal'].includes(acknowledgement.status)) return { state: 'unknown' };
        const status = await adapter.status(context.runId);
        if (status.runId !== context.runId || status.userTaskId !== context.taskId
          || status.ownerGeneration !== context.ownerGeneration || status.connectionLost) return { state: 'unknown' };
        if (!['succeeded', 'failed', 'cancelled'].includes(status.state)) return { state: 'pending' };
        const result = await adapter.result(context.runId);
        const outcome: ExternalStopOutcome = { state: 'stopped', result };
        return confirmedExternalStop(context, outcome) && result.outcome === status.state ? outcome : { state: 'unknown' };
      } catch { return { state: 'unknown' }; }
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
  cancel(taskId: string, opts?: { reason?: string }): Promise<{
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
        && typeof target.receiptId === 'string') ? targets : null;
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
        stopConfirmed: true, reason: null });
      return { snapshotId: window.snapshot_id, profileId: input.profileId, conversationId: input.conversationId,
        tasks, unresolved: !saved, reason: saved ? null : 'snapshot_conflict', stopConfirmed: !!saved };
    }

    let pending = false;
    let unknown = false;
    for (const target of tasks) {
      let outcome: { stopConfirmed: boolean; nativeStopState?: 'pending' | 'rejected' | 'unknown' };
      try { outcome = await this.port.cancel(target.userTaskId, { reason: `cp_stop_window:${window.snapshot_id}` }); }
      catch { outcome = { stopConfirmed: false, nativeStopState: 'unknown' }; }
      if (!outcome.stopConfirmed) {
        if (outcome.nativeStopState === 'pending') pending = true;
        else unknown = true;
      }
    }
    const stopConfirmed = !pending && !unknown;
    const reason: CpStopReason | null = stopConfirmed ? null : pending ? 'native_stop_pending' : 'native_stop_unknown';
    const saved = await this.store.updateCpStopWindow({ ...input, snapshotId: window.snapshot_id,
      stopConfirmed, reason });
    return { snapshotId: window.snapshot_id, profileId: input.profileId, conversationId: input.conversationId,
      tasks, unresolved: !saved || !stopConfirmed, reason: saved ? reason : 'snapshot_conflict',
      stopConfirmed: !!saved && stopConfirmed };
  }
}
