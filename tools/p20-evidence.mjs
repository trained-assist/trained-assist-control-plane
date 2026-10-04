#!/usr/bin/env node
/**
 * Санитизация evidence P20 (SANDBOX I06): читает логи песочницы и пишет
 * транскрипт + JSONL событий в `docs/evidence`.
 *
 * Принцип — fail closed, как у P16: если в сырых логах есть значение секрета
 * прогона, e-mail вне доменов RFC 2606, телефон или домашний путь, транскрипт
 * НЕ собирается и вызывающий получает ненулевой код выхода. Проверяется вход,
 * поэтому «секреты и личные данные не попали в evidence» — измеримый факт.
 *
 * Модуль экспортирует `sanitizeP20Evidence`, поэтому его проверяет тест CI;
 * CLI — тонкая обёртка `tools/p20-sanitize-evidence.mjs`.
 */
import { createHash } from 'node:crypto';

const NOTE = 'Проверяются: значение PRINCIPAL_SECRET этого прогона, e-mail вне доменов RFC 2606, телефоны, абсолютные пути пользователя.';
const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net', 'localhost', 'invalid', 'test'];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.[A-Za-z0-9-]+)/g;
const PHONE_RE = /\+\d[\d\s().-]{6,}\d|\(\d{2,4}\)[\d\s.-]{5,}\d|\b\d{3}-\d{3}-\d{2}-\d{2}\b/g;
const HOME_PATH_RE = /\/(?:Users|home)\/[A-Za-z0-9._-]+/g;
const WRANGLER_STATE_RE = /_scratch\/p20-sandbox\/state[^\s"']*/g;

/** Только события маршрута и brief'а: служебный шум dev-сервера в evidence не нужен. */
const ROUTING_EVENTS = new Set([
  'routing.decision',
  'routing.brief',
  'routing.technical_error',
  'routing.blocked',
  'routing.escalated',
  'route.dispatched',
  'intake.accepted',
]);

/** Файлы проб: ответы POST /route, приведённые к журнальным полям (без текста запроса). */
const PROBE_FILES = ['brief.json', 'budget.json', 'over-budget.json', 'fault-refused.json'];

function isPhone(candidate) {
  return candidate.replace(/\D/g, '').length >= 10;
}

function personalEmails(text) {
  return [...text.matchAll(EMAIL_RE)].map((m) => m[0]).filter((m) => !RESERVED_DOMAINS.includes(m[1] ?? ''));
}

function homePaths(text) {
  return [...text.matchAll(HOME_PATH_RE)].map((m) => m[0]);
}

function phoneMatches(text) {
  return [...text.matchAll(PHONE_RE)].map((m) => m[0]).filter(isPhone);
}

/** Находки для отчёта; пустой массив = «в этих данных ничего лишнего нет». */
function audit(label, text, secret) {
  const found = [];
  if (secret && text.includes(secret)) found.push(`${label}: значение PRINCIPAL_SECRET в тексте`);
  for (const email of personalEmails(text)) found.push(`${label}: e-mail ${email}`);
  for (const path of homePaths(text)) found.push(`${label}: домашний путь ${path}`);
  for (const phone of phoneMatches(text)) found.push(`${label}: телефон ${phone.trim()}`);
  return found;
}

function scrub(text, secret) {
  return text
    .replaceAll(secret, secret ? '<PRINCIPAL_SECRET>' : '<none>')
    .replace(EMAIL_RE, (m, domain) => (RESERVED_DOMAINS.includes(domain) ? m : '<email>'))
    .replace(PHONE_RE, (m) => (isPhone(m) ? '<phone>' : m))
    .replace(HOME_PATH_RE, '<home-path>')
    .replace(WRANGLER_STATE_RE, '<sandbox-state>');
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Журнальные поля пробы: только идентификаторы, версии, причины и счётчики. */
function probeEvent(name, probe) {
  const brief = probe.brief ?? {};
  return {
    probe: name,
    decisionId: probe.decisionId ?? null,
    route: probe.route ?? null,
    mode: probe.mode ?? null,
    reasonCode: probe.reasonCode ?? null,
    outcome: probe.outcome ?? null,
    needsExecutor: probe.needsExecutor ?? null,
    executor: probe.executor ?? null,
    escalationAttempt: probe.escalationAttempt ?? null,
    modelCalls: probe.modelCalls ?? null,
    execution: probe.execution ?? null,
    coverage: probe.coverage ?? null,
    schemaOutcome: probe.schemaOutcome ?? null,
    semanticOutcome: probe.semanticOutcome ?? null,
    permissionSource: probe.evidence?.permissionSource ?? null,
    authorizationRef: probe.evidence?.authorizationRef ?? null,
    catalogVersion: probe.evidence?.catalogVersion ?? null,
    contextVersion: probe.evidence?.contextVersion ?? null,
    brief: {
      status: brief.status ?? null,
      briefId: brief.briefId ?? null,
      tier1: Array.isArray(brief.tier1) ? brief.tier1.length : (brief.tier1 ?? null),
      tier2: Array.isArray(brief.tier2) ? brief.tier2.length : (brief.tier2 ?? null),
      candidates: brief.candidates ?? null,
      omittedByBudget: brief.omittedByBudget ?? null,
      excludedByScope: brief.excludedByScope ?? null,
      degraded: brief.degraded ?? null,
      bytes: brief.bytes ?? null,
      budget: brief.budget ?? null,
      cache: brief.cache ?? null,
    },
  };
}

/**
 * Собрать sanitized transcript из сырых строк журнала.
 *
 * @param {{ lines: string[], secret?: string, probes?: Array<{ probe: string, value: object }> }} params
 * @returns {{ events: string[], transcript: string, digest: string }}
 * @throws {{ findings: string[] }} — если на входе секрет или личные данные.
 */
export function sanitizeP20Evidence({ lines, secret = '', probes = [] }) {
  const findings = [];
  const events = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    findings.push(...audit(`line ${index + 1}`, trimmed, secret));
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && ROUTING_EVENTS.has(parsed.event)) {
      events.push(JSON.stringify({ ...parsed }));
    }
  }
  for (const probe of probes) {
    findings.push(...audit(`probe ${probe.probe}`, JSON.stringify(probe.value), secret));
  }
  if (findings.length > 0) {
    const error = new Error('санитизация: на входе секрет или личные данные');
    error.findings = findings;
    throw error;
  }
  const scrubbed = events.map((line) => scrub(line, secret));
  const probeEvents = probes.map((probe) => probeEvent(probe.probe, probe.value));
  const transcript = [
    '# P20 · sanitized transcript песочницы Brief builder',
    '',
    'Карточка [trained-agent-architecture#59](https://github.com/trained-assist/trained-agent-architecture/issues/59), этап I06 ([SANDBOX](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md#i06--capability-catalog)).',
    '',
    'Прогон воспроизводится одной командой в изолированной песочнице (отдельная D1, отдельный порт,',
    'отдельный принципал и сгенерированный на прогон секрет подписи, без сети и внешних сервисов):',
    '',
    '```bash',
    './tools/p20-brief-probe.sh',
    '```',
    '',
    '## Изоляция прогона',
    '',
    '| Что | Значение |',
    '|---|---|',
    '| Состояние D1 | отдельный каталог `_scratch/p20-sandbox/state`, не общий dev-стенд |',
    '| Принципал | `sandbox-cp20` / `profile-cp20`, scopes только приёма и чтения |',
    '| Секрет подписи | сгенерирован на прогон, лежит в `.dev.vars` (gitignored, chmod 600), в evidence не попадает |',
    '| Сеть и внешние сервисы | не используются; исполнитель не запускается — есть только заявка OpenCode |',
    '| Фиксированные часы | `ROUTER_CLOCK=1793388600000` → 2026-09-30T23:10:00+03:00 (детерминированные даты) |',
    '',
    '## Что проверялось',
    '',
    '| # | Проба | Что видно в ответе и журнале |',
    '|---|---|---|',
    '| 1 | brief собран | `routing.brief`: briefId, ключ кэша, попадание, байты, Tier-1/Tier-2, бюджет |',
    '| 2 | кэш по области | тот же профиль/контекст → `cacheHit=true`; тот же ключ, пересборки нет |',
    '| 3a | права не выдуманы | неподключённая интеграция → `availability=not_connected`, `executable=false` |',
    '| 3b | права не выдуманы | подключено, но нет обязательного входа → `input_missing` |',
    '| 4 | бюджет размера | `ROUTER_BRIEF_MAX_BYTES` мал → деградация Tier-2, `withinBudget=true` |',
    '| 5 | управляемый сбой | минимальный Tier-1 не влезает → `BRIEF_BUDGET_EXCEEDED`, модель не звалась |',
    '| 6 | сбой модели | `refused` → `technical_error`, исполнитель не включается |',
    '',
    '## Пробы (ответы POST /route)',
    '',
    '```json',
    JSON.stringify(probeEvents, null, 1),
    '```',
    '',
    '## События журнала',
    '',
    `Только события маршрута и briefа. ${NOTE}`,
    '',
    '```jsonl',
    ...scrubbed,
    '```',
    '',
    '## Измерения',
    '',
    'Размер briefа считается в байтах UTF-8 (TextEncoder), а не в «токенах»: одинаковый вход',
    'даёт одинаковый `briefId`, а превышение бюджета видно по шагам измерения',
    '(`full` → `tier1-only` → `tier1-minimal` → `tier1-minimal+tier2:N`).',
    '',
  ].join('\n');
  return { events: scrubbed, transcript, digest: sha256(scrubbed.join('\n')) };
}

export { PROBE_FILES };
