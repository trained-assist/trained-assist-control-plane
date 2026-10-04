#!/usr/bin/env node
/**
 * CLI-обёртка над `tools/p16-evidence.mjs` для песочницы P17: разбор аргументов
 * и ненулевой код выхода при нарушении санитизации. Вся логика — в библиотеке.
 *
 * Использование:
 *   node tools/p17-sanitize-evidence.mjs --raw-dir _scratch/p17-sandbox \
 *     --out-dir docs/evidence --secret <PRINCIPAL_SECRET>
 */
import { sanitizeEvidence } from './p16-evidence.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

try {
  const result = sanitizeEvidence({
    rawDir: args.get('raw-dir') ?? '_scratch/p17-sandbox',
    outDir: args.get('out-dir') ?? 'docs/evidence',
    secret: args.get('secret') ?? '',
    card: 'p17',
  });
  console.log(
    `ok: evidence собран (${result.decisions} решений, sha256=${result.digest.slice(0, 12)}…), нарушений не найдено`,
  );
} catch (error) {
  console.error('САНИТИЗАЦИЯ НЕ ПРОЙДЕНА:');
  for (const finding of error.findings ?? [String(error)]) console.error(`- ${finding}`);
  process.exit(1);
}
