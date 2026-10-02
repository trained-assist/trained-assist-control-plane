#!/usr/bin/env bash
# Воспроизводимый прогон control plane (P04 приём+квитанция, M1.2 порт) против
# локального `wrangler dev` (D1 + Cloudflare Workflows, всё локально, без деплоя).
#
# Использование:
#   терминал 1:  npm run db:migrate:local && npm run dev
#   терминал 2:  ./tools/local-smoke.sh
#
# Проверяет: приём задачи (201) -> повтор того же requestId (200, та же
# квитанция) -> другой payload с тем же ключом (409) -> без принципала (401) ->
# чтение квитанции -> запуск по принятой задаче -> дубль submit -> awaiting ->
# сигнал -> done -> позднее событие (отклоняется) -> дубль ключа (no-op).
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
PRINCIPAL="${PRINCIPAL:-sandbox-local}"
PROFILE="${PROFILE:-profile-1}"
REQUEST_ID="${REQUEST_ID:-req-smoke-$(date +%s)}"

py() { python3 -c "$1"; }

post() {
  curl -sS -X POST "$BASE$1" -H 'content-type: application/json' -H "X-Principal: $PRINCIPAL" -d "$2"
}

get() { curl -sS "$BASE$1"; }

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

# Локальный sandbox: принципал приёма (identity + scope, без секретов).
if command -v npx >/dev/null 2>&1; then
  npx wrangler d1 execute control-plane-task-store --local --command \
    "INSERT OR REPLACE INTO admission_principals(principal_id, profile_id, scopes, enabled, created_at, updated_at)
     VALUES ('$PRINCIPAL','$PROFILE','[\"tasks:intake\",\"tasks:read\",\"tasks:signal\"]',1,strftime('%s','now')*1000,strftime('%s','now')*1000)" \
    >/dev/null 2>&1 || echo "WARN: не удалось засеять принципал (продолжим; приём упадёт с 401)"
fi

echo "== 0. приём задачи (P04/C01) =="
INTAKE="$(post /intake "{\"contractVersion\":1,\"requestId\":\"$REQUEST_ID\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"local smoke\"}]}")"
echo "$INTAKE"
TASK="$(echo "$INTAKE" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
RECEIPT_ID="$(echo "$INTAKE" | py 'import json,sys; print(json.load(sys.stdin)["receiptId"])')"
echo "$INTAKE" | py 'import json,sys; d=json.load(sys.stdin); assert d["durable"] is True and d["duplicate"] is False, d' || exit 1
echo "OK: 201, userTaskId=$TASK receiptId=$RECEIPT_ID (квитанция = принято, не запущено)"

echo "== 0.1 повтор того же requestId = та же квитанция =="
DUP_INTAKE="$(post /intake "{\"contractVersion\":1,\"requestId\":\"$REQUEST_ID\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"local smoke\"}]}")"
echo "$DUP_INTAKE" | py 'import json,sys; d=json.load(sys.stdin); assert d["duplicate"] is True and d["receiptId"]=="'"$RECEIPT_ID"'", d' || exit 1
echo "OK: 200, прежняя квитанция"

echo "== 0.2 другой payload с тем же ключом = conflict =="
CONFLICT="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/intake" -H 'content-type: application/json' -H "X-Principal: $PRINCIPAL" -d "{\"contractVersion\":1,\"requestId\":\"$REQUEST_ID\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"другой текст\"}]}")"
[ "$CONFLICT" = "409" ] || { echo "FAIL: ждали 409, получили $CONFLICT" >&2; exit 1; }
echo "OK: 409 conflict"

echo "== 0.3 без принципала = 401 до запуска =="
NOAUTH="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/intake" -H 'content-type: application/json' -d "{\"contractVersion\":1,\"requestId\":\"req-noauth-$(date +%s)\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"x\"}]}")"
[ "$NOAUTH" = "401" ] || { echo "FAIL: ждали 401, получили $NOAUTH" >&2; exit 1; }
echo "OK: 401 unauthorized"

echo "== 0.4 чтение квитанции =="
get "/receipt?taskId=$TASK" | py 'import json,sys; d=json.load(sys.stdin); assert d["receiptId"]=="'"$RECEIPT_ID"'" and d["durable"] is True, d' || exit 1
echo "OK: квитанция читается"

echo "== 1. запуск по принятой задаче (квитанция != запуск) =="
SUBMIT="$(post /start "{\"taskId\":\"$TASK\",\"profileId\":\"$PROFILE\",\"goal\":\"local smoke\"}")"
echo "$SUBMIT" | py 'import json,sys; d=json.load(sys.stdin); assert d["created"] is False and d["instanceCreated"] is True, d' || exit 1
echo "OK: задача уже принята (created=false), создан только экземпляр (instanceCreated=true)"

echo "== 2. дубль submit = один запуск =="
DUP="$(post /start "{\"taskId\":\"$TASK\",\"profileId\":\"$PROFILE\",\"goal\":\"local smoke\"}")"
echo "$DUP" | py 'import json,sys; d=json.load(sys.stdin); assert d["created"] is False and d["instanceCreated"] is False, d' || exit 1
echo "OK: created=false, instanceCreated=false"

echo "== 3. план паркуется на ожидании ответа =="
wait_status awaiting_input
echo "OK: status=awaiting_input"

echo "== 4. сигнал пользователя будит экземпляр =="
SIG="$(post /signal "{\"taskId\":\"$TASK\",\"type\":\"user_reply\",\"payload\":{\"answer\":\"да\"},\"idempotencyKey\":\"web:smoke-1\"}")"
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
echo "$LATE" | py 'import json,sys; d=json.load(sys.stdin); assert d["delivered"] is False and d["reason"] == "terminal_state", d' || exit 1

echo "== 7. дубль ключа идемпотентности = no-op =="
DUP_SIG="$(post /signal "{\"taskId\":\"$TASK\",\"type\":\"user_reply\",\"payload\":{\"answer\":\"поздно\"},\"idempotencyKey\":\"web:smoke-late\"}")"
echo "$DUP_SIG" | py 'import json,sys; d=json.load(sys.stdin); assert d["duplicate"] is True, d' || exit 1

AFTER="$(post /status "{\"taskId\":\"$TASK\"}" | py 'import json,sys; t=json.load(sys.stdin)["taskStore"]; print(t["revision"], json.dumps(t["result"]))')"
[ "$BEFORE" = "$AFTER" ] || { echo "FAIL: статус/результат изменились: $BEFORE -> $AFTER" >&2; exit 1; }
echo "OK: revision+result не изменились ($AFTER)"
echo
echo "PASS: прогон $REQUEST_ID (task $TASK) завершён"
