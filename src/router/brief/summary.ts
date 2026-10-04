/**
 * Детерминированный summary brief'а (P20; «Brief имеет минимум смысла»).
 *
 * Summary собирается ТОЛЬКО из проверенных полей каталога и снимка: заголовок,
 * потребность в данных, эффект, обязательные входы и факт доступности. Ни одно
 * слово здесь не утверждает права пользователя — утверждать их может только
 * снимок идентичности, и он приходит отдельным полем `availability`.
 *
 * Проверка механическая, а не обещанием: если заголовок каталога сам содержит
 * утверждение о доступе («Подключено: …», «доступно …»), компилятор вырезает его
 * из summary и фиксирует gap `access_claim_in_title:<id>`. Иначе каталог молча
 * превратил бы рекламу возможности в обещание интеграции.
 */
import type { BriefAvailability, BriefDataNeed, BriefEffect, BriefTier1Entry } from './brief-types';
import type { CapabilityEntry } from '../router-types';

/** Фразы, утверждающие доступ/права. В summary они недопустимы. */
export const ACCESS_CLAIM_TOKENS = [
  'доступно',
  'подключено',
  'подключён',
  'вы можете',
  'можно выполнить',
  'разрешено',
  'у вас есть доступ',
] as const;

/** Находит утверждения о доступе в произвольном тексте (для проверок и журнала). */
export function accessClaimsOf(text: string): string[] {
  const lower = text.toLowerCase();
  return ACCESS_CLAIM_TOKENS.filter((token) => lower.includes(token));
}

/** Убирает утверждения о доступе из заголовка: факт доступности — отдельно. */
export function stripAccessClaims(text: string): string {
  let out = text;
  for (const token of ACCESS_CLAIM_TOKENS) {
    out = out.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }
  return out.replace(/\s{2,}/g, ' ').replace(/^[\s:—-]+|[\s:—-]+$/g, '').trim();
}

export const DATA_NEED_LABEL: Record<BriefDataNeed, string> = {
  none: 'данные не нужны',
  prepared: 'данные подготовлены хостом',
  live: 'живые данные внешнего источника',
};

export const EFFECT_LABEL: Record<BriefEffect, string> = {
  none: 'без внешнего действия',
  read: 'чтение',
  write: 'внешнее действие (write)',
};

export const AVAILABILITY_LABEL: Record<BriefAvailability, string> = {
  enabled: 'включено',
  not_connected: 'интеграция не подключена',
  not_granted: 'право не выдано',
  input_missing: 'нужны данные профиля',
};

export interface BriefSummary {
  summary: string;
  title: string;
  gaps: string[];
}

/**
 * Одна строка summary из проверенных полей. Порядок и состав фиксированы:
 * одинаковый вход даёт одинаковую строку (нужно для воспроизводимого eval).
 */
export function briefSummaryOf(entry: CapabilityEntry, availability: BriefAvailability): BriefSummary {
  const gaps: string[] = [];
  const claims = accessClaimsOf(entry.title);
  const title = claims.length > 0 ? stripAccessClaims(entry.title) : entry.title;
  if (claims.length > 0) gaps.push(`access_claim_in_title:${entry.id}`);
  const required = entry.requiredInputs.length > 0 ? entry.requiredInputs.join(', ') : 'нет';
  const summary = [
    `${title} —`,
    `данные: ${DATA_NEED_LABEL[dataNeedOf(entry.dataSource)]};`,
    `действие: ${EFFECT_LABEL[entry.effect]};`,
    `обязательные входы: ${required};`,
    `доступность по снимку: ${AVAILABILITY_LABEL[availability]}.`,
  ].join(' ');
  return { summary, title, gaps };
}

/** Потребность в данных из проверенного поля каталога (§11.3). */
export function dataNeedOf(dataSource: CapabilityEntry['dataSource']): BriefDataNeed {
  if (dataSource === 'external_live') return 'live';
  if (dataSource === 'none') return 'none';
  return 'prepared';
}

/** Подсказки по входам: только обязательные поля каталога, без догадок. */
export function inputHintsOf(entry: CapabilityEntry): string[] {
  return entry.requiredInputs.map((field) => `required:${field}`);
}
