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

get() { curl -sS -H "X-Principal: $PRINCIPAL" "$BASE$1"; }

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
     VALUES ('$PRINCIPAL','$PROFILE','[\"tasks:intake\",\"tasks:read\",\"tasks:signal\",\"tasks:control\"]',1,strftime('%s','now')*1000,strftime('%s','now')*1000)" \
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
assert t["result"] == {"answer": "да", "ok": True, "version": "m1-conversation-v2"}, t["result"]
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

echo "== 8. потеря связи и возобновление (P06) =="
REQ2="req-resume-$(date +%s)"
INTAKE2="$(post /intake "{\"contractVersion\":1,\"requestId\":\"$REQ2\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"resume smoke\"}]}")"
TASK2="$(echo "$INTAKE2" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
START2="$(post /start "{\"taskId\":\"$TASK2\",\"profileId\":\"$PROFILE\",\"goal\":\"resume smoke\"}")"
RUN2="$(echo "$START2" | py 'import json,sys; print(json.load(sys.stdin)["runId"])')"
for _ in $(seq 1 60); do
  st=$(post /status "{\"taskId\":\"$TASK2\"}" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["status"])')
  [ "$st" = "awaiting_input" ] && break
  sleep 0.5
done
[ "$st" = "awaiting_input" ] || { echo "FAIL: задача 2 не дождалась ($st)" >&2; exit 1; }

LOST="$(post /connection-lost "{\"runId\":\"$RUN2\",\"reason\":\"heartbeat lost\"}")"
echo "$LOST" | py 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="unknown" and d["errorClass"]=="connection_lost", d' || exit 1
echo "OK: попытка unknown (не failed), задача не изменилась: $(post /status "{\"taskId\":\"$TASK2\"}" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["status"])')"

RESUMED="$(post /resume "{\"taskId\":\"$TASK2\",\"reason\":\"reconnect\",\"instructions\":\"продолжить\"}")"
echo "$RESUMED" | py 'import json,sys; d=json.load(sys.stdin); assert d["runId"]!="'"$RUN2"'", d; print("OK: новый runId, generation =", d["generation"])'

SIG2="$(post /signal "{\"taskId\":\"$TASK2\",\"type\":\"user_reply\",\"payload\":{\"answer\":\"да\"},\"idempotencyKey\":\"web:resume-smoke\"}")"
echo "$SIG2" | py 'import json,sys; d=json.load(sys.stdin); assert d["delivered"] is True, d' || exit 1
for _ in $(seq 1 60); do
  st=$(post /status "{\"taskId\":\"$TASK2\"}" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["status"])')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: задача 2 не дошла до done ($st)" >&2; exit 1; }
echo "OK: после resume задача 2 дошла до done"

echo "== 9. поток событий с курсором (P05/C02) =="
python3 - "$TASK" "$BASE" "$PRINCIPAL" <<'PYEOF'
import json, sys, urllib.request
task_id, base = sys.argv[1], sys.argv[2]
principal = sys.argv[3] if len(sys.argv) > 3 else "sandbox-local"
def fetch(url):
    req = urllib.request.Request(url, headers={"X-Principal": principal})
    with urllib.request.urlopen(req) as r:
        return json.load(r)
seen, cursor = [], None
while True:
    url = f"{base}/events?taskId={task_id}&limit=2" + (f"&after={cursor}" if cursor else "")
    page = fetch(url)
    seen.extend(e["sequence"] for e in page["events"])
    if not page["hasMore"]:
        break
    cursor = page["nextCursor"]
import urllib.parse
full = fetch(f"{base}/status?" + urllib.parse.urlencode({"taskId": task_id}))["taskStore"]["history"]
assert seen == [e["id"] for e in full], (len(seen), len(full))
types = {e["kind"]: e["type"] for e in fetch(f"{base}/events?taskId={task_id}&limit=100")["events"]}
assert types["task_accepted"] == "accepted" and types["awaiting_opened"] == "waiting", types
print(f"OK: {len(seen)} событий через курсор без потерь/дублей; типы C02: accepted/waiting/started")
PYEOF

echo "== 10. доставка: один владелец, свой статус, retry не трогает execution =="
DEL="$(post /deliveries "{\"taskId\":\"$TASK\",\"logicalMessageId\":\"smoke-result-$TASK\",\"channel\":\"telegram\",\"message\":{\"text\":\"отчёт по задаче\"}}")"
echo "$DEL" | py 'import json,sys; d=json.load(sys.stdin); assert d["queued"] is True, d' || exit 1
DUP_DEL="$(post /deliveries "{\"taskId\":\"$TASK\",\"logicalMessageId\":\"smoke-result-$TASK\",\"channel\":\"telegram\",\"message\":{\"text\":\"отчёт по задаче\"}}")"
echo "$DUP_DEL" | py 'import json,sys; d=json.load(sys.stdin); assert d["queued"] is False, d' || exit 1
echo "OK: повтор того же logicalMessageId — no-op (одна доставка)"

