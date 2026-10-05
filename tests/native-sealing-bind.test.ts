import { describe, expect, it, vi } from 'vitest';
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import { conversationPlan } from '../src/workflow-port/conversation-plan';
import type { StepCtx } from '../src/workflow-port/step-ctx';
import { RunnerApiAdapter } from '../src/runner-adapter';

function strictBindings(database: D1Database): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(prepared, method) {
            if (method === 'bind') return (...values: unknown[]) => {
              if (values.includes(undefined)) throw new Error('D1_TYPE_ERROR: undefined bind');
              return prepared.bind(...values);
            };
            const value = Reflect.get(prepared, method);
            return typeof value === 'function' ? value.bind(prepared) : value;
          },
        });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('native result sealing binds', () => {
  it('enriches only missing immutable artifact metadata on replay without another result_ready event', async () => {
    const taskId = `native-enrich-${crypto.randomUUID()}`;
    const artifactRef = `r2://fixture/${taskId}/result.csv`;
    const store = new TaskStore(strictBindings(env.DB));
    await store.admitTask({ id: taskId, profileId: 'fixture-profile', goal: 'fixture CSV' });
    const original = await store.recordArtifact({ taskId, kind: 'file', artifactRef, runId: 'fixture-run' });
    const enriched = await store.recordArtifact({ taskId, kind: 'file', artifactRef, runId: 'fixture-run', sizeBytes: 34, checksum: 'sha256:fixture' });
    expect(enriched.created).toBe(false);
    expect(enriched.artifact).toMatchObject({ artifact_id: original.artifact.artifact_id, created_at: original.artifact.created_at,
      run_id: 'fixture-run', size_bytes: 34, checksum: 'sha256:fixture' });
    await store.recordArtifact({ taskId, kind: 'file', artifactRef, runId: 'fixture-run', sizeBytes: 34, checksum: 'sha256:fixture' });
    await expect(store.recordArtifact({ taskId, kind: 'file', artifactRef, runId: 'fixture-run', sizeBytes: 35 })).rejects.toThrow('metadata conflict');
    await expect(store.recordArtifact({ taskId, kind: 'file', artifactRef, runId: 'other-run', checksum: 'sha256:other' })).rejects.toThrow('metadata conflict');
    expect((await store.listArtifacts(taskId))[0]).toEqual(enriched.artifact);
    expect((await store.history(taskId)).filter(event => event.kind === 'result_ready')).toHaveLength(1);
  });

  it.each(['native', 'native-replay', 'legacy', 'malformed'] as const)('seals %s HTTP artifact manifests without undefined D1 binds', async shape => {
    const taskId = `native-bind-${crypto.randomUUID()}`;
    const runnerRunId = `native-run-${crypto.randomUUID()}`;
    const artifactRef = `r2://fixture/${taskId}/result.csv`;
    const store = new TaskStore(strictBindings(env.DB));
    await store.admitTask({ id: taskId, profileId: 'fixture-profile', goal: 'fixture CSV' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'dynamic-ip-azure-agent-run' });
    if (shape === 'native-replay') await store.recordArtifact({ taskId, kind: 'file', artifactRef, runId: runnerRunId });
    const submit = vi.fn(async () => ({ runId: runnerRunId, deduplicated: false }));
    const metadata = { name: 'result.csv', mime: 'text/csv', size: 42, sha256: 'fixture-checksum' };
    const manifest = shape === 'legacy' ? { ...metadata, storageKey: artifactRef, artifactId: 'fixture-artifact-id' }
      : { ...metadata, path: '/fixture/result.csv', ...(shape !== 'malformed' ? { url: artifactRef } : {}) };
    const fetchArtifacts = vi.fn(async () => Response.json({ artifacts: [manifest] }));
    const wire = new RunnerApiAdapter('https://runner.fixture', 'fixture-key', fetchArtifacts);
    const adapter = {
      submit,
      status: async () => ({ state: 'succeeded', connectionLost: false, answer: 'CSV complete' }),
      events: async () => ({ events: [], cursor: 0, hasMore: false }),
      result: async () => ({ runId: runnerRunId, ownerGeneration: 1, outcome: 'succeeded',
        persistence: 'persisted', exitReason: 'completed', outputRefs: [artifactRef] }),
      artifacts: async () => wire.artifacts(runnerRunId),
    } as unknown as RunnerApiAdapter;
    const ctx = { step: async (_name: string, operation: () => Promise<unknown>) => operation() } as StepCtx;
    const params = { taskId, profileId: 'fixture-profile', generation: 1, runId: attempt.id,
      runnerEngine: 'dynamic-ip-azure-agent-run' };
    const outcome = await conversationPlan(ctx, store, params, { adapter });
    expect(fetchArtifacts).toHaveBeenCalledWith(`https://runner.fixture/v1/runs/${runnerRunId}/artifacts`, expect.objectContaining({ method: 'GET' }));
    if (shape === 'malformed') {
      expect(outcome).toEqual({ ok: false, reason: 'runner_artifact_manifest_invalid' });
      expect((await store.requireTask(taskId)).status).toBe('active');
      expect((await store.requireRun(attempt.id)).status).toBe('running');
      expect(await store.listArtifacts(taskId)).toEqual([]);
    } else {
      expect(outcome).toMatchObject({ ok: true, answer: 'CSV complete' });
      expect((await store.requireTask(taskId)).status).toBe('done');
      expect((await store.requireRun(attempt.id)).status).toBe('success');
      expect(await store.listArtifacts(taskId)).toEqual([expect.objectContaining({ artifact_ref: artifactRef,
        size_bytes: 42, checksum: 'sha256:fixture-checksum' })]);
    }
    if (shape !== 'malformed') expect(await conversationPlan(ctx, store, params, { adapter })).toMatchObject({ reason: 'already_terminal' });
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await store.history(taskId)).filter(event => event.kind === 'result_ready')).toHaveLength(shape === 'malformed' ? 0 : 1);
  });
});
