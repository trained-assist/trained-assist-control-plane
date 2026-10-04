/**
 * Компилятор brief'а из проверенного каталога (P20; § «Brief», §11.1 шаг 2).
 *
 * Что здесь принципиально:
 *  - brief — проекция ВЕРСИОНИРОВАННОГО каталога, а не новый источник истины:
 *    оригинальные определения не меняются, а каждое entry несёт ссылку на них
 *    (`definitionRef`) и хэш каталога (`catalogDigest`);
 *  - права и готовность приходят из снимков (identity + profile), никогда из
 *    текста запроса: невыданная возможность не попадает в Tier-1 вовсе, а
 *    подключённость — факт снимка, а не обещание;
 *  - Tier-2 (полные схемы) собирается ТОЛЬКО для выбранных кандидатов;
 *  - размер ИЗМЕРЯЕТСЯ в байтах UTF-8 и укладывается в бюджет детерминированно:
 *    сначала отбрасывается Tier-2, затем сокращается число кандидатов, и только
 *    если минимальный Tier-1 не влезает — технический исход `over_budget`
 *    (исполнитель по нему не включается, как и по любому техническому исходу);
 *  - пробелы метаданных оформляются как `gaps`, а не догадки по названию.
 */
import { aliasMatchIn, validateCatalog } from '../catalog';
import { extractTextFeatures } from '../text-features';
import type { CapabilityEntry, RoutingInput } from '../router-types';
import { briefCacheKey, bindingsRefOf, canonicalJson, ScopedBriefCache } from './cache';
import { briefSummaryOf, dataNeedOf, inputHintsOf } from './summary';
import {
  BRIEF_SCHEMA_VERSION,
  type BriefAvailability,
  type BriefBudgetStep,
  type BriefCacheScope,
  type BriefCompileResult,
  type BriefPurpose,
  type BriefTier1Entry,
  type BriefTier2Entry,
  type CatalogBrief,
} from './brief-types';

/** Бюджет по умолчанию: измеренная цель, а не догма (§11.10). */
export const DEFAULT_BRIEF_MAX_BYTES = 24_576;
export const DEFAULT_BRIEF_MAX_CANDIDATES = 12;

export interface BriefBudgetOptions {
  maxBytes?: number;
  maxCandidates?: number;
}

export interface BriefCompileParams {
  input: RoutingInput;
  purpose: BriefPurpose;
  budget?: BriefBudgetOptions;
  cache?: ScopedBriefCache;
}

interface AvailabilityFact {
  availability: BriefAvailability;
  executable: boolean;
  gaps: string[];
}

const MINIMAL_TIER1_FIELDS = [
  'id',
  'version',
  'routingName',
  'routingNameSource',
  'nativeToolName',
  'modes',
  'preferredMode',
  'effect',
  'data',
  'availability',
  'executable',
  'definitionRef',
  'score',
] as const;