REVISION_BEFORE="$(post /status "{\"taskId\":\"$TASK\"}" | py 'import json,sys; t=json.load(sys.stdin)["taskStore"]; print(t["status"], t["generation"], json.dumps(t["result"]))')"
SENT="$(post /deliveries/deliver "{\"taskId\":\"$TASK\",\"owner\":\"local-worker\"}")"
echo "$SENT" | py 'import json,sys; d=json.load(sys.stdin); assert d["outcome"]=="delivered" and d["attempt"]==1, d' || exit 1
REVISION_AFTER="$(post /status "{\"taskId\":\"$TASK\"}" | py 'import json,sys; t=json.load(sys.stdin)["taskStore"]; print(t["status"], t["generation"], json.dumps(t["result"]))')"
[ "$REVISION_BEFORE" = "$REVISION_AFTER" ] || { echo "FAIL: доставка изменила состояние задачи: $REVISION_BEFORE -> $REVISION_AFTER" >&2; exit 1; }
post /status "{\"taskId\":\"$TASK\"}" | py 'import json,sys; d=json.load(sys.stdin); assert d["taskStore"]["delivery_state"]=="delivered", d["taskStore"]["delivery_state"]' || exit 1
echo "OK: доставка own-статус delivered, задача/поколение/результат не тронуты"

echo "== 11. артефакты переживают отмену =="
REQ3="req-artifacts-$(date +%s)"
INTAKE3="$(post /intake "{\"contractVersion\":1,\"requestId\":\"$REQ3\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"артефакты и отмена\"}]}")"
TASK3="$(echo "$INTAKE3" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
post /start "{\"taskId\":\"$TASK3\",\"profileId\":\"$PROFILE\",\"goal\":\"артефакты и отмена\"}" >/dev/null
for _ in $(seq 1 60); do
  st=$(post /status "{\"taskId\":\"$TASK3\"}" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["status"])')
  [ "$st" = "awaiting_input" ] && break
  sleep 0.5
done
ART="$(post /artifacts "{\"taskId\":\"$TASK3\",\"kind\":\"report\",\"artifactRef\":\"r2://control-plane/$TASK3/report.md\",\"sizeBytes\":2048,\"checksum\":\"sha256:local-smoke\"}")"
echo "$ART" | py 'import json,sys; d=json.load(sys.stdin); assert d["created"] is True, d' || exit 1
post /deliveries "{\"taskId\":\"$TASK3\",\"logicalMessageId\":\"pending-$TASK3\",\"channel\":\"telegram\",\"message\":{\"text\":\"отчёт\"}}" >/dev/null
CANCEL3="$(post /cancel "{\"taskId\":\"$TASK3\",\"reason\":\"user pressed stop\"}")"
echo "$CANCEL3" | py 'import json,sys; d=json.load(sys.stdin); assert d["cancelled"] is True and d["stopConfirmed"] is True, d' || exit 1
get "/artifacts?taskId=$TASK3" | py 'import json,sys; d=json.load(sys.stdin); assert len(d["artifacts"])==1, d' || exit 1
post /status "{\"taskId\":\"$TASK3\"}" | py '
import json,sys
d = json.load(sys.stdin)
assert d["taskStore"]["status"] == "cancelled", d["taskStore"]["status"]
assert len(d["artifacts"]) == 1, d["artifacts"]
assert d["deliveries"][0]["status"] == "failed" and d["deliveries"][0]["last_error"] == "suppressed_by_cancel", d["deliveries"]
' || exit 1
echo "OK: cancelled; артефакт на месте; retry доставки подавлен (suppressed_by_cancel)"

echo "== 12. host-owned interaction: ожидание с явным ID и дедуп ответа (шаг 5) =="
REQ4="req-awaiting-$(date +%s)"
INTAKE4="$(post /intake "{\"contractVersion\":1,\"requestId\":\"$REQ4\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"спрошу выбор\"}]}")"
TASK4="$(echo "$INTAKE4" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
OPENED="$(post /awaiting "{\"taskId\":\"$TASK4\",\"purpose\":\"preference\",\"question\":\"Какой вариант?\",\"options\":[{\"id\":\"opt-a\",\"label\":\"А\"},{\"id\":\"opt-b\",\"label\":\"Б\"}]}")"
echo "$OPENED" | py 'import json,sys; d=json.load(sys.stdin); assert d["kind"]=="choice" and d["purpose"]=="preference", d' || exit 1
AID="$(echo "$OPENED" | py 'import json,sys; print(json.load(sys.stdin)["awaitingInputId"])')"
echo "OK: purpose=preference -> kind=choice, awaitingInputId=$AID"

