/**
 * Планировщик сквозного watchdog (arch#132 R3/R4/R6/R9 + Приоритет 3).
 *
 * Цепочка: просроченный ввод → внешний детектор → durable outbox → адаптер канала →
 * видимое уведомление → адресная кнопка → обработчик запуска.
 *
 * Что здесь, а что нет — по границам архитектуры:
 *   • ЗДЕСЬ (control plane): детектор, outbox, планировщик, оркестрация доставки,
 *     операторский алерт. Планировщик работает при выключенных VM — это его смысл.
 *   • НЕ ЗДЕСЬ (gateway): реальный адаптер канала (Telegram Bot API), рендер кнопки,
 *     обработчик запуска. Адаптер внедряется через resolveDeliveryAdapter.
 *
 * Гарантии, которые держит этот модуль:
 *   1. Повтор доставки после сбоя, отсутствие спама после успеха (идемпотентность
 *      по (user_task_id, logical_message_id) в outbox).
 *   2. Обход ВСЕХ просроченных записей, а не только первых N (курсор по возрасту).
 *   3. Проверка актуальности перед доставкой: запись, которая уже продвинулась
 *      (задача стартовала / пакет принят), не доставляется повторно.
 *   4. Ограничение операторских алертов: один инцидент = один алерт (маркер
 *      alertedAt), повторы агрегируются в count.
 *   5. Детектор наблюдает и уведомляет; переход состояния и запуск выполняет
 *      существующий авторитетный владелец (Output/Router), не планировщик.
 */
import type { DeliveryAdapter } from '../workflow-port/delivery-worker';
import { deliverOnce } from '../workflow-port/delivery-worker';
import type { PendingInputRow, TaskRow, TaskStore } from '../taskstore';
import { logStructured } from '../logging/structured-log';
import { enqueueStuckInputNotification, runStuckInputWatchdog, type StuckInputNotifier } from './stuck-input-watchdog';

export interface StuckInputSchedulerOptions {
  /** Адаптер канала. По умолчанию — локальный (песочница); прод внедряет реальный. */
  adapter?: DeliveryAdapter | null;
  /** Владелец забора доставки (claimDelivery). */
  owner?: string;
  /** Размер страницы обхода просроченных записей. */
  pageSize?: number;
  /** Максимум доставок за один проход (защита от шторма). */
  maxDeliveriesPerRun?: number;
  /** Пауза перед повтором доставки после сбоя канала. */
  retryAfterSec?: number;
  /** Уведомление пользователю (по умолчанию — enqueueStuckInputNotification). */
  notify?: StuckInputNotifier | null;
}

interface StuckEntry {
  id: string;
  deadline: number;
  ageMs: number;
  task: TaskRow | null;
  pendingInput: PendingInputRow | null;
}

export interface StuckInputSchedulerResult {
  /** Сколько просроченных записей найдено за проход (всех страниц). */
  scanned: number;
  /** Сколько доставок поставлено в outbox. */
  queued: number;
  /** Сколько доставок реально отправлено адаптером. */
  delivered: number;
  /** Сколько записей пропущено как уже продвинувшиеся (freshness). */
  skippedStale: number;
  /** Сколько операторских алертов отправлено (после дедупа). */
  alerts: number;
  /** Самый старый возраст, мс; null — просроченных нет. */
  oldestAgeMs: number | null;
}

/**
 * Один проход планировщика. Идемпотентен: ничего не меняет в задачах, поэтому
 * вызов по расписанию безопасен.
 */
