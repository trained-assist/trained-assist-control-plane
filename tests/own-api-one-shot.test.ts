// Own-API dogfood (#23), шаг 1: результат задачи — конечный текст движка, а не
// ответ человека. Ожидание человека открывается только по typed-запросу хоста.
import { env } from './env';
import type { WorkflowStep } from 'cloudflare:workers';
import { TaskStore } from '../src/taskstore';
import { extractEngineText, ENGINE_TEXT_VERSION } from '../src/runner-adapter/engine-text';
import { awaitRunnerResult, RunnerApiAdapter } from '../src/runner-adapter';
import { conversationPlan, type PlanParams } from '../src/workflow-port/conversation-plan';
import { cfStepCtx, type StepCtx } from '../src/workflow-port/step-ctx';
import { describe, expect, it, vi } from 'vitest';
import { runSpecPolicyOf } from '../src/run-spec/run-spec';

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
    expect(result.artifacts).toEqual([{ ref: 'r2://control-plane/ut-x/answer.md', name: null, mime: null, sizeBytes: null, sha256: null }]);
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

describe('one-shot: RunSpec доходит до Runner целиком', () => {
  it.each([
    { answer: 'Итоги CSV:\n3 строки обработаны.', source: 'agent_file', expected: 'Итоги CSV:\n3 строки обработаны.' },
    { answer: 'Only the final assistant answer', source: 'engine_stdout', expected: 'Only the final assistant answer' },
    { answer: undefined, source: 'agent_file', expected: null },
    { answer: null, source: null, expected: null },
    { answer: '  \n', source: 'engine_stdout', expected: null },
  ])('uses only explicit native answers, preserves provenance and terminal replay: %j', async ({ answer, source, expected }) => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-native-answer');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'process the CSV' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'dynamic-ip-azure-agent-run' });
    const { adapter, runId } = makeFakeRunner({ stdout: ['{"type":"tool_use","tool":"read","input":"not a final answer"}'] });
    const submit = vi.fn(adapter.submit);
    const status = vi.fn(async () => ({ ...await adapter.status(), ...(answer === undefined ? {} : { answer }) }));
    const events = async () => {
      const page = await adapter.events();
      return { ...page, events: [...page.events, { type: 'agent_exit_resolved', sequence: page.cursor + 1, payload: { answerSource: source } }], cursor: page.cursor + 1 };
    };
    const native = { ...adapter, submit, status, events, result: async () => ({ ...await adapter.result(), text: 'result-text fallback must not leak' }) };
    const params = { taskId, generation: 1, profileId: 'profile-1', runId: attempt.id, runnerEngine: 'dynamic-ip-azure-agent-run', goal: 'process the CSV' };
    expect(await conversationPlan(ctx, store, params, { adapter: native as unknown as RunnerApiAdapter })).toMatchObject({ ok: true, answer: expected });
    const task = await store.requireTask(taskId);
    const result = JSON.parse(task.result_json!);
    expect(result.answer).toBe(expected);
    expect(result.answerSource).toBe(expected === null ? null : source);
    expect(result.engineText).toMatchObject({ text: expected, source: expected === null ? null : 'runner_status_answer', answerSource: expected === null ? null : source });
    expect(task.result_json).not.toContain('tool_use');
    expect(result.runId).toBe(runId);
    const artifacts = await store.listArtifacts(taskId);
    status.mockImplementation(async () => ({ ...await adapter.status(), answer: 'must not replace the durable answer' }));
    expect(await conversationPlan(ctx, store, params, { adapter: native as unknown as RunnerApiAdapter })).toMatchObject({ ok: true, reason: 'already_terminal' });
    expect((await store.requireTask(taskId)).result_json).toBe(task.result_json);
    expect(await store.listArtifacts(taskId)).toEqual(artifacts);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
    expect(await store.listRuns(taskId)).toHaveLength(1);
  });

  it('replays a pre-upgrade cached wait by reading native status, never stdout or new jobs', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-native-cached-answer');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'original task' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'dynamic-ip-azure-agent-run' });
    const { adapter } = makeFakeRunner({ stdout: ['{"type":"tool_result","text":"diagnostic"}'] });
    const submit = vi.fn(adapter.submit);
    const status = vi.fn(async () => ({ ...await adapter.status(), answer: 'Authoritative answer' }));
    const cachedCtx: StepCtx = { ...ctx, step: async (name, fn, options) => {
      const value = await ctx.step(name, fn, options);
      if (name === 'await-runner') {
        const cached = { ...value as Record<string, unknown> };
        delete cached.answer;
        return cached as typeof value;
      }
      return value;
    } };
    const outcome = await conversationPlan(cachedCtx, store,
      { taskId, generation: 1, profileId: 'profile-1', runId: attempt.id, runnerEngine: 'dynamic-ip-azure-agent-run', goal: 'original task' },
      { adapter: { ...adapter, submit, status } as unknown as RunnerApiAdapter });
    expect(outcome).toMatchObject({ ok: true, answer: 'Authoritative answer' });
    expect(JSON.parse((await store.requireTask(taskId)).result_json!)).toMatchObject({ answerSource: 'runner_status_answer' });
    expect(status).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await store.listRuns(taskId)).toHaveLength(1);
  });

  it('concurrent terminal completion writes one immutable attempt result and event', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-terminal-attempt');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'terminal refusal' });
    const attempt = await store.startRun(taskId, { generation: 1 });
    const result = { reason: 'WORKER_HTTP_ERROR' };
    const finished = await Promise.all([store.finishRun(attempt.id, 'failed', { result }), store.finishRun(attempt.id, 'failed', { result })]);
    expect(finished[0]).toEqual(finished[1]);
    expect((await store.history(taskId)).filter((event) => event.kind === 'run_finished')).toHaveLength(1);
    await expect(store.finishRun(attempt.id, 'success')).rejects.toThrow('finish rejected');
    expect(JSON.parse((await store.requireRun(attempt.id)).result_json!)).toEqual(result);
  });

  it.each(['pending', 'failed'] as const)('preserves WORKER_HTTP_ERROR before export checks (%s) and closes the attempt once', async (persistence) => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-worker-refusal');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'process original CSV' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'dynamic-ip-azure-agent-run' });
    const { adapter, runId } = makeFakeRunner();
    const failure = { code: 'WORKER_HTTP_ERROR', failureClass: 'external_dependency', safeSummary: 'Worker HTTP 400: taskId required', retryable: false };
    const artifacts = vi.fn(async () => { throw new Error('preflight has no artifact endpoint'); });
    const submit = vi.fn(adapter.submit);
    const failing = { ...adapter, submit, artifacts,
      status: async () => ({ state: 'failed', connectionLost: false }),
      events: async () => ({ runId, events: [], cursor: 0, hasMore: false }),
      result: async () => ({ ...await adapter.result(), outcome: 'failed', exitReason: 'worker_http_error', failure, persistence, outputRefs: [] }),
    };
    const params = { taskId, generation: 1, profileId: 'profile-1', runId: attempt.id, goal: 'process original CSV' };
    expect(await conversationPlan(ctx, store, params, { adapter: failing as unknown as RunnerApiAdapter })).toMatchObject({ ok: false, reason: 'runner_failed' });
    const task = await store.requireTask(taskId);
    expect(task.status).toBe('failed');
    expect(task.stage).toBe('finished');
    expect(JSON.parse(task.result_json!)).toMatchObject({ reason: 'WORKER_HTTP_ERROR', exitReason: 'worker_http_error', failure, persistence, outcome: 'failed', runId });
    expect(artifacts).not.toHaveBeenCalled();
    expect(await store.listArtifacts(taskId)).toHaveLength(0);
    const finished = await store.requireRun(attempt.id);
    expect(finished.status).toBe('failed');
    expect(finished.error_class).toBe('WORKER_HTTP_ERROR');
    await Promise.all([store.finishRun(attempt.id, 'failed'), store.finishRun(attempt.id, 'failed')]);
    expect(await store.requireRun(attempt.id)).toEqual(finished);
    expect((await store.history(taskId)).filter((event) => event.kind === 'run_finished')).toHaveLength(1);
    expect(await conversationPlan(ctx, store, params, { adapter: failing as unknown as RunnerApiAdapter })).toMatchObject({ ok: false, reason: 'already_terminal' });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await store.listRuns(taskId)).toHaveLength(1);
    expect((await store.requireTask(taskId)).result_json).toBe(task.result_json);
  });

  it.each([{ elapsedMs: 700_000, ok: true }, { elapsedMs: 841_000, ok: false }])('bounds result polling by host runtime plus startup budget: %j', async ({ elapsedMs, ok }) => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-host-budget');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'wait for cold start' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'opencode' });
    const { adapter } = makeFakeRunner();
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const submit = vi.fn(async (input: { userTaskId: string; idempotencyKey: string; runSpec: { limits: { timeoutMs: number } } }) => {
      expect(input.runSpec.limits.timeoutMs).toBe(240_000);
      return adapter.submit(input);
    });
    let polls = 0;
    const status = async () => {
      if (++polls === 1) {
        now += elapsedMs;
        return { state: 'running', connectionLost: false };
      }
      return adapter.status();
    };
    try {
      const budgetCtx: StepCtx = { ...ctx, step: async (name, fn, options) => {
        if (name === 'await-runner') expect(options?.timeoutSec).toBe(900);
        return ctx.step(name, fn, options);
      } };
      const outcome = await conversationPlan(budgetCtx, store,
        { taskId, generation: 1, profileId: 'profile-1', runId: attempt.id, runnerPollSec: 1, runnerTimeoutSec: 120 },
        { adapter: { ...adapter, submit, status } as unknown as RunnerApiAdapter,
          runSpecPolicy: runSpecPolicyOf({ RUN_SPEC_TIMEOUT_MS: '240000', RUN_SPEC_STARTUP_TIMEOUT_MS: '600000' }) });
      expect(outcome.ok).toBe(true);
      if (!ok) expect((await store.history(taskId)).some(event => event.payload_json.includes('runner_timeout'))).toBe(true);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(await store.listRuns(taskId)).toHaveLength(1);
      expect((await store.requireTask(taskId)).generation).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('passes the explicit result-wait timeout to Cloudflare without changing retry ownership', async () => {
    const doStep = vi.fn(async (_name: string, options: unknown, callback: () => Promise<unknown>) => {
      expect(options).toEqual({ retries: { limit: 2, delay: '1 seconds', backoff: 'constant' }, timeout: '900 seconds' });
      return callback();
    });
    const step = cfStepCtx({ do: doStep } as unknown as WorkflowStep);
    expect(await step.step('await-runner', async () => 'done', { limit: 2, delaySec: 1, timeoutSec: 900 })).toBe('done');
    expect(doStep).toHaveBeenCalledTimes(1);
  });

  it('adapter получает runSpec с хостовым cwd/env и клиентским prompt/refs', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-run-spec');
    await store.admitTask({
      id: taskId,
      profileId: 'profile-from-task-row',
      goal: 'сделай работу',
      userValue: { artifactRefs: ['artifact://input.md'] },
    });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'opencode' });
    const { adapter } = makeFakeRunner({ stdout: ['готово'] });

    const seen: Array<Record<string, unknown>> = [];
    const capturing = {
      ...adapter,
      submit: async (input: { userTaskId: string; idempotencyKey: string; runSpec?: Record<string, unknown> }) => {
        seen.push(input.runSpec ?? {});
        return adapter.submit(input);
      },
    };

    await conversationPlan(
      ctx,
      store,
      { taskId, generation: 1, profileId: 'profile-from-params', runId: attempt.id, goal: 'сделай работу', runnerPollSec: 1, runnerTimeoutSec: 30 },
      { adapter: capturing as unknown as RunnerApiAdapter },
    );

    expect(seen).toHaveLength(1);
    const spec = seen[0]!;
    // Хостовое: из политики и записи в Task Store.
    expect(spec['cwd']).toBe('/workspace');
    expect(spec['envAllowlist']).toEqual([]);
    expect(spec['profileId']).toBe('profile-from-task-row');
    expect(spec['userTaskId']).toBe(taskId);
    expect(spec['ownerGeneration']).toBe(1);
    expect(spec['traceId']).toBe(attempt.id);
    // Клиентское: полное сообщение и разрешённые вложения.
    expect(spec['input']).toEqual({ inlinePrompt: 'сделай работу', refs: [{ ref: 'artifact://input.md' }] });
    expect((spec['runId'] as string).startsWith('run_')).toBe(true);
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