ANSWERED="$(post "/awaiting/$AID/answer" "{\"idempotencyKey\":\"web:smoke-1\",\"answer\":{\"optionId\":\"opt-a\"}}")"
echo "$ANSWERED" | py 'import json,sys; d=json.load(sys.stdin); assert d["applied"] is True and d["duplicate"] is False, d' || exit 1
DUP_ANSWER="$(post "/awaiting/$AID/answer" "{\"idempotencyKey\":\"web:smoke-1\",\"answer\":{\"optionId\":\"opt-a\"}}")"
echo "$DUP_ANSWER" | py 'import json,sys; d=json.load(sys.stdin); assert d["applied"] is False and d["duplicate"] is True and d["answeredAt"]=='"$(echo "$ANSWERED" | py 'import json,sys; print(json.load(sys.stdin)["answeredAt"])')"', d' || exit 1
echo "OK: повтор ответа = no-op с прежним результатом"
CONFLICT="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/awaiting/$AID/answer" -H 'content-type: application/json' -H "X-Principal: $PRINCIPAL" -d '{"idempotencyKey":"web:smoke-2","answer":{"optionId":"opt-b"}}')"
[ "$CONFLICT" = "409" ] || { echo "FAIL: ждали 409 (другой ключ), получили $CONFLICT" >&2; exit 1; }
echo "OK: другой ключ на отвеченном ожидании -> 409 conflict"

echo "== 13. ответ переживает смерть движка: продолжение явное =="
REQ5="req-death-$(date +%s)"
INTAKE5="$(post /intake "{\"contractVersion\":1,\"requestId\":\"$REQ5\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"умру во время ожидания\"}]}")"
TASK5="$(echo "$INTAKE5" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
START5="$(post /start "{\"taskId\":\"$TASK5\",\"profileId\":\"$PROFILE\",\"goal\":\"умру во время ожидания\"}")"
RUN5="$(echo "$START5" | py 'import json,sys; print(json.load(sys.stdin)["runId"])')"
for _ in $(seq 1 60); do
  st=$(post /status "{\"taskId\":\"$TASK5\"}" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["status"])')
  [ "$st" = "awaiting_input" ] && break
  sleep 0.5
done
[ "$st" = "awaiting_input" ] || { echo "FAIL: задача 5 не дождалась ($st)" >&2; exit 1; }
AID5="$(get "/awaiting?taskId=$TASK5" 2>/dev/null | py 'import json,sys; print(json.load(sys.stdin).get("open",{}).get("awaiting_input_id",""))' 2>/dev/null || true)"
AID5="$(post /status "{\"taskId\":\"$TASK5\"}" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["awaiting_input_id"])')"
# Движок «умер»: отвечаем в durable-состояние БЕЗ пробуждения, затем явное продолжение.
post "/awaiting/$AID5/answer" "{\"idempotencyKey\":\"web:after-death\",\"answer\":{\"answer\":\"да\"}}" >/dev/null
RESUMED="$(post /resume "{\"taskId\":\"$TASK5\",\"reason\":\"engine died\"}")"
echo "$RESUMED" | py 'import json,sys; d=json.load(sys.stdin); assert d["runId"]!="'"$RUN5"'", d; print("OK: новый runId, generation =", d["generation"])' || exit 1
for _ in $(seq 1 60); do
  st=$(post /status "{\"taskId\":\"$TASK5\"}" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["status"])')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: задача 5 не дошла до done после продолжения ($st)" >&2; exit 1; }
post /status "{\"taskId\":\"$TASK5\"}" | py '
import json,sys
d = json.load(sys.stdin); t = d["taskStore"]
assert t["result"]["answer"] == "да", t["result"]
prepare = [e for e in t["history"] if e.get("step") == "prepare"]
assert len(prepare) == 1, "продолжение не должно переигрывать шаги до ожидания"
resumes = [e for e in t["history"] if e["kind"] == "run_started" and json.loads(e["payload"]).get("resumed")]
assert resumes, "нет явной отметки продолжения"
print("OK: ответ пережил смерть движка; шаг prepare выполнен один раз; продолжение помечено resumed")
'