/** Доступность и исполнимость по снимкам: только факты, без текста запроса. */
function availabilityOf(entry: CapabilityEntry, input: RoutingInput): AvailabilityFact {
  const gaps: string[] = [];
  const granted = input.authorization.grantedCapabilityIds.includes(entry.id);
  if (!granted) return { availability: 'not_granted', executable: false, gaps };
  if (entry.integrationId !== null && !input.authorization.grantedIntegrationIds.includes(entry.integrationId)) {
    return { availability: 'not_granted', executable: false, gaps: [...gaps, `integration_not_granted:${entry.integrationId}`] };
  }
  if (entry.integrationId !== null && input.hostFacts.connections[entry.integrationId] !== true) {
    return { availability: 'not_connected', executable: false, gaps: [...gaps, `integration_not_connected:${entry.integrationId}`] };
  }
  const missing = entry.requiredInputs.filter((field) => {
    const value = input.hostFacts.profileFields[field];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) {
    return { availability: 'input_missing', executable: false, gaps: [...gaps, `missing_profile_fields:${missing.join(',')}`] };
  }
  const binding = implementationBindingOf(entry);
  if (!binding) {
    gaps.push(`missing_implementation_binding:${entry.id}:${entry.preferredMode ?? 'unknown'}`);
    return { availability: 'enabled', executable: false, gaps };
  }
  return { availability: 'enabled', executable: true, gaps };
}

/** Реализация режима: каждый advertised mode требует реальной привязки. */
export function implementationBindingOf(entry: CapabilityEntry): BriefTier2Entry['implementation'] | null {
  const mode = entry.preferredMode ?? entry.supportedModes[0] ?? null;
  if (mode === null) return null;
  if (mode === 'template' && !entry.templateId) return null;
  if (mode === 'deterministic' && !entry.handlerRef) return null;
  if (mode === 'llm' && !entry.recipeId) return null;
  return {
    mode,
    templateId: mode === 'template' ? entry.templateId : null,
    handlerRef: mode === 'deterministic' ? (entry.handlerRef ?? null) : null,
    recipeId: mode === 'llm' ? (entry.recipeId ?? null) : null,
  };
}

/** Явное читаемое имя: из каталога либо детерминированная проекция id. */
export function routingNameOf(entry: CapabilityEntry): { routingName: string; source: 'catalog' | 'derived_from_id' } {
  if (entry.routingName && entry.routingName.trim().length > 0) {
    return { routingName: entry.routingName.trim(), source: 'catalog' };
  }
  return { routingName: entry.id.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''), source: 'derived_from_id' };
}

function definitionRefOf(entry: CapabilityEntry, catalogVersion: string): string {
  return `capabilities:${catalogVersion}:${entry.id}@${entry.version}`;
}

/** Релевантность запросу по ЯВНЫМ именам каталога: точное совпадение важнее вхождения. */
function scoreOf(entry: CapabilityEntry, normalized: string): number {
  const { routingName } = routingNameOf(entry);
  const names = [routingName, entry.nativeToolName, ...entry.aliases].filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  let score = 0;
  for (const name of names) {
    const needle = name.trim().toLowerCase();
    if (needle.length === 0) continue;
    if (needle === normalized) score = Math.max(score, 1000 + needle.length);
    else if (normalized.includes(needle)) score = Math.max(score, needle.length);
  }
  return score;
}