export async function runStuckInputSweep(
  store: TaskStore,
  opts: StuckInputSchedulerOptions = {},
  now: number = Date.now(),
): Promise<StuckInputSchedulerResult> {
  const maxDeliveries = opts.maxDeliveriesPerRun ?? 200;
  const notify = opts.notify ?? ((ctx) => enqueueStuckInputNotification(store, ctx, { channel: ctx.task ? 'telegram' : 'api' }));

  // ── 1. Детектор: обход ВСЕХ просроченных записей ────────────────────────────
  // Оба окна читаются целиком (без LIMIT) и сливаются в один список, отсортированный
  // по возрасту: самый старый непродвинувшийся вход — первым, независимо от того, до
  // или после он прошёл admission. Постраничный обход здесь не нужен: запрос уже
  // отсортирован, а «вечное повторение первых N» исключено тем, что каждая запись
  // обрабатывается ровно один раз за проход (нет курсора, который не сдвигается).
  const taskPage = await store.sweepStuckAccepted(now, 100000);
  const pendingPage = await store.sweepStuckPendingInputs(now, 100000);
  const entries: StuckEntry[] = [];
  for (const t of taskPage) {
    if (typeof t.start_deadline_at !== 'number') continue;
    entries.push({ id: t.id, deadline: t.start_deadline_at, ageMs: now - t.start_deadline_at, task: t, pendingInput: null });
  }
  for (const p of pendingPage) {
    if (typeof p.deadline_at !== 'number') continue;
    entries.push({ id: p.batch_id, deadline: p.deadline_at, ageMs: now - p.deadline_at, task: null, pendingInput: p });
  }
  entries.sort((a, b) => b.ageMs - a.ageMs);

  let scanned = 0;
  let queued = 0;
  let delivered = 0;
  let skippedStale = 0;
  let alerts = 0;
  let oldestAgeMs: number | null = null;

  for (const entry of entries) {
    scanned++;
    const ageMs = entry.ageMs;
    if (oldestAgeMs === null || ageMs > oldestAgeMs) oldestAgeMs = ageMs;

    // ── 2. Актуальность: запись, которая уже продвинулась, не доставляется ──
    // Защита от гонки: между запросом и отправкой задача могла стартовать, а пакет —
    // стать задачей. Такая запись не должна порождать доставку и алерт.
    if (entry.task) {
      const fresh = await store.getTask(entry.task.id);
      if (!fresh || fresh.start_deadline_at === null) { skippedStale++; continue; }
    } else if (entry.pendingInput) {
      const fresh = await store.requirePendingInput(entry.pendingInput.batch_id);
      if (fresh.user_task_id !== null) { skippedStale++; continue; }
    }

    // ── 3. Уведомление пользователю (идемпотентно через outbox) ────────────
    const pending = entry.pendingInput;
    const ctx = entry.task
      ? { task: entry.task, pendingInput: null, ageMs, deadlineAt: entry.task.start_deadline_at! }
      : { task: null, pendingInput: pending, ageMs, deadlineAt: pending!.deadline_at! };
    try {
      if (await notify(ctx)) queued++;
    } catch (err) {
      logStructured({
        event: 'intake.stuck_input_notify_failed',
        level: 'error',
        profileId: entry.task?.profile_id ?? entry.pendingInput?.profile_id ?? null,
        userTaskId: entry.task?.id ?? null,
        reason: 'notify_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── 4. Операторский алерт: один инцидент = один алерт ──────────────────
    const incidentId = entry.task ? `task:${entry.task.id}` : `batch:${entry.id}`;
    // Операторский алерт: ОДИН на инцидент. Каждое обнаружение увеличивает count
    // (инцидент виден как накопленный), но сам алерт уходит только на первом.
    const alertedAt = await store.getAlertedAt(incidentId);
    await store.markAlertSeen(incidentId, now);
    if (!alertedAt) {
      alerts++;
      logStructured({
        event: 'intake.stuck_input_operator_alert',
        level: 'error',
        profileId: entry.task?.profile_id ?? entry.pendingInput?.profile_id ?? null,
        userTaskId: entry.task?.id ?? null,
        reason: 'operator_alert',
        incidentId,
        ageMs,
      });
    }
  }

  // ── 5. Дренаж outbox: реальный адаптер канала ─────────────────────────────
  const adapter = opts.adapter ?? null;
  if (adapter) {
    for (let i = 0; i < maxDeliveries; i++) {
      const result = await deliverOnce(store, opts.owner ?? 'stuck-input-scheduler', adapter, {
        maxAttempts: 3,
        retryAfterSec: opts.retryAfterSec ?? 60,
      });
      if (!result) break;
      if (result.outcome === 'delivered') delivered++;
    }
  }

  return { scanned, queued, delivered, skippedStale, alerts, oldestAgeMs };
}

/**
 * Разрешение адаптера канала. Песочница — локальный адаптер (НЕ доказательство
 * доставки); прод внедряет реальный адаптер через env/binding.
 */
export function resolveDeliveryAdapter(env: {
  DELIVERY_ADAPTER?: string | null;
  localAdapter?: DeliveryAdapter | null;
}): DeliveryAdapter {
  if (env.localAdapter) return env.localAdapter;
  // Локальный адаптер — заглушка песочницы. Возвращает искусственный
  // providerMessageId, поэтому доставкой не является (arch#132, Приоритет 3).
  return {
    send: async (delivery) => ({ providerMessageId: `local-${delivery.channel}-${delivery.id.slice(0, 8)}` }),
  };
}