echo "== 14. расписание без обязательного GTD (P22, виртуальные часы) =="
# Моменты срабатывания задаются явно (песочница I07): реальные часы и сон не нужны.
# V — ближайшая граница часа UTC (создание расписания планирует её), V2 — следующая.
V=$(( ( $(date +%s) / 3600 + 1 ) * 3600 * 1000 ))
V2=$(( V + 3600000 ))
VKEY="$(python3 -c 'import datetime,sys; print(datetime.datetime.fromtimestamp(int(sys.argv[1])/1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:00:00Z"))' "$V")"

# Локальная D1 живёт между прогонами: гасим расписания прошлых прогонов, чтобы их
# просроченные срабатывания не попадали в этот тик.
for sid in $(get "/schedules?profileId=$PROFILE" | py 'import json,sys; print(" ".join(s["schedule_id"] for s in json.load(sys.stdin)["schedules"] if s["enabled"]))'); do
  post /schedules/disable "{\"scheduleId\":\"$sid\"}" >/dev/null
done
SCHED_REQ="sched-smoke-$(date +%s)-$$"
SCHED="$(post /schedules "{\"requestId\":\"$SCHED_REQ\",\"profileId\":\"$PROFILE\",\"cron\":\"0 * * * *\",\"timezone\":\"Europe/Moscow\",\"goal\":\"local smoke hourly\"}")"
echo "$SCHED" | py 'import json,sys; d=json.load(sys.stdin); assert d["created"] is True and d["gtdId"] is None, d' || exit 1
SCHED_ID="$(echo "$SCHED" | py 'import json,sys; print(json.load(sys.stdin)["schedule"]["schedule_id"])')"
NEXT="$(echo "$SCHED" | py 'import json,sys; print(json.load(sys.stdin)["schedule"]["next_due_at"])')"
[ "$NEXT" = "$V" ] || { echo "FAIL: расписание не запланировало ближайший час ($NEXT != $V)" >&2; exit 1; }
echo "OK: расписание создано, gtdId=null (контроль не регистрировался): $SCHED_ID"

post /schedules/tick "{\"now\":$V}" | py 'import json,sys; d=json.load(sys.stdin); assert d["admitted"]==1 and d["failed"]==0, d' || exit 1
OCC="$(get "/schedules/occurrences?scheduleId=$SCHED_ID")"
echo "$OCC" | py 'import json,sys
d = json.load(sys.stdin); occ = d["occurrences"]
assert len(occ) == 1 and occ[0]["state"] == "admitted", occ
assert occ[0]["gtd_id"] is None, occ[0]
print("OK: occurrence принят на", occ[0]["occurrence_key"], "| gtd_id =", occ[0]["gtd_id"], "| task =", occ[0]["user_task_id"])
' || exit 1
OCC_TASK="$(echo "$OCC" | py 'import json,sys; print(json.load(sys.stdin)["occurrences"][0]["user_task_id"])')"

for _ in $(seq 1 60); do
  st=$(post /status "{\"taskId\":\"$OCC_TASK\"}" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["status"])')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: задача occurrence не дошла до done ($st)" >&2; exit 1; }
post /status "{\"taskId\":\"$OCC_TASK\"}" | py '
import json,sys
d = json.load(sys.stdin); t = d["taskStore"]; r = t["result"]
assert r["ok"] is True and r["mode"] == "auto", r
assert "gtdId" not in r, r
kinds = [e["kind"] for e in t["history"]]
assert "awaiting_opened" not in kinds, kinds
print("OK: hourly task -> Output без gtdId; history =", " -> ".join(kinds))
' || exit 1

echo "== 14.1 повторный tick на том же моменте = нет второго срабатывания =="
post /schedules/tick "{\"now\":$V}" | py 'import json,sys; d=json.load(sys.stdin); assert d["admitted"]==0, d' || exit 1
get "/schedules/occurrences?scheduleId=$SCHED_ID" | py 'import json,sys; d=json.load(sys.stdin); assert len(d["occurrences"])==1, d' || exit 1
echo "OK: occurrence по-прежнему один"

echo "== 14.2 disable расписания != отмена принятой задачи =="
post /schedules/disable "{\"scheduleId\":\"$SCHED_ID\"}" | py 'import json,sys; d=json.load(sys.stdin); assert d["schedule"]["enabled"]==0, d' || exit 1
post /schedules/tick "{\"now\":$V2}" | py 'import json,sys; d=json.load(sys.stdin); assert d["admitted"]==0, d' || exit 1
get "/schedules/occurrences?scheduleId=$SCHED_ID" | py 'import json,sys; d=json.load(sys.stdin); assert len(d["occurrences"])==1, d' || exit 1
post /status "{\"taskId\":\"$OCC_TASK\"}" | py 'import json,sys
d = json.load(sys.stdin); t = d["taskStore"]
assert t["status"] == "done", t["status"]
kinds = [e["kind"] for e in t["history"]]
assert "task_cancelled" not in kinds and "cancel_requested" not in kinds, kinds
print("OK: disable не отменил задачу (status=done); час, прошедший при выключенном расписании, не превратился в occurrence")
' || exit 1

