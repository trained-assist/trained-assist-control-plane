/**
 * Scoped context cache brief'а (P20; §6, §11.1, AC-136).
 *
 * Ключ кэша — НЕ хэш текста запроса (§8: «Cache ключ по text hash» — известная
 * ошибка текущего процесса). Ключ включает область: tenant/profile, снимок прав,
 * связывания профиля, версию каталога, версию политики, версию контекста,
 * назначение и версию схемы brief. Одинаковый текст разных профилей не должен
 * смешиваться, и наоборот: устаревший контекст не должен отдаваться как свежий.
 *
 * В кэше лежит ТОЛЬКО проекция каталога: текст запроса, вложения и секреты в
 * ключ и в значение не попадают по построению (проверяется тестом).
 */
import { BRIEF_CACHE_SCOPE_VERSION, type BriefCacheScope, type CatalogBrief } from './brief-types';

export interface ScopedBriefCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
}

export interface ScopedBriefCacheStats {
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
  bytes: number;
}

/** Канонический JSON для хэша: сортированные ключи, без пробелов. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Хэш связываний профиля: подключения и известные поля (права — не из текста). */
export async function bindingsRefOf(bindings: {
  connections: Record<string, boolean>;
  profileFields: Record<string, string | null>;
}): Promise<string> {
  return `bindings-${(await sha256Hex(canonicalJson({ connections: bindings.connections, profileFields: bindings.profileFields }))).slice(0, 16)}`;
}

/**
 * Ключ кэша по области. Любое изменение области (другой профиль, другие права,
 * другой снимок связываний, другая версия каталога/политики/контекста) даёт
 * другой ключ — это и есть требование «cache keyed profile/context/catalog/policy».
 */
export async function briefCacheKey(scope: BriefCacheScope): Promise<string> {
  const canonical = canonicalJson({
    v: BRIEF_CACHE_SCOPE_VERSION,
    tenantId: scope.tenantId,
    profileId: scope.profileId,
    authorizationRef: scope.authorizationRef,
    bindingsRef: scope.bindingsRef,
    catalogVersion: scope.catalogVersion,
    policyVersion: scope.policyVersion,
    contextVersion: scope.contextVersion,
    purpose: scope.purpose,
    schemaVersion: scope.schemaVersion,
  });
  return `brief-${(await sha256Hex(canonical)).slice(0, 24)}`;
}

/**
 * LRU-кэш с ограничением по числу записей и суммарным размеру. Вытеснение
 * детерминировано (давний вход удаляется первым), поэтому поведение кэша
 * воспроизводимо и проверяемо.
 */
export class ScopedBriefCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly store = new Map<string, CatalogBrief>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private bytes = 0;

  constructor(options: ScopedBriefCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 64);
    this.maxBytes = Math.max(1, options.maxBytes ?? 4 * 1024 * 1024);
  }

  async get(key: string): Promise<CatalogBrief | null> {
    const hit = this.store.get(key);
    if (!hit) {
      this.misses += 1;
      return null;
    }
    // LRU: повторная вставка переносит запись в конец порядка удаления.
    this.store.delete(key);
    this.store.set(key, hit);
    this.hits += 1;
    return hit;
  }

  async set(key: string, brief: CatalogBrief): Promise<void> {
    if (this.store.has(key)) {
      const previous = this.store.get(key);
      if (previous) this.bytes -= previous.bytes;
      this.store.delete(key);
    }
    this.store.set(key, brief);
    this.bytes += brief.bytes;
    while (this.store.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.store.get(oldest);
      if (evicted) this.bytes -= evicted.bytes;
      this.store.delete(oldest);
      this.evictions += 1;
    }
  }

  stats(): ScopedBriefCacheStats {
    return { entries: this.store.size, hits: this.hits, misses: this.misses, evictions: this.evictions, bytes: this.bytes };
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.bytes = 0;
  }
}
