/**
 * Пилотная маршрутизация: конфиг-гейт (feature flag + список cohort).
 *
 * Решение принимается один раз при приёме задачи и сохраняется в
 * user_value.pilotRoute. Последующие операции (start / signal / cancel)
 * читают сохранённый маршрут — повторного вычисления нет.
 *
 * Переменные окружения (только из env, ничего в репо):
 *   PILOT_ENABLED          — 'true' / 'false' (дефолт false)
 *   PILOT_ACTIVATED_AT     — ISO-8601 timestamp включения пилота (обязателен при enabled)
 *   PILOT_COHORT_PROFILE_IDS — comma-separated список profileId для cohort (пусто = все)
 *   PILOT_LEGACY_PROFILE_IDS — comma-separated список profileId, всегда legacy
 */
export interface PilotConfig {
  /** Флаг пилота: true = пилот активен, новые задачи могут идти на новый plane. */
  enabled: boolean;
  /** Момент включения пилота (ISO-8601). Задачи, созданные ДО этой даты — legacy. */
  activatedAt: number | null;
  /** Cohort: profileId, которые попадают в пилот (null = все profileId). */
  cohortProfileIds: string[] | null;
  /** ProfileId, которые ВСЕГДА legacy, даже если пилот активен. */
  legacyProfileIds: string[] | null;
}

export interface PilotRoute {
  /** 'new-plane' = новый control plane, 'legacy' = старый владелец. */
  route: 'new-plane' | 'legacy';
  /** Причина решения (для логов и аудита). */
  reason: string;
  /** Timestamp принятия решения. */
  decidedAt: number;
}

const envBool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
};

const envStringArray = (name: string): string[] | null => {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return null;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

const envIsoTimestamp = (name: string): number | null => {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return null;
  const ts = Date.parse(raw.trim());
  return Number.isFinite(ts) ? ts : null;
};

export function readPilotConfig(): PilotConfig {
  return {
    enabled: envBool('PILOT_ENABLED', false),
    activatedAt: envIsoTimestamp('PILOT_ACTIVATED_AT'),
    cohortProfileIds: envStringArray('PILOT_COHORT_PROFILE_IDS'),
    legacyProfileIds: envStringArray('PILOT_LEGACY_PROFILE_IDS'),
  };
}

/**
 * Принимает решение о маршрутизации задачи.
 * Правила (применяются по порядку, первый совпавший побеждает):
 *  1. Пилот выключен → legacy.
 *  2. profileId в legacyProfileIds → legacy.
 *  3. cohortProfileIds задан и profileId не в нём → legacy.
 *  4. Задача создана до activatedAt → legacy.
 *  5. Иначе → new-plane.
 */
export function decideRoute(
  profileId: string,
  createdAt: number,
  config: PilotConfig,
): PilotRoute {
  const decidedAt = Date.now();

  if (!config.enabled) {
    return { route: 'legacy', reason: 'pilot_disabled', decidedAt };
  }

  if (config.legacyProfileIds && config.legacyProfileIds.includes(profileId)) {
    return { route: 'legacy', reason: 'profile_in_legacy_cohort', decidedAt };
  }

  if (config.cohortProfileIds && !config.cohortProfileIds.includes(profileId)) {
    return { route: 'legacy', reason: 'profile_not_in_cohort', decidedAt };
  }

  if (config.activatedAt && createdAt < config.activatedAt) {
    return { route: 'legacy', reason: 'task_created_before_pilot_activation', decidedAt };
  }

  return { route: 'new-plane', reason: 'pilot_active_cohort_match', decidedAt };
}

/** Валидация конфига: возвращает массив ошибок (пустой = конфиг корректен). */
export function validatePilotConfig(config: PilotConfig): string[] {
  const errors: string[] = [];
  if (config.enabled && config.activatedAt === null) {
    errors.push('PILOT_ACTIVATED_AT is required when PILOT_ENABLED=true');
  }
  return errors;
}