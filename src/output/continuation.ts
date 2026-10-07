/**
 * Output — единственный владелец продолжения fast path (P17; §2 шаг 4, §11.2 шаг 6).
 *
 * Роутер только ПРЕДЛАГАЕТ продолжение: `needs_executor` — нормальный результат
 * маршрутизации, а не запуск. Решение о следующей работе принимает ровно один
 * владелец, и для работы без контроля это Output (`continuationOwner='output'`,
 * как у обычной задачи в плане). Управляемая работа (gtdId) — исключение: там
 * владелец продолжения GTD, и этот владелец отказывается создавать второй
 * поток решений.
 *
 * Продолжение — явное и идемпотентное: тот же `userTaskId`, НОВЫЕ `jobRef` и
 * `runId`, подъём поколения, ключ идемпотентности — `decisionId`. Повторный
 * запрос с тем же decisionId не создаёт вторую работу.
 *
 * Исполнитель назначается здесь и только здесь: `TERMINAL_EXECUTOR` (OpenCode).
 * Модель исполнителя не выбирает (поля `executor` нет в контракте решения), а
 * автоматической цепочки OpenCode → Claude Code/Codex нет (§ policy 30.09,
 * AC-243).
 */
import { TERMINAL_EXECUTOR, type ReasonCode } from '../router/router-types';
import type { AgentWorkOrder } from '../router/handlers';
import type { TaskStore } from '../taskstore';
import type { ExecutionContextManifest } from '../router/brief/execution-context';

/** Владелец продолжения работы без контроля: Output (§5a/§11). */
export const FAST_PATH_CONTINUATION_OWNER = 'output' as const;

export interface FastPathContinuationRequest {
  /** Ключ идемпотентности: решение маршрута, по которому выдано продолжение. */
  decisionId: string;
  userTaskId: string;
  profileId: string;
  conversationId: string | null;
  /** Ссылка на неизменённый исходный запрос, а не на переформулированную цель. */
  originalRequestRef: string;
  goal: string;
  /** Ограничения из исходного текста: reformulation их не отбрасывает (§11.3). */
  preservedConstraints: string[];
  /** Capability IDs, явно выбранные первым Router-вызовом. */
  selectedCapabilityIds: string[];
  requiredCapabilities: string[];
  reasonCode: ReasonCode;
  /** Частичный результат host-обработчика: агент его не повторяет. */
  partialResultRef: string | null;
  authorizationRef: string;
  requiresConfirmation: boolean;
  workOrder: AgentWorkOrder;
  /** Host-built task instructions плюс безопасный manifest для аудита. */
  executionContext: { instructions: string; manifest: ExecutionContextManifest };
}

export type ContinuationRefusal =
  | { reason: 'already_continued'; jobRef: string; runId: string; generation: number }
  | { reason: 'gtd_owns_continuation' }
  | { reason: 'agent_not_allowed_by_policy' }
  | { reason: 'task_terminal' }
  | { reason: 'task_missing' }
  | { reason: 'executor_not_terminal' }
  | { reason: 'execution_context_missing' };

export type ContinuationOutcome =
  | {
      owner: typeof FAST_PATH_CONTINUATION_OWNER;
      created: true;
      userTaskId: string;
      jobRef: string;
      runId: string;
      generation: number;
      executor: typeof TERMINAL_EXECUTOR;
    }
  | { owner: typeof FAST_PATH_CONTINUATION_OWNER; created: false; refusal: ContinuationRefusal };

/** Порт продолжения: новый runId, тот же userTaskId, подъём поколения. */
export interface ContinuationPort {
  resume(
    taskId: string,
    opts: { reason: string; instructions?: string; executionContext?: ExecutionContextManifest; engine?: string | null; previousRunId?: string | null },
  ): Promise<{ runId: string; generation: number }>;
}

/** Хранилище продолжения: статус задачи, владелец контроля, идемпотентность. */
export interface ContinuationStore {
  taskOf(userTaskId: string): Promise<{ status: string; generation: number } | null>;
  gtdIdOf(userTaskId: string): Promise<string | null>;
  continuationOf(
    userTaskId: string,
    decisionId: string,
  ): Promise<{ jobRef: string; runId: string; generation: number } | null>;
  recordContinuation(params: {
    userTaskId: string;
    decisionId: string;
    jobRef: string;
    runId: string;
    generation: number;
    executor: typeof TERMINAL_EXECUTOR;
    reasonCode: ReasonCode;
    owner: typeof FAST_PATH_CONTINUATION_OWNER;
  }): Promise<void>;
}

export interface ContinuationDeps {
  port: ContinuationPort;
  store: ContinuationStore;
  /** Разрешён ли исполнитель политикой для этого principal (снимок, не текст). */
  agentAllowed: boolean;
}

export const CONTINUATION_EVENT = 'route.continued';

/**
 * Выдать продолжение. Возвращает исход, а не бросает исключение: отказ
 * продолжить — тоже корректный результат (задача терминальна, владелец
 * продолжения другой, исполнитель запрещён политикой).
 */
