/**
 * Детектор «принято, но не начато» (arch#132 R3/R4/R5/R6).
 *
 * Зачем отдельный модуль, а не таймер внутри накопителя: единственные «часы»
 * накопителя — его собственный таймер. Сломанный или не взведённый таймер — это
 * ровно то, что произошло 2026-10-04 в tg-bot: голосовое принято, расшифровано,
 * а автозапуск не взвёлся, буфер остался без таймера и без кнопки, и чат молчал
 * ~7 минут, пока пользователь не нажал старую кнопку ▶️. Агент при этом был
 * здоров — зелёный health при зависшем входе остаётся возможным, если детектор
 * живёт там же, где и сломанный таймер.
 *
 * Поэтому детектор опрашивает Task Store извне (cron/Workflow) и считает возраст
 * самого старого принятого, но не начатого входа. Это НАБЛЮДЕНИЕ: у одного перехода
 * ровно один владелец, и следующий шаг решает не детектор — он только делает
 * тишину видимой (structured error event) и даёт оператору факт для алерта.
 *
 * Прод-фикс того же класса в tg-bot: PR #345 (инвариант «непустой не-busy буфер
 * всегда имеет живой аларм»). Здесь — перенос инварианта на Task Store.
 */
import type { TaskRow, TaskStore } from '../taskstore';
import { logStructured } from '../logging/structured-log';

export interface StuckInputWatchdogOptions {
  /** Сколько задач вернуть за один проход (самые старые — первыми). */
  limit?: number;
  /**
   * Уведомление пользователю в чат. Внедряется вызывающим: канал доставки
   * знает хост (destination/audience), а не детектор. Если не задан — детектор
   * только пишет intake.stuck_input (наблюдение, без доставки).
   */
  notify?: StuckInputNotifier | null;
}

export interface StuckInputNotifyContext {
  task: TaskRow;
  /** Возраст просрочки, мс (now - start_deadline_at). */
  ageMs: number;
  startDeadlineAt: number;
}

export type StuckInputNotifier = (ctx: StuckInputNotifyContext) => Promise<void>;

export interface StuckInputWatchdogResult {
  /** Сколько задач просканировано детектором (найдено просроченных). */
  stuck: number;
  /** Возраст самой старой просроченной задачи, мс; null — таких нет. */
  oldestAgeMs: number | null;
  /** Задачи, у которых дедлайн старта уже прошёл. */
  tasks: string[];
}

/**
 * Один проход детектора. Идемпотентен по построению: ничего не меняет в задачах,
 * поэтому вызов по расписанию безопасен и не требует блокировок.
 */
export async function runStuckInputWatchdog(
  store: TaskStore,
  opts: StuckInputWatchdogOptions = {},
  now: number = Date.now(),
): Promise<StuckInputWatchdogResult> {
  const limit = opts.limit ?? 50;
  const stuck = await store.sweepStuckAccepted(now, limit);

  let oldestAgeMs: number | null = null;
  for (const task of stuck) {
    const deadline = task.start_deadline_at;
    if (typeof deadline !== 'number') continue;
    const age = now - deadline;
    if (oldestAgeMs === null || age > oldestAgeMs) oldestAgeMs = age;
    logStructured({
      event: 'intake.stuck_input',
      level: 'error',
      profileId: task.profile_id,
      userTaskId: task.id,
      reason: 'accepted_but_not_started',
      stage: task.stage,
      startDeadlineAt: deadline,
      ageMs: age,
    });
    // Уведомление пользователю — забота вызывающего (он знает канал доставки).
    // Детектор не угадывает канал: неверный канал = доставка, которая не уйдёт.
    if (opts.notify) {
      try {
        await opts.notify({ task, ageMs: age, startDeadlineAt: deadline });
      } catch (e) {
        logStructured({
          event: 'intake.stuck_input_notify_failed',
          level: 'error',
          profileId: task.profile_id,
          userTaskId: task.id,
          reason: 'notify_failed',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return { stuck: stuck.length, oldestAgeMs, tasks: stuck.map((t) => t.id) };
}

/**
 * Постановка уведомления «принято, но не начато» в outbox доставки (C02).
 *
 * Идемпотентно по (user_task_id, logical_message_id): повторный проход детектора
 * по той же задаче не создаёт вторую доставку, поэтому зависший вход не спамит
 * чат на каждом цикле. Канал обязателен и приходит от вызывающего — доставка
 * должна уйти туда, откуда пришёл вход.
 */
export async function enqueueStuckInputNotification(
  store: TaskStore,
  task: TaskRow,
  opts: { channel: string },
): Promise<void> {
  await store.queueDelivery({
    taskId: task.id,
    logicalMessageId: `stuck_input:${task.id}`,
    channel: opts.channel,
    message: {
      kind: 'stuck_input',
      text: '⏳ Всё ещё жду запуска — нажми «▶️ Запустить проработку» или допиши контекст.',
      action: 'launch',
    },
    destinationId: task.destination_id,
    audienceId: task.audience_id,
    conversationId: task.conversation_id,
  });
}
