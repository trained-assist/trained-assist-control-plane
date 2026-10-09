// Issue #122: adapter control plane → ai-agent-runner.
//  - стабильный ключ попытки ДО отправки, идемпотентный повтор (тот же ключ = тот же Run);
//  - чтение результата/событий по курсору, финализация артефактов;
//  - connection_lost = НЕИЗВЕСТНЫЙ исход (не failed), без авто-rerun;
//  - Runner недоступен -> задача не теряется, повтор безопасен.
import { env } from './env';
import { TaskStore } from '../src/taskstore';
import { awaitRunnerResult, RunnerApiAdapter, stableAttemptKey } from '../src/runner-adapter';
import { conversationPlan, type PlanParams } from '../src/workflow-port/conversation-plan';
import type { StepCtx } from '../src/workflow-port/step-ctx';
import { RunnerConflictError, RunnerUnavailableError } from '../src/runner-adapter/errors';
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
const makeFakeRunner = (
  opts: {
    failSubmit?: boolean;
    connectionLost?: boolean;
    persistence?: 'persisted' | 'failed';
    outputRefs?: string[];
    artifactManifests?: Array<{ artifactId: string; name: string; storageKey: string; size: number; sha256: string; mime: string }>;
  } = {},
) => {
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
          // Конечный текст движка живёт только в событиях log/stdout (контракт
          // Runner'а не имеет поля с текстом ответа) — см. engine-text.ts.
          { type: 'log', sequence: 3, payload: { stream: 'stdout', level: 'info', message: 'работаю' } },
          { type: 'log', sequence: 4, payload: { stream: 'stdout', level: 'info', message: 'Готово: отчёт собран.' } },
        ],
        result: {
          outcome: 'succeeded',
          exitReason: 'completed',
          outputRefs: opts.outputRefs ?? [`r2://control-plane/${input.userTaskId}/answer.json`],
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
      return opts.artifactManifests ?? [];
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

describe('Runner adapter: HTTP-клиент (маршруты, auth, идемпотентность, ошибки)', () => {
  it('submit: POST /v1/runs с Bearer и Idempotency-Key; deduplicated из ответа', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ requestId: 'req-1', userTaskId: 'ut-1', runId: 'run-1', deduplicated: false }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const adapter = new RunnerApiAdapter('http://runner.local', 'test-key', fetchImpl);

    const receipt = await adapter.submit({ userTaskId: 'ut-1', idempotencyKey: 'run-key-1' });

    expect(receipt.runId).toBe('run-1');
    expect(calls[0]!.url).toBe('http://runner.local/v1/runs');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key');
    expect(headers['idempotency-key']).toBe('run-key-1');
    expect(JSON.parse(String(calls[0]!.init.body)).userTaskId).toBe('ut-1');
  });

  // Контракт тела submit сверен с живым Runner'ом: null вместо необязательного поля
  // и `input.text` он отвергает (400 INVALID_REQUEST).
  it('тело submit по контракту Runner\'а: null пропускаются, текст в input.inlinePrompt, refs объектами', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ requestId: 'req-1', userTaskId: 'ut-1', runId: 'run-1', deduplicated: false }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const adapter = new RunnerApiAdapter('http://runner.local', 'k', fetchImpl);

    await adapter.submit({ userTaskId: 'ut-1', idempotencyKey: 'k1' });
    await adapter.submit({
      userTaskId: 'ut-1',
      idempotencyKey: 'k2',
      conversationId: 'conv-1',
      inputText: 'сделай отчёт',
      inputRefs: ['r2://in/a.txt'],
      instructions: 'коротко',
      engineName: 'fake',
      timeoutMs: 60000,
    });

    expect(bodies[0]).toEqual({
      userTaskId: 'ut-1',
      engine: { name: 'opencode', adapterVersion: '1' },
      envAllowlist: [],
      limits: { timeoutMs: 300000 },
    });
    expect(bodies[1]).toEqual({
      userTaskId: 'ut-1',
      engine: { name: 'fake', adapterVersion: '1' },
      envAllowlist: [],
      limits: { timeoutMs: 60000 },
      conversationId: 'conv-1',
      input: { inlinePrompt: 'сделай отчёт', refs: [{ ref: 'r2://in/a.txt' }] },
      instructions: 'коротко',
    });
  });

  it("status/result/events/artifacts/cancel идут по маршрутам Runner'а с курсором", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ runId: 'run-1', events: [], cursor: 5, hasMore: false, artifacts: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const adapter = new RunnerApiAdapter('http://runner.local', 'k', fetchImpl);

    await adapter.status('run-1');
    await adapter.result('run-1');
    await adapter.events('run-1', 5, 100);
    await adapter.artifacts('run-1');
    await adapter.cancel('run-1', { ownerGeneration: 2, reason: 'stop' });

    expect(seen).toEqual([
      'http://runner.local/v1/runs/run-1/status',
      'http://runner.local/v1/runs/run-1/result',
      'http://runner.local/v1/runs/run-1/events?cursor=5&limit=100',
      'http://runner.local/v1/runs/run-1/artifacts',
      'http://runner.local/v1/runs/run-1/cancel',
    ]);
  });

  it('маппинг ошибок: 5xx -> Unavailable, 404 -> NotFound, 409 -> Conflict, STALE -> StaleGeneration', async () => {
    const mk = (status: number, code: string, message = code) =>
      (async () =>
        new Response(JSON.stringify({ error: { code, message } }), {
          status,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch;

    await expect(new RunnerApiAdapter('http://r', 'k', mk(503, 'INTERNAL')).status('x')).rejects.toMatchObject({ name: 'RunnerUnavailableError' });
    await expect(new RunnerApiAdapter('http://r', 'k', mk(503, 'MCP_BINDING_UNAVAILABLE')).submit({ userTaskId: 'u', idempotencyKey: 'k' }))
      .rejects.toMatchObject({ name: 'RunnerConflictError', apiCode: 'MCP_BINDING_UNAVAILABLE', statusCode: 503 });
    await expect(new RunnerApiAdapter('http://r', 'k', mk(503, 'SERVER_MISCONFIGURED', 'authenticated profile has no repository binding'))
      .submit({ userTaskId: 'u', idempotencyKey: 'k' }))
      .rejects.toMatchObject({ name: 'RunnerConflictError', apiCode: 'SERVER_MISCONFIGURED', statusCode: 503 });
    await expect(new RunnerApiAdapter('http://r', 'k', mk(503, 'SERVER_MISCONFIGURED', 'an unrelated server misconfiguration'))
      .submit({ userTaskId: 'u', idempotencyKey: 'k' })).rejects.toMatchObject({ name: 'RunnerUnavailableError' });
    await expect(new RunnerApiAdapter('http://r', 'k', mk(404, 'NOT_FOUND')).status('x')).rejects.toMatchObject({ name: 'RunnerNotFoundError' });
    await expect(new RunnerApiAdapter('http://r', 'k', mk(400, 'INVALID_REQUEST')).submit({ userTaskId: 'u', idempotencyKey: 'k' })).rejects.toMatchObject({ name: 'RunnerConflictError' });
    await expect(new RunnerApiAdapter('http://r', 'k', mk(409, 'STALE_OWNER_GENERATION')).cancel('x')).rejects.toMatchObject({ name: 'RunnerStaleGenerationError' });
  });

  it('сетевой сбой -> RunnerUnavailableError (задача не теряется)', async () => {
    const boom = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    await expect(new RunnerApiAdapter('http://r', 'k', boom).submit({ userTaskId: 'u', idempotencyKey: 'k' })).rejects.toMatchObject({
      name: 'RunnerUnavailableError',
    });
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
    expect(outcome.eventsRecorded).toBe(4);

    // События Runner записаны в журнал с курсором и оригинальным типом.
    const events = await store.history(taskId);
    const runnerEvents = events.filter((e) => e.execution_id === receipt.runId);
    expect(runnerEvents.length).toBe(4);
    const payloads = runnerEvents.map((e) => JSON.parse(e.payload_json));
    expect(payloads.map((p) => p.type)).toEqual(['claimed', 'started', 'log', 'log']);
    expect(payloads[0].sequence).toBe(1);
    expect(payloads[3].eventId).toBeTruthy();

    // Артефакты: ссылки на выходы Runner'а.
    const artifacts = await store.listArtifacts(taskId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.artifact_ref).toContain('answer.json');
    expect(artifacts[0]!.run_id).toBe(receipt.runId);
  });

  it('артефакты из манифестов Runner\'а попадают в задачу даже при пустых outputRefs', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'соберём артефакт' });
    // Живой Runner: outputRefs пуст, артефакт виден в GET /v1/runs/{runId}/artifacts.
    const { adapter } = makeFakeRunner({
      outputRefs: [],
      artifactManifests: [{ artifactId: 'art-1', name: 'ran.txt', storageKey: 'runs/run-1/ran.txt', size: 2, sha256: 'deadbeef', mime: 'text/plain' }],
    });
    const receipt = await adapter.submit({ userTaskId: taskId, idempotencyKey: await stableAttemptKey(taskId, 1) });
    await store.startRun(taskId, { generation: 1, engine: 'opencode', sessionId: receipt.runId });

    const outcome = await awaitRunnerResult(adapter as unknown as RunnerApiAdapter, store, { runId: receipt.runId, taskId, generation: 1, pollSec: 1, timeoutSec: 30 });
    expect(outcome.ok).toBe(true);

    const artifacts = await store.listArtifacts(taskId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.artifact_ref).toBe('runs/run-1/ran.txt');
    expect(artifacts[0]!.size_bytes).toBe(2);
    expect(artifacts[0]!.checksum).toBe('sha256:deadbeef');
    expect(artifacts[0]!.run_id).toBe(receipt.runId);
  });

  it('connection_lost = неизвестный исход: попытка unknown, задача не failed, без авто-rerun', async () => {    const store = new TaskStore(env.DB);
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

describe('Runner adapter: план с adapter\'ом (интеграция, fake StepCtx)', () => {
  it('submit -> ожидание человека -> результат Runner\'а по курсору -> артефакт -> done', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-plan');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'сделай работу' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'opencode' });

    const { adapter } = makeFakeRunner();
    const submittedKeys: string[] = [];
    const wrapped = {
      ...adapter,
      submit: async (input: { userTaskId: string; idempotencyKey: string }) => {
        submittedKeys.push(input.idempotencyKey);
        return adapter.submit(input);
      },
    };

    // Пользователь отвечает, пока план ждёт: durable-ответ, затем «пробуждение».
    const ctx: StepCtx = {
      step: async (_name, fn) => fn({ attempt: 1 }),
      sleep: async () => {},
      waitFor: async () => {
        const open = await store.getOpenAwaiting(taskId);
        if (open) {
          await store.answerAwaitingById({ awaitingInputId: open.awaiting_input_id, idempotencyKey: 'web:plan-test', answer: { answer: 'да' } });
        }
        throw new Error('event timed out');
      },
    };

    const params: PlanParams = {
      taskId,
      generation: 1,
      profileId: 'profile-1',
      runId: attempt.id,
      goal: 'сделай работу',
      runnerPollSec: 1,
      runnerTimeoutSec: 30,
    };
    const outcome = await conversationPlan(ctx, store, params, { adapter: wrapped as unknown as RunnerApiAdapter });

    expect(outcome.ok).toBe(true);
    expect(submittedKeys).toHaveLength(1);
    expect(submittedKeys[0]).toBe(await stableAttemptKey(taskId, 1));

    // Результат несёт маркеры попытки и артефакт Runner'а.
    const task = await store.requireTask(taskId);
    expect(task.status).toBe('done');
    const result = JSON.parse(task.result_json!);
    expect(result.ok).toBe(true);
    expect(result.runId).toMatch(/^run-/);
    expect(result.ownerGeneration).toBe(1);
    expect(result.attempt).toBe(1);
    expect(result.persistence).toBe('persisted');
    expect(result.artifacts[0]!.ref).toContain('answer.json');

    // runId Runner'а привязан к попытке; события Runner'а — в журнале.
    const runs = await store.listRuns(taskId);
    expect(runs[0]!.session_id).toMatch(/^run-/);
    const runnerEvents = (await store.history(taskId)).filter((e) => e.execution_id === runs[0]!.session_id);
    expect(runnerEvents.length).toBeGreaterThanOrEqual(3);
    expect(await store.listArtifacts(taskId)).toHaveLength(1);
  });

  it('движок попытки берётся из параметров плана (runnerEngine), по умолчанию opencode', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-engine');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'выбери движок' });

    const engines: Array<string | undefined> = [];
    const fake: RunnerApiAdapter = {
      submit: async (input: { engineName?: string; runSpec?: { engine?: { name?: string } } }) => {
        // Движок приходит из RunSpec (versioned mapping), а не из поля адаптера.
        engines.push(input.runSpec?.engine?.name ?? input.engineName);
        return { requestId: 'req-1', userTaskId: taskId, runId: 'run-eng', deduplicated: false };
      },
      status: async () => ({ state: 'succeeded' }),
      result: async () => ({ outcome: 'succeeded', exitReason: 'completed', outputRefs: [], persistence: 'persisted', ownerGeneration: 1 }),
      events: async () => ({ events: [], cursor: 0, hasMore: false }),
      artifacts: async () => [],
    } as unknown as RunnerApiAdapter;
    const ctx: StepCtx = {
      step: async (_n, fn) => fn({ attempt: 1 }),
      sleep: async () => {},
      waitFor: async () => {
        const open = await store.getOpenAwaiting(taskId) ?? (await store.getOpenAwaiting(taskId2));
        if (open) {
          await store.answerAwaitingById({ awaitingInputId: open.awaiting_input_id, idempotencyKey: 'web:engine-test', answer: { answer: 'да' } });
        }
        throw new Error('event timed out');
      },
    };

    await conversationPlan(ctx, store, { taskId, generation: 1, profileId: 'profile-1', runnerEngine: 'fake' }, { adapter: fake });
    const taskId2 = nextId('ut-engine2');
    await store.admitTask({ id: taskId2, profileId: 'profile-1', goal: 'по умолчанию' });
    await conversationPlan(ctx, store, { taskId: taskId2, generation: 1, profileId: 'profile-1' }, { adapter: fake });

    expect(engines).toEqual(['fake', 'opencode']);
  });

  // Живая находка: у реального Runner'а outputRefs пуст, артефакт виден только в
  // манифестах. Раньше result.artifacts собирался из outputRefs — и был пуст,
  // хотя артефакт лежал в task_artifacts.
  it('result.artifacts несёт финализированные ссылки из манифестов (пустые outputRefs)', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-plan-manifest');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'соберём артефакт' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'opencode' });
    const { adapter } = makeFakeRunner({
      outputRefs: [],
      artifactManifests: [{ artifactId: 'art-1', name: 'ran.txt', storageKey: 'runs/run-1/ran.txt', size: 2, sha256: 'deadbeef', mime: 'text/plain' }],
    });

    const ctx: StepCtx = {
      step: async (_name, fn) => fn({ attempt: 1 }),
      sleep: async () => {},
      waitFor: async () => {
        const open = await store.getOpenAwaiting(taskId);
        if (open) {
          await store.answerAwaitingById({ awaitingInputId: open.awaiting_input_id, idempotencyKey: 'web:plan-manifest', answer: { answer: 'да' } });
        }
        throw new Error('event timed out');
      },
    };

    const params: PlanParams = {
      taskId,
      generation: 1,
      profileId: 'profile-1',
      runId: attempt.id,
      goal: 'соберём артефакт',
      runnerPollSec: 1,
      runnerTimeoutSec: 30,
    };
    const outcome = await conversationPlan(ctx, store, params, { adapter: adapter as unknown as RunnerApiAdapter });
    expect(outcome.ok).toBe(true);

    const task = await store.requireTask(taskId);
    expect(task.status).toBe('done');
    const result = JSON.parse(task.result_json!);
    expect(result.artifacts).toEqual([{ ref: 'runs/run-1/ran.txt', name: 'ran.txt', mime: 'text/plain', sizeBytes: 2, sha256: 'deadbeef' }]);
    // Ровно тот же набор, что записан в task_artifacts — источник один.
    expect((await store.listArtifacts(taskId)).map((a) => a.artifact_ref)).toEqual(result.artifacts.map((a: { ref: string }) => a.ref));
  });

  it('Runner недоступен в плане: задача не теряется, попытка unknown, повтор безопасен', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-plan-down');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'runner лежит' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'opencode' });
    const { adapter: down } = makeFakeRunner({ failSubmit: true });

    const ctx: StepCtx = { step: async (_n, fn) => fn({ attempt: 1 }), sleep: async () => {}, waitFor: async () => { throw new Error('t'); } };
    await expect(
      conversationPlan(ctx, store, { taskId, generation: 1, profileId: 'profile-1', runId: attempt.id }, { adapter: down as unknown as RunnerApiAdapter }),
    ).rejects.toBeInstanceOf(RunnerUnavailableError);

    const task = await store.requireTask(taskId);
    expect(task.status).toBe('active'); // задача не потеряна
    const run = await store.getRun(attempt.id);
    expect(run!.status).toBe('unknown');
    expect(run!.error_class).toBe('runner_unavailable');
    const events = await store.history(taskId);
    expect(events.some((e) => e.kind === 'error' && e.payload_json.includes('runner_unavailable'))).toBe(true);
  });

  it('definitive Runner 4xx rejection closes only its attempt; it is not a stop hold', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-plan-rejected');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'некорректный RunSpec' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'opencode' });
    const rejected: RunnerApiAdapter = {
      submit: async () => { throw new RunnerConflictError('INVALID_REQUEST: rejected before admission'); },
    } as unknown as RunnerApiAdapter;
    const ctx: StepCtx = { step: async (_n, fn) => fn({ attempt: 1 }), sleep: async () => {}, waitFor: async () => { throw new Error('t'); } };

    await expect(conversationPlan(ctx, store, { taskId, generation: 1, profileId: 'profile-1', runId: attempt.id }, { adapter: rejected }))
      .resolves.toMatchObject({ ok: false, reason: 'runner_rejected' });

    const run = await store.getRun(attempt.id);
    expect(run).toMatchObject({ status: 'failed', error_class: 'runner_rejected' });
    expect(run?.finished_at).not.toBeNull();
    expect(await store.runnerSubmitMayHaveStarted(taskId, attempt.id)).toBe(false);
    expect((await store.requireTask(taskId)).status).toBe('failed');

    const nextTaskId = nextId('ut-after-rejected');
    await expect(store.admitTask({ id: nextTaskId, profileId: 'profile-1', goal: 'следующая задача' })).resolves.toBeDefined();
    expect((await store.requireTask(nextTaskId)).status).toBe('active');
  });

  // Живая находка: недоступность Runner'а посреди отправки не должна оставлять
  // задачу навсегда без прогона. Отправка — шаг с повтором: недоступность
  // прописана в журнал, повтор с тем же ключом возвращает тот же Run.
  it('отправка — шаг с повтором: обрыв связи переживается тем же Run, задача доходит до done', async () => {
    const store = new TaskStore(env.DB);
    const taskId = nextId('ut-plan-retry');
    await store.admitTask({ id: taskId, profileId: 'profile-1', goal: 'обрыв на отправке' });
    const attempt = await store.startRun(taskId, { generation: 1, engine: 'opencode' });
    const { adapter } = makeFakeRunner();

    const keys: string[] = [];
    let failFirst = true;
    const flaky = {
      ...adapter,
      submit: async (input: { userTaskId: string; idempotencyKey: string }) => {
        keys.push(input.idempotencyKey);
        if (failFirst) {
          failFirst = false;
          throw new RunnerUnavailableError('injected: tunnel down');
        }
        return adapter.submit(input);
      },
    };

    // StepCtx, который честно повторяет шаг: так же, как движок Workflows.
    const retryCtx: StepCtx = {
      step: async <T>(_name: string, fn: (a?: { attempt?: number }) => Promise<T>, retry?: { limit: number; delaySec: number }): Promise<T> => {
        let last: unknown;
        for (let n = 1; n <= (retry?.limit ?? 1); n++) {
          try {
            return await fn({ attempt: n });
          } catch (e) {
            last = e;
          }
        }
        throw last;
      },
      sleep: async () => {},
      waitFor: async () => {
        const open = await store.getOpenAwaiting(taskId);
        if (open) {
          await store.answerAwaitingById({ awaitingInputId: open.awaiting_input_id, idempotencyKey: 'web:plan-retry', answer: { answer: 'да' } });
        }
        throw new Error('event timed out');
      },
    };

    const params: PlanParams = {
      taskId,
      generation: 1,
      profileId: 'profile-1',
      runId: attempt.id,
      goal: 'обрыв на отправке',
      runnerPollSec: 1,
      runnerTimeoutSec: 30,
    };
    const outcome = await conversationPlan(retryCtx, store, params, { adapter: flaky as unknown as RunnerApiAdapter });
    expect(outcome.ok).toBe(true);

    // Оба вызова отправки — с одним ключом: Runner дедуплицирует, второй Run не создан.
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(await stableAttemptKey(taskId, 1));

    // Попытка: обрыв помечен, но попытка живёт и привязана к Run Runner'а.
    const events = await store.history(taskId);
    expect(events.some((e) => e.kind === 'error' && e.payload_json.includes('runner_unavailable'))).toBe(true);
    const run = await store.getRun(attempt.id);
    expect(run!.session_id).toMatch(/^run-/);
    expect((await store.requireTask(taskId)).status).toBe('done');
  });
});
