/**
 * Проверенный каталог возможностей для fast path (P16; §11.2 шаг 2, §10).
 *
 * Каталог — источник ИМЕН и АЛИАСОВ. Политика не «угадывает» capability по
 * регулярке по всему тексту: совпадение идёт по явным меткам каталога, а
 * решение дополнительно требует намерения. Отсутствие capability среди
 * кандидатов не означает, что её нет в системе (§11.2 шаг 2) — это значит, что
 * путь не детерминирован, и запрос уходит исполнителю.
 *
 * Готовность (connected/not connected) в каталоге НЕ хранится: она приходит
 * из снимка профиля хоста (`HostFacts.connections`) на момент запроса. Иначе
 * ответ «у вас подключено» был бы вечным обещанием, а не фактом (§11.8).
 */
import type { CapabilityCatalog, CapabilityEntry, CatalogValidation } from './router-types';

/** Версия снимка каталога: входит в ключ кэша и в лог решения (§11.6). */
export const SANDBOX_CATALOG_VERSION = 'capabilities-v1';

const SERVICE_COMMANDS: CapabilityEntry[] = [
  {
    id: 'service.help',
    version: 1,
    title: 'Список команд',
    aliases: ['/help', 'help', 'помощь', 'что делать можно'],
    dataSource: 'none',
    effect: 'none',
    integrationId: null,
    requiredInputs: [],
    routeHint: 'template',
    supportedModes: ['template'],
    templateId: 'service.help',
  },
  {
    id: 'service.status',
    version: 1,
    title: 'Статус задач',
    aliases: ['статус', 'статус задач', 'статус задачи'],
    dataSource: 'task_store',
    effect: 'none',
    integrationId: null,
    requiredInputs: [],
    routeHint: 'deterministic',
    supportedModes: ['deterministic'],
    templateId: null,
  },
  {
    id: 'service.stop',
    version: 1,
    title: 'Остановка работы',
    aliases: ['стоп', 'останови', 'остановись', 'остановить'],
    dataSource: 'task_store',
    effect: 'write',
    integrationId: null,
    requiredInputs: [],
    routeHint: 'deterministic',
    supportedModes: ['deterministic'],
    templateId: null,
  },
];

const OWN_DATA: CapabilityEntry[] = [
  {
    id: 'tasks.list_active',
    version: 1,
    title: 'Что сейчас в работе',
    aliases: ['что сейчас в работе', 'что в работе', 'какие задачи сейчас', 'чем занят'],
    dataSource: 'task_store',
    effect: 'none',
    integrationId: null,
    requiredInputs: [],
    routeHint: 'deterministic',
    supportedModes: ['deterministic'],
    templateId: null,
  },
  {
    id: 'tasks.last',
    version: 1,
    title: 'Номер последней задачи',
    aliases: ['какой номер у моей последней задачи', 'номер последней задачи', 'последняя задача'],
    dataSource: 'task_store',
    effect: 'none',
    integrationId: null,
    requiredInputs: [],
    routeHint: 'deterministic',
    supportedModes: ['deterministic'],
    templateId: null,
  },
  {
    id: 'tasks.by_day',
    version: 1,
    title: 'Задачи за день',
    aliases: ['что я просил вчера', 'что я просил сегодня', 'задачи за вчера', 'задачи за день'],
    dataSource: 'task_store',
    effect: 'none',
    integrationId: null,
    requiredInputs: [],
    routeHint: 'deterministic',
    supportedModes: ['deterministic'],
    templateId: null,
  },
  {
    id: 'clock.date_after',
    version: 1,
    title: 'Дата по часам системы',
    aliases: ['какое число будет через', 'какое число через', 'какая дата через', 'дата через'],
    dataSource: 'clock',
    effect: 'none',
    integrationId: null,
    requiredInputs: [],
    routeHint: 'deterministic',
    supportedModes: ['deterministic'],
    templateId: null,
  },
  {
    id: 'integrations.connection_status',
    version: 1,
    title: 'Подключена ли интеграция',
    aliases: ['подключен ли', 'подключена ли', 'подключено ли'],
    dataSource: 'connection_state',
    effect: 'none',
    integrationId: null,
    requiredInputs: [],
    routeHint: 'deterministic',
    supportedModes: ['deterministic'],
    templateId: null,
  },
];

