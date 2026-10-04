/**
 * Единственный владелец продолжения fast path (P17, AC-128).
 *
 * Проверяется контракт `continueFastPathEscalation`:
 *  - исполнитель — только терминальный (OpenCode): подмена значения не даёт
 *    продолжения, цепочки на Claude/Codex нет;
 *  - идемпотентность по decisionId: повторный запрос не создаёт вторую работу
 *    и возвращает существующие ссылки;
 *  - управляемая работа (gtdId) — второй владелец продолжения не появляется;
 *  - терминальная задача и запрещённый политикой исполнитель — отказ, а не
 *    запуск.
 */
import { describe, expect, it } from 'vitest';
import { continueFastPathEscalation, FAST_PATH_CONTINUATION_OWNER } from '../src/output/continuation';
import { TERMINAL_EXECUTOR, type AgentWorkOrder } from '../src/router';

function workOrder(executor: string = TERMINAL_EXECUTOR): AgentWorkOrder {
  return {
    userTaskId: 'ut-1',
    profileId: 'profile-p17',
    conversationId: 'conv-1',
    originalRequestRef: 'task:ut-1:request:req-1',
    goal: 'найди пять конкурентов',
    preservedConstraints: [],
    requiredCapabilities: ['web-search'],
    reasonCode: 'ADAPTIVE_TOOL_LOOP',
    escalationReason: 'ADAPTIVE_TOOL_LOOP',
    executor: executor as AgentWorkOrder['executor'],
    authorizationRef: 'authz-test',
    requiresConfirmation: false,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    decisionId: 'ut-1:req-1:capabilities-v1',
    userTaskId: 'ut-1',
    profileId: 'profile-p17',
    conversationId: 'conv-1',
    originalRequestRef: 'task:ut-1:request:req-1',
    goal: 'найди пять конкурентов',
    preservedConstraints: [],
    requiredCapabilities: ['web-search'],
    reasonCode: 'ADAPTIVE_TOOL_LOOP' as const,
    partialResultRef: null,
    authorizationRef: 'authz-test',
    requiresConfirmation: false,
    workOrder: workOrder(),
    ...overrides,
  };
}

interface StoreStub {
  task: { status: string; generation: number } | null;
  gtdId: string | null;
  recorded: Array<{ decisionId: string; jobRef: string; runId: string; generation: number }>;
}

function deps(store: StoreStub, port: { runId?: string; generation?: number } = {}, agentAllowed = true) {
  return {
    agentAllowed,
    port: {
      resume: async () => ({ runId: port.runId ?? 'run-1', generation: port.generation ?? 2 }),
    },
    store: {
      taskOf: async () => store.task,
      gtdIdOf: async () => store.gtdId,
      continuationOf: async (_userTaskId: string, decisionId: string) =>
        store.recorded.find((row) => row.decisionId === decisionId) ?? null,
      recordContinuation: async (params: { decisionId: string; jobRef: string; runId: string; generation: number }) => {
        store.recorded.push(params);
      },
    },
  };
}

describe('P17 · единственный владелец продолжения', () => {
  it('выдаёт продолжение: новый runId, тот же userTaskId, подъём поколения, OpenCode', async () => {
    const store: StoreStub = { task: { status: 'running', generation: 1 }, gtdId: null, recorded: [] };
    const outcome = await continueFastPathEscalation(request(), deps(store, { runId: 'run-2', generation: 2 }));
    expect(outcome.created).toBe(true);
    if (!outcome.created) return;
    expect(outcome.owner).toBe(FAST_PATH_CONTINUATION_OWNER);
    expect(outcome.executor).toBe(TERMINAL_EXECUTOR);
    expect(outcome.runId).toBe('run-2');
    expect(outcome.generation).toBe(2);
    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]!.decisionId).toBe('ut-1:req-1:capabilities-v1');
  });

  it('исполнитель только терминальный: подмена значения не даёт продолжения', async () => {
    const store: StoreStub = { task: { status: 'running', generation: 1 }, gtdId: null, recorded: [] };
    const outcome = await continueFastPathEscalation(request({ workOrder: workOrder('claude') }), deps(store));
    expect(outcome.created).toBe(false);
    if (outcome.created) return;
    expect(outcome.refusal.reason).toBe('executor_not_terminal');
    expect(store.recorded).toHaveLength(0);
  });

  it('идемпотентность: тот же decisionId — та же работа, второй попытки нет', async () => {
    const store: StoreStub = {
      task: { status: 'running', generation: 1 },
      gtdId: null,
      recorded: [{ decisionId: 'ut-1:req-1:capabilities-v1', jobRef: 'job_ut-1_g2', runId: 'run-2', generation: 2 }],
    };
    const outcome = await continueFastPathEscalation(request(), deps(store));
    expect(outcome.created).toBe(false);
    if (outcome.created) return;
    expect(outcome.refusal.reason).toBe('already_continued');
    if (outcome.refusal.reason !== 'already_continued') return;
    expect(outcome.refusal.jobRef).toBe('job_ut-1_g2');
    expect(outcome.refusal.runId).toBe('run-2');
    expect(store.recorded).toHaveLength(1);
  });

  it('управляемая работа: продолжение выдаёт только GTD, второго владельца нет', async () => {
    const store: StoreStub = { task: { status: 'running', generation: 1 }, gtdId: 'gtd-1', recorded: [] };
    const outcome = await continueFastPathEscalation(request(), deps(store));
    expect(outcome.created).toBe(false);
    if (outcome.created) return;
    expect(outcome.refusal.reason).toBe('gtd_owns_continuation');
    expect(store.recorded).toHaveLength(0);
  });

  it('терминальная задача — отказ, а не запуск', async () => {
    const store: StoreStub = { task: { status: 'done', generation: 3 }, gtdId: null, recorded: [] };
    const outcome = await continueFastPathEscalation(request(), deps(store));
    expect(outcome.created).toBe(false);
    if (outcome.created) return;
    expect(outcome.refusal.reason).toBe('task_terminal');
  });

  it('исполнитель, запрещённый политикой, — отказ, а не запуск', async () => {
    const store: StoreStub = { task: { status: 'running', generation: 1 }, gtdId: null, recorded: [] };
    const outcome = await continueFastPathEscalation(request(), deps(store, {}, false));
    expect(outcome.created).toBe(false);
    if (outcome.created) return;
    expect(outcome.refusal.reason).toBe('agent_not_allowed_by_policy');
  });

  it('задача отсутствует — отказ, а не запуск', async () => {
    const store: StoreStub = { task: null, gtdId: null, recorded: [] };
    const outcome = await continueFastPathEscalation(request(), deps(store));
    expect(outcome.created).toBe(false);
    if (outcome.created) return;
    expect(outcome.refusal.reason).toBe('task_missing');
  });
});
