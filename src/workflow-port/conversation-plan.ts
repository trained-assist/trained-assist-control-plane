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
import type { GtdService } from '../gtd/gtd-service';
import type { ManagedGtdContext } from '../gtd/types';
import { isWaitTimeout, type StepCtx, type StepAttempt } from './step-ctx';

/** Маркер версии логики шагов: payload шагов фиксируют, каким кодом они шли (#92). */
export const PLAN_VERSION = 'm1-conversation-v2';

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
  /** Период durable-опроса ответа в ожидании: сколько ждём подсказку движка до перечитывания БД. */
  waitPollSec?: number;
  /**
   * Простая задача без уточнений (P22: occurrence расписания, обычный hourly
   * task). План не открывает ожидание человека и не входит в control loop:
   * работа + terminal result в Output. Уточнять нечего — спрашивать некого.
   */
  autoRun?: boolean;
  /**
   * Управляемая работа (P23): задача под контролем GTD. План исполняет шаг,
   * отчитывается структурированным исходом в GTD inbox и НЕ закрывает задачу:
   * продолжение выдаёт только GTD (один владелец продолжения). Ожидание
   * (input/condition) — durable строка, живой процесс не держится.
   */
  gtd?: ManagedGtdContext | null;
  /**
   * Свидетельство по критериям завершения ({criterionId: true}) — структурированный
   * факт результата шага. Проверяет его GTD детерминированно, без LLM-суждения.
   */
  criteria?: Record<string, unknown> | null;
  /** Ссылка на внешнее условие, если шаг ждёт гейт/CI (synthetic CI provider I07). */
  conditionRef?: string | null;
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
  /** GTD Manager (P23): отчёт об исходе шага и проверка записи контроля. */
  gtd?: GtdService | null;
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

/**
 * Управляемый шаг (P23): работа под контролем GTD.
 *
 * План не принимает решений о продолжении: он исполняет шаг, отчитывается
 * структурированным исходом в durable GTD inbox и завершает попытку. Дальше
 * решение (continue/wait/complete/stop) принимает только GTD — один владелец
 * продолжения. Ожидание человека — уже существующая durable строка
 * awaiting_inputs; попытка паркуется (status='waiting'), живой процесс и токены
 * не держатся.
 */
