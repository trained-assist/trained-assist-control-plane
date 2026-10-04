#!/usr/bin/env node
/**
 * Сборка sanitized evidence P16 (SANDBOX I05): читает сырые логи песочницы и
 * пишет транскрипт + JSONL событий в `docs/evidence`.
 *
 * Принцип — fail closed, а не «причесать на выходе»: если в сырых логах есть
 * значение секрета прогона, e-mail вне доменов RFC 2606 или домашний путь,
 * транскрипт НЕ собирается и вызывающий получает ненулевой код выхода.
 * Проверяется вход, поэтому «секреты не попали в evidence» — измеримый факт.
 *
 * Модуль экспортирует `sanitizeEvidence`, поэтому его проверяет тест CI; CLI —
 * тонкая обёртка `tools/p16-sanitize-evidence.mjs`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const NOTE = 'Проверяются: значение PRINCIPAL_SECRET этого прогона, e-mail вне доменов RFC 2606, телефоны, абсолютные пути пользователя.';
const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net', 'localhost', 'invalid', 'test'];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.[A-Za-z0-9-]+)/g;
// Телефон ловится по форме, а не по «длинной последовательности цифр»: в журнале
// полно идентификаторов и epoch-миллисекунд, и они не являются персональными
// данными. Проверяются только явные телефонные формы.
const PHONE_RE = /\+\d[\d\s().-]{6,}\d|\(\d{2,4}\)[\d\s.-]{5,}\d|\b\d{3}-\d{3}-\d{2}-\d{2}\b/g;
const HOME_PATH_RE = /\/(?:Users|home)\/[A-Za-z0-9._-]+/g;
const WRANGLER_STATE_RE = /_scratch\/p16-sandbox\/state[^\s"']*/g;

function isPhone(candidate) {
  return candidate.replace(/\D/g, '').length >= 10;
}

function phoneMatches(text) {
  return [...text.matchAll(PHONE_RE)].map((m) => m[0]).filter(isPhone);
}

function personalEmails(text) {
  return [...text.matchAll(EMAIL_RE)].map((m) => m[0]).filter((m) => !RESERVED_DOMAINS.includes(m[1] ?? ''));
}

function homePaths(text) {
  return [...text.matchAll(HOME_PATH_RE)].map((m) => m[0]);
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

/** Только события маршрута: служебный шум dev-сервера в evidence не нужен. */
const ROUTING_EVENTS = new Set([
  'routing.decision',
  'routing.technical_error',
  'routing.blocked',
  'routing.escalated',
  'route.dispatched',
  'intake.accepted',
]);

const PROBE_FILES = ['pr21.json', 'pr23.json', 'permission.json', 'fault-refused.json'];

/** Измеренные прогонные счётчики `run_started` в журнале задач (не утверждение). */
function readRunCounts(rawDir) {
  const text = readIfExists(join(rawDir, 'runs.json'));
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function jsonLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event !== null);
}

function collect(rawDir, secret) {
  const workerLog = readIfExists(join(rawDir, 'worker.log'));
  const faultLog = readIfExists(join(rawDir, 'worker-fault.log'));
  const events = [...jsonLines(workerLog), ...jsonLines(faultLog)].filter((event) => ROUTING_EVENTS.has(event.event));
  const failures = [...audit('worker.log', workerLog, secret), ...audit('worker-fault.log', faultLog, secret)];
  const eventsText = events
    .map((event) => scrub(JSON.stringify(event), secret))
    .join('\n');
  const probes = PROBE_FILES.map((name) => [name, readIfExists(join(rawDir, name))]).filter(([, text]) => text.trim().length > 0);
  return {
    events,
    decisions: events.filter((event) => event.event === 'routing.decision'),
    eventsText,
    failures,
    probes,
    runCounts: readRunCounts(rawDir),
    digest: createHash('sha256').update(eventsText).digest('hex'),
    secret,
  };
}

function probeSummary(text, secret) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return {
    route: parsed.route,
    mode: parsed.mode,
    reasonCode: parsed.reasonCode,
    outcome: parsed.outcome,
    needsExecutor: parsed.needsExecutor,
    executor: parsed.executor,
    replyAllowed: parsed.replyAllowed,
    capabilityId: parsed.capabilityId,
    coverage: parsed.coverage,
    schemaOutcome: parsed.schemaOutcome,
    semanticOutcome: parsed.semanticOutcome,
    modelCalls: parsed.modelCalls,
    execution: parsed.execution,
    workOrder: parsed.workOrder
      ? {
          executor: parsed.workOrder.executor,
          originalRequestRef: parsed.workOrder.originalRequestRef,
          requiresConfirmation: parsed.workOrder.requiresConfirmation,
        }
      : null,
    reply: parsed.reply ? { text: scrub(String(parsed.reply.text), secret) } : null,
    evidence: parsed.evidence,
  };
}