export async function continueFastPathEscalation(
  request: FastPathContinuationRequest,
  deps: ContinuationDeps,
): Promise<ContinuationOutcome> {
  // Исполнитель — только терминальный. Проверка здесь — последний рубеж: даже
  // если вызывающий подставит другое значение, продолжение не будет выдано.
  if (request.workOrder.executor !== TERMINAL_EXECUTOR) {
    return { owner: FAST_PATH_CONTINUATION_OWNER, created: false, refusal: { reason: 'executor_not_terminal' } };
  }
  if (!request.executionContext?.instructions || request.executionContext.manifest.decisionId !== request.decisionId) {
    return { owner: FAST_PATH_CONTINUATION_OWNER, created: false, refusal: { reason: 'execution_context_missing' } };
  }

  // Идемпотентность: тот же decisionId — та же работа. Второй job/run не создаётся.
  const existing = await deps.store.continuationOf(request.userTaskId, request.decisionId);
  if (existing) {
    return { owner: FAST_PATH_CONTINUATION_OWNER, created: false, refusal: { reason: 'already_continued', ...existing } };
  }

  // Управляемая работа: продолжение выдаёт только GTD. Второго владельца нет.
  const gtdId = await deps.store.gtdIdOf(request.userTaskId);
  if (gtdId) {
    return { owner: FAST_PATH_CONTINUATION_OWNER, created: false, refusal: { reason: 'gtd_owns_continuation' } };
  }

  const task = await deps.store.taskOf(request.userTaskId);
  if (!task) return { owner: FAST_PATH_CONTINUATION_OWNER, created: false, refusal: { reason: 'task_missing' } };
  if (isTerminal(task.status)) {
    return { owner: FAST_PATH_CONTINUATION_OWNER, created: false, refusal: { reason: 'task_terminal' } };
  }
  if (!deps.agentAllowed) {
    return { owner: FAST_PATH_CONTINUATION_OWNER, created: false, refusal: { reason: 'agent_not_allowed_by_policy' } };
  }

  const { runId, generation } = await deps.port.resume(request.userTaskId, {
    reason: `fast_path_escalation:${request.reasonCode}`,
    instructions: request.executionContext.instructions,
    executionContext: request.executionContext.manifest,
    engine: TERMINAL_EXECUTOR,
    previousRunId: null,
  });
  const jobRef = `job_${request.userTaskId}_g${generation}`;
  await deps.store.recordContinuation({
    userTaskId: request.userTaskId,
    decisionId: request.decisionId,
    jobRef,
    runId,
    generation,
    executor: TERMINAL_EXECUTOR,
    reasonCode: request.reasonCode,
    owner: FAST_PATH_CONTINUATION_OWNER,
  });
  return {
    owner: FAST_PATH_CONTINUATION_OWNER,
    created: true,
    userTaskId: request.userTaskId,
    jobRef,
    runId,
    generation,
    executor: TERMINAL_EXECUTOR,
  };
}

function isTerminal(status: string): boolean {
  return ['done', 'failed', 'cancelled'].includes(status);
}

/** Продолжение через существующий Workflow Port: новый runId, тот же userTaskId. */
export function portContinuationPort(port: {
  resume(
    taskId: string,
    opts: { reason?: string; instructions?: string; executionContext?: ExecutionContextManifest; engine?: string | null; previousRunId?: string | null },
  ): Promise<{ runId: string; generation: number }>;
}): ContinuationPort {
  return {
    resume: (taskId, opts) =>
      port.resume(taskId, {
        reason: opts.reason ?? 'fast_path_escalation',
        instructions: opts.instructions,
        executionContext: opts.executionContext,
        engine: opts.engine ?? null,
        previousRunId: opts.previousRunId ?? null,
      }),
  };
}

const CONTINUATION_KIND = 'continuation.created';

/** Хранилище продолжения поверх Task Store: статус, gtdId и ключ идемпотентности. */
export function taskStoreContinuationStore(store: TaskStore): ContinuationStore {
  return {
    async taskOf(userTaskId) {
      const task = await store.getTask(userTaskId);
      return task ? { status: task.status, generation: task.generation } : null;
    },
    async gtdIdOf(userTaskId) {
      const task = await store.getTask(userTaskId);
      if (!task?.user_value) return null;
      try {
        const parsed = JSON.parse(task.user_value) as { gtdId?: string | null };
        return parsed.gtdId ?? null;
      } catch {
        return null;
      }
    },
    async continuationOf(userTaskId, decisionId) {
      const rows = await store.continuationEvents(userTaskId);
      for (const row of rows) {
        if (row.decisionId === decisionId) {
          return { jobRef: row.jobRef, runId: row.runId, generation: row.generation };
        }
      }
      return null;
    },
    async recordContinuation(params) {
      await store.logEvent({
        taskId: params.userTaskId,
        kind: CONTINUATION_KIND,
        source: 'output',
        payload: {
          decisionId: params.decisionId,
          jobRef: params.jobRef,
          runId: params.runId,
          generation: params.generation,
          executor: params.executor,
          reasonCode: params.reasonCode,
          owner: params.owner,
        },
      });
    },
  };
}

export { CONTINUATION_KIND };
