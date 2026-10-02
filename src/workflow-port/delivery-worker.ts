/**
 * Воркер доставки — единственный владелец отправки (C02: «Delivery adapter
 * подтверждает принятие события»; outbox принадлежит control plane).
 *
 * Адаптер канала внедряется: в песочнице это локальная заглушка, настоящий
 * Telegram/Web-канал подключается в карточке доставки M1.4+. Ключевые свойства,
 * которые держит воркер:
 *  - одна доставка забирается одним владельцем (claimDelivery атомарен);
 *  - retry доставки НЕ перезапускает исполнение: трогается только строка
 *    deliveries, задача/попытки/шаги не меняются;
 *  - повтор того же logicalMessageId не создаёт вторую доставку.
 */
import type { DeliveryRow, TaskStore } from '../taskstore';
import { logStructured } from '../logging/structured-log';

export interface DeliveryAdapter {
  /** Отправка сообщения каналу; бросок = попытка не удалась. */
  send(delivery: DeliveryRow): Promise<{ providerMessageId?: string | null }>;
}

export interface DeliverOnceOptions {
  channel?: string | null;
  /** Ограничить забор задачей (в prod — общий FIFO outbox). */
  taskId?: string | null;
  maxAttempts?: number;
  retryAfterSec?: number;
  leaseSec?: number;
}

export interface DeliverOnceResult {
  deliveryId: string;
  taskId: string;
  outcome: 'delivered' | 'retry_scheduled' | 'failed';
  attempt: number;
  providerMessageId?: string | null;
  error?: string;
}

export async function deliverOnce(
  store: TaskStore,
  owner: string,
  adapter: DeliveryAdapter,
  opts: DeliverOnceOptions = {},
): Promise<DeliverOnceResult | null> {
  const claimed = await store.claimDelivery(owner, {
    channel: opts.channel ?? null,
    taskId: opts.taskId ?? null,
    leaseSec: opts.leaseSec,
  });
  if (!claimed) return null;

  const task = await store.requireTask(claimed.user_task_id);
  try {
    const result = await adapter.send(claimed);
    await store.confirmDelivery(claimed.id, { providerMessageId: result?.providerMessageId ?? null });
    logStructured({
      event: 'delivery.delivered',
      profileId: task.profile_id,
      userTaskId: claimed.user_task_id,
      requestId: task.request_id,
      reason: 'provider_accepted',
      deliveryId: claimed.id,
      channel: claimed.channel,
      attempt: claimed.attempt,
      providerMessageId: result?.providerMessageId ?? null,
    });
    return {
      deliveryId: claimed.id,
      taskId: claimed.user_task_id,
      outcome: 'delivered',
      attempt: claimed.attempt,
      providerMessageId: result?.providerMessageId ?? null,
    };
  } catch (e) {
    const error = String((e as Error)?.message ?? e);
    const failed = await store.failDelivery(claimed.id, {
      error,
      retryAfterSec: opts.retryAfterSec,
      maxAttempts: opts.maxAttempts,
    });
    const outcome = failed.status === 'failed' ? 'failed' : 'retry_scheduled';
    logStructured({
      event: 'delivery.failed',
      level: 'warn',
      profileId: task.profile_id,
      userTaskId: claimed.user_task_id,
      requestId: task.request_id,
      reason: error,
      deliveryId: claimed.id,
      channel: claimed.channel,
      attempt: failed.attempt,
      exhausted: failed.status === 'failed',
      nextAttemptAt: failed.next_attempt_at,
    });
    return { deliveryId: claimed.id, taskId: claimed.user_task_id, outcome, attempt: failed.attempt, error };
  }
}
