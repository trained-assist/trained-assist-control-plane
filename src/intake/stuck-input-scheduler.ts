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
import { classifyWait, enqueueStuckInputNotification, needsOperatorAlert, type StuckInputNotifier } from './stuck-input-watchdog';

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
    // Классификация одна и та же для детектора, уведомления и алерта: нормальное
    // ожидание (медиа, полоса) не алертится, настоящее зависание и сбой — да.
    const wait = classifyWait({ task: entry.task, pendingInput: entry.pendingInput });
    const ctx = entry.task
      ? { task: entry.task, pendingInput: null, ageMs, deadlineAt: entry.task.start_deadline_at!, wait }
      : { task: null, pendingInput: pending, ageMs, deadlineAt: pending!.deadline_at!, wait };
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
    // Операторский алерт: ОДИН на инцидент, и только для записей, которые
    // действительно требуют внимания. Нормальное ожидание (сбор медиа, очередь
    // за полосой) НЕ попадает в таблицу инцидентов: иначе «инцидент» перестаёт
    // значить инцидент. Для алертуемых каждое обнаружение увеличивает count
    // (инцидент виден как накопленный), сам алерт уходит только на первом.
    if (!needsOperatorAlert(wait, ageMs)) continue;
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
        waitKind: wait.kind,
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
 * Разрешение адаптера канала (arch#132 П3b).
 *
 * 'gateway' — РЕАЛЬНЫЙ адаптер: control plane отдаёт доставку шлюзу, который
 * умеет говорить с каналом (Telegram Bot API) и умеет отрисовать кнопку запуска.
 * 'local' (по умолчанию) — песочничная заглушка: возвращает искусственный
 * providerMessageId и доставкой НЕ является.
 *
 * Если заявлен реальный адаптер, но не заданы его реквизиты — это ошибка
 * настройки, и мы НЕ откатываемся молча к заглушке: тихая подмена означала бы,
 * что доставка «успешна», а пользователь ничего не получил.
 */
export async function resolveDeliveryAdapter(env: {
  DELIVERY_ADAPTER?: string | null;
  GATEWAY_DELIVERY_URL?: string | null;
  GATEWAY_DELIVERY_SECRET?: string | null;
}): Promise<DeliveryAdapter> {
  const mode = env.DELIVERY_ADAPTER ?? 'local';
  if (mode === 'gateway') {
    if (!env.GATEWAY_DELIVERY_URL) {
      throw new Error('DELIVERY_ADAPTER=gateway требует GATEWAY_DELIVERY_URL (тихая подмена заглушкой запрещена)');
    }
    return gatewayDeliveryAdapter({
      baseUrl: env.GATEWAY_DELIVERY_URL,
      secret: env.GATEWAY_DELIVERY_SECRET ?? null,
    });
  }
  return localDeliveryAdapter();
}

/** Заглушка песочницы: искусственный providerMessageId, доставкой не является. */
export function localDeliveryAdapter(): DeliveryAdapter {
  return {
    send: async (delivery) => ({ providerMessageId: `local-${delivery.channel}-${delivery.id.slice(0, 8)}` }),
  };
}

/**
 * Реальный адаптер: control plane отдаёт доставку шлюзу канала.
 *
 * Канал, рендер кнопки и обработчик запуска принадлежат шлюзу (границы
 * архитектуры), control plane владеет только outbox. Шлюз возвращает
 * providerMessageId — только тогда доставка считается подтверждённой.
 */
export function gatewayDeliveryAdapter(opts: { baseUrl: string; secret: string | null }): DeliveryAdapter {
  return {
    send: async (delivery) => {
      const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/deliver`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(opts.secret ? { Authorization: `Bearer ${opts.secret}` } : {}),
        },
        body: JSON.stringify({
          deliveryId: delivery.id,
          userTaskId: delivery.user_task_id,
          channel: delivery.channel,
          destinationId: delivery.destination_id,
          audienceId: delivery.audience_id,
          conversationId: delivery.conversation_id,
          message: JSON.parse(delivery.message_json || '{}'),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        // Хост и ответ — иначе в логе только «404», и непонятно, куда ходили:
        // именно так выглядел диагностический тупик при первой приёмке (2026-10-04).
        const snippet = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`gateway delivery failed: ${res.status} ${new URL(opts.baseUrl).host}/deliver — ${snippet || res.statusText}`);
      }
      const body = (await res.json().catch(() => ({}))) as { providerMessageId?: string | null };
      // Без providerMessageId доставка не подтверждена: доставка — это факт
      // принятия каналом, а не «ответ 200».
      if (!body.providerMessageId) throw new Error('gateway delivery not confirmed (no providerMessageId)');
      return { providerMessageId: body.providerMessageId };
    },
  };
}
