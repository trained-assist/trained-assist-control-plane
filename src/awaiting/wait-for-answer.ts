/**
 * Ожидание ответа человека, устойчивое к смерти движка (эпик #109 шаг 5, гейт
 * #115: durable wait живёт в HOST/Task Store, а не в движке).
 *
 * Правила:
 *  1. Истина ответа — строка `awaiting_inputs` (status='answered' + answer_json),
 *     а НЕ событие движка. Событие — только подсказка «проснись».
 *  2. Поэтому движок после пробуждения ПЕРЕЧИТЫВАЕТ durable состояние (#116).
 *  3. Если движок умер во время ожидания, новая попытка читает тот же адрес
 *     ответа и находит уже сохранённый ответ — ожидание пережило смерть.
 *  4. TTL ожидания (deadline) задаётся отдельно от лимита попытки.
 *
 * Совместимость с прежним путём (M1.2): если ответ пришёл только событием
 * движка, он СРАЗУ сохраняется durable через answerAwaitingById — движок никогда
 * не остаётся единственным носителем ответа.
 */
import type { TaskStore } from '../taskstore';
import type { StepCtx } from '../workflow-port/step-ctx';
import { isWaitTimeout } from '../workflow-port/step-ctx';

export interface WaitForAnswerParams {
  store: TaskStore;
  ctx: StepCtx;
  taskId: string;
  awaitingInputId: string;
  /** Подсказка пробуждения; тип события движка. */
  eventType?: string;
  /** Период durable-опроса: сколько ждём событие движка, затем перечитываем БД. */
  pollSec?: number;
  /** TTL ожидания (по умолчанию — до дедлайна строки, максимум сутки). */
  timeoutSec?: number;
  step?: string | null;
  executionId?: string | null;
}

export interface WaitForAnswerResult {
  answer: unknown;
  /** Всегда 'durable': ответ прочитан из Task Store, а не из события. */
  source: 'durable';
  /** Сколько раз перечитали durable состояние. */
  durableReads: number;
  /** Сколько раз движок вернул подсказку-пробуждение. */
  wakeHints: number;
}

export async function waitForAnswer(params: WaitForAnswerParams): Promise<WaitForAnswerResult> {
  const { store, ctx, taskId, awaitingInputId } = params;
  const eventType = params.eventType ?? 'user_reply';
  const pollSec = Math.max(1, params.pollSec ?? 60);
  const timeoutSec = params.timeoutSec ?? 24 * 3600;

  const deadline = Date.now() + timeoutSec * 1000;
  let durableReads = 0;
  let wakeHints = 0;

  const readDurable = async (): Promise<unknown | undefined> => {
    durableReads += 1;
    const answer = await store.readAnswer(awaitingInputId);
    return answer === null ? undefined : answer.answer;
  };

  const returnAnswer = async (answer: unknown): Promise<WaitForAnswerResult> => ({
    answer,
    source: 'durable',
    durableReads,
    wakeHints,
  });

  for (;;) {
    // 1. Durable состояние — единственный источник истины.
    const durable = await readDurable();
    if (durable !== undefined) return returnAnswer(durable);

    if (Date.now() >= deadline) {
      // TTL ожидания истёк: вызывающий закрывает ожидание (expireAwaiting).
      return { answer: null, source: 'durable', durableReads, wakeHints };
    }

    // 2. Подсказка пробуждения от движка (не более чем на pollSec).
    const sliceSec = Math.max(1, Math.min(pollSec, Math.ceil((deadline - Date.now()) / 1000)));
    let hint: unknown = null;
    try {
      wakeHints += 1;
      hint = await ctx.waitFor<unknown>('wait', eventType, sliceSec);
    } catch (e) {
      if (!isWaitTimeout(e)) throw e;
      hint = null;
    }

    // 3. Реальное пробуждение (а не истёкший срез ожидания) попадает в журнал.
    if (hint !== null && hint !== undefined) {
      await store.logEvent({
        taskId,
        kind: 'step_woken',
        step: params.step ?? null,
        executionId: params.executionId ?? null,
        source: 'executor',
        payload: { awaitingInputId, eventType, wakeHints, durableReads },
      });
    }

    // 4. После пробуждения — снова durable чтение (сигнал не единственная копия).
    const afterWake = await readDurable();
    if (afterWake !== undefined) return returnAnswer(afterWake);

    if (hint !== null && hint !== undefined) {
      if (eventType === 'credential_ready') continue;
      // Ответ мог прийти канальным сигналом (его уже записал Port) — тогда
      // применяем именно его, не плодя вторую строку сигнала. Если сигнала не
      // было (ответ пришёл только событием движка) — сохраняем событие durable
      // немедленно, чтобы ответ не жил только в памяти движка.
      const channelSignal = await store.peekSignal(taskId, eventType);
      const answer = channelSignal ? JSON.parse(channelSignal.payload_json) : hint;
      const idempotencyKey = channelSignal
        ? channelSignal.idempotency_key
        : `wf-event:${awaitingInputId}:${stableKey(String(JSON.stringify(hint)))}`;
      const applied = await store.answerAwaitingById({
        awaitingInputId,
        idempotencyKey,
        answer,
        step: params.step ?? null,
      });
      return returnAnswer(applied.answer);
    }
  }
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16);
}
