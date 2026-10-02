// Workflow Port (ARCHITECTURE §4.2) поверх Cloudflare Workflows + D1.
// Контрольная сторона: submit / signal / cancel / status / recover.
// Исполнительная сторона (step/sleep/waitFor) — step-ctx.ts; код плана не видит
// API движка. Логика перенесена из пилота pilots/p-db/cf-workflows/src/port.ts.
import type { AdmitTaskInput, SignalSource, TaskStore } from '../taskstore';
import type { PlanParams } from './conversation-plan';

export interface SubmitInput extends AdmitTaskInput {
  question?: string;
  waitTimeoutSec?: number;
  crashRunOnce?: boolean;
}

export interface SubmitResult {
  taskId: string;
  instanceId: string;
  /** false = задача уже была принята (повтор submit = один запуск). */
  created: boolean;
  instanceCreated: boolean;
  generation: number;
}

export interface SignalResult {
  /** false: сигнал отклонён портом по статусу либо не доставлен движку. */
  delivered: boolean;
  signalId: number;
  /** true = повторная доставка того же ключа идемпотентности. */
  duplicate: boolean;
  reason?: string;
}

export interface CancelResult {
  cancelled: boolean;
  generation?: number;
  status?: string;
}

export interface PortStatusResult {
  taskStore: Awaited<ReturnType<TaskStore['statusRow']>>;
  engine: unknown;
}

export interface WorkflowPortApi {
  submit(input: SubmitInput): Promise<SubmitResult>;
  signal(
    taskId: string,
    eventType: string,
    payload: unknown,
    opts?: { idempotencyKey?: string; source?: SignalSource },
  ): Promise<SignalResult>;
  cancel(taskId: string, opts?: { reason?: string }): Promise<CancelResult>;
  status(taskId: string): Promise<PortStatusResult>;
}

export class CfWorkflowPort implements WorkflowPortApi {
  constructor(
    private readonly wf: Workflow,
    private readonly store: TaskStore,
  ) {}

  /**
   * Идемпотентный запуск: строка задачи создаётся с ON CONFLICT DO NOTHING,
   * экземпляр — по id задачи. Повтор submit возвращает тот же экземпляр и
   * created=false: второй запуск плана невозможен.
   * Ответ возвращается сразу после постановки в очередь (ранний ответ) —
   * план дальше живёт асинхронно.
   */
  async submit(input: SubmitInput): Promise<SubmitResult> {
    const { created, task } = await this.store.admitTask(input);
    const params: PlanParams = {
      taskId: task.id,
      generation: task.generation,
      profileId: input.profileId,
      question: input.question,
      waitTimeoutSec: input.waitTimeoutSec,
      crashRunOnce: input.crashRunOnce,
    };

    // Единственная гарантия «один запуск» — состояние в Task Store, а не
    // поведение create на разных платформах (в miniflare create с существующим
    // id не бросает ошибку, в проде бросает). Экземпляр создаётся один раз:
    // либо при первом приёме задачи, либо при восстановлении обрыва приёма
    // (строка задачи есть, run_started ещё не записан).
    let instanceCreated = false;
    if (created || !(await this.store.hasEvent(task.id, 'run_started'))) {
      try {
        await this.wf.create({ id: task.id, params });
        instanceCreated = true;
      } catch (e) {
        // Экземпляр уже существует (гонка или повтор) — берём прежний.
        try {
          await this.wf.get(task.id);
        } catch {
          throw e;
        }
      }
      if (!(await this.store.hasEvent(task.id, 'run_started'))) {
        await this.store.logEvent({
          taskId: task.id,
          kind: 'run_started',
          generation: task.generation,
          source: 'gateway',
          payload: { instanceId: task.id, created },
        });
      }
    }

    return { taskId: task.id, instanceId: task.id, created, instanceCreated, generation: task.generation };
  }

  /**
   * Доставить сигнал ожидающему экземпляру.
   * Дедуп — в task_signals (UNIQUE userTaskId/step/ключ): дубль не создаёт
   * вторую строку, но движку событие уходит повторно — безвредно, waitForEvent
   * берёт первое. Сигнал в терминальную задачу отклоняется Портом по статусу
   * (§5.3): строка сохраняется с rejected_reason, экземпляр не будится.
   */
  async signal(
    taskId: string,
    eventType: string,
    payload: unknown,
    opts: { idempotencyKey?: string; source?: SignalSource } = {},
  ): Promise<SignalResult> {
    const source = opts.source ?? 'web';
    const idempotencyKey = opts.idempotencyKey ?? `${source}:${crypto.randomUUID()}`;
    const { inserted, signal } = await this.store.recordSignal({
      taskId,
      idempotencyKey,
      eventType,
      payload,
      source,
    });

    if (signal.rejected_reason) {
      return { delivered: false, signalId: signal.id, duplicate: !inserted, reason: signal.rejected_reason };
    }

    try {
      const instance = await this.wf.get(taskId);
      await instance.sendEvent({ type: eventType, payload });
      return { delivered: true, signalId: signal.id, duplicate: !inserted };
    } catch (e) {
      return {
        delivered: false,
        signalId: signal.id,
        duplicate: !inserted,
        reason: `engine: ${String((e as Error)?.message ?? e)}`,
      };
    }
  }

  /** Отмена (INV-08): сначала Task Store (fencing), потом остановка движка. */
  async cancel(taskId: string, opts: { reason?: string } = {}): Promise<CancelResult> {
    const res = await this.store.cancel(taskId, { reason: opts.reason });
    if (res.cancelled) {
      try {
        const instance = await this.wf.get(taskId);
        await instance.terminate();
      } catch (e) {
        // Статус уже cancelled в Task Store — источник истины; остановка
        // движка лучшего усилия.
        await this.store.logEvent({
          taskId,
          kind: 'error',
          source: 'gateway',
          payload: { where: 'cancel.terminate', message: String((e as Error)?.message ?? e) },
        });
      }
    }
    return { cancelled: res.cancelled, generation: res.generation, status: res.status };
  }

  async status(taskId: string): Promise<PortStatusResult> {
    const taskStore = await this.store.statusRow(taskId);
    let engine: unknown = null;
    try {
      engine = await (await this.wf.get(taskId)).status();
    } catch (e) {
      engine = { error: String((e as Error)?.message ?? e) };
    }
    return { taskStore, engine };
  }

  /**
   * LOCAL-EMULATOR WORKAROUND (взят из пилота): движок miniflare держит таймеры
   * в памяти и не перезапускает убитый экземпляр сам; пробуждение даёт
   * no-op событие __wake для каждой незавершённой задачи. На Cloudflare
   * перезапуск прерванных экземпляров делает платформа.
   */
  async recover(): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const t of await this.store.unfinishedTasks()) {
      try {
        const instance = await this.wf.get(t.id);
        const engineStatus = (await instance.status()).status;
        if (['running', 'waiting', 'queued'].includes(engineStatus)) {
          await instance.sendEvent({ type: '__wake', payload: null });
        }
        out.push({ id: t.id, engineStatus });
      } catch (e) {
        out.push({ id: t.id, error: String((e as Error)?.message ?? e) });
      }
    }
    return out;
  }
}
