// Own-API dogfood (#23), шаг 1: результат задачи — конечный текст движка, а не
// ответ человека. Ожидание человека открывается только по typed-запросу хоста.
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import { extractEngineText, ENGINE_TEXT_VERSION } from '../src/runner-adapter/engine-text';
import { awaitRunnerResult, RunnerApiAdapter } from '../src/runner-adapter';
import { conversationPlan, type PlanParams } from '../src/workflow-port/conversation-plan';
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

/** Фейковый Runner: тот же контракт Serverless Agent API, без сети. */
const makeFakeRunner = (opts: { stdout?: string[]; failSubmit?: boolean } = {}) => {
  const runId = nextId('run');
  const stdout = opts.stdout ?? ['работаю', 'Готово: отчёт собран.'];
  const adapter = {
    async submit(input: { userTaskId: string; idempotencyKey: string }) {
      if (opts.failSubmit) throw new Error('injected: runner down');
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
        outputRefs: [`r2://control-plane/ut-x/answer.md`],
        persistence: 'persisted' as const,
        cleanup: 'completed' as const,
        logPath: `/logs/${runId}.log`,
      };
    },
    async events() {
      const events = [
        { type: 'claimed', sequence: 1, payload: { operationId: 'op-1' } },
        { type: 'started', sequence: 2 },
        ...stdout.map((message, i) => ({
          type: 'log',
          sequence: 3 + i,
          payload: { stream: 'stdout', level: 'info', message },
        })),
      ];
      return { runId, events, cursor: events.length, hasMore: false, snapshot: { state: 'succeeded', connectionLost: false, sequence: events.length, ownerGeneration: 1 } };
    },
    async artifacts() {
      return [];
    },
    async cancel() {
      return { status: 'cancelled' };
    },
  };
  return { adapter, runId };
};

describe('engine-text: конечный текст движка из событий Runner\'а', () => {
  it('берёт только stdout log-события, в порядке sequence', () => {
    const text = extractEngineText([
      { eventId: 'e1', runId: 'r', jobId: 'j', userTaskId: 'u', profileId: 'p', ownerGeneration: 1, sequence: 2, timestamp: new Date().toISOString(), type: 'log', payload: { stream: 'stdout', level: 'info', message: 'вторая строка' } },
      { eventId: 'e2', runId: 'r', jobId: 'j', userTaskId: 'u', profileId: 'p', ownerGeneration: 1, sequence: 1, timestamp: new Date().toISOString(), type: 'log', payload: { stream: 'stdout', level: 'info', message: 'первая строка' } },
      { eventId: 'e3', runId: 'r', jobId: 'j', userTaskId: 'u', profileId: 'p', ownerGeneration: 1, sequence: 3, timestamp: new Date().toISOString(), type: 'log', payload: { stream: 'stderr', level: 'error', message: 'не в ответе' } },
      { eventId: 'e4', runId: 'r', jobId: 'j', userTaskId: 'u', profileId: 'p', ownerGeneration: 1, sequence: 4, timestamp: new Date().toISOString(), type: 'succeeded', payload: { outcome: 'succeeded', exitReason: 'completed', exitCode: 0 } },
    ]);

    expect(text).not.toBeNull();
    expect(text!.text).toBe('первая строка\nвторая строка');
    expect(text!.lines).toBe(2);
    expect(text!.version).toBe(ENGINE_TEXT_VERSION);
    expect(text!.source).toBe('runner_log_stdout');
  });

  it('пустой stdout = null, а не пустый ответ', () => {
    expect(extractEngineText([])).toBeNull();
    expect(
      extractEngineText([
        { eventId: 'e1', runId: 'r', jobId: 'j', userTaskId: 'u', profileId: 'p', ownerGeneration: 1, sequence: 1, timestamp: new Date().toISOString(), type: 'log', payload: { stream: 'stderr', level: 'error', message: 'шум' } },
      ]),
    ).toBeNull();
  });
});

