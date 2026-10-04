#!/usr/bin/env node
/**
 * CLI-обёртка санитизатора evidence P20.
 *
 *   node tools/p20-sanitize-evidence.mjs --raw-dir _scratch/p20-sandbox \
 *     --out-dir docs/evidence --secret "$SECRET"
 *
 * Читает все `worker*.log` каталога прогона и файлы проб (`brief.json` и др.).
 * Код возврата 0 = транскрипт собран; 1 = на входе секрет или личные данные
 * (транскрипт не собирается — fail closed).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeP20Evidence, PROBE_FILES } from './p20-evidence.mjs';

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const rawDir = value('--raw-dir') ?? '_scratch/p20-sandbox';
const outDir = value('--out-dir') ?? 'docs/evidence';
const secret = value('--secret') ?? '';

const logFiles = readdirSync(rawDir)
  .filter((name) => /^worker.*\.log$/.test(name))
  .sort();
const lines = logFiles.flatMap((name) => readFileSync(join(rawDir, name), 'utf8').split('\n'));

const probes = [];
for (const name of PROBE_FILES) {
  try {
    const parsed = JSON.parse(readFileSync(join(rawDir, name), 'utf8'));
    probes.push({ probe: name, value: parsed });
  } catch {
    // Проба не выполнялась — в evidence не попадает.
  }
}

const result = sanitizeP20Evidence({ lines, secret, probes });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'P20-BRIEF-TRANSCRIPT.md'), result.transcript, 'utf8');
writeFileSync(join(outDir, 'p20-brief-events.jsonl'), `${result.events.join('\n')}\n`, 'utf8');
console.log(`ok: логов ${logFiles.length}, событий ${result.events.length}, проб ${probes.length}, digest ${result.digest}`);
