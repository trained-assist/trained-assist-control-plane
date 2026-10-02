// Демо-план M1.2/M1: реплика -> ожидание ответа -> сигнал -> результат.
// Зависит только от StepCtx + TaskStore (как pilotPlan в пилоте P-DB),
// написан по TASK-STORE-SCHEMA-V1 (awaiting_inputs, дедуп сигналов, guard).
//
// Шаг 5 (Conversation и Awaiting user input, гейт #115): ожидание человека —
// durable строка в Task Store, а не живой процесс. Движок может умереть во время
// ожидания; новая попытка продолжает ОТ того же awaitingInputId и находит уже
// сохранённый ответ. Продолжение помечается явно (новый runId, тот же
// userTaskId), шаги до ожидания не переигрываются.
import {
  AlreadyOpenAwaitingError,
  FencedError,
  TaskStore,
  TerminalStateError,
  TaskStoreError,
  isTerminalStatus,
  type AwaitingPurpose,
} from '../taskstore';
import { waitForAnswer } from '../awaiting/wait-for-answer';
import { isWaitTimeout, type StepCtx, type StepAttempt } from './step-ctx';

/** Маркер версии логики шагов: payload шагов фиксируют, каким кодом они шли (#92). */
export const PLAN_VERSION = 'm1-conversation-v1';

export interface PlanParams {
  taskId: string;
  /** ownerGeneration попытки: записи идут только с ним (fencing, INV-02). */
  generation: number;
  /** Профиль-владелец: respondentScope ожидания (ARCHITECTURE §5.4, INV-19). */
  profileId: string;
  /** runId попытки: план завершает её при терминальных переходах. */
  runId?: string;
  /** Назначение ожидания: preference | missing_fact | credential | approval. */
  awaitingPurpose?: AwaitingPurpose | null;
  /** Варианты ответа для purpose=preference (choice) со стабильными option ID (#115). */
  awaitingOptions?: { id: string; label: string }[] | null;
  question?: string;
  waitTimeoutSec?: number;
  /** Период durable-опроса ответа: сколько ждём подсказку движка до перечитывания БД. */
  waitPollSec?: number;
  /** Тестовый хук: шаг падает на 1-й попытке, платформа должна продолжить сама. */
  crashRunOnce?: boolean;
}

export interface PlanOutcome {
  ok: boolean;
  reason?: string;
  answer?: string | null;
}

const answerText = (raw: unknown): string | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && 'answer' in (raw as Record<string, unknown>)) {
    const v = (raw as Record<string, unknown>).answer;
    return typeof v === 'string' ? v : null;
  }
  return null;
};

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
    if (p.runId) {
      await store.finishRun(p.runId, 'failed', { errorClass: 'user_reply_timeout' }).catch(() => null);
    }
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

/** apply + finalize: общий хвост для обычного хода и для явного продолжения. */
async function finishAfterAnswer(
  ctx: StepCtx,
  store: TaskStore,
  p: PlanParams,
  raw: unknown,
): Promise<PlanOutcome> {
  const { taskId, generation } = p;
  const answer = answerText(raw);

  await ctx.step('apply', () =>
    store.commit(taskId, generation, {
      kind: 'step_done',
      status: 'active',
      stage: 'running',
      step: 'apply',
      payload: { used: answer, version: PLAN_VERSION },
    }),
  );

  const result = { answer, ok: answer === 'да', version: PLAN_VERSION };
  await ctx.step('finalize', () =>
    store.commit(taskId, generation, {
      status: 'done',
      stage: 'finished',
      step: 'finalize',
      result,
      payload: { version: PLAN_VERSION },
    }),
  );
  if (p.runId) await store.finishRun(p.runId, 'success', { result });

  return { ok: true, answer };
}

export async function conversationPlan(ctx: StepCtx, store: TaskStore, p: PlanParams): Promise<PlanOutcome> {
  const { taskId, generation } = p;

  // Задача уже терминальна (например, экземпляр перезапущен после done):
  // шаги не выполняем, состояние не трогаем — иначе терминальный guard уронит
  // экземпляр на повторном finalize.
  const current = await store.getTask(taskId);
  if (current && isTerminalStatus(current.status)) {
    return { ok: current.status === 'done', reason: 'already_terminal' };
  }

  // ЯВНОЕ ПРОДОЛЖЕНИЕ (шаг 5): если движок умер во время ожидания человека,
  // задача уже в awaiting_input с открытым ожиданием — продолжаем ОТ него.
  // Шаги до ожидания не переигрываются: это не молчаливый повтор задачи.
  const alreadyWaiting = current?.status === 'awaiting_input' ? await store.getOpenAwaiting(taskId) : null;
  if (alreadyWaiting) {
    const waited = await waitForAnswer({
      store,
      ctx,
      taskId,
      awaitingInputId: alreadyWaiting.awaiting_input_id,
      pollSec: p.waitPollSec ?? 60,
      timeoutSec: p.waitTimeoutSec ?? 24 * 3600,
      step: 'wait',
    });
    if (waited.answer === null) return handleWaitTimeout(store, p);
    return finishAfterAnswer(ctx, store, p, waited.answer);
  }

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
      async (attempt?: StepAttempt) => {
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

  const awaitingInputId: string = await ctx.step('mark-awaiting', async () => {
    try {
      const opened = await store.openAwaiting({
        taskId,
        purpose: p.awaitingPurpose ?? 'missing_fact',
        question: p.question ?? 'Продолжить работу? Ответьте на вопрос задачи.',
        respondentScope: p.profileId,
        step: 'wait',
        generation,
        schema: p.awaitingOptions ? { options: p.awaitingOptions } : undefined,
        engineRefs: p.runId ? { sessionRef: `run:${p.runId}` } : null,
      });
      return opened.awaitingInputId;
    } catch (e) {
      // Повтор шага: ожидание уже открыто — возвращаем прежний адрес ответа.
      if (e instanceof AlreadyOpenAwaitingError) return e.awaitingInputId;
      throw e;
    }
  });

  // Ожидание человека: истина — durable строка awaiting_inputs, движок только
  // будит. Ответ по явному адресу применяет host (API ответа).
  const waited = await waitForAnswer({
    store,
    ctx,
    taskId,
    awaitingInputId,
    pollSec: p.waitPollSec ?? 60,
    timeoutSec: p.waitTimeoutSec ?? 24 * 3600,
    step: 'wait',
  });
  if (waited.answer === null) return handleWaitTimeout(store, p);

  return finishAfterAnswer(ctx, store, p, waited.answer);
}

export { isWaitTimeout };
