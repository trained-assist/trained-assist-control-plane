/**
 * Детектор «принято, но не начато» (arch#132 R3/R4/R5/R6/R9).
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
 * Два окна, а не одно (arch#132 R9):
 *   • ДО admission — пакет принят шлюзом, задачи ещё нет (pending_inputs);
 *   • ПОСЛЕ admission — задача есть, Run ещё не стартовал (durable_tasks).
 * Первое окно детектор из durable_tasks не видит вовсе: задачи нет, строки нет.
 * Именно там вход мог потеряться молча, поэтому у него своя таблица и свой индекс.
 *
 * Прод-фикс того же класса в tg-bot: PR #346 (инвариант «непустой не-busy буфер
 * всегда имеет живой аларм»). Здесь — перенос инварианта на Task Store.
 */
import type { PendingInputRow, TaskRow, TaskStore } from '../taskstore';
import { logStructured } from '../logging/structured-log';

export interface StuckInputWatchdogOptions {
  /** Сколько записей вернуть за один проход (самые старые — первыми). */
  limit?: number;
  /**
   * Уведомление пользователю в чат. Внедряется вызывающим: канал доставки
   * знает хост (destination/audience), а не детектор. Если не задан — детектор
   * только пишет intake.stuck_input (наблюдение, без доставки).
   */
  notify?: StuckInputNotifier | null;
}

/**
 * Вид ожидания. Один и тот же факт «прошло start_deadline_at» означает разные
 * вещи, и пользователю нужны разные сообщения и разные действия (arch#132,
 * Приоритет 4): ждать сбор медиа, ждать полосу, повторить после сбоя или
 * нажать запуск — не одно и то же.
 */
export type WaitKind =
  /** Идёт сбор/подготовка вложений: ждать законно и долго. */
  | 'media_prep'
  /** Ввод ждёт свободную полосу/слот: это нормальная очередь. */
  | 'queued_for_lane'
  /** Ввод собран и готов, но не дошёл до admitTask — это дыра, а не ожидание. */
  | 'ready_not_admitted'
  /** Явный технический сбой на стороне системы. */
  | 'technical'
  /** Ничего не оправдывает: настоящее зависание. */
  | 'no_progress';

export interface WaitClassification {
  kind: WaitKind;
  reason: string;
  /** Текст пользователю; null — сообщать нечего. */
  userMessage: string | null;
  /** Допустимые действия в этом состоянии. */
  actions: Array<'launch' | 'retry' | 'wait'>;
  /**
   * Операторский алерт. Нормальное ожидание (сбор медиа, очередь за полосой)
   * НЕ алертится — иначе тревога перестаёт быть сигналом.
   */
  operatorAlert: boolean;
}

/**
 * Второй порог для нормального ожидания. Сбор медиа и очередь за полосой — это
 * норма, и алертить на каждом проходе нельзя. Но если «норма» длится получасами,
 * это уже эксплуатационная проблема (пропускная способность/медиа-пайплайн), и
 * она должна быть видна.
 */
export const HARD_WAIT_ALERT_MS = 30 * 60_000;

/** Нужно ли операторское тревогу по этой записи с учётом возраста. */
export function needsOperatorAlert(wait: WaitClassification, ageMs: number): boolean {
  return wait.operatorAlert || ageMs >= HARD_WAIT_ALERT_MS;
}

const WAIT_TABLE: Record<WaitKind, Omit<WaitClassification, 'kind' | 'reason'>> = {
  media_prep: {
    userMessage: '⏳ Собираю вложения — если это затянулось, пришлите их ещё раз.',
    actions: ['wait', 'retry'],
    operatorAlert: false,
  },
  queued_for_lane: {
    userMessage: '⏳ Жду свободную полосу — можно запустить вручную.',
    actions: ['wait', 'launch'],
    operatorAlert: false,
  },
  ready_not_admitted: {
    userMessage: '⏳ Ввод собран, но не запустился — нажми «▶️ Запустить проработку».',
    actions: ['launch'],
    operatorAlert: true,
  },
  technical: {
    userMessage: '⚠️ Не удалось подготовить ввод — запусти вручную или повтори.',
    actions: ['launch', 'retry'],
    operatorAlert: true,
  },
  no_progress: {
    userMessage: '⏳ Всё ещё жду запуска — нажми «▶️ Запустить проработку» или допиши контекст.',
    actions: ['launch'],
    operatorAlert: true,
  },
};

