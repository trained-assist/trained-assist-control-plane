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
    preferredMode: 'template',
    routingName: 'service_show_command_list',
    nativeToolName: 'assist_help',
    templateId: 'service.help',
    docsRefs: ['docs:service.help'],
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
    preferredMode: 'deterministic',
    routingName: 'service_get_task_status',
    nativeToolName: 'assist_status',
    templateId: null,
    handlerRef: 'handler:service.status',
    outputSchema: [{ name: 'tasks', type: 'array', required: true, description: 'Активные задачи профиля' }],
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
    preferredMode: 'deterministic',
    routingName: 'service_stop_active_work',
    nativeToolName: 'assist_stop',
    templateId: null,
    handlerRef: 'handler:service.stop',
    outputSchema: [{ name: 'stopped', type: 'boolean', required: true, description: 'Работа остановлена' }],
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
    preferredMode: 'deterministic',
    routingName: 'tasks_list_active',
    nativeToolName: 'tasks_list',
    templateId: null,
    handlerRef: 'handler:tasks.list_active',
    outputSchema: [{ name: 'tasks', type: 'array', required: true, description: 'Активные задачи снимка' }],
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
    preferredMode: 'deterministic',
    routingName: 'tasks_get_last_task_number',
    nativeToolName: 'tasks_last',
    templateId: null,
    handlerRef: 'handler:tasks.last',
    outputSchema: [{ name: 'taskId', type: 'string', required: false, description: 'Идентификатор последней задачи' }],
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
    preferredMode: 'deterministic',
    routingName: 'tasks_list_by_day',
    nativeToolName: 'tasks_by_day',
    templateId: null,
    handlerRef: 'handler:tasks.by_day',
    outputSchema: [{ name: 'tasks', type: 'array', required: true, description: 'Задачи за предыдущие сутки' }],
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
    preferredMode: 'deterministic',
    routingName: 'clock_resolve_date_after',
    nativeToolName: 'clock_date_after',
    templateId: null,
    handlerRef: 'handler:clock.date_after',
    inputSchema: [{ name: 'interval', type: 'string', required: true, description: 'Срок вида «через 3 дня»' }],
    outputSchema: [{ name: 'date', type: 'string', required: true, description: 'Дата по часам системы' }],
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
    preferredMode: 'deterministic',
    routingName: 'integrations_get_connection_status',
    nativeToolName: 'integrations_connection_status',
    templateId: null,
    handlerRef: 'handler:integrations.connection_status',
    inputSchema: [{ name: 'integrationId', type: 'string', required: true, description: 'Идентификатор интеграции' }],
    outputSchema: [{ name: 'connected', type: 'boolean', required: true, description: 'Подключена ли интеграция' }],
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
    preferredMode: 'template',
    routingName: 'catalog_describe_capabilities',
    nativeToolName: 'catalog_brief',
    templateId: 'catalog.brief',
    outputSchema: [{ name: 'text', type: 'string', required: true, description: 'Ответ о подключениях профиля' }],
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
    preferredMode: 'template',
    routingName: 'policy_describe_model_and_cost',
    nativeToolName: 'policy_model_facts',
    templateId: 'policy.model_facts',
    outputSchema: [{ name: 'text', type: 'string', required: true, description: 'Факты о модели и стоимости' }],
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
    preferredMode: 'deterministic',
    routingName: 'google_drive_read_file',
    nativeToolName: 'gdrive_read',
    templateId: 'capability.not_connected',
    handlerRef: 'handler:google-drive.read',
    inputSchema: [{ name: 'fileRef', type: 'string', required: true, description: 'Ссылка на файл на диске' }],
    outputSchema: [{ name: 'content', type: 'string', required: true, description: 'Содержимое файла' }],
    docsRefs: ['docs:google-drive.read'],
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
    preferredMode: 'deterministic',
    routingName: 'google_drive_share_file',
    nativeToolName: 'gdrive_share',
    templateId: 'capability.missing_input',
    handlerRef: 'handler:google-drive.share_file',
    inputSchema: [
      { name: 'email', type: 'string', required: true, description: 'E-mail получателя' },
      { name: 'fileRef', type: 'string', required: true, description: 'Ссылка на файл' },
    ],
    outputSchema: [{ name: 'shared', type: 'boolean', required: true, description: 'Файл отправлен' }],
    docsRefs: ['docs:google-drive.share_file'],
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
 *
 * Для метаданных P20 проверяются инварианты, которые иначе ломаются молча:
 * коллизии явных имён (routingName/nativeToolName), режим вне supportedModes,
 * непустые привязки реализации и корректные поля схем. Отсутствующее поле —
 * не ошибка: компилятор оформляет это как gap brief'а, а не как падение.
 */
const ROUTING_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

export function validateCatalog(catalog: CapabilityCatalog): CatalogValidation {
  const errors: string[] = [];
  const seen = new Set<string>();
  const routingNames = new Set<string>();
  const nativeNames = new Set<string>();
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
    if (entry.routingName !== undefined) {
      if (!ROUTING_NAME_RE.test(entry.routingName)) {
        errors.push(`${at}.routingName: expected snake_case (lowercase letters, digits, underscore), got "${entry.routingName}"`);
      } else if (routingNames.has(entry.routingName)) {
        errors.push(`${at}.routingName: duplicate "${entry.routingName}"`);
      } else {
        routingNames.add(entry.routingName);
      }
    }
    if (entry.nativeToolName != null && entry.nativeToolName !== '') {
      if (nativeNames.has(entry.nativeToolName)) {
        errors.push(`${at}.nativeToolName: duplicate "${entry.nativeToolName}"`);
      } else {
        nativeNames.add(entry.nativeToolName);
      }
    }
    if (entry.preferredMode !== undefined && !entry.supportedModes.includes(entry.preferredMode)) {
      errors.push(`${at}.preferredMode: "${entry.preferredMode}" is not in supportedModes`);
    }
    for (const [field, ref] of [
      ['handlerRef', entry.handlerRef],
      ['recipeId', entry.recipeId],
    ] as const) {
      if (ref !== undefined && ref !== null && ref.trim().length === 0) errors.push(`${at}.${field}: expected a non-empty reference`);
    }
    for (const [field, schema] of [
      ['inputSchema', entry.inputSchema],
      ['outputSchema', entry.outputSchema],
    ] as const) {
      if (schema === undefined) continue;
      for (const [j, spec] of schema.entries()) {
        if (!spec.name || !spec.type || !spec.description || typeof spec.required !== 'boolean') {
          errors.push(`${at}.${field}[${j}]: expected { name, type, required, description }`);
        }
      }
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
