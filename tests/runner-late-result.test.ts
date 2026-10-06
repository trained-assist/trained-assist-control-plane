import { describe, expect, it, vi } from 'vitest';
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import type { RunnerApiAdapter } from '../src/runner-adapter';
import { conversationPlan } from '../src/workflow-port/conversation-plan';
import type { StepCtx } from '../src/workflow-port/step-ctx';

let sequence = 0;

describe('durable same-run result reconciliation', () => {
  it.each([
    { terminalState: 'succeeded', reason: 'runner_timeout' },
    { terminalState: 'failed', reason: 'runner_timeout' },
    { terminalState: 'succeeded', reason: 'connection_lost' },
    { terminalState: 'failed', reason: 'runner_unavailable' },
  ] as const)('survives cached $reason and cold resume to late $terminalState', async ({ terminalState, reason }) => {
    const store = new TaskStore(env.DB);
    const taskId = `ut-late-result-${++sequence}`;
    const profileId = 'integration-telegram-ux-v1';
    const runId = `run_68b4b926-11a5-4131-9905-${String(sequence).padStart(12, '0')}`;
    await store.admitTask({ id: taskId, profileId, goal: 'preserve the accepted task' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'dynamic-ip-azure-agent-run' });
    let clock = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let ready = false;
    const submit = vi.fn(async () => ({ requestId: 'fixture-request', userTaskId: taskId, runId, deduplicated: false }));
    const status = vi.fn(async (observedRunId: string) => {
      expect(observedRunId).toBe(runId);
      if (!ready && reason === 'runner_unavailable') throw new Error('runner unreachable');
      if (!ready) clock += 2000;
      return { runId, state: ready ? terminalState : 'running', connectionLost: !ready && reason === 'connection_lost', answer: 'late native answer' };
    });
    const result = vi.fn(async () => ({ runId, userTaskId: taskId, profileId, ownerGeneration: 1,
      outcome: terminalState, exitReason: terminalState === 'failed' ? 'nonzero_exit' : 'completed',
      exitObserved: true, persistence: 'persisted', outputRefs: [],
      ...(terminalState === 'failed' ? { failure: { code: 'ENGINE_NONZERO', safeSummary: 'fixture engine failed' } } : {}) }));
    const adapter = { submit, status, result,
      events: async () => ({ events: [], cursor: 0, hasMore: false }), artifacts: async () => [],
    } as unknown as RunnerApiAdapter;
    const cached = new Map<string, unknown>();
    const suspension = new Error('offline durable sleep suspension');
    let suspended = false;
    const delays: number[] = [];
    const context: StepCtx = {
      step: async (name, callback) => {
        if (cached.has(name)) return cached.get(name) as never;
        const value = await callback({ attempt: 1 });
        cached.set(name, structuredClone(value));
        return value;
      },
      sleep: async name => {
        expect(name).toBe('runner-reconcile-backoff-0');
        suspended = true;
        throw suspension;
      },
      waitFor: async () => { throw new Error('unexpected awaiting'); },
    };
    const params = { taskId, profileId, generation: 1, runId: attempt.id,
      runnerEngine: 'dynamic-ip-azure-agent-run', runnerTimeoutSec: 1 };
    try {
      await expect(conversationPlan(context, store, params, { adapter })).rejects.toBe(suspension);
      expect(suspended).toBe(true);
      expect(cached.get('await-runner')).toEqual({ ok: false, reason });
      expect(await store.requireTask(taskId)).toMatchObject({ status: 'active', generation: 1, result_json: null });
      expect(result).not.toHaveBeenCalled();
      const resumed: StepCtx = { ...context, sleep: async (name, seconds) => {
        expect(name).toBe(`runner-reconcile-backoff-${delays.length}`);
        delays.push(seconds);
        if (delays.length === 4) ready = true;
      } };
      const outcome = await conversationPlan(resumed, store, params, { adapter });
      expect(outcome.ok).toBe(terminalState === 'succeeded');
      expect(delays).toEqual([15, 30, 60, 60]);
      expect(submit).toHaveBeenCalledOnce();
      expect(result).toHaveBeenCalledOnce();
      expect(await store.requireTask(taskId)).toMatchObject({ status: terminalState === 'succeeded' ? 'done' : 'failed', generation: 1, stage: 'finished' });
      expect(await store.listRuns(taskId)).toHaveLength(1);
      expect(await store.requireRun(attempt.id)).toMatchObject({ session_id: runId, generation: 1,
        status: terminalState === 'succeeded' ? 'success' : 'failed' });
      const history = await store.history(taskId);
      expect(history.filter(event => event.payload_json.includes('same_accepted_run'))).toHaveLength(4);
      expect(await conversationPlan(resumed, store, params, { adapter })).toMatchObject({ reason: 'already_terminal' });
      expect(submit).toHaveBeenCalledOnce();
    } finally {
      dateNow.mockRestore();
    }
  });
});
