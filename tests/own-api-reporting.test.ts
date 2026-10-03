// Own-API dogfood (#23), шаг 3: структурированный текстовый результат движка и
// манифесты артефактов видны в отчёте. Exit 0 != пользователь получил ответ.
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import { reportSnapshot } from '../src/reporting';
import { awaitRunnerResult, RunnerApiAdapter } from '../src/runner-adapter';
import { conversationPlan } from '../src/workflow-port/conversation-plan';
import type { StepCtx } from '../src/workflow-port/step-ctx';
import { describe, expect, it } from 'vitest';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

const ctx: StepCtx = {
  step: async (_name, fn) => fn({ attempt: 1 }),
  sleep: async () => {},
  waitFor: async () => {
    throw new Error('event timed out');
  },
};

const makeRunner = (opts: { stdout?: string[]; manifests?: Array<{ artifactId: string; name: string; storageKey: string; size: number; sha256: string; mime: string }> } = {}) => {
  const runId = nextId('run');
  const stdout = opts.stdout ?? ['Отчёт готов.'];
  const adapter = {
    async submit(input: { userTaskId: string }) {
      return { requestId: `req-${runId}`, userTaskId: input.userTaskId, runId, deduplicated: false };
    },
    async status() {
      return { state: 'succeeded', connectionLost: false };
    },
    async result() {
      return {
        runId,
        userTaskId: 'ut-x',
        profileId: 'profile-1',
        ownerGeneration: 1,
        outcome: 'succeeded' as const,
        exitReason: 'completed',
        exitCode: 0,
        exitSignal: null,
        exitObserved: true,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        usage: { status: 'unknown' as const },
        outputRefs: [],
        persistence: 'persisted' as const,
        cleanup: 'completed' as const,
        logPath: `/logs/${runId}.log`,
      };
    },
    async events() {
      const events = [
        { type: 'claimed', sequence: 1, payload: { operationId: 'op-1' } },
        ...stdout.map((message, i) => ({ type: 'log', sequence: 2 + i, payload: { stream: 'stdout', level: 'info', message } })),
      ];
      return { runId, events, cursor: events.length, hasMore: false, snapshot: { state: 'succeeded', connectionLost: false, sequence: events.length, ownerGeneration: 1 } };
    },
    async artifacts() {
      return opts.manifests ?? [];
    },
    async cancel() {
      return { status: 'cancelled' };
    },
  };
  return { adapter, runId };
};

describe('reporting: текст движка и манифесты артефактов', () => {
  it('отчёт отдаёт конечный текст движка отдельно от ответа человека', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-report-text');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'собери отчёт' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'opencode' });
    const { adapter } = makeRunner({ stdout: ['Первая строка.', 'Вторая строка.'] });

    await conversationPlan(
      ctx,
      store,
      { taskId, generation: 1, profileId: 'profile-1', runId: attempt.id, goal: 'собери отчёт', runnerPollSec: 1, runnerTimeoutSec: 30 },
      { adapter: adapter as unknown as RunnerApiAdapter },
    );

    const snapshot = await reportSnapshot(store, taskId);
    expect(snapshot.status).toBe('done');
    expect(snapshot.answer).toBe('Первая строка.\nВторая строка.');
    expect(snapshot.userAnswer).toBeNull();
    expect((snapshot.result as Record<string, unknown>)['mode']).toBe('engine');
  });

  it('движок без текста: answer=null виден в отчёте, а не пустый ответ', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-report-no-text');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'молча сделай работу' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'opencode' });
    const { adapter } = makeRunner({ stdout: [] });

    await conversationPlan(
      ctx,
      store,
      { taskId, generation: 1, profileId: 'profile-1', runId: attempt.id, goal: 'молча сделай работу', runnerPollSec: 1, runnerTimeoutSec: 30 },
      { adapter: adapter as unknown as RunnerApiAdapter },
    );

    const snapshot = await reportSnapshot(store, taskId);
    expect(snapshot.status).toBe('done');
    expect(snapshot.answer).toBeNull();
  });

  it('манифесты артефактов несут размер и контрольную сумму для проверки скачанного', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-report-manifest');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'создай файл' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'opencode' });
    const { adapter } = makeRunner({
      stdout: ['Файл создан.'],
      manifests: [{ artifactId: 'art-1', name: 'report.md', storageKey: `runs/${taskId}/report.md`, size: 42, sha256: 'a'.repeat(64), mime: 'text/markdown' }],
    });

    await conversationPlan(
      ctx,
      store,
      { taskId, generation: 1, profileId: 'profile-1', runId: attempt.id, goal: 'создай файл', runnerPollSec: 1, runnerTimeoutSec: 30 },
      { adapter: adapter as unknown as RunnerApiAdapter },
    );

    const snapshot = await reportSnapshot(store, taskId);
    expect(snapshot.artifacts).toEqual([
      { ref: `runs/${taskId}/report.md`, kind: 'file', sizeBytes: 42, sha256: 'a'.repeat(64), runId: expect.any(String) },
    ]);
    // Тот же манифест в структурированном результате.
    const result = snapshot.result as { artifacts: Array<{ ref: string; sizeBytes: number | null; sha256: string | null }> };
    expect(result.artifacts[0]).toEqual({ ref: `runs/${taskId}/report.md`, name: 'report.md', mime: 'text/markdown', sizeBytes: 42, sha256: 'a'.repeat(64) });
  });

  it('awaitRunnerResult возвращает манифесты, а не голые ссылки', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-manifest');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'проверь манифест' });
    const { adapter, runId } = makeRunner({
      manifests: [{ artifactId: 'art-9', name: 'index.html', storageKey: `runs/${taskId}/index.html`, size: 11, sha256: 'b'.repeat(64), mime: 'text/html' }],
    });

    const outcome = await awaitRunnerResult(adapter as unknown as RunnerApiAdapter, store, { runId, taskId, generation: 1, pollSec: 1, timeoutSec: 30 });
    if (!outcome.ok) throw new Error(`ожидался ok, получили ${outcome.reason}`);

    expect(outcome.artifacts).toEqual([{ ref: `runs/${taskId}/index.html`, name: 'index.html', mime: 'text/html', sizeBytes: 11, sha256: 'b'.repeat(64) }]);
    // Ссылка без манифеста остаётся видимой, но честно без контрольной суммы.
    const store2 = new TaskStore(env.DB);
    const taskId2 = nextId('ut-manifest-bare');
    await store2.admitTask({ id: taskId2, profileId: 'profile-1', goal: 'проверь голую ссылку' });
    const bare = {
      ...adapter,
      async artifacts() {
        return [];
      },
      async result() {
        return {
          runId,
          userTaskId: taskId2,
          profileId: 'profile-1',
          ownerGeneration: 1,
          outcome: 'succeeded' as const,
          exitReason: 'completed',
          exitCode: 0,
          exitSignal: null,
          exitObserved: true,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          usage: { status: 'unknown' as const },
          outputRefs: [`r2://${taskId2}/answer.md`],
          persistence: 'persisted' as const,
          cleanup: 'completed' as const,
          logPath: `/logs/${runId}.log`,
        };
      },
    };
    const outcome2 = await awaitRunnerResult(bare as unknown as RunnerApiAdapter, store2, { runId, taskId: taskId2, generation: 1, pollSec: 1, timeoutSec: 30 });
    if (!outcome2.ok) throw new Error(`ожидался ok, получили ${outcome2.reason}`);
    expect(outcome2.artifacts).toEqual([{ ref: `r2://${taskId2}/answer.md`, name: null, mime: null, sizeBytes: null, sha256: null }]);
  });
});