const TEMPLATES: CapabilityEntry[] = [
  {
    id: 'catalog.brief',
    version: 1,
    title: 'Что умею',
    aliases: ['что ты умеешь', 'что умеешь', 'что можешь', 'какие возможности'],
    dataSource: 'none',
    effect: 'none',
    integrationId: null,
    requiredInputs: [],
    routeHint: 'template',
    supportedModes: ['template'],
    templateId: 'catalog.brief',
  },
  {
    id: 'policy.model_facts',
    version: 1,
    title: 'Модель и стоимость',
    aliases: ['с какой моделью работаешь', 'какая модель', 'сколько это стоит', 'почему так дорого'],
    dataSource: 'none',
    effect: 'none',
    integrationId: null,
    requiredInputs: [],
    routeHint: 'template',
    supportedModes: ['template'],
    templateId: 'policy.model_facts',
  },
];

/**
 * Интеграции и их capability. Готовность — из снимка профиля, не отсюда.
 * `web-search` подключение есть, но чтение веба НЕ объявлено capability:
 * поэтому «курс сейчас» и «что написано на странице» уходят исполнителю, а не
 * получают выдуманный быстрый ответ (FR-050, FR-051, AC-126).
 */
const INTEGRATIONS: CapabilityEntry[] = [
  {
    id: 'google-drive.read',
    version: 1,
    title: 'Чтение Google Drive',
    aliases: ['гугл-таблица', 'гугл-таблицу', 'таблицу', 'гугл-документ', 'гугл-документ', 'диск', 'файл на диске'],
    dataSource: 'external_live',
    effect: 'read',
    integrationId: 'google-drive',
    requiredInputs: [],
    routeHint: 'capability_dispatch',
    supportedModes: ['deterministic', 'llm'],
    templateId: 'capability.not_connected',
  },
  {
    id: 'google-drive.share_file',
    version: 1,
    title: 'Отправка файла',
    aliases: ['расшарь файл', 'расшарить файл', 'поделись файлом', 'отправь файл', 'расшарь', 'поделись'],
    dataSource: 'external_live',
    effect: 'write',
    integrationId: 'google-drive',
    requiredInputs: ['email'],
    routeHint: 'capability_dispatch',
    supportedModes: ['deterministic'],
    templateId: 'capability.missing_input',
  },
];

export function sandboxCapabilityCatalog(): CapabilityCatalog {
  return {
    version: SANDBOX_CATALOG_VERSION,
    capabilities: [...SERVICE_COMMANDS, ...OWN_DATA, ...TEMPLATES, ...INTEGRATIONS],
  };
}

/**
 * Проверка снимка каталога перед решением. Невалидный снимок — технический
 * исход `NO_ENABLED_CANDIDATES`, а не «агент попробует» (§11.2 шаг 4).
 */
export function validateCatalog(catalog: CapabilityCatalog): CatalogValidation {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of catalog.capabilities.entries()) {
    const at = `capabilities[${i}]`;
    if (!entry.id) errors.push(`${at}.id: expected a non-empty id`);
    if (seen.has(entry.id)) errors.push(`${at}.id: duplicate "${entry.id}"`);
    seen.add(entry.id);
    if (!Number.isInteger(entry.version) || entry.version < 1) errors.push(`${at}.version: expected a positive integer`);
    if (entry.aliases.length === 0) errors.push(`${at}.aliases: at least one alias is required (no ad-hoc regex)`);
    if (entry.supportedModes.length === 0) errors.push(`${at}.supportedModes: at least one mode is required`);
    if (entry.routeHint === 'template' && !entry.templateId) errors.push(`${at}.templateId: required for template hint`);
    if (entry.requiredInputs.length > 0 && entry.effect === 'none') {
      errors.push(`${at}.requiredInputs: only meaningful for an effect capability`);
    }
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/** Точное совпадение алиаса с нормализованным текстом (команды и короткие реплики). */
export function exactAliasMatches(entry: CapabilityEntry, normalized: string): string | null {
  return entry.aliases.find((alias) => alias.trim().toLowerCase() === normalized) ?? null;
}

/**
 * Вхождение алиаса в текст запроса. Длина совпадения идёт в оценку: из двух
 * совпадений выигрывает более специфичное («подключен ли у меня гугл-диск» против
 * «гугл-диск»), при равной длине — решение не принимается (уточнение).
 */
export function aliasMatchIn(entry: CapabilityEntry, normalized: string): { alias: string; length: number } | null {
  const hits = entry.aliases.filter((alias) => {
    const needle = alias.trim().toLowerCase();
    return needle.length > 0 && normalized.includes(needle);
  });
  if (hits.length === 0) return null;
  const best = hits.reduce((a, b) => (b.length > a.length ? b : a));
  return { alias: best, length: best.length };
}
