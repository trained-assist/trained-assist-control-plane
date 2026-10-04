#!/usr/bin/env node
/**
 * Негативные проверки санитизации evidence (P16). Отдельный node-скрипт, а не
 * vitest-тест: файловые операции в workerd-пуле запрещены, а проверять надо
 * именно «скрипт refuses собирать плохие данные».
 *
 *   node tools/p16-evidence-selfcheck.mjs
 *
 * Код возврата 0 = все проверки прошли. Временные каталоги — внутри рабочего
 * дерева (`_scratch`), наружу ничего не пишется.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeEvidence } from './p16-evidence.mjs';

const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ROOT = join(process.cwd(), '_scratch', 'evidence-selfcheck');
const CLEAN_EVENT = JSON.stringify({
  event: 'routing.decision',
  profileId: 'profile-cp16',
  userTaskId: 'ut-clean',
  runId: null,
  route: 'llm',
  mode: 'llm-recipe-job',
  reasonCode: 'QUOTED_LINK_NOT_FETCHED',
  outcome: 'reply',
  needsExecutor: false,
  escalationAttempt: false,
  permissionSource: 'identity_snapshot',
  evidence: { urlHosts: ['example.com'], urlQuoted: true, urlReadIntent: false, intents: ['url_quoted'] },
});

const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};

function run(lines, secret = SECRET) {
  mkdirSync(ROOT, { recursive: true });
  const base = mkdtempSync(join(ROOT, 'case-'));
  const rawDir = join(base, 'raw');
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(join(rawDir, 'worker.log'), `${lines.join('\n')}\n`, 'utf8');
  try {
    const result = sanitizeEvidence({ rawDir, outDir: join(base, 'out'), secret });
    return { ok: true, digest: result.digest, outDir: join(base, 'out') };
  } catch (error) {
    return { ok: false, findings: error.findings ?? [String(error)], outDir: join(base, 'out') };
  } finally {
    setTimeout(() => rmSync(base, { recursive: true, force: true }), 0);
  }
}

const clean = run([CLEAN_EVENT]);
check('чистые логи собираются', clean.ok, clean.findings?.join('; '));
check('повтор даёт тот же sha256', run([CLEAN_EVENT]).digest === clean.digest);
check('транскрипт не содержит секрет', clean.ok && !readFileSync(join(clean.outDir, 'P16-SANDBOX-TRANSCRIPT.md'), 'utf8').includes(SECRET));

const secretLeak = run([CLEAN_EVENT, `{"event":"route.dispatched","note":"secret=${SECRET}"}`]);
check('значение секрета останавливает сборку', !secretLeak.ok && secretLeak.findings.some((f) => f.includes('PRINCIPAL_SECRET')), secretLeak.findings?.join('; '));

const pii = run([CLEAN_EVENT, '{"event":"route.dispatched","mail":"someone@personal-mail.example","file":"/Users/someone/private/notes.md"}']);
check(
  'личный e-mail и домашний путь останавливают сборку',
  !pii.ok && pii.findings.some((f) => f.includes('e-mail')) && pii.findings.some((f) => f.includes('домашний путь')),
  pii.findings?.join('; '),
);

const phone = run([CLEAN_EVENT, '{"event":"route.dispatched","contact":"+7 999 123 45 67"}']);
check('телефон в свободной форме останавливает сборку', !phone.ok && phone.findings.some((f) => f.includes('телефон')), phone.findings?.join('; '));

const allowed = run([
  CLEAN_EVENT,
  '{"event":"route.dispatched","url":"https://example.com/x","clock":1793388600000,"requestId":"req-quoted-1791077194298095000"}',
]);
check('домены RFC 2606, epoch-миллисекунды и идентификаторы — не нарушение', allowed.ok, allowed.findings?.join('; '));

rmSync(ROOT, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`\nсанитизация: нарушений ${failures.length}`);
  process.exit(1);
}
console.log('\nвсе проверки санитизации прошли');
