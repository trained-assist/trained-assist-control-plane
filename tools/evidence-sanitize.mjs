#!/usr/bin/env node
/**
 * Общие правила санитизации evidence песочницы (P16, P17).
 *
 * Принцип — fail closed, а не «причесать на выходе»: если в сырых логах есть
 * значение секрета прогона, e-mail вне доменов RFC 2606 или домашний путь,
 * транскрипт НЕ собирается и вызывающий получает ненулевой код выхода.
 * Проверяется вход, поэтому «секреты не попали в evidence» — измеримый факт.
 *
 * Правила живут здесь, а не в карточке-конструкторе, потому что это набор
 * требований безопасности evidence: две копии одного и того же правила со
 * временем разъезжаются, и «секрет не попал в транскрипт P17» перестаёт быть
 * проверяемым. Негативные проверки — `tools/p16-evidence-selfcheck.mjs`.
 */
import { existsSync, readFileSync } from 'node:fs';

export const SANITIZATION_NOTE =
  'Проверяются: значение PRINCIPAL_SECRET этого прогона, e-mail вне доменов RFC 2606, телефоны, абсолютные пути пользователя.';

const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net', 'localhost', 'invalid', 'test'];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.[A-Za-z0-9-]+)/g;
// Телефон ловится по форме, а не по «длинной последовательности цифр»: в журнале
// полно идентификаторов и epoch-миллисекунд, и они не являются персональными
// данными. Проверяются только явные телефонные формы.
const PHONE_RE = /\+\d[\d\s().-]{6,}\d|\(\d{2,4}\)[\d\s.-]{5,}\d|\b\d{3}-\d{3}-\d{2}-\d{2}\b/g;
const HOME_PATH_RE = /\/(?:Users|home)\/[A-Za-z0-9._-]+/g;
const SANDBOX_STATE_RE = /_scratch\/p1[67]-sandbox\/state[^\s"']*/g;

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
export function audit(label, text, secret) {
  const found = [];
  if (secret && text.includes(secret)) found.push(`${label}: значение PRINCIPAL_SECRET в тексте`);
  for (const email of personalEmails(text)) found.push(`${label}: e-mail ${email}`);
  for (const path of homePaths(text)) found.push(`${label}: домашний путь ${path}`);
  for (const phone of phoneMatches(text)) found.push(`${label}: телефон ${phone.trim()}`);
  return found;
}

export function scrub(text, secret) {
  return text
    .replaceAll(secret, secret ? '<PRINCIPAL_SECRET>' : '<none>')
    .replace(EMAIL_RE, (m, domain) => (RESERVED_DOMAINS.includes(domain) ? m : '<email>'))
    .replace(PHONE_RE, (m) => (isPhone(m) ? '<phone>' : m))
    .replace(HOME_PATH_RE, '<home-path>')
    .replace(SANDBOX_STATE_RE, '<sandbox-state>');
}

export function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Строки журнала, которые читаются как JSON; служебный шум игнорируется. */
export function jsonLines(text) {
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

/** Собрать находки по всем входам и по готовому транскрипту, либо бросить. */
export function refuseIfDirty(label, texts, transcript, secret) {
  const findings = texts.flatMap(([name, text]) => audit(name, text, secret));
  findings.push(...audit(label, transcript, secret));
  if (findings.length === 0) return;
  const error = new Error('санитизация не пройдена');
  error.findings = findings;
  throw error;
}