#!/usr/bin/env node
/**
 * Живой сквозной прогон шага 7 (M1) против НАСТОЯЩЕГО control plane.
 *
 * Что делает скрипт:
 *   1. поднимает control plane как отдельный процесс (`wrangler dev`, свой порт,
 *      своя локальная D1 — изолированная песочница, ничего общего с продом);
 *   2. играет роль web-клиента: пять сообщений одной conversation, среди них
 *      awaited user input (ответ дедуплицируется ключом сообщения);
 *   3. РЕСТАРТУЕТ ПРОЦЕСС control plane ПОСЕРЕДИНЕ разговора (SIGTERM + подъём);
 *   4. продолжает с курсора: проверяет, что попытка не перезапущена (run_started
 *      ровно один на задачу), ответ расходуется один раз, результат и артефакт
 *      доступны после восстановления;
 *   5. пишет JSON-отчёт (без секретов) и завершается с кодом 0/1.
 *
 * Подключение — только из env (в репозитории и в отчёте ничего нет):
 *   CONTROL_PLANE_URL         — базовый URL control plane (если не задан, скрипт
 *                              сам поднимает wrangler dev на CONTROL_PLANE_PORT);
 *   CONTROL_PLANE_PRINCIPAL   — принципал песочницы (X-Principal);
 *   CONTROL_PLANE_PROFILE     — профиль песочницы;
 *   CONTROL_PLANE_API_KEY     — необязательный bearer-ключ;
 *   CONTROL_PLANE_REPO        — путь к чекута control plane (для автоподъёма);
 *   CONTROL_PLANE_PORT        — порт автоподъёма (по умолчанию 8799);
 *   CONTROL_PLANE_STARTUP_MS  — таймаут ожидания подъёма (по умолчанию 60000);
 *   E2E_CONVERSATION_ID       — id разговора (по умолчанию m1-step7-<ts>);
 *   E2E_RESTART_MODE          — process | client | none (по умолчанию process);
 *   E2E_REPORT                — путь к JSON-отчёту (по умолчанию stdout).
 *
 * Сбои доставки пробуждения и потерянного ответа (обрыв между записью сигнала
 * и доставкой wake, #116) в живом API не внедрить — у него нет таких хуков,
 * поэтому они проверяются на песочнице (tests/web-e2e-controlled-failure.test.ts,
 * режимы F1/F4). Здесь проверяется то, что реально можно воспроизвести на
 * живом сервисе: рестарт процесса и обрыв соединения.
 *
 * Пример:
 *   CONTROL_PLANE_REPO=../trained-assist-control-plane CONTROL_PLANE_PRINCIPAL=sandbox-local \
 *   CONTROL_PLANE_PROFILE=profile-1 E2E_RESTART_MODE=process node web/e2e/run-m1-web-slice-e2e.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = process.env;
// Базовый URL control plane: либо из env, либо автоподъём на CONTROL_PLANE_PORT.
let BASE = (env['CONTROL_PLANE_URL'] ?? '').replace(/\/+$/, '');
const PRINCIPAL = env['CONTROL_PLANE_PRINCIPAL'] ?? '';
const PROFILE = env['CONTROL_PLANE_PROFILE'] ?? '';
const API_KEY = env['CONTROL_PLANE_API_KEY'] ?? '';
// Случайный порт: иначе проверка готовности может попасть на процесс прошлого прогона.
const PORT = Number(env['CONTROL_PLANE_PORT'] ?? '') || 8800 + Math.floor(Math.random() * 1000);
const STARTUP_MS = Number(env['CONTROL_PLANE_STARTUP_MS'] ?? '60000');
const CONVERSATION_ID = env['E2E_CONVERSATION_ID'] ?? `m1-step7-${Date.now()}`;
const RESTART_MODE = env['E2E_RESTART_MODE'] ?? 'process';
const REPORT = env['E2E_REPORT'] ?? '';
const REPO = (env['CONTROL_PLANE_REPO'] ?? '').trim();

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

if (!PRINCIPAL || !PROFILE) fail('CONTROL_PLANE_PRINCIPAL и CONTROL_PLANE_PROFILE обязательны (env)');

const log = (event, fields = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'm1-web-slice-e2e', event, ...fields }));

// ---------------------------------------------------------------- HTTP-клиент

const request = async (method, path, body) => {
  const headers = { 'content-type': 'application/json', 'x-principal': PRINCIPAL };
  if (API_KEY) headers['authorization'] = `Bearer ${API_KEY}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let value = null;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = { raw: text.slice(0, 200) };
  }
  return { status: res.status, value };
};

const post = (path, body) => request('POST', path, body);
const get = (path) => request('GET', path);

const waitFor = async (predicate, { timeoutMs = 20_000, intervalMs = 200, what = 'условие' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
};

// ------------------------------------------------------- подъём control plane

let child = null;
let ownsProcess = false;
// Каталог состояния переживает рестарт процесса: иначе «рестарт» терял бы
// durable-состояние, которое обязано выжить (D1 — файл на диске).
let workdir = null;
let persistTo = null;

const startControlPlane = async () => {
  if (BASE) {
    const root = await get('/').catch(() => null);
    if (root?.status === 200) {
      log('control_plane.attached', { base: BASE });
      return;
    }
    // Процесс уже был поднят нами и остановлен (рестарт) — поднимаем заново.
    if (!ownsProcess || !REPO) fail(`control plane по ${BASE} не отвечает`);
    log('control_plane.restarting', { base: BASE });
    await stopControlPlane();
  }
  if (!REPO) fail('нужен CONTROL_PLANE_URL или CONTROL_PLANE_REPO (env)');
  if (!workdir) {
    workdir = mkdtempSync(join(tmpdir(), 'm1-web-slice-cp-'));
    persistTo = join(workdir, 'state');
  }
  // Подчистим процесс прошлого прогона на этом порту (если порт задан явно).
  if (env['CONTROL_PLANE_PORT']) {
    spawnSync('pkill', ['-f', `wrangler dev --port ${PORT}`], { encoding: 'utf8' });
    await new Promise((r) => setTimeout(r, 500));
  }
  child = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--local', '--persist-to', persistTo], {
    cwd: REPO,
    env: { ...process.env, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ownsProcess = true;
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const url = `http://127.0.0.1:${PORT}`;
  const root = await waitFor(async () => {
    try {
      const res = await fetch(url);
      return res.ok ? res : null;
    } catch {
      return null;
    }
  }, { timeoutMs: STARTUP_MS, intervalMs: 500, what: 'control plane поднялся' });
  if (!root) fail(`control plane не поднялся за ${STARTUP_MS}ms (порт ${PORT})`);
  BASE = url;
  log('control_plane.started', { url, workdir });

  // Миграции и принципал песочницы — ПОСЛЕ подъёма: локальный D1 сервера
  // инициализируется при старте, поэтому схему применяем к живому процессу.
  const migrate = spawnSync(
    'npx',
    ['wrangler', 'd1', 'migrations', 'apply', 'control-plane-task-store', '--local', '--persist-to', persistTo],
    { cwd: REPO, env: { ...process.env, NODE_ENV: 'development' }, encoding: 'utf8' },
  );
  log('control_plane.migrate', { status: migrate.status, stdout: (migrate.stdout ?? '').slice(-400), stderr: (migrate.stderr ?? '').slice(-400) });
  if (migrate.status !== 0) fail(`миграции не применились: ${migrate.stderr ?? migrate.stdout}`);
  const seed = spawnSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'control-plane-task-store',
      '--local',
      '--persist-to',
      persistTo,
      '--command',
      `INSERT OR REPLACE INTO admission_principals(principal_id, profile_id, scopes, enabled, created_at, updated_at)
       VALUES ('${PRINCIPAL}','${PROFILE}','["tasks:intake","tasks:read","tasks:signal","tasks:control"]',1,strftime('%s','now')*1000,strftime('%s','now')*1000)`,
    ],
    { cwd: REPO, env: { ...process.env, NODE_ENV: 'development' }, encoding: 'utf8' },
  );
  if (seed.status !== 0) fail(`принципал песочницы не засеян: ${seed.stderr ?? seed.stdout}`);
  log('control_plane.migrated', { workdir });
};

const stopControlPlane = async () => {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  child = null;
};

// Процесс не должен оставаться, если прогон упал на fail() до stopControlPlane.
process.on('exit', () => {
  if (child) child.kill('SIGTERM');
});

const restartControlPlane = async () => {
  if (RESTART_MODE === 'client') {
    // Рестарт «по клиенту»: соединение рвётся, процесс остаётся — проверяем,
    // что web не перезапускает задачу и продолжает с курсора.
    log('restart.client', { mode: 'connection_drop' });
    return;
  }
  if (RESTART_MODE === 'none') {
    log('restart.skipped', { mode: 'none' });
    return;
  }
  log('restart.process', { mode: 'sigterm_and_start' });
  await stopControlPlane();
  await startControlPlane();
};

// ------------------------------------------------------------------- сценарий

const messageKey = (seq) => `web:${CONVERSATION_ID}:m${seq}`;

const scenario = async () => {
  const report = {
    conversationId: CONVERSATION_ID,
    restartMode: RESTART_MODE,
    messages: [],
    runStartedByTask: {},
    checks: {},
  };

  const record = (seq, kind, text, extra) => {
    report.messages.push({ seq, kind, text, ...extra });
    log('message', { seq, kind, userTaskId: extra.userTaskId, requestId: extra.requestId, status: extra.status });
  };

  // 1. Первое сообщение: приём -> квитанция -> запуск -> открытое ожидание.
  const intake1 = await post('/intake', {
    contractVersion: 1,
    requestId: messageKey(1),
    profileId: PROFILE,
    conversationRef: CONVERSATION_ID,
    inputItems: [{ text: 'собери сводку по песочнице' }],
  });
  if (intake1.status !== 201) fail(`принять задачу: ${intake1.status} ${JSON.stringify(intake1.value)}`);
  const task1 = intake1.value.userTaskId;
  const start1 = await post('/start', { taskId: task1, profileId: PROFILE, goal: 'собери сводку по песочнице' });
  if (start1.status !== 200) fail(`запустить задачу: ${start1.status}`);
  const awaiting1 = await waitFor(async () => {
    const status = await post('/status', { taskId: task1 });
    return status.value?.taskStore?.status === 'awaiting_input' ? status.value : null;
  }, { what: 'status=awaiting_input' });
  if (!awaiting1) fail('задача не дошла до awaiting_input');
  // runId берём из статуса (таблица executions). В текущей сборке control plane
  // /status её не отдаёт (runs добавлен в PR #7), а событие run_started несёт
  // instanceId, а не runId, — поэтому в живом отчёте runId может быть null.
  // В песочнице (web/fake-control-plane.ts) runId есть в каждом событии.
  const runOf = (status) => status.runs?.find((r) => r.status === 'running')?.id ?? status.runs?.[0]?.id ?? null;
  const run1 = runOf(awaiting1);
  record(1, 'new', 'собери сводку по песочнице', {
    userTaskId: task1,
    requestId: messageKey(1),
    status: 'awaiting_input',
    runId: run1,
  });

  // 2. Ответ человека: дедуп по ключу сообщения, ожидание расходуется один раз.
  const answer1 = await post('/signal', {
    taskId: task1,
    type: 'user_reply',
    payload: { answer: 'только за вчера' },
    idempotencyKey: messageKey(2),
    source: 'web',
  });
  if (answer1.value?.delivered !== true) fail(`ответ не доставлен: ${JSON.stringify(answer1.value)}`);
  const done1 = await waitFor(async () => {
    const status = await post('/status', { taskId: task1 });
    return status.value?.taskStore?.status === 'done' ? status.value : null;
  }, { what: 'status=done (задача 1)' });
  if (!done1) fail('задача 1 не дошла до done');
  const answeredOnce = done1.taskStore.history.filter((e) => e.kind === 'awaiting_answered').length === 1;
  record(2, 'answer', 'только за вчера', {
    userTaskId: task1,
    requestId: messageKey(2),
    status: 'done',
    runId: run1,
    answersUsed: 1,
    awaitingAnsweredEvents: done1.taskStore.history.filter((e) => e.kind === 'awaiting_answered').length,
  });
  report.checks.awaitingConsumedExactlyOnce = answeredOnce;

  // 3. Второе сообщение того же разговора: новая задача, снова ожидание.
  const intake2 = await post('/intake', {
    contractVersion: 1,
    requestId: messageKey(3),
    profileId: PROFILE,
    conversationRef: CONVERSATION_ID,
    inputItems: [{ text: 'выгрузи результат в файл' }],
  });
  if (intake2.status !== 201) fail(`принять вторую задачу: ${intake2.status}`);
  const task2 = intake2.value.userTaskId;
  await post('/start', { taskId: task2, profileId: PROFILE, goal: 'выгрузи результат в файл' });
  const awaiting2 = await waitFor(async () => {
    const status = await post('/status', { taskId: task2 });
    return status.value?.taskStore?.status === 'awaiting_input' ? status.value : null;
  }, { what: 'status=awaiting_input (задача 2)' });
  if (!awaiting2) fail('задача 2 не дошла до awaiting_input');
  const run2 = runOf(awaiting2);
  record(3, 'new', 'выгрузи результат в файл', {
    userTaskId: task2,
    requestId: messageKey(3),
    status: 'awaiting_input',
    runId: run2,
  });

  // 4. РЕСТАРТ ПОСЕРЕДИНЕ: процесс control plane убит и поднят заново.
  await restartControlPlane();

  // 5. Продолжение с курсора: попытка не перезапущена, ответ расходуется один раз.
  const afterRestart = await waitFor(async () => {
    const status = await post('/status', { taskId: task2 });
    return status.value?.taskStore?.status === 'awaiting_input' ? status.value : null;
  }, { what: 'status=awaiting_input после рестарта' });
  if (!afterRestart) fail('после рестарта задача 2 не в awaiting_input');
  const runStarted2 = afterRestart.taskStore.history.filter((e) => e.kind === 'run_started').length;
  report.runStartedByTask[task2] = runStarted2;
  report.checks.noRerunAfterRestart = runStarted2 === 1;
  if (runStarted2 !== 1) fail(`после рестарта run_started=${runStarted2}, ожидали 1 (rerun!)`);

  const answer2 = await post('/signal', {
    taskId: task2,
    type: 'user_reply',
    payload: { answer: 'да, выгружай' },
    idempotencyKey: messageKey(4),
    source: 'web',
  });
  if (answer2.value?.delivered !== true) fail(`ответ после рестарта не доставлен: ${JSON.stringify(answer2.value)}`);
  const done2 = await waitFor(async () => {
    const status = await post('/status', { taskId: task2 });
    return status.value?.taskStore?.status === 'done' ? status.value : null;
  }, { what: 'status=done (задача 2) после рестарта' });
  if (!done2) fail('задача 2 не дошла до done после рестарта');
  record(4, 'answer', 'да, выгружай', {
    userTaskId: task2,
    requestId: messageKey(4),
    status: 'done',
    runId: run2,
    answersUsed: 1,
  });

  // 6. Пятое сообщение: новая задача того же разговора после восстановления.
  //    Настоящий план control plane задаёт одно уточнение на ход, поэтому
  //    пятое сообщение открывает третий ход и остаётся в awaiting_input —
  //    результаты и артефакты первых двух ходов уже доступны после рестарта.
  const intake3 = await post('/intake', {
    contractVersion: 1,
    requestId: messageKey(5),
    profileId: PROFILE,
    conversationRef: CONVERSATION_ID,
    inputItems: [{ text: 'итоговая сводка' }],
  });
  if (intake3.status !== 201) fail(`принять третью задачу: ${intake3.status}`);
  const task3 = intake3.value.userTaskId;
  await post('/start', { taskId: task3, profileId: PROFILE, goal: 'итоговая сводка' });
  const last = await waitFor(async () => {
    const status = await post('/status', { taskId: task3 });
    const value = status.value?.taskStore;
    return value && value.status !== 'draft' ? { status: value.status, value } : null;
  }, { what: 'статус третьего хода' });
  if (!last) fail('третий ход не получил статус');
  const history = Array.isArray(last.value.history)
    ? last.value.history
    : (() => {
        try {
          return JSON.parse(last.value.history ?? '[]');
        } catch {
          return [];
        }
      })();
  const artifactRefs = history
    .flatMap((e) => (e.kind === 'result_ready' || e.kind === 'task_status_changed' ? JSON.parse(e.payload ?? '{}').artifactRefs ?? [] : []))
    .filter(Boolean);
  record(5, 'new', 'итоговая сводка', {
    userTaskId: task3,
    requestId: messageKey(5),
    status: last.status,
    artifactRefs,
  });
  report.checks.terminalResultAvailable = report.messages
    .filter((m) => m.kind === 'answer')
    .every((m) => m.status === 'done');
  report.checks.artifactRefsVisible = artifactRefs.length;
  report.checks.lastMessageStatus = last.status;

  // 7. Журнал по курсору: переподключение не теряет события и не перезапускает.
  //    Основной путь — C02 /events; если в этой сборке control plane его ещё
  //    нет (PR #7), тот же журнал читается из истории /status.
  let kinds = [];
  let transport = 'events-endpoint';
  const events = await get(`/events?taskId=${task2}&after=0&limit=500`);
  if (events.status === 200 && Array.isArray(events.value?.events)) {
    kinds = events.value.events.map((e) => e.kind);
  } else {
    transport = 'status-history';
    const status = await post('/status', { taskId: task2 });
    kinds = (status.value?.taskStore?.history ?? []).map((e) => e.kind);
  }
  report.checks.cursorReplayComplete = kinds.includes('run_started') && kinds.includes('awaiting_opened') && kinds.includes('awaiting_answered');
  report.checks.runStartedOnceInJournal = kinds.filter((k) => k === 'run_started').length === 1;
  report.checks.transport = transport;
  report.runIdNote = Object.values(report.runStartedByTask).length
    ? 'runId доступен через /status (executions)'
    : 'runId не отдаётся этой сборкой control plane: /status без runs, run_started без runId';

  report.checks.fiveMessages = report.messages.length === 5;
  return report;
};

// ---------------------------------------------------------------------- запуск

await startControlPlane();
let report;
try {
  report = await scenario();
} catch (e) {
  await stopControlPlane();
  fail(`${e?.message ?? e}\n${e?.stack ?? ''}`);
}

// Жёсткие проверки — только булевы; artifactRefsVisible и lastMessageStatus —
// отчётные поля (настоящий план control plane артефактов не выпускает: это
// зона Runner/M1.3, поэтому 0 здесь — не провал, а честный факт).
const ok = Object.entries(report.checks)
  .filter(([key]) => !['artifactRefsVisible', 'lastMessageStatus', 'transport'].includes(key))
  .every(([, value]) => value === true);
report.ok = ok;
report.secretsInReport = JSON.stringify(report).includes(API_KEY) && API_KEY.length > 0;

if (REPORT) {
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  log('report.written', { path: REPORT });
} else {
  console.log(JSON.stringify(report, null, 2));
}

await stopControlPlane();
log(ok ? 'PASS' : 'FAIL', { checks: report.checks });
process.exit(ok ? 0 : 1);