/**
 * Классификация ожидания по фактам записи — без догадок и без LLM.
 *
 * pending_inputs: prep_state прямо говорит, что происходит (сбор / подготовка /
 * готово / сбой). durable_tasks: stage 'queued' — это ожидание полосы, а
 * 'handing_off' и прочее — уже не оправдание.
 */
export function classifyWait(entry: {
  task: TaskRow | null;
  pendingInput: PendingInputRow | null;
}): WaitClassification {
  if (entry.pendingInput) {
    const prep = entry.pendingInput.prep_state;
    if (prep === 'collecting' || prep === 'preparing') {
      return { kind: 'media_prep', reason: `preparing_${prep}`, ...WAIT_TABLE.media_prep };
    }
    if (prep === 'failed') {
      return { kind: 'technical', reason: 'preparation_failed', ...WAIT_TABLE.technical };
    }
    // 'ready' без userTaskId — собрано, но не принято: настоящая дыра.
    return { kind: 'ready_not_admitted', reason: 'ready_but_not_admitted', ...WAIT_TABLE.ready_not_admitted };
  }
  const stage = entry.task?.stage ?? null;
  if (stage === 'queued') {
    return { kind: 'queued_for_lane', reason: 'queued_for_lane', ...WAIT_TABLE.queued_for_lane };
  }
  if (stage === 'collecting' || stage === 'preparing') {
    return { kind: 'media_prep', reason: `task_${stage}`, ...WAIT_TABLE.media_prep };
  }
  return { kind: 'no_progress', reason: `stage_${stage ?? 'null'}`, ...WAIT_TABLE.no_progress };
}

export interface StuckInputNotifyContext {
  /** Задача (null, если пакет ещё не дошёл до admitTask). */
  task: TaskRow | null;
  /** Пакет до admission (null, если задача уже создана). */
  pendingInput: PendingInputRow | null;
  /** Возраст просрочки, мс. */
  ageMs: number;
  /** Дедлайн, который прошёл. */
  deadlineAt: number;
  /** Что именно за ожидание: медиа, полоса, сбой или настоящее зависание. */
  wait: WaitClassification;
}

/** Возвращает true, если доставка реально поставлена в outbox. */
export type StuckInputNotifier = (ctx: StuckInputNotifyContext) => Promise<boolean>;

export interface StuckInputWatchdogResult {
  /** Сколько записей просканировано детектором (найдено просроченных). */
  stuck: number;
  /** Возраст самой старой просроченной записи, мс; null — таких нет. */
  oldestAgeMs: number | null;
  /** Задачи/пакеты, у которых дедлайн уже прошёл. */
  tasks: string[];
}

interface StuckEntry {
  id: string;
  deadline: number;
  ageMs: number;
  task: TaskRow | null;
  pendingInput: PendingInputRow | null;
}

/**
 * Один проход детектора. Идемпотентен по построению: ничего не меняет в задачах,
 * поэтому вызов по расписанию безопасен и не требует блокировок.
 *
 * Оба окна читаются в одном проходе и сливаются в один список, отсортированный по
 * возрасту: самый старый непродвинувшийся вход — первым, независимо от того, до или
 * после он прошёл admission.
 */
