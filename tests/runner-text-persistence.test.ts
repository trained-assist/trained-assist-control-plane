import { describe, expect, it, vi } from 'vitest';
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import { RunnerApiAdapter, awaitRunnerResult } from '../src/runner-adapter';
import { defaultRunSpecPolicy } from '../src/run-spec/run-spec';
import { conversationPlan } from '../src/workflow-port/conversation-plan';
import type { StepCtx } from '../src/workflow-port/step-ctx';

let sequence = 0;

describe('text-only native persistence contract', () => {
  it.each([
    { persistence: 'not_required', declared: false, refs: false, ok: true },
    { persistence: 'not_required', declared: true, refs: false, ok: false },
    { persistence: 'not_required', declared: false, refs: true, ok: false },
    { persistence: 'pending', declared: false, refs: false, ok: false },
    { persistence: 'failed', declared: false, refs: false, ok: false },
    { persistence: 'persisted', declared: true, refs: true, ok: true },
  ] as const)('$persistence with declared=$declared refs=$refs yields success=$ok', async ({ persistence, declared, refs, ok }) => {
    const store = new TaskStore(env.DB);
    const taskId = `ut-text-persistence-${++sequence}`;
    const runId = `run_40085128-f369-4dea-a3e2-${String(sequence).padStart(12, '0')}`;
    const profileId = 'integration-telegram-ux-v1';
    await store.admitTask({ id: taskId, profileId, goal: 'Return exactly the fixture answer without creating files' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'dynamic-ip-azure-agent-run' });
    const submit = vi.fn();
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-key');
      if (path === '/v1/runs') {
        const body = JSON.parse(String(init?.body));
        submit(body);
        expect(body.outputs ?? []).toEqual(declared ? [{ path: 'outputs/required.csv' }] : []);
        return Response.json({ requestId: 'fixture-request', userTaskId: taskId, runId, deduplicated: false });
      }
      expect(path.startsWith(`/v1/runs/${runId}/`)).toBe(true);
      if (path.endsWith('/status')) return Response.json({ runId, state: 'succeeded', connectionLost: false, answer: '42 fixture nonce' });
      if (path.endsWith('/result')) return Response.json({ runId, userTaskId: taskId, profileId, ownerGeneration: 1,
        outcome: 'succeeded', exitReason: 'completed', exitCode: 0, exitSignal: null, exitObserved: true,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), usage: { status: 'unknown' },
        persistence, outputRefs: refs ? ['outputs/required.csv'] : [], cleanup: 'completed', logPath: 'fixture-log' });
      if (path.endsWith('/events')) return Response.json({ events: [], cursor: 0, hasMore: false });
      if (path.endsWith('/artifacts')) return Response.json({ artifacts: [] });
      throw new Error('Unexpected fixture endpoint');
    };
    const adapter = new RunnerApiAdapter('https://runner.example.test', 'fixture-key', fetchImpl);
    const cache = new Map<string, unknown>();
    let coldResume = false;
    const suspension = new Error('offline cold resume');
    const context: StepCtx = {
      step: async (name, callback) => {
        if (cache.has(name)) return cache.get(name) as never;
        if (name === 'await-runner' && !coldResume) throw suspension;
        const value = await callback({ attempt: 1 });
        cache.set(name, structuredClone(value));
        return value;
      },
      sleep: async () => { throw new Error('Unexpected reconciliation sleep'); },
      waitFor: async () => { throw new Error('Unexpected awaiting'); },
    };
    const params = { taskId, profileId, generation: 1, runId: attempt.id, runnerEngine: 'dynamic-ip-azure-agent-run' };
    const deps = { adapter, runSpecPolicy: { ...defaultRunSpecPolicy(), outputs: declared ? [{ path: 'outputs/required.csv' }] : [] } };
    await expect(conversationPlan(context, store, params, deps)).rejects.toBe(suspension);
    expect(await store.requireTask(taskId)).toMatchObject({ status: 'active', generation: 1 });
    coldResume = true;
    const changedHostPolicy = { ...deps, runSpecPolicy: { ...deps.runSpecPolicy,
      outputs: declared ? [] : [{ path: 'outputs/new-policy.csv' }] } };
    expect((await conversationPlan(context, store, params, changedHostPolicy)).ok).toBe(ok);
    expect(submit).toHaveBeenCalledOnce();
    const task = await store.requireTask(taskId);
    expect(task).toMatchObject({ status: ok ? 'done' : 'failed', generation: 1 });
    const result = JSON.parse(task.result_json!);
    expect(result.persistence).toBe(persistence);
    expect(result.runId).toBe(runId);
    if (ok) expect(result).toMatchObject({ answer: '42 fixture nonce', engineText: { source: 'runner_status_answer' } });
    else expect(result.reason).toBe('export_not_persisted');
    expect(await store.listRuns(taskId)).toHaveLength(1);
    expect(await store.requireRun(attempt.id)).toMatchObject({ session_id: runId, generation: 1, status: ok ? 'success' : 'failed' });
    expect(await store.listArtifacts(taskId)).toHaveLength(refs ? 1 : 0);
    expect(await conversationPlan(context, store, params, deps)).toMatchObject({ reason: 'already_terminal' });
    expect(submit).toHaveBeenCalledOnce();
  });

  it('cached historical submit receipts without frozen output expectations fail closed', async () => {
    const store = new TaskStore(env.DB);
    const taskId = `ut-text-persistence-${++sequence}`;
    const runId = `run_40085128-f369-4dea-a3e2-${String(sequence).padStart(12, '0')}`;
    const profileId = 'integration-telegram-ux-v1';
    await store.admitTask({ id: taskId, profileId, goal: 'historical receipt' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'dynamic-ip-azure-agent-run' });
    const submit = vi.fn(async () => { throw new Error('Historical submit must not repeat'); });
    const adapter = { submit, status: async () => ({ state: 'succeeded', answer: '42' }),
      events: async () => ({ events: [], hasMore: false }), artifacts: async () => [],
      result: async () => ({ runId, ownerGeneration: 1, outcome: 'succeeded', exitReason: 'completed', outputRefs: [], persistence: 'not_required' }),
    } as unknown as RunnerApiAdapter;
    const context: StepCtx = {
      step: async (name, callback) => name === 'submit-runner'
        ? { requestId: 'historical-request', userTaskId: taskId, runId, deduplicated: false } as never
        : callback({ attempt: 1 }),
      sleep: async () => {}, waitFor: async () => { throw new Error('Unexpected awaiting'); },
    };
    expect(await conversationPlan(context, store, { taskId, profileId, generation: 1, runId: attempt.id,
      runnerEngine: 'dynamic-ip-azure-agent-run' }, { adapter, runSpecPolicy: defaultRunSpecPolicy() }))
      .toMatchObject({ ok: false, reason: 'export_not_persisted' });
    expect(submit).not.toHaveBeenCalled();
    expect(await store.requireTask(taskId)).toMatchObject({ status: 'failed', generation: 1 });
  });

  it.each([
    { declaredOutputPaths: undefined, unexpectedManifest: false },
    { declaredOutputPaths: [], unexpectedManifest: true },
  ])('fails closed with declaration=$declaredOutputPaths and unexpected manifest=$unexpectedManifest', async ({ declaredOutputPaths, unexpectedManifest }) => {
    const store = new TaskStore(env.DB);
    const taskId = `ut-text-persistence-${++sequence}`;
    const runId = `run_40085128-f369-4dea-a3e2-${String(sequence).padStart(12, '0')}`;
    await store.admitTask({ id: taskId, profileId: 'fixture-profile', goal: 'unknown output policy' });
    await store.startRun(taskId, { generation: 1, engine: 'opencode', sessionId: runId });
    const adapter = {
      status: async () => ({ state: 'succeeded' }),
      events: async () => ({ events: [], hasMore: false }),
      artifacts: async () => unexpectedManifest ? [{ artifactId: 'fixture-artifact', storageKey: 'fixture-output', ref: 'fixture-output' }] : [],
      result: async () => ({ runId, ownerGeneration: 1, outcome: 'succeeded', exitReason: 'completed', outputRefs: [], persistence: 'not_required' }),
    } as unknown as RunnerApiAdapter;
    expect(await awaitRunnerResult(adapter, store, { taskId, generation: 1, runId, declaredOutputPaths })).toEqual({ ok: false, reason: 'export_not_persisted' });
    expect(await store.requireTask(taskId)).toMatchObject({ status: 'failed', generation: 1 });
  });
});