echo "== 14.3 enable = ближайшее будущее срабатывание, окно не отыгрывается пачкой =="
ENABLED="$(post /schedules/enable "{\"scheduleId\":\"$SCHED_ID\"}")"
echo "$ENABLED" | py 'import json,sys
d = json.load(sys.stdin)["schedule"]
assert d["enabled"] == 1 and d["next_due_at"] >= '"$V"', d
print("OK: включено, ближайшее срабатывание =", d["next_due_at"])
' || exit 1
post /schedules/tick "{\"now\":$V2}" | py 'import json,sys; d=json.load(sys.stdin); assert d["admitted"]==1 and d["misfires"]==1, d' || exit 1
get "/schedules/occurrences?scheduleId=$SCHED_ID" | py 'import json,sys
d = json.load(sys.stdin); occ = d["occurrences"]
assert len(occ) == 2, occ
assert occ[1]["gtd_id"] is None, occ[1]
print("OK: после enable одно новое occurrence (coalesce), gtd_id =", occ[1]["gtd_id"], "| всего occurrence:", len(occ))
' || exit 1

echo
echo "PASS: прогоны $REQUEST_ID/$REQ2/$REQ3/$REQ4/$REQ5 и расписание $SCHED_ID завершены"

echo "== 15. GTD opt-in и bounded control (P23, виртуальные часы) =="
# Контроль появляется только по явной регистрации: обычная задача и occurrence
# расписания остаются без gtdId (AC-141 не меняется). Время — виртуальное
# (now в теле /gtd/tick), внешний гейт — synthetic provider (SANDBOX · I07).
GTD_REQ="gtd-smoke-$(date +%s)-$$"
GTD_DEADLINE=$(( $(date +%s) * 1000 + 4 * 3600000 ))
GTD_NOW=$(( $(date +%s) * 1000 ))

echo "== 15.1 обычная задача без контроля: gtdId отсутствует, владелец продолжения output =="
PLAIN_REQ="req-p23-plain-$(date +%s)"
PLAIN="$(post /intake "{\"contractVersion\":1,\"requestId\":\"$PLAIN_REQ\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"разовый вопрос без контроля\"}]}")"
PLAIN_TASK="$(echo "$PLAIN" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
post /start "{\"taskId\":\"$PLAIN_TASK\",\"profileId\":\"$PROFILE\",\"goal\":\"разовый вопрос без контроля\"}" >/dev/null
for _ in $(seq 1 60); do
  st=$(post /status "{\"taskId\":\"$PLAIN_TASK\"}" | py 'import json,sys; t=json.load(sys.stdin)["taskStore"]; print(t["status"])')
  [ "$st" = "done" ] && break
  sleep 0.5
done
[ "$st" = "done" ] || { echo "FAIL: обычная задача не дошла до done ($st)" >&2; exit 1; }
post /status "{\"taskId\":\"$PLAIN_TASK\"}" | py '
import json,sys
d = json.load(sys.stdin); r = d["taskStore"]["result"]
assert "gtdId" not in r, r
assert r["continuationOwner"] == "output", r
print("OK: без регистрации контроля нет: gtdId отсутствует, continuationOwner =", r["continuationOwner"])
' || exit 1
get "/gtd?profileId=$PROFILE" | py 'import json,sys; d=json.load(sys.stdin); assert d["records"]==[], d' || exit 1
echo "OK: записей контроля нет (GTD не создаётся сам)"

echo "== 15.2 явная регистрация: одна запись, детерминированный gtdId =="
GTD="$(post /gtd "{\"requestId\":\"$GTD_REQ\",\"profileId\":\"$PROFILE\",\"userTaskId\":\"$PLAIN_TASK\",\"reason\":\"довести до конца и проверить CI\",\"criteria\":[{\"id\":\"ci-gate\",\"description\":\"required check зелёный\",\"required\":true}],\"deadlineAt\":$GTD_DEADLINE,\"maxAttempts\":3}")"
echo "$GTD" | py 'import json,sys; d=json.load(sys.stdin); assert d["created"] is True and d["continuationOwner"]=="gtd", d' || exit 1
GTD_ID="$(echo "$GTD" | py 'import json,sys; print(json.load(sys.stdin)["gtdId"])')"
echo "OK: запись контроля создана: $GTD_ID (continuationOwner=gtd)"
GTD_DUP="$(post /gtd "{\"requestId\":\"$GTD_REQ\",\"profileId\":\"$PROFILE\",\"userTaskId\":\"$PLAIN_TASK\",\"reason\":\"довести до конца и проверить CI\",\"criteria\":[{\"id\":\"ci-gate\",\"description\":\"required check зелёный\",\"required\":true}],\"deadlineAt\":$GTD_DEADLINE,\"maxAttempts\":3}")"
echo "$GTD_DUP" | py 'import json,sys; d=json.load(sys.stdin); assert d["created"] is False and d["gtdId"]=="'"$GTD_ID"'", d' || exit 1
echo "OK: повторная регистрация — тот же gtdId, второй записи нет"

