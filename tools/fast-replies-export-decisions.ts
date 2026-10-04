/**
 * Пересобрать артефакт решений eval (P16) из пинned-снимка корпуса P18.
 *
 * Что делает: прогоняет все диалоги `eval/fast-replies/dialogs.v1.jsonl` через
 * `decideRoute` и пишет `eval/fast-replies/decisions/p16-route-policy.v1.jsonl`
 * в формате стенда P18 (`case`, `route`, `reasonCode`, …). Файл — артефакт
 * версии: CI (`tests/fast-replies-corpus.test.ts`) пересчитывает его и требует
 * байт-в-байтного совпадения, поэтому «подогнать результат» нельзя.
 *
 * Запуск (Node ≥22 с type stripping):
 *   npm run eval:fast-replies
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxCapabilityCatalog } from '../src/router/catalog';
import { decisionRow, replayDialog, type CorpusDialog } from '../src/router/corpus-replay';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const corpusPath = resolve(root, 'eval/fast-replies/dialogs.v1.jsonl');
const decisionsPath = resolve(root, 'eval/fast-replies/decisions/p16-route-policy.v1.jsonl');

const dialogs = readFileSync(corpusPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as CorpusDialog);

const catalog = sandboxCapabilityCatalog();
const rows: string[] = [];
let matched = 0;
for (const dialog of dialogs) {
  const { decision, fault } = await replayDialog(dialog, catalog);
  if (decision.route === dialog.route) matched += 1;
  rows.push(JSON.stringify(decisionRow(dialog.id, decision, fault)));
}

writeFileSync(decisionsPath, `${rows.join('\n')}\n`, 'utf8');
console.log(`записано решений: ${rows.length} (совпало с корпусом: ${matched}) -> eval/fast-replies/decisions/p16-route-policy.v1.jsonl`);
