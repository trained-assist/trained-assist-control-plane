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
import { awaitRunnerResult } from '../runner-adapter/await-runner-result';
import { stableAttemptKey, type RunnerApiAdapter } from '../runner-adapter/runner-api-adapter';
import { RunnerUnavailableError } from '../runner-adapter/errors';
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
  /** Продолжение: адрес ожидания, от которого продолжаем (шаг 5). */
  awaitingInputId?: string | null;
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
  goal?: string | null;
  instructions?: string | null;
  runnerPollSec?: number;
  runnerTimeoutSec?: number;
  /** Движок попытки Runner'а (RunSpec.engine.name); по умолчанию opencode. */
  runnerEngine?: string;
}

/**
 * Зависимости рантайма (НЕ сериализуются в params Workflow): adapter строится
 * из env в TaskWorkflow, чтобы ключ Runner'а не попадал в durable params движка.
 */
export interface PlanDeps {
  adapter?: RunnerApiAdapter | null;
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

export async function conversationPlan(
  ctx: StepCtx,
  store: TaskStore,
  p: PlanParams,
  deps: PlanDeps = {},
): Promise<PlanOutcome> {
  const adapter = deps.adapter ?? null;
  const { taskId, generation } = p;

  // Задача уже терминальна (например, экземпляр перезапущен после done):
  // шаги не выполняем, состояние не трогаем — иначе терминальный guard уронит
  // экземпляр на повторном finalize.
  const current = await store.getTask(taskId);
  if (current && isTerminalStatus(current.status)) {
    return { ok: current.status === 'done', reason: 'already_terminal' };
  }

  // ЯВНОЕ ПРОДОЛЖЕНИЕ (шаг 5): если движок умер во время ожидания человека,
  // продолжение получает адрес того же ожидания и идёт ОТ него — шаги до
  // ожидания не переигрываются (это не молчаливый повтор задачи).
  //  - ожидание открыто   -> продолжаем ждать ответа;
  //  - ответ уже durable  -> сразу к результату (ответ пережил смерть движка).
  const resumeAwaitingId = p.awaitingInputId ?? (current?.status === 'awaiting_input' ? (await store.getOpenAwaiting(taskId))?.awaiting_input_id ?? null : null);
  if (resumeAwaitingId) {
    const row = await store.getAwaiting(resumeAwaitingId);
    if (row?.status === 'answered' && row.answer_json !== null) {
      return finishAfterAnswer(ctx, store, p, JSON.parse(row.answer_json));
    }
    if (row?.status === 'open') {
      const waited = await waitForAnswer({
        store,
        ctx,
        taskId,
        awaitingInputId: resumeAwaitingId,
        pollSec: p.waitPollSec ?? 60,
        timeoutSec: p.waitTimeoutSec ?? 24 * 3600,
        step: 'wait',
      });
      if (waited.answer === null) return handleWaitTimeout(store, p);
      return finishAfterAnswer(ctx, store, p, waited.answer);
    }
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

  // Настоящий Runner (issue #122): попытка отправляется в Serverless Agent API
  // со СТАБИЛЬНЫМ ключом, вычисленным до отправки. Недоступность Runner'а не
  // теряет задачу: попытка остаётся незапущенной, повтор с тем же ключом
  // возвращает тот же receipt.
  let runnerRunId: string | null = null;
  if (adapter) {
    const attemptKey = await stableAttemptKey(taskId, generation);
    try {
      const receipt = await adapter.submit({
        userTaskId: taskId,
        conversationId: current?.conversation_id ?? null,
        engineName: p.runnerEngine ?? 'opencode',
        inputText: p.goal ?? current?.goal ?? null,
        inputRefs: [],
        instructions: p.instructions ?? null,
        idempotencyKey: attemptKey,
        timeoutMs: (p.runnerTimeoutSec ?? 120) * 1000,
      });
      runnerRunId = receipt.runId;
      // Попытку уже создал порт (p.runId); привязываем runId Runner'а к ней.
      if (p.runId) await store.attachRunnerRun(p.runId, receipt.runId);
      await store.logEvent({
        taskId,
        kind: 'run_started',
        generation,
        source: 'executor',
        payload: {
          runId: receipt.runId,
          requestId: receipt.requestId,
          ownerGeneration: null,
          attempt: 1,
          deduplicated: receipt.deduplicated,
          idempotencyKey: attemptKey,
        },
      });
    } catch (e) {
      if (e instanceof RunnerUnavailableError) {
        // Задача не теряется: попытка -> unknown, статус задачи не меняется,
        // повтор с тем же ключом безопасен.
        if (p.runId) {
          await store.markConnectionLost(p.runId, e.message, 'runner_unavailable').catch(() => null);
        }
        await store.logEvent({
          taskId,
          kind: 'error',
          generation,
          source: 'executor',
          payload: { class: 'runner_unavailable', message: e.message, idempotencyKey: attemptKey },
        });
        throw e; // платформа повторит шаг с тем же ключом
      }
      throw e;
    }
  }

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

  // Настоящий Runner: читаем результат и события по курсору, финализируем
  // артефакты. connection_lost — неизвестный исход, не failed, без авто-rerun.
  if (adapter && runnerRunId) {
    const outcome = await ctx.step('await-runner', () =>
      awaitRunnerResult(adapter, store, {
        runId: runnerRunId,
        taskId,
        generation,
        pollSec: p.runnerPollSec ?? 1,
        timeoutSec: p.runnerTimeoutSec ?? 120,
      }),
    );
    if (!outcome.ok) {
      if (outcome.reason === 'connection_lost') return { ok: false, reason: 'connection_lost' };
      if (outcome.reason === 'runner_unavailable') return { ok: false, reason: 'runner_unavailable' };
      return { ok: false, reason: outcome.reason };
    }
    const runnerResult = outcome.result;
    const answer = answerText(waited.answer);
    const ok = runnerResult.outcome === 'succeeded';
    const result = {
      answer,
      ok,
      version: PLAN_VERSION,
      runId: runnerResult.runId,
      ownerGeneration: runnerResult.ownerGeneration,
      attempt: 1,
      artifacts: runnerResult.outputRefs,
      persistence: runnerResult.persistence,
      exitReason: runnerResult.exitReason,
    };
    await ctx.step('finalize', () =>
      store.commit(taskId, generation, {
        status: ok ? 'done' : 'failed',
        stage: ok ? 'finished' : undefined,
        step: 'finalize',
        result,
        payload: { runId: runnerResult.runId, persistence: runnerResult.persistence, eventsRecorded: outcome.eventsRecorded },
      }),
    );
    if (p.runId) await store.finishRun(p.runId, ok ? 'success' : 'failed', { result });
    return { ok, answer };
  }

  return finishAfterAnswer(ctx, store, p, waited.answer);
}

export { isWaitTimeout };