export async function runStuckInputWatchdog(
  store: TaskStore,
  opts: StuckInputWatchdogOptions = {},
  now: number = Date.now(),
): Promise<StuckInputWatchdogResult> {
  const limit = opts.limit ?? 50;
  const entries: StuckEntry[] = [];

  for (const task of await store.sweepStuckAccepted(now, limit)) {
    const deadline = task.start_deadline_at;
    if (typeof deadline !== 'number') continue;
    entries.push({ id: task.id, deadline, ageMs: now - deadline, task, pendingInput: null });
  }

  for (const pending of await store.sweepStuckPendingInputs(now, limit)) {
    if (typeof pending.deadline_at !== 'number') continue;
    entries.push({
      id: pending.batch_id,
      deadline: pending.deadline_at,
      ageMs: now - pending.deadline_at,
      task: null,
      pendingInput: pending,
    });
  }

  entries.sort((a, b) => b.ageMs - a.ageMs);

  let oldestAgeMs: number | null = null;
  for (const entry of entries) {
    if (oldestAgeMs === null || entry.ageMs > oldestAgeMs) oldestAgeMs = entry.ageMs;
    const wait = classifyWait(entry);
    if (entry.task) {
      logStructured({
        event: 'intake.stuck_input',
        // Нормальное ожидание (сбор медиа, очередь за полосой) — warn, не error:
        // error-уровень забьёт Watcher и превратит норму в тревогу.
        level: needsOperatorAlert(wait, entry.ageMs) ? 'error' : 'warn',
        profileId: entry.task.profile_id,
        userTaskId: entry.task.id,
        reason: wait.reason,
        waitKind: wait.kind,
        stage: entry.task.stage,
        startDeadlineAt: entry.deadline,
        ageMs: entry.ageMs,
      });
    } else if (entry.pendingInput) {
      logStructured({
        event: 'intake.stuck_input',
        level: needsOperatorAlert(wait, entry.ageMs) ? 'error' : 'warn',
        profileId: entry.pendingInput.profile_id,
        userTaskId: null,
        reason: wait.reason,
        waitKind: wait.kind,
        batchId: entry.pendingInput.batch_id,
        prepState: entry.pendingInput.prep_state,
        firstMessageAt: entry.pendingInput.first_message_at,
        deadlineAt: entry.deadline,
        ageMs: entry.ageMs,
      });
    }
    // Уведомление пользователю — забота вызывающего (он знает канал доставки).
    // Детектор не угадывает канал: неверный канал = доставка, которая не уйдёт.
    if (opts.notify) {
      try {
        await opts.notify({
          task: entry.task,
          pendingInput: entry.pendingInput,
          ageMs: entry.ageMs,
          deadlineAt: entry.deadline,
          wait,
        });
      } catch (e) {
        logStructured({
          event: 'intake.stuck_input_notify_failed',
          level: 'error',
          profileId: entry.task?.profile_id ?? entry.pendingInput?.profile_id ?? null,
          userTaskId: entry.task?.id ?? null,
          reason: 'notify_failed',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return { stuck: entries.length, oldestAgeMs, tasks: entries.map((e) => e.id) };
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
  ctx: { task: TaskRow | null; pendingInput: PendingInputRow | null; wait: WaitClassification },
  opts: { channel: string },
): Promise<boolean> {
  if (!ctx.task) {
    // Пакет ещё не стал задачей: доставка привязывается к задаче, которой нет.
    // Связь появится, когда задача будет создана (linkPendingInputToTask), и тогда
    // детектор увидит этот вход в окне ПОСЛЕ admission.
    logStructured({
      event: 'intake.stuck_input_notify_skipped',
      level: 'warn',
      profileId: ctx.pendingInput?.profile_id ?? null,
      userTaskId: null,
      reason: 'no_task_yet',
      batchId: ctx.pendingInput?.batch_id ?? null,
    });
    return false;
  }
  const task = ctx.task;
  const { queued } = await store.queueDelivery({
    taskId: task.id,
    logicalMessageId: `stuck_input:${task.id}`,
    channel: opts.channel,
    message: {
      kind: 'stuck_input',
      // Текст и действия — по виду ожидания: «собираю вложения» и «не удалось
      // подготовить» просят разного, а одно «нажми ▶️» для обоих бессмысленно.
      waitKind: ctx.wait.kind,
      text: ctx.wait.userMessage ?? WAIT_TABLE.no_progress.userMessage,
      actions: ctx.wait.actions,
    },
    destinationId: task.destination_id,
    audienceId: task.audience_id,
    conversationId: task.conversation_id,
  });
  // Report whether a NEW row appeared, not that we asked. The outbox is
  // idempotent per logical_message_id, so a repeat pass would otherwise count as
  // a fresh notification and make watchdog_health look busy on every tick.
  return queued;
}