echo "== 15.3 managed шаг: критерий не выполнен -> ровно одно продолжение =="
post /start "{\"taskId\":\"$PLAIN_TASK\",\"profileId\":\"$PROFILE\",\"goal\":\"довести до конца и проверить CI\",\"gtdId\":\"$GTD_ID\",\"stepOutcome\":\"succeeded\",\"criteria\":{\"ci-gate\":false}}" >/dev/null
for _ in $(seq 1 60); do
  pending=$(get "/gtd/$GTD_ID" | py 'import json,sys; d=json.load(sys.stdin); print(sum(1 for o in d["outcomes"] if o["state"]=="pending"))')
  active=$(post /status "{\"taskId\":\"$PLAIN_TASK\"}" | py 'import json,sys; print(len([r for r in json.load(sys.stdin)["runs"] if r["status"]=="running"]))')
  [ "$pending" = "1" ] && [ "$active" = "0" ] && break
  sleep 0.5
done
[ "$pending" = "1" ] && [ "$active" = "0" ] || { echo "FAIL: исход managed шага не доехал (pending=$pending active=$active)" >&2; exit 1; }
ACK1="$(post /gtd/ack "{\"gtdId\":\"$GTD_ID\"}")"
echo "$ACK1" | py 'import json,sys
d = json.load(sys.stdin)
assert len(d["processed"]) == 1, d
p = d["processed"][0]
assert p["decision"] == "continue" and p["reason"] == "criteria_not_met", p
assert p["continuationRunId"], p
print("OK: ACK -> одно решение continue, continuationRunId =", p["continuationRunId"])
' || exit 1
for _ in $(seq 1 60); do
  pending=$(get "/gtd/$GTD_ID" | py 'import json,sys; d=json.load(sys.stdin); print(sum(1 for o in d["outcomes"] if o["state"]=="pending"))')
  active=$(post /status "{\"taskId\":\"$PLAIN_TASK\"}" | py 'import json,sys; print(len([r for r in json.load(sys.stdin)["runs"] if r["status"]=="running"]))')
  [ "$pending" = "1" ] && [ "$active" = "0" ] && break
  sleep 0.5
done
[ "$pending" = "1" ] && [ "$active" = "0" ] || { echo "FAIL: исход продолжения не доехал (pending=$pending active=$active)" >&2; exit 1; }
ACK2="$(post /gtd/ack "{\"gtdId\":\"$GTD_ID\"}")"
echo "$ACK2" | py 'import json,sys
d = json.load(sys.stdin)
assert len(d["processed"]) == 1, d
p = d["processed"][0]
assert p["decision"] == "complete" and p["reason"] == "criteria_met", p
assert p["continuationRunId"] is None, p
print("OK: критерий выполнен -> complete, новых попыток нет")
' || exit 1
post /status "{\"taskId\":\"$PLAIN_TASK\"}" | py '
import json,sys
d = json.load(sys.stdin); t = d["taskStore"]
assert t["status"] == "done", t["status"]
r = t["result"]
assert r["gtdId"] == "'"$GTD_ID"'" and r["completedBy"] == "gtd", r
runs = [x["id"] for x in d["runs"]]
assert len(runs) == 2 and len(set(runs)) == 2, runs
print("OK: задача закрыта GTD (done); попыток:", len(runs), "| владелец продолжения один")
' || exit 1

