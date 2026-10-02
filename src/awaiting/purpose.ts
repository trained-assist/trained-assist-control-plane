/**
 * Маппинг «зачем спрашиваем» ↔ «какой формы ответ» (эпик #109 шаг 5).
 *
 * kind остаётся лексикой A2 §5.4 (data/choice/approval) — форма ответа.
 * purpose — новая закрытая лексика «зачем», из которой kind выводится, чтобы
 * не заводить второй набор терминов. Обратный маппинг (kind -> purpose) неоднозначен
 * по построению (choice = preference), поэтому для чтения purpose хранится в строке.
 */
import type { AwaitingKind } from '../taskstore';

export const AWAITING_PURPOSES = ['preference', 'missing_fact', 'credential', 'approval'] as const;
export type AwaitingPurpose = (typeof AWAITING_PURPOSES)[number];

/** purpose -> форма ответа. Обоснование каждой строки — в README (шаг 5). */
const KIND_BY_PURPOSE: Record<AwaitingPurpose, AwaitingKind> = {
  // Хотим выбрать один из вариантов -> ответ это выбор.
  preference: 'choice',
  // Не хватает факта -> ответ это свободное значение.
  missing_fact: 'data',
  // Нужна учётная запись: ответом является ПОДТВЕРЖДЕНИЕ, сам секрет приходит
  // через credential broker (C13) и в ответе/логах не появляется.
  credential: 'approval',
  // Нужно подтверждение действия -> ответ это подтверждение.
  approval: 'approval',
};

export function kindForPurpose(purpose: AwaitingPurpose | null | undefined, fallback: AwaitingKind = 'data'): AwaitingKind {
  if (!purpose) return fallback;
  const kind = KIND_BY_PURPOSE[purpose];
  if (!kind) throw new Error(`unknown awaiting purpose: ${purpose}`);
  return kind;
}

export function purposesForKind(kind: AwaitingKind): AwaitingPurpose[] {
  return AWAITING_PURPOSES.filter((p) => KIND_BY_PURPOSE[p] === kind);
}

export const PURPOSE_KIND_TABLE: ReadonlyArray<{ purpose: AwaitingPurpose; kind: AwaitingKind }> = AWAITING_PURPOSES.map(
  (purpose) => ({ purpose, kind: KIND_BY_PURPOSE[purpose] }),
);
