// StepCtx — единственное, что видит код плана: шаги, сон, ожидание события.
// Cloudflare-специфика остаётся здесь (ARCHITECTURE §4.2 — Workflow Port).
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { FencedError, TerminalStateError } from '../taskstore';

export interface StepAttempt {
  /** 1 на первой попытке, 2+ при повторах платформы. */
  attempt?: number;
}

export interface StepCtx {
  step<T>(
    name: string,
    fn: (attempt?: StepAttempt) => Promise<T>,
    retry?: { limit: number; delaySec: number; timeoutSec?: number },
  ): Promise<T>;
  sleep(name: string, seconds: number): Promise<void>;
  waitFor<T = unknown>(name: string, eventType: string, timeoutSec: number): Promise<T>;
}

const isPermanentStoreError = (e: unknown): boolean =>
  e instanceof FencedError || e instanceof TerminalStateError;

/**
 * Адаптер над WorkflowStep. Ошибки, которые повтор не исправит (fencing,
 * терминальный статус), превращаются в NonRetryableError сразу внутри шага —
 * движок не тратит попытки на заведомо безнадёжный повтор.
 */
export function cfStepCtx(step: WorkflowStep): StepCtx {
  const doStep = <T,>(
    name: string,
    fn: (attempt?: StepAttempt) => Promise<T>,
    retry: { limit: number; delaySec: number; timeoutSec?: number } = { limit: 2, delaySec: 1 },
  ): Promise<T> =>
    step.do(
      name,
      { retries: { limit: retry.limit, delay: `${retry.delaySec} seconds`, backoff: 'constant' },
        ...(retry.timeoutSec === undefined ? {} : { timeout: `${retry.timeoutSec} seconds` as `${number} seconds` }) },
      (async (context: unknown) => {
        try {
          return await fn(context as StepAttempt);
        } catch (e) {
          if (isPermanentStoreError(e)) throw new NonRetryableError(String((e as Error).message));
          throw e;
        }
      }) as never,
      // Результат шага — данные Task Store, уже сериализуемые (JSON-строки).
    ) as unknown as Promise<T>;

  return {
    step: doStep,
    sleep: (name, seconds) => step.sleep(name, `${seconds} seconds`),
    waitFor: async (name, eventType, timeoutSec) => {
      const event = await step.waitForEvent(name, { type: eventType, timeout: `${timeoutSec} seconds` });
      return event.payload as never;
    },
  };
}

export function isWaitTimeout(e: unknown): boolean {
  return /timeout|timed out/i.test(String((e as Error)?.message ?? e));
}