echo "== 15.4 wait по вводу человека: durable ожидание, ответ -> одно продолжение =="
INPUT_REQ="req-p23-input-$(date +%s)"
INPUT="$(post /intake "{\"contractVersion\":1,\"requestId\":\"$INPUT_REQ\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"нужен выбор пользователя\"}]}")"
INPUT_TASK="$(echo "$INPUT" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
INPUT_REG="$(post /gtd "{\"requestId\":\"reg-$INPUT_REQ\",\"profileId\":\"$PROFILE\",\"userTaskId\":\"$INPUT_TASK\",\"reason\":\"довести до конца, нужен выбор\",\"criteria\":[{\"id\":\"choice-made\",\"description\":\"пользователь выбрал\",\"required\":true}],\"deadlineAt\":$GTD_DEADLINE,\"maxAttempts\":3}")"
INPUT_GTD="$(echo "$INPUT_REG" | py 'import json,sys; print(json.load(sys.stdin)["gtdId"])')"
post /start "{\"taskId\":\"$INPUT_TASK\",\"profileId\":\"$PROFILE\",\"goal\":\"нужен выбор пользователя\",\"gtdId\":\"$INPUT_GTD\",\"stepOutcome\":\"awaiting_user\"}" >/dev/null
for _ in $(seq 1 60); do
  st=$(post /status "{\"taskId\":\"$INPUT_TASK\"}" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["status"])')
  [ "$st" = "awaiting_input" ] && break
  sleep 0.5
done
[ "$st" = "awaiting_input" ] || { echo "FAIL: managed шаг не встал на ожидание ($st)" >&2; exit 1; }
AID="$(post /status "{\"taskId\":\"$INPUT_TASK\"}" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["awaiting_input_id"])')"
post /status "{\"taskId\":\"$INPUT_TASK\"}" | py '
import json,sys
d = json.load(sys.stdin)
runs = d["runs"]
assert len(runs) == 1 and runs[0]["status"] == "waiting", runs
print("OK: попытка паркована (waiting), живого процесса нет; awaitingInputId =", d["taskStore"]["awaiting_input_id"])
' || exit 1
post /gtd/ack "{\"gtdId\":\"$INPUT_GTD\"}" | py 'import json,sys
d = json.load(sys.stdin)
assert d["processed"][0]["decision"] == "wait" and d["processed"][0]["triggerKind"] == "input", d
print("OK: ACK -> wait по вводу, продолжения нет")
' || exit 1
# Тики без ответа: ни одной новой попытки (токены не расходуются).
for i in 1 2 3; do
  post /gtd/tick "{\"now\":$(( GTD_NOW + i * 60000 ))}" | py 'import json,sys; d=json.load(sys.stdin); assert d["continued"]==0 and d["waiting"]==1, d' || exit 1
done
post /status "{\"taskId\":\"$INPUT_TASK\"}" | py 'import json,sys; d=json.load(sys.stdin); assert len(d["runs"])==1, d["runs"]' || exit 1
echo "OK: 3 тика без ответа — новых попыток нет (wait не держит токены)"
post "/awaiting/$AID/answer" "{\"idempotencyKey\":\"web:p23-smoke\",\"answer\":{\"optionId\":\"opt-a\"}}" >/dev/null
post /gtd/tick "{\"now\":$GTD_NOW}" | py 'import json,sys; d=json.load(sys.stdin); assert d["continued"]==1, d' || exit 1
for _ in $(seq 1 60); do
  pending=$(get "/gtd/$INPUT_GTD" | py 'import json,sys; d=json.load(sys.stdin); print(sum(1 for o in d["outcomes"] if o["state"]=="pending"))')
  active=$(post /status "{\"taskId\":\"$INPUT_TASK\"}" | py 'import json,sys; print(len([r for r in json.load(sys.stdin)["runs"] if r["status"]=="running"]))')
  [ "$pending" = "1" ] && [ "$active" = "0" ] && break
  sleep 0.5
done
[ "$pending" = "1" ] && [ "$active" = "0" ] || { echo "FAIL: продолжение после ответа не отработало" >&2; exit 1; }
post /gtd/ack "{\"gtdId\":\"$INPUT_GTD\"}" | py 'import json,sys
d = json.load(sys.stdin)
assert d["processed"][0]["decision"] == "complete", d
print("OK: ответ пользователя -> ровно одно продолжение, критерий выполнен")
' || exit 1
post /status "{\"taskId\":\"$INPUT_TASK\"}" | py '
import json,sys
d = json.load(sys.stdin)
assert d["taskStore"]["status"] == "done", d["taskStore"]["status"]
assert len(d["runs"]) == 2, d["runs"]
print("OK: задача закрыта после ответа; попыток:", len(d["runs"]))
' || exit 1