describe('one-shot с движком: результат = текст движка, ожидание не открывается', () => {
  it('без awaitingPurpose план закрывает задачу текстом движка, без ожидания', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-one-shot');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'собери отчёт' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'opencode' });
    const { adapter } = makeFakeRunner({ stdout: ['Отчёт готов: 42 строки.'] });

    const params: PlanParams = {
      taskId,
      generation: 1,
      profileId: 'profile-1',
      runId: attempt.id,
      goal: 'собери отчёт',
      runnerPollSec: 1,
      runnerTimeoutSec: 30,
    };
    const outcome = await conversationPlan(ctx, store, params, { adapter: adapter as unknown as RunnerApiAdapter });

    expect(outcome.ok).toBe(true);
    // Ответ — конечный текст движка.
    expect(outcome.answer).toBe('Отчёт готов: 42 строки.');

    const task = await store.requireTask(taskId);
    expect(task.status).toBe('done');
    expect(task.awaiting_input_id).toBeNull();
    expect(await store.getOpenAwaiting(taskId)).toBeNull();
    expect(await store.listSignals(taskId)).toHaveLength(0);

    const result = JSON.parse(task.result_json!);
    expect(result.ok).toBe(true);
    expect(result.answer).toBe('Отчёт готов: 42 строки.');
    expect(result.mode).toBe('engine');
    expect(result.runId).toMatch(/^run-/);
    expect(result.artifacts).toEqual(['r2://control-plane/ut-x/answer.md']);
  });

  it('с awaitingPurpose ожидание открывается, но ответ всё равно текст движка', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-typed-ask');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'уточни деталь' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'opencode' });
    const { adapter } = makeFakeRunner({ stdout: ['Запрос уточнения отправлен.'] });

    const answeringCtx: StepCtx = {
      ...ctx,
      waitFor: async () => {
        const open = await store.getOpenAwaiting(taskId);
        if (open) {
          await store.answerAwaitingById({ awaitingInputId: open.awaiting_input_id, idempotencyKey: 'web:typed-ask', answer: { answer: 'да' } });
        }
        throw new Error('event timed out');
      },
    };

    const params: PlanParams = {
      taskId,
      generation: 1,
      profileId: 'profile-1',
      runId: attempt.id,
      goal: 'уточни деталь',
      awaitingPurpose: 'missing_fact',
      runnerPollSec: 1,
      runnerTimeoutSec: 30,
    };
    const outcome = await conversationPlan(answeringCtx, store, params, { adapter: adapter as unknown as RunnerApiAdapter });

    expect(outcome.ok).toBe(true);
    expect(outcome.answer).toBe('Запрос уточнения отправлен.');

    const task = await store.requireTask(taskId);
    expect(task.status).toBe('done');
    const result = JSON.parse(task.result_json!);
    expect(result.answer).toBe('Запрос уточнения отправлен.');
    // Ответ человека сохранён рядом и не подменяет текст движка.
    expect(result.userAnswer).toBe('да');
  });

  it('движок без текста: answer=null, но задача не выдаёт пустоту за ответ', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-no-text');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'молча сделай работу' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'opencode' });
    const { adapter } = makeFakeRunner({ stdout: [] });

    const outcome = await conversationPlan(
      ctx,
      store,
      { taskId, generation: 1, profileId: 'profile-1', runId: attempt.id, goal: 'молча сделай работу', runnerPollSec: 1, runnerTimeoutSec: 30 },
      { adapter: adapter as unknown as RunnerApiAdapter },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.answer).toBeNull();
    const result = JSON.parse((await store.requireTask(taskId)).result_json!);
    expect(result.answer).toBeNull();
    expect(result.answer).toBeNull();
    expect(result.mode).toBe('engine');
  });
});

describe('awaitRunnerResult: текст движка возвращается вместе с результатом', () => {
  it('engineText собирается из событий и не зависит от ответа человека', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-engine-text');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'проверь текст' });
    const { adapter, runId } = makeFakeRunner({ stdout: ['первая строка', 'вторая строка'] });

    const outcome = await awaitRunnerResult(adapter as unknown as RunnerApiAdapter, store, { runId, taskId, generation: 1, pollSec: 1, timeoutSec: 30 });

    if (!outcome.ok) throw new Error(`ожидался ok, получили ${outcome.reason}`);
    expect(outcome.engineText).not.toBeNull();
    expect(outcome.engineText!.text).toBe('первая строка\nвторая строка');
    expect(outcome.engineText!.lines).toBe(2);
  });
});
