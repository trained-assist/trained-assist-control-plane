import { createHash, createHmac } from 'node:crypto';

const BASE = 'http://127.0.0.1:8899';
const PRINCIPAL = 'sandbox-cp23';
const PROFILE = 'profile-cp23';
const SECRET = process.env.PRINCIPAL_SECRET;
const RUNNER = 'http://169.58.15.230:8787';
const RKEY = process.env.RUNNER_API_KEY;

const sig = createHmac('sha256', SECRET).update(PRINCIPAL).digest('hex');
const auth = { 'x-principal': PRINCIPAL, 'x-principal-sig': sig };
const call = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? auth : { ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
};
const rcall = async (method, path, body) => {
  const res = await fetch(`${RUNNER}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${RKEY}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) throw new Error(`runner ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

const waitFor = async (taskId, want) => {
  for (let i = 0; i < 150; i++) {
    const s = await call('POST', '/status', { taskId });
    if (want.includes(s.taskStore.status)) return s;
    await sleep(2000);
  }
  throw new Error(`timeout waiting ${want} for ${taskId}`);
};

// ── Run A: создаёт файл, который станет снимком ──────────────────────────
const reqA = `snapA-${Date.now()}`;
const a = await call('POST', '/intake', {
  contractVersion: 1, requestId: reqA, profileId: PROFILE,
  inputItems: [{ text: 'Создай файл result.md с единственной строкой SEED-42. Больше ничего не делай.' }],
});
record('A intake durable', a.durable === true && a.duplicate === false, a.userTaskId);
const aStart = await call('POST', '/start', { taskId: a.userTaskId, profileId: PROFILE, goal: 'создай result.md' });
const aRun = aStart.runId;
record('A start', Boolean(aRun), aRun);
const aDone = await waitFor(a.userTaskId, ['done', 'failed']);
record('A done', aDone.taskStore.status === 'done', aDone.taskStore.status);
const aRunnerRun = aDone.taskStore.result?.runId ?? aRun;

// ── Снимок workspace рана A ───────────────────────────────────────────────
const snap = await rcall('POST', `/v1/runs/${aRunnerRun}/snapshot`, { action: 'create' });
const snapId = snap?.snapshotId ?? snap?.id ?? null;
record('snapshot created', Boolean(snapId), JSON.stringify(snap).slice(0, 160));

// Снимок — указатель: в него надо положить артефакты рана, иначе он пустой.
const aArtifacts = await rcall('GET', `/v1/runs/${aRunnerRun}/artifacts`);
const aList = aArtifacts?.artifacts ?? [];
const target = aList.find((a) => a.name === 'result.md') ?? aList[0];
record('у рана A есть артефакты', Boolean(target), target ? `${target.name} ${target.size}B sha256=${String(target.sha256).slice(0, 12)}…` : 'нет');
const attached = await rcall('POST', `/v1/runs/${aRunnerRun}/snapshot-file/${snapId}`, {
  action: 'link',
  path: target.name,
  artifactId: target.artifactId,
  sha256: target.sha256,
  size: target.size,
});
record('артефакт положен в снимок', attached?.artifacts?.length === 1, `artifacts=${attached?.artifacts?.length}`);

const committed = await rcall('POST', `/v1/runs/${aRunnerRun}/snapshot`, { action: 'commit', snapshotId: snapId });
record('snapshot committed', committed?.status === 'committed', JSON.stringify(committed).slice(0, 160));

// ── Run B: вход = снимок рана A ──────────────────────────────────────────
const reqB = `snapB-${Date.now()}`;
const b = await call('POST', '/intake', {
  contractVersion: 1, requestId: reqB, profileId: PROFILE,
  inputItems: [{ text: 'Во входных данных лежит файл result.md. Прочитай его и создай в корне рабочей директории файл result.md с ТЕМ ЖЕ содержимым. Больше ничего не делай.', snapshotId: snapId }],
});
record('B intake durable (snapshot ref)', b.durable === true && b.duplicate === false, b.userTaskId);
const bStart = await call('POST', '/start', { taskId: b.userTaskId, profileId: PROFILE, goal: 'прочитай входной result.md и создай result.md с тем же содержимым' });
const bRun = bStart.runId;
record('B start', Boolean(bRun), bRun);
const bDone = await waitFor(b.userTaskId, ['done', 'failed']);
record('B done', bDone.taskStore.status === 'done', bDone.taskStore.status);
const bRunnerRun = bDone.taskStore.result?.runId ?? bRun;

// ── Проверка: ран B увидел файл из снимка ────────────────────────────────
const events = await rcall('GET', `/v1/runs/${bRunnerRun}/events?limit=200`);
const mat = (events.events || []).find((e) => e.type === 'inputs_materialized');
record('inputs_materialized event', Boolean(mat), mat ? `status=${mat.payload?.status} files=${mat.payload?.files} bytes=${mat.payload?.bytes}` : 'нет события');
const sawSeed = (events.events || []).some((e) => JSON.stringify(e).includes('SEED-42'));
record('ран B прочитал содержимое из снимка (SEED-42)', sawSeed, '');

// ── Проверка: чужой снимок отклоняется ───────────────────────────────────
const reqC = `snapC-${Date.now()}`;
const c = await call('POST', '/intake', {
  contractVersion: 1, requestId: reqC, profileId: PROFILE,
  inputItems: [{ text: 'x', snapshotId: 'snap-does-not-exist' }],
});
const cStart = await call('POST', '/start', { taskId: c.userTaskId, profileId: PROFILE, goal: 'x' });
const cDone = await waitFor(c.userTaskId, ['done', 'failed']);
const cEvents = await rcall('GET', `/v1/runs/${cDone.taskStore.result?.runId ?? cStart.runId}/events?limit=200`);
const cMat = (cEvents.events || []).find((e) => e.type === 'inputs_materialized');
record('несуществующий снимок → отказ до spawn', cDone.taskStore.status === 'failed' && cMat?.payload?.status === 'refused',
  cMat ? `status=${cMat.payload.status} reason=${cMat.payload.reason}` : `status=${cDone.taskStore.status}`);

// ── Проверка: дубль submit не создаёт второй ран ─────────────────────────
const dup = await call('POST', '/intake', { contractVersion: 1, requestId: reqB, profileId: PROFILE, inputItems: [{ text: 'Во входных данных лежит файл result.md. Прочитай его и создай в корне рабочей директории файл result.md с ТЕМ ЖЕ содержимым. Больше ничего не делай.', snapshotId: snapId }] });
record('дубль intake → та же задача', dup.duplicate === true && dup.userTaskId === b.userTaskId, `duplicate=${dup.duplicate}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} проверок пройдено ===`);
if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exit(1); }
