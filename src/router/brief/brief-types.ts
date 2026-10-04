/**
 * Контракты brief builder'а (P20; CAPABILITY-CATALOG-AND-FAST-REPLIES.md,
 * TASK-ROUTER-AND-MCP.md §6, §11.1, §12).
 *
 * Brief — это ПРОЕКЦИЯ проверенного каталога, а не новый источник истины:
 *  - Tier-1 — явные короткие имена/алиасы + mode tags + факты доступности для
 *    РАЗРЕШЁННЫХ возможностей (права — из снимка идентичности, готовность — из
 *    снимка профиля; ни то, ни другое не выводится из текста запроса);
 *  - Tier-2 — полные input/output schemas и ограничения ТОЛЬКО для выбранных
 *    кандидатов (retrieval), чтобы весь каталог не ехал в каждый запрос;
 *  - native MCP names не переименовываются: brief публикует отображение
 *    routingName → nativeToolName, а оригинальные имена остаются в манифесте.
 *
 * Размер brief ИЗМЕРЯЕТСЯ (байты UTF-8, не «токены»): бюджет применяется
 * детерминированно — сначала отбрасывается Tier-2, затем сокращается список
 * кандидатов, и только если минимальный Tier-1 всё ещё не влезает, это
 * технический исход, а не «ответ примерно».
 */
import type { BriefFieldSpec, CapabilityMode } from '../router-types';

/** Версия схемы brief: входит в ключ кэша и в журнал. */
export const BRIEF_SCHEMA_VERSION = 'catalog-brief-v1';

/** Версия области кэша: меняется при изменении состава ключа. */
export const BRIEF_CACHE_SCOPE_VERSION = 'brief-cache-scope-v1';

/** Назначение brief: от него зависит состав (Tier-2 нужен только рецепту). */
export type BriefPurpose = 'reply-or-route' | 'capability-discovery' | 'agent-work-order';

/**
 * Доступность на момент снимка. Это ФАКТ снимка, а не обещание: `enabled`
 * означает «право выдано, интеграция подключена, обязательные входы известны»,
 * и повторная проверка перед исполнением всё равно остаётся за хостом.
 */
export type BriefAvailability = 'enabled' | 'not_connected' | 'not_granted' | 'input_missing';

/** Откуда capability берёт данные (§11.3: data needs — none/prepared/live). */
export type BriefDataNeed = 'none' | 'prepared' | 'live';

/** Что делает capability: чтение или внешнее действие. */
export type BriefEffect = 'read' | 'write' | 'none';

/** Обязательное поле схемы (verified metadata каталога). */
export type { BriefFieldSpec } from '../router-types';

/** Tier-1 entry: минимальный смысл, а не одно имя (§ «Brief имеет минимум смысла»). */
export interface BriefTier1Entry {
  id: string;
  version: number;
  /** Явное читаемое имя маршрутизации (snake_case). */
  routingName: string;
  /** Источник имени: каталог или детерминированная проекция id. */
  routingNameSource: 'catalog' | 'derived_from_id';
  /** Нативное имя MCP-инструмента. НЕ переименывается — brief только отображает. */
  nativeToolName: string | null;
  /** Одна строка из проверенных полей; прав не утверждает. */
  summary: string;
  /** Заголовок каталога без утверждений о доступе (для проверки и журнала). */
  summaryTitle: string;
  modes: CapabilityMode[];
  preferredMode: CapabilityMode;
  effect: BriefEffect;
  data: BriefDataNeed;
  required: string[];
  inputHints: string[];
  availability: BriefAvailability;
  /** Может ли эта возможность быть исполняемой в данном снимке. */
  executable: boolean;
  /** Ссылка на оригинальное определение в манифесте. */
  definitionRef: string;
  docsRefs: string[];
  /** Оценка релевантности запросу (0 — явного совпадения нет). */
  score: number;
}

/** Tier-2 entry: полные схемы и ограничения только для кандидатов. */
export interface BriefTier2Entry {
  id: string;
  version: number;
  definitionRef: string;
  inputSchema: BriefFieldSpec[];
  outputSchema: BriefFieldSpec[];
  /** Ограничения по данным и задаче: модель обязана их видеть, а не угадывать. */
  constraints: { data: string[]; task: string[] };
  implementation: {
    mode: CapabilityMode;
    templateId: string | null;
    /** Host-owned обработчик: модель capability не вызывает сама. */
    handlerRef: string | null;
    recipeId: string | null;
  };
}

/** Один шаг измерения бюджета: видно, что именно отбрасывалось. */
export interface BriefBudgetStep {
  step: string;
  bytes: number;
  tier1: number;
  candidates: number;
  tier2: number;
}

/** Область кэша brief (AC-136: profile/context/catalog/policy + связывания). */
export interface BriefCacheScope {
  tenantId: string;
  profileId: string;
  /** Хэш снимка прав (profile + capability + integration). */
  authorizationRef: string;
  /** Хэш связываний профиля (подключения + известные поля). */
  bindingsRef: string;
  catalogVersion: string;
  policyVersion: string;
  contextVersion: string;
  purpose: BriefPurpose;
  schemaVersion: string;
}

export interface CatalogBrief {
  schemaVersion: string;
  catalogVersion: string;
  /** Хэш проверенного каталога: по нему видно, что оригинал не менялся. */
  catalogDigest: string;
  /** Хэш содержимого brief: идентичный вход даёт идентичный brief. */
  briefId: string;
  purpose: BriefPurpose;
  tier1: BriefTier1Entry[];
  /** Идентификаторы кандидатов в порядке релевантности. */
  candidates: string[];
  tier2: BriefTier2Entry[];
  /** Возможности вне области видимости: не выдано право. */
  excludedByScope: Array<{ id: string; reason: 'not_granted' | 'integration_not_granted' }>;
  /** Кандидаты, отброшенные бюджетом (id остался в Tier-1). */
  omittedByBudget: string[];
  /** Brief собран с потерями: Tier-2 или кандидаты урезаны. */
  degraded: boolean;
  /** Пробелы метаданных: честный gap, а не догадка по названию. */
  gaps: string[];
  bytes: number;
  chars: number;
  budget: { maxBytes: number; measuredBytes: number; withinBudget: boolean };
  measurements: BriefBudgetStep[];
  cache: { key: string; hit: boolean; stored: boolean; scope: BriefCacheScope };
}

export type BriefCompileResult =
  | { status: 'ok'; brief: CatalogBrief }
  | { status: 'over_budget'; brief: CatalogBrief; minimalBytes: number }
  | { status: 'invalid'; errors: string[] };