async function managedStep(ctx: StepCtx, store: TaskStore, p: PlanDeps, plan: PlanParams): Promise<PlanOutcome> {
  const managed = plan.gtd;
  const gtd = p.gtd;
  if (!managed) return { ok: false, reason: 'gtd_context_missing' };
  if (!gtd) return { ok: false, reason: 'gtd_service_missing' };
  const { gtdId, stepId, attempt, stepOutcome } = managed;
  const { taskId, generation } = plan;

  // Host-проверка: gtdId не выбирается произвольно, запись контроля ещё открыта.
  const record = await gtd.requireManagedTask(gtdId, taskId);

  await ctx.step('prepare', () =>
    store.commit(taskId, generation, {
      kind: 'step_done',
      step: 'prepare',
      payload: { managed: true, gtdId, stepId, attempt, version: PLAN_VERSION },
    }),
  );

  await ctx.step('execute', () =>
    store.commit(taskId, generation, {
      kind: 'step_done',
      step: 'execute',
      payload: { managed: true, gtdId, stepId, attempt, outcome: stepOutcome, version: PLAN_VERSION },
    }),
  );

  // Ожидание человека: durable строка awaiting_inputs с дедлайном контроля.
  // Истина ответа — в Task Store, движок только будит; сам план не ждёт.
  let awaitingInputId: string | null = null;
  if (stepOutcome === 'awaiting_user') {
    awaitingInputId = await ctx.step('open-awaiting', async () => {
      try {
        const opened = await store.openAwaiting({
          taskId,
          purpose: 'missing_fact',
          question: 'Нужен ваш ответ для продолжения контролируемой работы.',
          respondentScope: plan.profileId,
          step: 'wait',
          generation,
          deadlineAt: record.deadline_at,
          engineRefs: plan.runId ? { sessionRef: `run:${plan.runId}` } : null,
        });
        return opened.awaitingInputId;
      } catch (e) {
        if (e instanceof AlreadyOpenAwaitingError) return e.awaitingInputId;
        throw e;
      }
    });
  }

  const detail: Record<string, unknown> = {
    criteria: plan.criteria ?? null,
    checkpointRef: awaitingInputId ? `awaiting:${awaitingInputId}` : null,
  };
  if (stepOutcome === 'awaiting_user') detail.awaitingInputId = awaitingInputId;
  if (stepOutcome === 'awaiting_condition') detail.conditionRef = plan.conditionRef ?? null;

  // Output → GTD: структурированный исход сохраняется в durable inbox ДО решения
  // GTD. Ключ идемпотентности стабилен между попытками повтора шага.
  const reported = await ctx.step('report-outcome', async () => {
    const res = await gtd.reportOutcome({
      gtdId,
      userTaskId: taskId,
      runId: plan.runId ?? null,
      stepId,
      outcome: stepOutcome,
      detail,
      idempotencyKey: `gtd:${gtdId}:${stepId}:${attempt}`,
    });
    return res;
  });

  const result = {
    ok: stepOutcome === 'succeeded',
    gtdId,
    continuationOwner: 'gtd' as const,
    stepId,
    attempt,
    outcome: stepOutcome,
    inboxState: reported.state,
    version: PLAN_VERSION,
  };

  // Задачу закрывает только GTD (complete/stop). Здесь — промежуточное
  // состояние: работа ждёт решения контроля, попытка паркуется.
  const waiting = stepOutcome === 'awaiting_user' || stepOutcome === 'awaiting_condition';
  await ctx.step('park', () =>
    store.commit(taskId, generation, {
      kind: 'step_done',
      step: 'park',
      status: stepOutcome === 'awaiting_user' ? 'awaiting_input' : 'active',
      stage: stepOutcome === 'awaiting_user' ? 'waiting_input' : 'waiting_followup',
      result,
      payload: { managed: true, gtdId, stepId, attempt, outcome: stepOutcome, inboxState: reported.state, version: PLAN_VERSION },
    }),
  );

  if (plan.runId) {
    if (waiting) {
      await store.parkRun(plan.runId, {
        reason: stepOutcome === 'awaiting_user' ? 'awaiting_user_input' : 'awaiting_external_condition',
        checkpointRef: typeof detail.checkpointRef === 'string' ? detail.checkpointRef : null,
      });
    } else {
      await store.finishRun(plan.runId, stepOutcome === 'succeeded' ? 'success' : 'failed', { result });
    }
  }
  return { ok: stepOutcome === 'succeeded', reason: stepOutcome };
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

  // Управляемая работа (P23): ветка идёт ДО обычного хода и resume-ожидания —
  // у managed work ожидание принадлежит контролю (GTD выдаёт продолжение), а не
  // плану: план не ждёт человека и не закрывает задачу.
  if (p.gtd?.gtdId) return managedStep(ctx, store, deps, p);

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

  // Простая задача без уточнений (P22, обычный hourly task из расписания):
  // результат терминальный сразу, ожидание человека не открывается, запись
  // контроля (gtdId) не создаётся — control loop не начинается (AC-141).
  // Идентичность шагов та же, что у обычного хода (prepare -> finalize), чтобы
  // отчёт о шагах не расходился между видами задач.
  if (p.autoRun) {
    const result = {
      ok: true,
      mode: 'auto' as const,
      version: PLAN_VERSION,
      goal: p.goal ?? current?.goal ?? null,
      // Явный владелец продолжения: у работы без контроля это output (§5a/§11).
      continuationOwner: 'output' as const,
    };
    await ctx.step('execute', () =>
      store.commit(taskId, generation, {
        kind: 'step_done',
        status: 'active',
        stage: 'running',
        step: 'execute',
        payload: { mode: 'auto', version: PLAN_VERSION },
      }),
    );
    await ctx.step('finalize', () =>
      store.commit(taskId, generation, {
        status: 'done',
        stage: 'finished',
        step: 'finalize',
        result,
        payload: { mode: 'auto', version: PLAN_VERSION, gtdId: null, controlRegistration: 'not_requested' },
      }),
    );
    if (p.runId) await store.finishRun(p.runId, 'success', { result });
    return { ok: true, answer: null };
  }

  // Настоящий Runner (issue #122): попытка отправляется в Serverless Agent API
  // со СТАБИЛЬНЫМ ключом, вычисленным до отправки. Отправка — ШАГ с явным
  // повтором: недоступность Runner'а не теряет задачу (попытка -> unknown,
  // статус задачи не меняется), а повтор с тем же ключом возвращает тот же
  // Run, а не второй.
  let runnerRunId: string | null = null;
  if (adapter) {
    const attemptKey = await stableAttemptKey(taskId, generation);
    const receipt = await ctx.step(
      'submit-runner',
      async () => {
        try {
          return await adapter.submit({
            userTaskId: taskId,
            conversationId: current?.conversation_id ?? null,
            engineName: p.runnerEngine ?? 'opencode',
            inputText: p.goal ?? current?.goal ?? null,
            inputRefs: [],
            instructions: p.instructions ?? null,
            idempotencyKey: attemptKey,
            timeoutMs: (p.runnerTimeoutSec ?? 120) * 1000,
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
          }
          throw e;
        }
      },
      { limit: 8, delaySec: 3 },
    );
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
      artifacts: outcome.artifacts,
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
