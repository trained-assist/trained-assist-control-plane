#!/usr/bin/env node
/**
 * Единственный sandbox-клиент own-API dogfood (#23).
 *
 * Клиент ходит в тот же публичный Task API, который получат Web и Telegram:
 *   POST /intake              приём задачи (квитанция, не запуск)
 *   POST /start               запуск задачи
 *   POST /status              статус (только чтение)
 *   GET  /report              структурированный результат: текст движка + манифесты
 *   GET  /artifact?taskId&ref байты файла (read-only прокси, ключ не в URL)
 *
 * Принцип: control plane — единственный владелец запуска. Клиент НЕ вызывает
 * `POST /v1/runs` напрямую, НЕ пишет в workspace и НЕ подменяет результаты
 * ручной загрузкой. Запуск только через `/start`.
 *
 * Личность - подписью HMAC (см. src/auth/principal-auth.ts), секрет только из
 * SM/env. Секреты в вывод не печатаются.
 *
 * Использование:
 *   PRINCIPAL_SECRET=... node tools/own-api-dogfood-client.js \
 *     --base https://<worker>.workers.dev --principal sandbox-cp23 \
 *     --profile profile-cp23 --goal "создай файл report.md ..."
 */
import { createHash, createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const read = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const BASE = (read('base', process.env.BASE) ?? '').replace(/\/$/, '');
const PRINCIPAL = read('principal', process.env.PRINCIPAL ?? 'sandbox-cp23');
const PROFILE = read('profile', process.env.PROFILE ?? 'profile-cp23');
const GOAL = read('goal', process.env.GOAL ?? '');
const SECRET = process.env.PRINCIPAL_SECRET;
const OUT_DIR = read('out', process.env.OUT_DIR ?? '.');

if (!BASE || !GOAL || !SECRET) {
  console.error('нужны --base, --goal и окружение PRINCIPAL_SECRET');
  process.exit(2);
}

// HMAC-SHA256(secret, principalId) — то же, что проверяет control plane.
const hmac = (principal) => createHmac('sha256', SECRET).update(principal).digest('hex');
const authHeaders = () => ({ 'x-principal': PRINCIPAL, 'x-principal-sig': hmac(PRINCIPAL) });

// Пробуждение worker'а после простоя может занять десятки секунд — таймаут
// запроса шире дефолтных 10s, иначе ложный провал вместо результата.
const REQUEST_TIMEOUT_MS = 90_000;

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? authHeaders() : { ...authHeaders(), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const requestId = `dogfood-${Date.now()}`;
const RESUME_TASK_ID = read('taskId', process.env.TASK_ID);
const RESUME = Boolean(RESUME_TASK_ID);
const TASK_ID = RESUME_TASK_ID ?? null;

const intake = { userTaskId: TASK_ID };
let started = { runId: null, pilotRoute: 'resume' };

if (!RESUME) {
console.log('== 1. приём задачи (POST /intake) ==');
Object.assign(intake, await call('POST', '/intake', {
  contractVersion: 1,
  requestId,
  profileId: PROFILE,
  inputItems: [{ text: GOAL }],
}));
if (intake.durable !== true) fail(`квитанция не durable: ${JSON.stringify(intake)}`);
console.log(`OK: userTaskId=${intake.userTaskId} durable=${intake.durable} duplicate=${intake.duplicate}`);
} else {
  console.log(`== 1. переподключение к существующей задаче (${TASK_ID}) ==`);
}

if (!RESUME) {
console.log('== 2. запуск (POST /start) ==');
started = await call('POST', '/start', { taskId: intake.userTaskId, profileId: PROFILE, goal: GOAL });
console.log(`OK: попытка=${started.runId} pilotRoute=${started.pilotRoute}`);
} else {
  console.log('== 2. без повторного запуска: переподключение читает тот же Run ==');
}

console.log('== 3. ожидание результата (POST /status, только чтение) ==');
let status = null;
for (let i = 0; i < 120; i++) {
  status = await call('POST', '/status', { taskId: intake.userTaskId });
  if (['done', 'failed', 'cancelled'].includes(status.taskStore.status)) break;
  await sleep(2000);
}
const task = status.taskStore;
console.log(`OK: status=${task.status} stage=${task.stage}`);
if (task.status !== 'done') fail(`задача не завершилась успешно: ${task.status}`);

console.log('== 4. результат (GET /report) ==');
const snapshot = (await call('GET', `/report?taskId=${intake.userTaskId}`)).snapshot;
const answer = snapshot.answer;
if (typeof answer !== 'string' || answer.length === 0) {
  fail(`движок не вернул текст: ${JSON.stringify(snapshot.result)}`);
}
console.log(`OK: текст движка (${answer.length} символов):`);
for (const line of answer.split('\n').slice(0, 12)) console.log(`  | ${line}`);

console.log('== 5. артефакты ==');
// Сверка с манифестами Runner'а: объявленные выходы сейчас не экспортируются
// (дефект Runner'а, см. отчёт в #23), поэтому ссылки берём из его манифестов.
const reconciled = await call('POST', '/artifacts/reconcile', { taskId: intake.userTaskId });
console.log(`OK: reconcile added=${reconciled.added} total=${reconciled.total}`);
const after = (await call('GET', `/report?taskId=${intake.userTaskId}`)).snapshot;
if (!after.artifacts.length) fail('артефактов нет после сверки');
for (const artifact of after.artifacts) {
  console.log(`  ${artifact.ref} size=${artifact.sizeBytes} sha256=${artifact.sha256 ?? 'н/д'}`);
}

console.log('== 6. скачивание и проверка checksum ==');
let checked = 0;
for (const artifact of after.artifacts) {
  const url = `${BASE}/artifact?taskId=${intake.userTaskId}&ref=${encodeURIComponent(artifact.ref)}`;
  const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) fail(`артефакт ${artifact.ref}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = sha256(bytes);
  if (artifact.sha256 && digest !== artifact.sha256) {
    fail(`checksum не совпал: ожидали ${artifact.sha256}, получили ${digest} (${artifact.ref})`);
  }
  // Ссылка на скачивание не содержит ни ключа Runner'а, ни подписи.
  if (/key=|token=|authorization|bearer/i.test(url)) fail('в URL скачивания есть секрет');
  const name = artifact.name || artifact.ref.split('/').pop() || 'artifact';
  await writeFile(`${OUT_DIR}/${name}`, bytes);
  console.log(`OK: ${name} — ${bytes.length} байт, sha256=${digest}${artifact.sha256 ? ' (совпал с манифестом)' : ' (манифест без суммы)'}`);
  checked += 1;
}
if (!checked) fail('нечего скачивать');

console.log(`\nPASS: пользователь получил реальный текст и ${checked} файл(ов), checksum проверен`);
console.log(`EVIDENCE userTaskId=${intake.userTaskId} runId=${task.result?.runId ?? null} artifacts=${after.artifacts.length}`);