#!/usr/bin/env bash
# Обновить снимок корпуса быстрых ответов (P18) в этом репозитории.
#
# Корпус живёт в trained-agent-architecture (версионирован там: `corpus.manifest.json`
# с sha256). Роутеру P16 нужен тот же корпус под своим CI, поэтому здесь хранится
# ПИНNED-снимок: байты файла + ожидаемый sha256 из манифеста. Правка снимка без
# пересборки манифеста ломает проверку `tests/fast-replies-corpus.test.ts`.
#
# Ничего не пишется вне репозитория: stdout gh api перенаправляется в файл снимка.
#
# Использование:
#   ./tools/fetch-fast-replies-corpus.sh            # проверить текущий снимок
#   ./tools/fetch-fast-replies-corpus.sh --refresh  # перекачать и сверить хэш
set -euo pipefail

REPO="trained-assist/trained-agent-architecture"
REF="${REF:-main}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/eval/fast-replies"
SNAPSHOT="$DIR/corpus.snapshot.json"
TARGET="$DIR/dialogs.v1.jsonl"
MODE="${1:-check}"

api() { gh api "$REPO/contents/$1?ref=$REF" --jq .content | base64 -d; }

expected_sha="$(python3 -c '
import json,sys
print(json.load(open(sys.argv[1]))["files"]["dialogs.v1.jsonl"]["sha256"])' "$SNAPSHOT")"
expected_records="$(python3 -c '
import json,sys
print(json.load(open(sys.argv[1]))["files"]["dialogs.v1.jsonl"]["records"])' "$SNAPSHOT")"

if [ "$MODE" = "--refresh" ]; then
  api "eval/fast-replies/dialogs.v1.jsonl" > "$TARGET"
fi

[ -f "$TARGET" ] || { echo "нет снимка корпуса: $TARGET" >&2; exit 1; }

actual_sha="$(shasum -a 256 "$TARGET" | cut -d' ' -f1)"
actual_records="$(wc -l < "$TARGET" | tr -d ' ')"

echo "corpus file      : $TARGET"
echo "upstream sha256  : $expected_sha"
echo "snapshot sha256  : $actual_sha"
echo "records          : $actual_records (ожидалось $expected_records)"

[ "$actual_sha" = "$expected_sha" ] || { echo "FAIL: снимок корпуса не совпадает с манифестом P18" >&2; exit 1; }
[ "$actual_records" = "$expected_records" ] || { echo "FAIL: число записей корпуса разошлось" >&2; exit 1; }
echo "ok: снимок корпуса совпадает с версией P18 ($REF)"
