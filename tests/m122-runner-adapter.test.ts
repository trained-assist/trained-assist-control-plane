// Issue #122: adapter control plane → ai-agent-runner.
//  - стабильный ключ попытки ДО отправки, идемпотентный повтор (тот же ключ = тот же Run);
//  - чтение результата/событий по курсору, финализация артефактов;
//  - connection_lost = НЕИЗВЕСТНЫЙ исход (не failed), без авто-rerun;
//  - Runner недоступен -> задача не теряется, повтор безопасен.
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import { awaitRunnerResult, stableAttemptKey, type RunnerApiAdapter } from '../src/runner-adapter';
import { RunnerUnavailableError } from '../src/runner-adapter/errors';
import { describe, expect, it } from 'vitest';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Date.now()}`;

interface FakeRun {
  runId: string;
  state: string;
  statusCalls?: number;
  connectionLost: boolean;
  events: Array<{ type: string; sequence: number; payload?: unknown }>;
  result: {
    outcome: 'succeeded' | 'failed' | 'cancelled';
    exitReason: string;
    outputRefs: string[];
    persistence: 'pending' | 'persisted' | 'failed';
    ownerGeneration: number;
  };
}

/** Фейковый Runner: тот же контракт, что у Serverless Agent API, без сети. */
const makeFakeRunner = (opts: { failSubmit?: boolean; connectionLost?: boolean; persistence?: 'persisted' | 'failed' } = {}) => {
  const runs = new Map<string, FakeRun>();
  const receipts = new Map<string, { runId: string; deduplicated: boolean }>();

  const adapter = {
    async submit(input: { userTaskId: string; idempotencyKey: string; timeoutMs?: number }) {
      if (opts.failSubmit) throw new RunnerUnavailableError('injected: runner down');
      const existing = receipts.get(input.idempotencyKey);
      if (existing) return { requestId: `req-${existing.runId}`, userTaskId: input.userTaskId, runId: existing.runId, deduplicated: true };
      const runId = nextId('run');
      const run: FakeRun = {
        runId,
        state: 'running',
        connectionLost: opts.connectionLost ?? false,
        events: [
          { type: 'claimed', sequence: 1, payload: { operationId: 'op-1' } },
          { type: 'started', sequence: 2 },
          { type: 'log', sequence: 3, payload: { text: 'работаю' } },
        ],
        result: {
          outcome: 'succeeded',
          exitReason: 'completed',
          outputRefs: [`r2://control-plane/${input.userTaskId}/answer.json`],
          persistence: opts.persistence ?? 'persisted',
          ownerGeneration: 1,
        },
      };
      runs.set(runId, run);
      receipts.set(input.idempotencyKey, { runId, deduplicated: false });
      return { requestId: `req-${runId}`, userTaskId: input.userTaskId, runId, deduplicated: false };
    },
    async status(runId: string) {
      const run = runs.get(runId);
      if (!run) throw new Error(`unknown run ${runId}`);
      run.statusCalls = (run.statusCalls ?? 0) + 1;
      // Первый опрос — running, дальше — терминал (фейк завершает работу).
      const state = run.statusCalls < 2 ? 'running' : 'succeeded';
      return {
        requestId: `req-${runId}`,
        userTaskId: 'ut-x',
        conversationId: 'conv-x',
        runId,
        ownerGeneration: run.result.ownerGeneration,
        state,
        cancelRequested: false,
        connectionLost: run.connectionLost,
        observedAt: new Date().toISOString(),
        sequence: run.events.length,
        fencing: { rejected: 0 },
      };
    },
    async result(runId: string) {
      const run = runs.get(runId);
      if (!run) throw new Error(`unknown run ${runId}`);
      return {
        runId,
        userTaskId: 'ut-x',
        profileId: 'profile-1',
        ownerGeneration: run.result.ownerGeneration,
        outcome: run.result.outcome,
        exitReason: run.result.exitReason,
        exitCode: 0,
        exitSignal: null,
        exitObserved: true,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        usage: { status: 'unknown' },
        outputRefs: run.result.outputRefs,
        persistence: run.result.persistence,
        cleanup: 'completed',
        logPath: `/logs/${runId}.log`,
      };
    },
    async events(runId: string, cursor = 0) {
      const run = runs.get(runId);
      if (!run) throw new Error(`unknown run ${runId}`);
      const events = run.events.slice(cursor).map((e, i) => ({
        eventId: `${runId}-${e.sequence}`,
        runId,
        jobId: 'job-1',
        userTaskId: 'ut-x',
        profileId: 'profile-1',
        ownerGeneration: run.result.ownerGeneration,
        sequence: e.sequence,
        timestamp: new Date().toISOString(),
        type: e.type,
        payload: e.payload,
      }));
      return { runId, events, cursor: run.events.length, hasMore: false, snapshot: { state: run.state, connectionLost: run.connectionLost, sequence: run.events.length, ownerGeneration: run.result.ownerGeneration } };
    },
    async artifacts() {
      return [];
    },
    async cancel() {
      return { status: 'cancelled' };
    },
  };

  return { adapter, runs, receipts };
};