async function catalogDigestOf(catalog: RoutingInput['catalog']): Promise<string> {
  const canonical = canonicalJson({
    version: catalog.version,
    capabilities: [...catalog.capabilities]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => ({
        id: entry.id,
        version: entry.version,
        title: entry.title,
        aliases: entry.aliases,
        dataSource: entry.dataSource,
        effect: entry.effect,
        integrationId: entry.integrationId,
        requiredInputs: entry.requiredInputs,
        routeHint: entry.routeHint,
        supportedModes: entry.supportedModes,
        preferredMode: entry.preferredMode ?? null,
        routingName: entry.routingName ?? null,
        nativeToolName: entry.nativeToolName ?? null,
        templateId: entry.templateId,
        handlerRef: entry.handlerRef ?? null,
        recipeId: entry.recipeId ?? null,
        inputSchema: entry.inputSchema ?? null,
        outputSchema: entry.outputSchema ?? null,
        docsRefs: entry.docsRefs ?? null,
      })),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function tier1EntryOf(entry: CapabilityEntry, catalogVersion: string, fact: AvailabilityFact, score: number): BriefTier1Entry {
  const { routingName, source } = routingNameOf(entry);
  const summary = briefSummaryOf(entry, fact.availability);
  return {
    id: entry.id,
    version: entry.version,
    routingName,
    routingNameSource: source,
    nativeToolName: entry.nativeToolName ?? null,
    summary: summary.summary,
    summaryTitle: summary.title,
    modes: [...entry.supportedModes],
    preferredMode: entry.preferredMode ?? entry.supportedModes[0] ?? 'deterministic',
    effect: entry.effect,
    data: dataNeedOf(entry.dataSource),
    required: [...entry.requiredInputs],
    inputHints: inputHintsOf(entry),
    availability: fact.availability,
    executable: fact.executable,
    definitionRef: definitionRefOf(entry, catalogVersion),
    docsRefs: [...(entry.docsRefs ?? [])],
    score,
  };
}

/** Пробелы summary: заголовок каталога не имеет права обещать доступ. */
function briefSummaryGapsOf(entry: CapabilityEntry, availability: BriefAvailability): string[] {
  return briefSummaryOf(entry, availability).gaps;
}

function tier2EntryOf(entry: CapabilityEntry, catalogVersion: string): BriefTier2Entry | null {
  const implementation = implementationBindingOf(entry);
  if (!implementation) return null;
  return {
    id: entry.id,
    version: entry.version,
    definitionRef: definitionRefOf(entry, catalogVersion),
    inputSchema: [...(entry.inputSchema ?? [])],
    outputSchema: [...(entry.outputSchema ?? [])],
    constraints: {
      data: [`data:${dataNeedOf(entry.dataSource)}`, `effect:${entry.effect}`],
      task: [...entry.requiredInputs.map((field) => `required:${field}`)],
    },
    implementation,
  };
}

/** Минимальный Tier-1: только идентификация, режимы, эффект и доступность. */
function minimalTier1(entry: BriefTier1Entry): BriefTier1Entry {
  const out: Record<string, unknown> = {};
  for (const field of MINIMAL_TIER1_FIELDS) out[field] = entry[field];
  return out as unknown as BriefTier1Entry;
}

function bytesOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Содержимое brief без идентификаторов и кэша. Именно этот объект измеряется
 * в бюджете, поэтому измеренный размер всегда равен финальному `bytes`.
 */
function contentOf(
  variant: BriefVariant,
  params: {
    catalogVersion: string;
    excludedByScope: CatalogBrief['excludedByScope'];
    gaps: string[];
  },
): Record<string, unknown> {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    catalogVersion: params.catalogVersion,
    tier1: variant.tier1,
    candidates: variant.candidates,
    tier2: variant.tier2,
    excludedByScope: params.excludedByScope,
    omittedByBudget: variant.omittedByBudget,
    degraded: variant.degraded,
    gaps: params.gaps,
  };
}

interface BriefVariant {
  step: string;
  tier1: BriefTier1Entry[];
  candidates: string[];
  tier2: BriefTier2Entry[];
  /** Кандидаты без Tier-2: они остались в Tier-1, но схем не получили. */
  omittedByBudget: string[];
  /** Brief собран с потерями: Tier-2 или кандидаты урезаны. */
  degraded: boolean;
}

/**
 * Компиляция brief'а с измерением бюджета. Возвращает ТИПИЗИРОВАННЫЙ исход:
 * `ok` — brief собран и влез в бюджет (возможно, с потерями); `over_budget` —
 * минимальный Tier-1 не влезает; `invalid` — снимок каталога не проверен.
 */
export async function compileCatalogBrief(params: BriefCompileParams): Promise<BriefCompileResult> {
  const { input, purpose } = params;
  const maxBytes = Math.max(1, params.budget?.maxBytes ?? DEFAULT_BRIEF_MAX_BYTES);
  const maxCandidates = Math.max(1, params.budget?.maxCandidates ?? DEFAULT_BRIEF_MAX_CANDIDATES);
  const catalog = input.catalog;

  const catalogCheck = validateCatalog(catalog);
  if (!catalogCheck.ok) return { status: 'invalid', errors: catalogCheck.errors };

  const normalized = extractTextFeatures(input.prepared.text).normalized;
  const catalogVersion = catalog.version;

  // ── Tier-1: только РАЗРЕШЁННЫЕ возможности; невыданные не попадают в brief ──
  const tier1: BriefTier1Entry[] = [];
  const excludedByScope: CatalogBrief['excludedByScope'] = [];
  const gaps: string[] = [];
  const catalogIndex = new Map(catalog.capabilities.map((entry, index) => [entry.id, index] as const));
  for (const entry of catalog.capabilities) {
    const fact = availabilityOf(entry, input);
    gaps.push(...fact.gaps);
    if (!input.authorization.grantedCapabilityIds.includes(entry.id)) {
      excludedByScope.push({ id: entry.id, reason: 'not_granted' });
      continue;
    }
    if (entry.integrationId !== null && !input.authorization.grantedIntegrationIds.includes(entry.integrationId)) {
      excludedByScope.push({ id: entry.id, reason: 'integration_not_granted' });
      continue;
    }
    const summaryGaps = briefSummaryGapsOf(entry, fact.availability);
    gaps.push(...summaryGaps);
    tier1.push(tier1EntryOf(entry, catalogVersion, fact, scoreOf(entry, normalized)));
  }

  // ── Кандидаты: исполнимые, по убыванию релевантности, стабильный порядок ──
  const candidates = tier1
    .filter((entry) => entry.executable)
    .sort((a, b) => b.score - a.score || (catalogIndex.get(a.id) ?? 0) - (catalogIndex.get(b.id) ?? 0))
    .slice(0, maxCandidates)
    .map((entry) => entry.id);

  const tier2ById = new Map<string, BriefTier2Entry>();
  for (const entry of catalog.capabilities) {
    if (!candidates.includes(entry.id)) continue;
    const tier2 = tier2EntryOf(entry, catalogVersion);
    if (!tier2) continue;
    tier2ById.set(entry.id, tier2);
    if (tier2.inputSchema.length === 0) gaps.push(`missing_input_schema:${entry.id}`);
    if (tier2.outputSchema.length === 0 && entry.effect !== 'none') gaps.push(`missing_output_schema:${entry.id}`);
  }

  const includeTier2 = purpose === 'reply-or-route';
  const contentParams = { catalogVersion, excludedByScope, gaps };
  const measurements: BriefBudgetStep[] = [];
  const measure = (variant: BriefVariant): number => {
    const bytes = bytesOf(contentOf(variant, contentParams));
    measurements.push({
      step: variant.step,
      bytes,
      tier1: variant.tier1.length,
      candidates: variant.candidates.length,
      tier2: variant.tier2.length,
    });
    return bytes;
  };

  const fullTier2 = candidates.map((id) => tier2ById.get(id)).filter((entry): entry is BriefTier2Entry => entry !== undefined);
  const full: BriefVariant = { step: 'full', tier1, candidates, tier2: fullTier2, omittedByBudget: [], degraded: false };
  if (includeTier2 && measure(full) <= maxBytes) return finish(full);

  const tier1Only: BriefVariant = { step: 'tier1-only', tier1, candidates, tier2: [], omittedByBudget: [...candidates], degraded: true };
  if (measure(tier1Only) <= maxBytes) return finish(tier1Only);

  const minimal = tier1.map(minimalTier1);
  const minimalVariant: BriefVariant = { step: 'tier1-minimal', tier1: minimal, candidates, tier2: [], omittedByBudget: [], degraded: true };
  const minimalBytes = measure(minimalVariant);
  if (minimalBytes > maxBytes) {
    return {
      status: 'over_budget',
      brief: await buildBrief(minimalVariant, {
        ...contentParams,
        candidates,
        tier2ById,
        measurements,
        maxBytes,
        purpose,
        input,
        cacheInfo: null,
        degraded: minimalVariant.degraded,
        omittedByBudget: minimalVariant.omittedByBudget,
      }),
      minimalBytes,
    };
  }

  // Tier-2 возвращается частично: максимум кандидатов, которые влезают.
  let chosen: BriefVariant = minimalVariant;
  if (includeTier2) {
    for (let count = candidates.length; count >= 1; count -= 1) {
      const ids = candidates.slice(0, count);
      const variant: BriefVariant = {
        step: `tier1-minimal+tier2:${count}`,
        tier1: minimal,
        candidates: ids,
        tier2: ids.map((id) => tier2ById.get(id)).filter((entry): entry is BriefTier2Entry => entry !== undefined),
        omittedByBudget: [...candidates.slice(count)],
        degraded: true,
      };
      if (measure(variant) <= maxBytes) {
        chosen = variant;
        break;
      }
    }
  }
  return finish(chosen);

  async function finish(variant: BriefVariant): Promise<BriefCompileResult> {
    return {
      status: 'ok',
      brief: await buildBrief(variant, {
        ...contentParams,
        candidates: variant.candidates,
        tier2ById,
        measurements,
        maxBytes,
        purpose,
        input,
        cacheInfo: null,
        degraded: variant.degraded,
        omittedByBudget: variant.omittedByBudget,
      }),
    };
  }
}

async function buildBrief(
  variant: BriefVariant,
  params: {
    catalogVersion: string;
    candidates: string[];
    tier2ById: Map<string, BriefTier2Entry>;
    excludedByScope: CatalogBrief['excludedByScope'];
    gaps: string[];
    measurements: BriefBudgetStep[];
    maxBytes: number;
    purpose: BriefPurpose;
    input: RoutingInput;
    cacheInfo: { key: string; hit: boolean; stored: boolean } | null;
    degraded: boolean;
    omittedByBudget: string[];
  },
): Promise<CatalogBrief> {
  const { input } = params;
  const scope: BriefCacheScope = {
    tenantId: input.envelope.principalId,
    profileId: input.envelope.profileId,
    authorizationRef: input.authorization.snapshotRef,
    bindingsRef: await bindingsRefOf(input.hostFacts),
    catalogVersion: input.catalog.version,
    policyVersion: input.envelope.policyVersion,
    contextVersion: input.prepared.contextVersion,
    purpose: params.purpose,
    schemaVersion: BRIEF_SCHEMA_VERSION,
  };
  const key = params.cacheInfo?.key ?? (await briefCacheKey(scope));
  const content = contentOf(variant, params);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(content)));
  const briefId = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const measuredBytes = bytesOf(content);
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    catalogVersion: params.catalogVersion,
    catalogDigest: await catalogDigestOf(input.catalog),
    briefId,
    purpose: params.purpose,
    tier1: variant.tier1,
    candidates: variant.candidates,
    tier2: variant.tier2,
    excludedByScope: params.excludedByScope,
    omittedByBudget: params.omittedByBudget ?? [],
    degraded: params.degraded ?? false,
    gaps: params.gaps,
    bytes: measuredBytes,
    chars: JSON.stringify(content).length,
    budget: { maxBytes: params.maxBytes, measuredBytes, withinBudget: measuredBytes <= params.maxBytes },
    measurements: params.measurements,
    cache: { key, hit: params.cacheInfo?.hit ?? false, stored: params.cacheInfo?.stored ?? false, scope },
  };
}

/** Кэшированная компиляция: ключ по области, значение — только проекция каталога. */
export async function compileCachedBrief(params: BriefCompileParams): Promise<BriefCompileResult> {
  const cache = params.cache;
  if (!cache) return compileCatalogBrief(params);
  const probe = await compileCatalogBrief({ ...params, cache: undefined });
  if (probe.status !== 'ok') return probe;
  const scope = probe.brief.cache.scope;
  const key = await briefCacheKey(scope);
  const hit = await cache.get(key);
  if (hit) {
    return {
      status: 'ok',
      brief: { ...hit, cache: { key, hit: true, stored: false, scope } },
    };
  }
  await cache.set(key, probe.brief);
  return {
    status: 'ok',
    brief: { ...probe.brief, cache: { key, hit: false, stored: true, scope } },
  };
}

/** Идентификаторы для discovery-индекса исполнителя: только разрешённые (§12). */
export function discoveryCapabilityIds(brief: CatalogBrief | null, input: RoutingInput): string[] {
  if (brief) return brief.tier1.map((entry) => entry.id);
  return input.catalog.capabilities.filter((entry) => input.authorization.grantedCapabilityIds.includes(entry.id)).map((entry) => entry.id);
}
