// Демо-план M1.2: реплика -> ожидание ответа -> сигнал -> результат.
// Зависит только от StepCtx + TaskStore (как pilotPlan в пилоте P-DB),
// написан по TASK-STORE-SCHEMA-V1 (awaiting_inputs, дедуп сигналов, guard).
import {
  AlreadyOpenAwaitingError,
  FencedError,
  TaskStore,
  TerminalStateError,
  TaskStoreError,
  isTerminalStatus,
} from '../taskstore';
import { isWaitTimeout, type StepCtx } from './step-ctx';

/** Маркер версии логики шагов: payload шагов фиксируют, каким кодом они шли (#92). */
export const PLAN_VERSION = 'm1-conversation-v1';

export interface PlanParams {
  taskId: string;
  /** ownerGeneration, с которым запущен экземпляр; записи идут только с ним. */
  generation: number;
  profileId: string;
  question?: string;
  waitTimeoutSec?: number;
  /** Тестовый хук: шаг падает на 1-й попытке, платформа должна продолжить сама. */
  crashRunOnce?: boolean;
}

export interface PlanOutcome {
  ok: boolean;
  reason?: string;
  answer?: string | null;
}

async function handleWaitTimeout(store: TaskStore, p: PlanParams): Promise<PlanOutcome> {
  const { taskId, generation } = p;
  const current = await store.getTask(taskId);
  if (!current) return { ok: false, reason: 'task_missing' };
  // Устаревшее поколение не пишет ничего (fencing).
  if (current.generation !== generation) return { ok: false, reason: 'fenced' };

  try {
    await store.expireAwaiting({
      taskId,
      nextStatus: 'failed',
      generation,
      step: 'wait',
      reason: 'user_reply_timeout',
    });
  } catch (e) {
    // Задачу уже закрыл кто-то другой (done/failed/cancelled) — НЕ перезаписываем
    // статус и результат: суть issue #90.
    if (e instanceof TerminalStateError || e instanceof FencedError) return { ok: false, reason: 'already_terminal' };
    if (e instanceof TaskStoreError && /no open awaiting/.test(e.message)) {
      const now = await store.getTask(taskId);
      if (now && isTerminalStatus(now.status)) return { ok: false, reason: 'already_terminal' };
      return { ok: false, reason: 'already_closed' };
    }
    throw e;
  }
  return { ok: false, reason: 'user_reply_timeout' };
}

export async function conversationPlan(ctx: StepCtx, store: TaskStore, p: PlanParams): Promise<PlanOutcome> {
  const { taskId, generation } = p;

  await ctx.step('prepare', () =>
    store.commit(taskId, generation, {
      kind: 'step_done',
      status: 'active',
      stage: 'running',
      step: 'prepare',
      payload: { version: PLAN_VERSION },
    }),
  );

  if (p.crashRunOnce) {
    await ctx.step(
      'guard-crash',
      async (attempt) => {
        const n = attempt?.attempt ?? 1;
        if (n === 1) throw new Error('injected executor crash between steps (attempt 1)');
        return store.commit(taskId, generation, {
          kind: 'step_done',
          step: 'guard-crash',
          payload: { resumedBy: 'platform', attempt: n, version: PLAN_VERSION },
        });
      },
      { limit: 3, delaySec: 1 },
    );
  }

  await ctx.step('mark-awaiting', async () => {
    try {
      const { awaitingInputId } = await store.openAwaiting({
        taskId,
        kind: 'data',
        question: p.question ?? 'Продолжить работу? Ответьте на вопрос задачи.',
        respondentScope: p.profileId,
        step: 'wait',
        generation,
      });
      return awaitingInputId;
    } catch (e) {
      // Повтор шага: ожидание уже открыто — возвращаем прежний адрес ответа.
      if (e instanceof AlreadyOpenAwaitingError) return e.awaitingInputId;
      throw e;
    }
  });

  // Ранний сигнал лежит в task_signals до парковки (T4) — сначала буфер в БД,
  // и только потом ожидание события у движка.
  let reply: { answer?: string } | undefined;
  const buffered = await store.peekSignal(taskId, 'user_reply');
  if (buffered) {
    reply = JSON.parse(buffered.payload_json);
  } else {
    try {
      reply = await ctx.waitFor<{ answer?: string }>('wait', 'user_reply', p.waitTimeoutSec ?? 24 * 3600);
    } catch (e) {
      if (!isWaitTimeout(e)) throw e;
      return handleWaitTimeout(store, p);
    }
  }
  await store.takeSignal(taskId, 'user_reply', { step: 'wait', executionId: taskId });

  await ctx.step('wait-received', async () => {
    try {
      return await store.answerAwaiting({ taskId, answer: reply, generation, step: 'wait' });
    } catch (e) {
      if (e instanceof TaskStoreError && /no open awaiting/.test(e.message)) return null;
      throw e;
    }
  });

  await ctx.step('apply', () =>
    store.commit(taskId, generation, {
      kind: 'step_done',
      status: 'active',
      stage: 'running',
      step: 'apply',
      payload: { used: reply?.answer ?? null, version: PLAN_VERSION },
    }),
  );

  const answer = reply?.answer ?? null;
  await ctx.step('finalize', () =>
    store.commit(taskId, generation, {
      status: 'done',
      stage: 'finished',
      step: 'finalize',
      result: { answer, ok: answer === 'да', version: PLAN_VERSION },
      payload: { version: PLAN_VERSION },
    }),
  );

  return { ok: true, answer };
}