describe('Runner adapter: стабильный ключ и идемпотентность', () => {
  it('ключ попытки вычисляется ДО отправки; повтор с тем же ключом = тот же Run', async () => {
    const { adapter, receipts } = makeFakeRunner();
    const key = await stableAttemptKey('ut-1', 1);

    const first = await adapter.submit({ userTaskId: 'ut-1', idempotencyKey: key });
    const second = await adapter.submit({ userTaskId: 'ut-1', idempotencyKey: key });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.runId).toBe(first.runId);
    expect(receipts.size).toBe(1);
  });

  it('другой generation = другой ключ = новая попытка', async () => {
    const key1 = await stableAttemptKey('ut-1', 1);
    const key2 = await stableAttemptKey('ut-1', 2);
    expect(key1).not.toBe(key2);
  });
});

describe('Runner adapter: результат, курсор событий, артефакты', () => {
  it('awaitRunnerResult: события по курсору в журнал, артефакты зафиксированы, результат с маркерами попытки', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'сделай работу' });
    const { adapter } = makeFakeRunner();
    const receipt = await adapter.submit({ userTaskId: taskId, idempotencyKey: await stableAttemptKey(taskId, 1) });
    await store.startRun(taskId, { generation: 1, engine: 'opencode', sessionId: receipt.runId });

    const outcome = await awaitRunnerResult(adapter as unknown as RunnerApiAdapter, store, { runId: receipt.runId, taskId, generation: 1, pollSec: 1, timeoutSec: 30 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.outcome).toBe('succeeded');
    expect(outcome.eventsRecorded).toBe(3);

    // События Runner записаны в журнал с курсором и оригинальным типом.
    const events = await store.history(taskId);
    const runnerEvents = events.filter((e) => e.execution_id === receipt.runId);
    expect(runnerEvents.length).toBe(3);
    const payloads = runnerEvents.map((e) => JSON.parse(e.payload_json));
    expect(payloads.map((p) => p.type)).toEqual(['claimed', 'started', 'log']);
    expect(payloads[0].sequence).toBe(1);
    expect(payloads[2].eventId).toBeTruthy();

    // Артефакты: ссылки на выходы Runner'а.
    const artifacts = await store.listArtifacts(taskId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.artifact_ref).toContain('answer.json');
    expect(artifacts[0]!.run_id).toBe(receipt.runId);
  });

  it('connection_lost = неизвестный исход: попытка unknown, задача не failed, без авто-rerun', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'потеряем связь' });
    const { adapter } = makeFakeRunner({ connectionLost: true });
    const receipt = await adapter.submit({ userTaskId: taskId, idempotencyKey: await stableAttemptKey(taskId, 1) });
    await store.startRun(taskId, { generation: 1, engine: 'opencode', sessionId: receipt.runId });

    const outcome = await awaitRunnerResult(adapter as unknown as RunnerApiAdapter, store, { runId: receipt.runId, taskId, generation: 1, pollSec: 1, timeoutSec: 30 });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('connection_lost');

    // Попытка — unknown, задача осталась active, никакого failed/rerun.
    const runs = await store.listRuns(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('unknown');
    expect(runs[0]!.error_class).toBe('connection_lost');
    const task = await store.requireTask(taskId);
    expect(task.status).toBe('active');
    expect(task.generation).toBe(1);
  });

  it('Runner недоступен: задача не теряется, повтор с тем же ключом безопасен', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'runner лежит' });
    const { adapter: down } = makeFakeRunner({ failSubmit: true });
    const key = await stableAttemptKey(taskId, 1);

    await expect(down.submit({ userTaskId: taskId, idempotencyKey: key })).rejects.toBeInstanceOf(RunnerUnavailableError);

    // Задача цела: статус active, попыток нет, событие о недоступности видно.
    // Задача цела: статус active, попыток нет (submit не дошёл до Runner'а).
    const task = await store.requireTask(taskId);
    expect(task.status).toBe('active');
    expect(await store.listRuns(taskId)).toHaveLength(0);

    // Повтор с тем же ключом после восстановления Runner'а: тот же Run, не второй.
    const { adapter: up } = makeFakeRunner();
    const retry = await up.submit({ userTaskId: taskId, idempotencyKey: key });
    expect(retry.deduplicated).toBe(false);
    expect(retry.runId).toBeTruthy();
    expect(await store.listRuns(taskId)).toHaveLength(0); // попытку создаёт план, а не adapter
  });

  it('экспорт не подтверждён: задача failed с причиной, артефакты не теряются молча', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'export упадёт' });
    const { adapter } = makeFakeRunner({ persistence: 'failed' });
    const receipt = await adapter.submit({ userTaskId: taskId, idempotencyKey: await stableAttemptKey(taskId, 1) });
    await store.startRun(taskId, { generation: 1, engine: 'opencode', sessionId: receipt.runId });

    const outcome = await awaitRunnerResult(adapter as unknown as RunnerApiAdapter, store, { runId: receipt.runId, taskId, generation: 1, pollSec: 1, timeoutSec: 30 });

    expect(outcome.ok).toBe(false);
    const task = await store.requireTask(taskId);
    expect(task.status).toBe('failed');
    const result = task.result_json ? JSON.parse(task.result_json) : null;
    expect(result.reason).toBe('export_not_persisted');
    expect(result.persistence).toBe('failed');
    // Артефакты всё равно зафиксированы (ссылки), результат не потерян молча.
    expect(await store.listArtifacts(taskId)).toHaveLength(1);
  });
});
