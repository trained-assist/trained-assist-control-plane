import type { RunnerApiAdapter, RunnerResult } from '../runner-adapter/runner-api-adapter';
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