echo "== 15.5 caps завершают прогрессию: обхода новой записью нет =="
CAPS_REQ="req-p23-caps-$(date +%s)"
CAPS="$(post /intake "{\"contractVersion\":1,\"requestId\":\"$CAPS_REQ\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"шаг падает\"}]}")"
CAPS_TASK="$(echo "$CAPS" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
CAPS_REG="$(post /gtd "{\"requestId\":\"reg-$CAPS_REQ\",\"profileId\":\"$PROFILE\",\"userTaskId\":\"$CAPS_TASK\",\"reason\":\"довести до конца с проверкой\",\"criteria\":[{\"id\":\"release-ok\",\"description\":\"релиз проверен\",\"required\":true}],\"deadlineAt\":$GTD_DEADLINE,\"maxAttempts\":2}")"
CAPS_GTD="$(echo "$CAPS_REG" | py 'import json,sys; print(json.load(sys.stdin)["gtdId"])')"
for attempt in 1 2; do
  post /start "{\"taskId\":\"$CAPS_TASK\",\"profileId\":\"$PROFILE\",\"goal\":\"шаг падает\",\"gtdId\":\"$CAPS_GTD\",\"stepOutcome\":\"failed\"}" >/dev/null
  for _ in $(seq 1 60); do
    pending=$(get "/gtd/$CAPS_GTD" | py 'import json,sys; d=json.load(sys.stdin); print(sum(1 for o in d["outcomes"] if o["state"]=="pending"))')
    active=$(post /status "{\"taskId\":\"$CAPS_TASK\"}" | py 'import json,sys; print(len([r for r in json.load(sys.stdin)["runs"] if r["status"]=="running"]))')
    [ "$pending" = "1" ] && [ "$active" = "0" ] && break
    sleep 0.5
  done
  [ "$pending" = "1" ] && [ "$active" = "0" ] || { echo "FAIL: попытка $attempt не отработала" >&2; exit 1; }
  post /gtd/ack "{\"gtdId\":\"$CAPS_GTD\"}" | py 'import json,sys
d = json.load(sys.stdin)
p = d["processed"][0]
assert p["decision"] in ("continue","stop"), p
print("OK: попытка", '"$attempt"', "->", p["decision"], p["reason"])
' || exit 1
done
post /status "{\"taskId\":\"$CAPS_TASK\"}" | py '
import json,sys
d = json.load(sys.stdin); t = d["taskStore"]
assert t["status"] == "blocked", t["status"]
assert t["blockerReason"] == "attempt_cap_exhausted", t["blockerReason"]
assert len(d["runs"]) == 2, d["runs"]
print("OK: attempt cap -> blocked (blockerReason =", t["blockerReason"], "), попыток:", len(d["runs"]))
' || exit 1
DUP_REG="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/gtd" -H 'content-type: application/json' -H "X-Principal: $PRINCIPAL" -d "{\"requestId\":\"reg-$CAPS_REQ-again\",\"profileId\":\"$PROFILE\",\"userTaskId\":\"$CAPS_TASK\",\"reason\":\"начать заново\",\"criteria\":[{\"id\":\"release-ok\",\"description\":\"релиз проверен\",\"required\":true}],\"deadlineAt\":$GTD_DEADLINE,\"maxAttempts\":5}")"
[ "$DUP_REG" = "409" ] || { echo "FAIL: ждали 409 на повторную регистрацию, получили $DUP_REG" >&2; exit 1; }
echo "OK: обойти caps новой записью контроля нельзя (409)"

echo "== 15.6 неизвестный gtdId у managed outcome: карантин, не тихий fallback =="
GHOST="$(curl -sS -X POST "$BASE/gtd/outcomes" -H 'content-type: application/json' -H "X-Principal: $PRINCIPAL" -d "{\"gtdId\":\"gtd-ffffffffffffffffffff\",\"userTaskId\":\"$CAPS_TASK\",\"stepId\":\"step-9\",\"outcome\":\"failed\",\"idempotencyKey\":\"ghost:smoke\"}")"
echo "$GHOST" | py 'import json,sys; d=json.load(sys.stdin); assert d["state"]=="quarantined" and d["reason"]=="unknown_control_record", d' || exit 1
GHOST_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/gtd/outcomes" -H 'content-type: application/json' -H "X-Principal: $PRINCIPAL" -d "{\"gtdId\":\"gtd-ffffffffffffffffffff\",\"userTaskId\":\"$CAPS_TASK\",\"stepId\":\"step-9\",\"outcome\":\"failed\",\"idempotencyKey\":\"ghost:smoke\"}")"
[ "$GHOST_CODE" = "409" ] || { echo "FAIL: ждали 409 на неизвестный gtdId, получили $GHOST_CODE" >&2; exit 1; }
post /status "{\"taskId\":\"$CAPS_TASK\"}" | py 'import json,sys; d=json.load(sys.stdin); assert len(d["runs"])==2, d["runs"]' || exit 1
echo "OK: исход без записи контроля — quarantined (409), попыток не добавилось"

echo
echo "PASS: раздел 15 (GTD opt-in и bounded control) завершён; записи контроля: $GTD_ID/$INPUT_GTD/$CAPS_GTD"
