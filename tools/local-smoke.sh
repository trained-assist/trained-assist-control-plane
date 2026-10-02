#!/usr/bin/env bash
# Воспроизводимый прогон слоя M1.1/M1.2 control plane против локального
# `wrangler dev` (D1 + Cloudflare Workflows, всё локально, без деплоя).
#
# Использование:
#   терминал 1:  npm run dev
#   терминал 2:  ./tools/local-smoke.sh
#
# Проверяет: submit (ранний ответ) -> дубль submit -> awaiting_input ->
# сигнал -> done -> позднее событие (отклоняется) -> дубль ключа идемпотентности.
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
TASK="${TASK:-ut-http-$(date +%s)}"

py() { python3 -c "$1"; }

post() {
  curl -sS -X POST "$BASE$1" -H 'content-type: application/json' -d "$2"
}

task_status() {
  post /status "{\"taskId\":\"$TASK\"}" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["status"])'
}

wait_status() {
  local want="$1" st=""
  for _ in $(seq 1 60); do
    st="$(task_status)"
    [ "$st" = "$want" ] && return 0
    sleep 0.5
  done
  echo "FAIL: ждали status=$want, получили st=$st (task=$TASK)" >&2
  exit 1
}

echo "== 1. submit (ранний ответ) =="
START_MS="$(py 'import time; print(int(time.time()*1000))')"
SUBMIT="$(post /start "{\"taskId\":\"$TASK\",\"profileId\":\"demo\",\"goal\":\"local smoke\"}")"
echo "$SUBMIT"
echo "$SUBMIT" | py 'import json,sys; d=json.load(sys.stdin); assert d["created"] is True, d' || exit 1
ELAPSED_MS="$(py 'import time; print(int(time.time()*1000))')"
ELAPSED_MS="$(( ELAPSED_MS - START_MS ))"
[ "$ELAPSED_MS" -lt 5000 ] || { echo "FAIL: submit занял ${ELAPSED_MS}ms (>5s)" >&2; exit 1; }
echo "OK: submit за ${ELAPSED_MS}ms, задача не терминальна на момент ответа: status=$(task_status)"

echo "== 2. дубль submit = один запуск =="
DUP="$(post /start "{\"taskId\":\"$TASK\",\"profileId\":\"demo\",\"goal\":\"local smoke\"}")"
echo "$DUP"
echo "$DUP" | py 'import json,sys; d=json.load(sys.stdin); assert d["created"] is False and d["instanceCreated"] is False, d' || exit 1
echo "OK: created=false, instanceCreated=false"

echo "== 3. план паркуется на ожидании ответа =="
wait_status awaiting_input
echo "OK: status=awaiting_input"

echo "== 4. сигнал пользователя будит экземпляр =="
SIG="$(post /signal "{\"taskId\":\"$TASK\",\"type\":\"user_reply\",\"payload\":{\"answer\":\"да\"},\"idempotencyKey\":\"web:smoke-1\"}")"
echo "$SIG"
echo "$SIG" | py 'import json,sys; d=json.load(sys.stdin); assert d["delivered"] is True and d["duplicate"] is False, d' || exit 1

echo "== 5. задача доходит до done с результатом =="
wait_status done
post /status "{\"taskId\":\"$TASK\"}" | py '
import json, sys
d = json.load(sys.stdin)
t = d["taskStore"]
assert t["status"] == "done", t
assert t["result"] == {"answer": "да", "ok": True, "version": "m1-conversation-v1"}, t["result"]
kinds = [e["kind"] for e in t["history"]]
order = ["task_accepted", "run_started", "awaiting_opened", "signal_received",
         "step_woken", "awaiting_answered", "task_status_changed"]
positions = [kinds.index(k) for k in order]
assert positions == sorted(positions), kinds
assert d["engine"]["status"] == "complete", d["engine"]
print("OK: history =", " -> ".join(kinds))
print("OK: result =", json.dumps(t["result"], ensure_ascii=False), "| engine =", d["engine"]["status"])
'

echo "== 6. позднее событие после done отклоняется (суть issue #90) =="
BEFORE="$(post /status "{\"taskId\":\"$TASK\"}" | py 'import json,sys; t=json.load(sys.stdin)["taskStore"]; print(t["revision"], json.dumps(t["result"]))')"
LATE="$(post /signal "{\"taskId\":\"$TASK\",\"type\":\"user_reply\",\"payload\":{\"answer\":\"поздно\"},\"idempotencyKey\":\"web:smoke-late\"}")"
echo "$LATE"
echo "$LATE" | py 'import json,sys; d=json.load(sys.stdin); assert d["delivered"] is False and d["reason"] == "terminal_state", d' || exit 1

echo "== 7. дубль ключа идемпотентности = no-op =="
DUP_SIG="$(post /signal "{\"taskId\":\"$TASK\",\"type\":\"user_reply\",\"payload\":{\"answer\":\"поздно\"},\"idempotencyKey\":\"web:smoke-late\"}")"
echo "$DUP_SIG"
echo "$DUP_SIG" | py 'import json,sys; d=json.load(sys.stdin); assert d["duplicate"] is True, d' || exit 1

AFTER="$(post /status "{\"taskId\":\"$TASK\"}" | py 'import json,sys; t=json.load(sys.stdin)["taskStore"]; print(t["revision"], json.dumps(t["result"]))')"
[ "$BEFORE" = "$AFTER" ] || { echo "FAIL: статус/результат изменились: $BEFORE -> $AFTER" >&2; exit 1; }
echo "OK: revision+result не изменились ($AFTER)"
echo
echo "PASS: прогон $TASK завершён"