function buildTranscript(collected) {
  const { decisions, probes, digest, secret } = collected;
  const lines = [];
  lines.push('# P16 · sanitized transcript песочницы Task Router');
  lines.push('');
  lines.push('Карточка [trained-agent-architecture#55](https://github.com/trained-assist/trained-agent-architecture/issues/55), этап I05 ([SANDBOX](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md#i05--первый-fast-path)).');
  lines.push('');
  lines.push('Прогон воспроизводится одной командой в изолированной песочнице (отдельная D1, отдельный порт,');
  lines.push('отдельный принципал и сгенерированный на прогон секрет подписи, без сети и внешних сервисов):');
  lines.push('');
  lines.push('```bash');
  lines.push('./tools/p16-sandbox-probe.sh');
  lines.push('```');
  lines.push('');
  lines.push('## Изоляция прогона');
  lines.push('');
  lines.push('| Что | Значение |');
  lines.push('|---|---|');
  lines.push('| Состояние D1 | `<sandbox-state>` — отдельный каталог `_scratch/p16-sandbox/state`, не общий dev-стенд |');
  lines.push('| Принципал | `sandbox-cp16` / `profile-cp16`, scopes только приёма и чтения |');
  lines.push('| Секрет подписи | сгенерирован на прогон, лежит в `.dev.vars` (gitignored, chmod 600), в evidence не попадает |');
  lines.push('| Сеть и внешние сервисы | не используются; исполнитель не запускается — есть только заявка OpenCode |');
  lines.push('| Фиксированные часы | `ROUTER_CLOCK=1793388600000` → 2026-09-30T23:10:00+03:00 (детерминированные даты) |');
  lines.push('');
  lines.push('## Что проверялось');
  lines.push('');
  lines.push('| # | Проба | Что видит пользователь | Сигнал в журнале |');
  lines.push('|---|---|---|---|');
  lines.push('| 1 | PR-23 · ссылка в цитате | быстрый ответ по тексту; страница не открывается | `route=llm`, `agentDispatchAttempts=0`, `agentStarted=false`, `run_started` = 0 |');
  lines.push('| 2 | PR-21 · вопрос о живых данных | «передаю исполнителю»; числа нет | `route=agent`, `executor=opencode`, `replyAllowed=false`, `run_started` = 0 |');
  lines.push('| 3 | AC-126 · права | право не выводится из текста запроса | `PERMISSION_DENIED`, `needsExecutor=false`, `permissionSource=identity_snapshot`, `run_started` = 0 |');
  lines.push('| 4 | управляемый сбой recipe | честная причина, а не «ответ» | `outcome=technical_error`, `schemaOutcome=refused`, `escalationAttempt=false`, `run_started` = 0 |');
  lines.push('');
  lines.push('### Измеренные `run_started` в журнале задач');
  lines.push('');
  lines.push('Считается прямо в D1 песочницы после каждой пробы (`SELECT COUNT(*) … WHERE kind=\'run_started\'`).');
  lines.push('Ноль означает: ни одна проба не дошла до запуска попытки исполнения.');
  lines.push('');
  lines.push('| Проба | userTaskId | run_started |');
  lines.push('|---|---|---|');
  for (const [label, value] of Object.entries(collected.runCounts ?? {})) {
    lines.push(`| ${label} | ${value.userTaskId ?? '—'} | ${value.run_started ?? '—'} |`);
  }
  lines.push('');
  lines.push('## Решения маршрута (журнал worker\'а, санитизировано)');
  lines.push('');
  lines.push('| userTaskId | route | mode | reasonCode | outcome | needsExecutor | escalationAttempt | permissionSource |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const event of decisions) {
    lines.push(
      `| ${event.userTaskId} | ${event.route} | ${event.mode} | ${event.reasonCode} | ${event.outcome} | ${event.needsExecutor} | ${event.escalationAttempt} | ${event.permissionSource} |`,
    );
  }
  lines.push('');
  lines.push('## Ответы проб');
  lines.push('');
  lines.push('В песочнице recipe — заглушка без модели (`ROUTER_RECIPE_STUB`), поэтому её ответ эхом повторяет');
  lines.push('входной текст. В **журнал** маршрута текст запроса не пишется: там только идентификаторы,');
  lines.push('признаки и причины (проверяется тестом `tests/p16-probe-pr21-live-data.test.ts`).');
  lines.push('');
  for (const [name, text] of probes) {
    const summary = probeSummary(text, secret);
    lines.push(`### ${name}`);
    lines.push('');
    lines.push('```json');
    lines.push(scrub(summary === null ? '(сырой ответ не читается как JSON)' : JSON.stringify(summary, null, 1), secret));
    lines.push('```');
    lines.push('');
  }
  lines.push('## Проверка санитизации');
  lines.push('');
  lines.push(NOTE);
  lines.push('');
  lines.push(`- sha256 санитизированных событий: \`${digest}\``);
  lines.push(`- строк журнала маршрута в evidence: ${decisions.length}`);
  lines.push('- сборка из тех же сырых логов даёт тот же sha256: транскрипт воспроизводим;');
  lines.push('- текст запроса в журнал не пишется — только идентификаторы, признаки и причины;');
  lines.push('- негативные проверки санитизации (секрет, e-mail, домашний путь, телефон) выполняет `tools/p16-evidence-selfcheck.mjs`, он же гоняется в CI (`npm run check:evidence`).');
  lines.push('');
  return lines.join('\n');
}

/**
 * Собрать транскрипт и JSONL событий.
 * @param {{rawDir: string, outDir: string, secret?: string}} options
 * @returns {{decisions: number, digest: string, outDir: string}}
 */
export function sanitizeEvidence(options) {
  const rawDir = resolve(options.rawDir);
  const outDir = resolve(options.outDir);
  const secret = options.secret ?? '';
  const collected = collect(rawDir, secret);
  const transcript = buildTranscript(collected);
  const findings = [...collected.failures, ...audit('transcript', transcript, secret)];
  if (findings.length > 0) {
    const error = new Error('санитизация не пройдена');
    error.findings = findings;
    throw error;
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'P16-SANDBOX-TRANSCRIPT.md'), transcript, 'utf8');
  writeFileSync(join(outDir, 'p16-sandbox-events.jsonl'), `${collected.eventsText}\n`, 'utf8');
  return { decisions: collected.decisions.length, digest: collected.digest, outDir };
}
