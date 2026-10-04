/**
 * Host-owned сборка brief'а для маршрута (P20; §11.1 шаг 2, §11.9).
 *
 * Brief собирает ХОСТ до вызова рецепта: модель получает уже подготовленную
 * проекцию каталога, а не весь каталог и не догадки. Сборка идёт только для
 * путей, которые brief используют (рецепт и discovery-индекс исполнителя):
 * детерминированные и шаблонные пути P16 от него не зависят.
 *
 * Исходы сборки — типизированные и ни один не включает исполнителя:
 *  - `ok` — brief собран (возможно, с потерями: Tier-2 или кандидаты урезаны);
 *  - `over_budget` — минимальный Tier-1 не влезает в бюджет: технический исход
 *    `BRIEF_BUDGET_EXCEEDED`, модель не зовётся, исполнитель не включается;
 *  - `invalid` — снимок каталога не проверен: `BRIEF_METADATA_INVALID`.
 *
 * Журнал: отдельное событие `routing.brief` с доверительным контекстом
 * (profileId/userTaskId/runId/requestId), ключом кэша, попаданием, размером в
 * байтах, числом entries/кандидатов и причиной деградации. Текст запроса,
 * содержимое вложений и секреты в журнал не попадают.
 */
import { logStructured } from '../../logging/structured-log';
import { compileCachedBrief, type BriefBudgetOptions } from './compiler';
import { type ScopedBriefCache } from './cache';

export const BRIEF_CACHE_EVENT = 'routing.brief';
import type { BriefPurpose } from './brief-types';
import type { StructuredLogFields } from '../../logging/structured-log';
import type { RoutingInput } from '../router-types';

export interface BriefServiceDeps {
  cache?: ScopedBriefCache;
  budget?: BriefBudgetOptions;
  purpose?: BriefPurpose;
}

export interface BriefBuildResult {
  status: 'ok' | 'over_budget' | 'invalid';
  brief: import('./brief-types').CatalogBrief | null;
  errors: string[];
  cache: { key: string | null; hit: boolean; stored: boolean };
}

/** Краткий снимок для ответа API и журнала: без содержимого каталога. */
export interface BriefBuildSummary {
  status: BriefBuildResult['status'];
  briefId: string | null;
  catalogVersion: string;
  catalogDigest: string | null;
  purpose: BriefPurpose;
  tier1: number;
  candidates: number;
  tier2: number;
  omittedByBudget: number;
  excludedByScope: number;
  degraded: boolean;
  gaps: string[];
  bytes: number;
  budget: { maxBytes: number; measuredBytes: number; withinBudget: boolean } | null;
  cache: BriefBuildResult['cache'];
}

export async function buildScopedBrief(input: RoutingInput, deps: BriefServiceDeps = {}): Promise<BriefBuildResult> {
  const purpose = deps.purpose ?? 'reply-or-route';
  const result = await compileCachedBrief({
    input,
    purpose,
    budget: deps.budget,
    cache: deps.cache,
  });
  if (result.status === 'invalid') {
    return { status: 'invalid', brief: null, errors: result.errors, cache: { key: null, hit: false, stored: false } };
  }
  if (result.status === 'over_budget') {
    return {
      status: 'over_budget',
      brief: result.brief,
      errors: [`brief_minimal_tier1_bytes=${result.minimalBytes}`],
      cache: { key: result.brief.cache.key, hit: result.brief.cache.hit, stored: result.brief.cache.stored },
    };
  }
  return {
    status: 'ok',
    brief: result.brief,
    errors: [],
    cache: { key: result.brief.cache.key, hit: result.brief.cache.hit, stored: result.brief.cache.stored },
  };
}

export function briefBuildSummaryOf(result: BriefBuildResult): BriefBuildSummary {
  const brief = result.brief;
  return {
    status: result.status,
    briefId: brief?.briefId ?? null,
    catalogVersion: brief?.catalogVersion ?? '',
    catalogDigest: brief?.catalogDigest ?? null,
    purpose: brief?.purpose ?? 'reply-or-route',
    tier1: brief?.tier1.length ?? 0,
    candidates: brief?.candidates.length ?? 0,
    tier2: brief?.tier2.length ?? 0,
    omittedByBudget: brief?.omittedByBudget.length ?? 0,
    excludedByScope: brief?.excludedByScope.length ?? 0,
    degraded: brief?.degraded ?? false,
    gaps: brief?.gaps ?? [],
    bytes: brief?.bytes ?? 0,
    budget: brief?.budget ?? null,
    cache: result.cache,
  };
}

/** Событие журнала: ключ кэша, попадание, размер, причина деградации. */
export function briefLogFields(
  result: BriefBuildResult,
  params: { profileId: string; userTaskId: string; runId: string | null; requestId: string | null; decisionId: string | null },
): Record<string, unknown> {
  const brief = result.brief;
  return {
    event: BRIEF_CACHE_EVENT,
    profileId: params.profileId,
    userTaskId: params.userTaskId,
    runId: params.runId,
    requestId: params.requestId,
    decisionId: params.decisionId,
    reason: result.status === 'ok' ? null : result.status,
    briefId: brief?.briefId ?? null,
    briefKey: result.cache.key,
    cacheHit: result.cache.hit,
    cacheStored: result.cache.stored,
    purpose: brief?.purpose ?? null,
    catalogVersion: brief?.catalogVersion ?? null,
    catalogDigest: brief?.catalogDigest ?? null,
    tier1Entries: brief?.tier1.length ?? 0,
    candidates: brief?.candidates.length ?? 0,
    tier2Entries: brief?.tier2.length ?? 0,
    omittedByBudget: brief?.omittedByBudget.length ?? 0,
    excludedByScope: brief?.excludedByScope.length ?? 0,
    degraded: brief?.degraded ?? false,
    gaps: brief?.gaps ?? [],
    bytes: brief?.bytes ?? 0,
    budgetMaxBytes: brief?.budget?.maxBytes ?? null,
    budgetWithin: brief?.budget?.withinBudget ?? null,
    measurements: (brief?.measurements ?? []).map((step) => `${step.step}:${step.bytes}`),
  };
}

export function logBrief(result: BriefBuildResult, params: Parameters<typeof briefLogFields>[1]): void {
  logStructured({ event: BRIEF_CACHE_EVENT, ...briefLogFields(result, params) });
}
