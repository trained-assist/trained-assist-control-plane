import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TaskStore } from '../src/taskstore';
import { RunnerApiAdapter } from '../src/runner-adapter';
import { defaultRunSpecPolicy } from '../src/run-spec/run-spec';
import { conversationPlan } from '../src/workflow-port/conversation-plan';
import { inputManifestForTask } from '../src/intake/input-artifact-manifest';
import type { StepCtx } from '../src/workflow-port/step-ctx';
import { env } from './env';

let sequence = 0;

const stepContext: StepCtx = {
  step: async (_name, callback) => callback({ attempt: 1 }),
  sleep: async () => {},
  waitFor: async () => { throw new Error('Unexpected awaiting input'); },
};

describe('CP routes admitted media as a pinned Runner ingress manifest', () => {
  it('submits the task-scoped manifest pin, not media refs or workspace snapshots', async () => {
    const store = new TaskStore(env.DB);
    const suffix = `runner-ingress-${++sequence}-${Date.now()}`;
    const taskId = `ut-${suffix}`;
    const profileId = `profile-${suffix}`;
    const bytes = new TextEncoder().encode('voice fixture');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifact = {
      contractVersion: 1,
      ref: 'a'.repeat(64),
      version: sha256,
      ownerProfileId: profileId,
      mediaType: 'audio/ogg',
      name: 'voice.ogg',
      sizeBytes: bytes.byteLength,
      sha256,
    };
    await store.admitTask({
      id: taskId,
      profileId,
      goal: 'Summarize the attached audio',
      userValue: {
        inputItems: [
          { text: 'Summarize the attached audio', artifacts: [artifact] },
        ],
        artifactRefs: [artifact.ref],
        inputArtifacts: [artifact],
        snapshotIds: [],
      },
    });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'opencode' });
    const pinnedManifest = await inputManifestForTask(await store.requireTask(taskId));
    expect(pinnedManifest?.inputItems).toEqual([{ text: 'Summarize the attached audio', artifacts: [artifact] }]);

    let submitted: Record<string, unknown> | null = null;
    const runnerRunId = `runner-${suffix}`;
    const adapter = new RunnerApiAdapter('https://runner.example.test', 'fixture-key', async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/runs') {
        submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ requestId: `request-${suffix}`, userTaskId: taskId, runId: runnerRunId, deduplicated: false });
      }
      if (path.endsWith('/status')) return Response.json({ runId: runnerRunId, state: 'succeeded', connectionLost: false, answer: 'Audio summary' });
      if (path.endsWith('/result')) return Response.json({
        runId: runnerRunId, userTaskId: taskId, profileId, ownerGeneration: 1,
        outcome: 'succeeded', exitReason: 'completed', exitCode: 0, exitSignal: null,
        exitObserved: true, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        usage: { status: 'unknown' }, outputRefs: [], persistence: 'not_required', cleanup: 'completed', logPath: null,
      });
      if (path.endsWith('/events')) return Response.json({ events: [], cursor: 0, hasMore: false });
      if (path.endsWith('/artifacts')) return Response.json({ artifacts: [] });
      throw new Error(`Unexpected Runner endpoint: ${path}`);
    });

    const outcome = await conversationPlan(stepContext, store, {
      taskId, generation: 1, profileId, runId: attempt.id, runnerEngine: 'opencode',
    }, { adapter, runSpecPolicy: defaultRunSpecPolicy() });

    expect(outcome.ok).toBe(true);
    expect(submitted).toMatchObject({
      ingressManifest: {
        contractVersion: 1,
        manifestRef: `cp-input-manifest:${taskId}`,
        manifestVersion: pinnedManifest?.manifestVersion,
        userTaskId: taskId,
        profileId,
        runId: `run_${taskId}_1`,
        ownerGeneration: 1,
      },
    });
    expect(submitted).not.toHaveProperty('input.refs');
    expect(JSON.stringify(submitted)).not.toContain(artifact.ref);
  });
});
