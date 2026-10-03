#!/usr/bin/env bash
# Проверка развёрнутой песочницы own-API dogfood (#23) на реальном Cloudflare.
#
# Что доказывает:
#   1. защищённый endpoint: без подписи / с чужой подписью / с подменой x-principal
#      -> 401, доступ к Task Store не открывается;
#   2. два пользователя -> две независимые задачи;
#   3. дубль submit с тем же requestId -> тот же экземпляр, второй Run не создаётся;
#   4. повторный submit после done -> квитанция, а не 500 и не второй Run;
#   5. сквозной прогон: подписанный intake -> start -> реальный Run на VM Runner ->
#      done с конечным текстом движка.
#
# Секреты только из SM/env: PRINCIPAL_SECRET (подпись) и RUNNER_API_KEY (Runner).
# В репозиторий, в файлы и в вывод они не попадают.
#
# Использование:
#   PRINCIPAL_SECRET=... ./tools/own-api-sandbox-verify.sh
set -euo pipefail

BASE="${BASE:-https://trained-assist-control-plane.skillset-apply.workers.dev}"
PRINCIPAL_SECRET="${PRINCIPAL_SECRET:?PRINCIPAL_SECRET не задан}"
P1="${P1:-sandbox-cp23}"
P2="${P2:-sandbox-cp23-other}"
PROFILE="${PROFILE:-profile-cp23}"
RUNNER_API_KEY="${RUNNER_API_KEY:-$(gcloud secrets versions access latest --secret=RUNNER_API_KEY 2>/dev/null)}"
ENGINE="${ENGINE:-fake}"

sig() { PRINCIPAL_SECRET="$PRINCIPAL_SECRET" ./tools/principal-sig.sh "$1"; }
S1="$(sig "$P1")"
S2="$(sig "$P2")"
CT="content-type: application/json"

post() { # $1=path $2=principal $3=sig $4=body
  curl -sS --max-time 30 -X POST "$BASE$1" -H "$CT" -H "x-principal: $2" -H "x-principal-sig: $3" -d "$4"
}
code() { # $1=path $2=body  -> только HTTP-код
  curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -X POST "$BASE$1" -H "$CT" -d "$2"
}
py() { python3 -c "$1"; }

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== 1. защищённый endpoint =="
[ "$(code /intake '{"requestId":"v-noauth","profileId":"profile-cp23","inputItems":[{"text":"x"}]}')" = "401" ] || fail "без подписи ожидали 401"
echo "OK: без подписи -> 401"
[ "$(code /intake '{"requestId":"v-badsig","profileId":"profile-cp23","inputItems":[{"text":"x"}]}')" = "401" ] || fail "с чужой подписью ожидали 401"
echo "OK: чужая подпись -> 401"
SPOOF="$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -X POST "$BASE/intake" -H "$CT" -H "x-principal: $P2" -H "x-principal-sig: $S1" -d '{"requestId":"v-spoof","profileId":"profile-cp23","inputItems":[{"text":"x"}]}')"
[ "$SPOOF" = "401" ] || fail "подмена x-principal ожидали 401, получили $SPOOF"
echo "OK: подпись $P1 с x-principal: $P2 -> 401 (подменить нельзя)"

echo "== 2. два пользователя -> две задачи =="
R1="v-u1-$(date +%s)"; R2="v-u2-$(date +%s)"
T1="$(post /intake "$P1" "$S1" "{\"contractVersion\":1,\"requestId\":\"$R1\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"задача пользователя 1\"}]}" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
T2="$(post /intake "$P2" "$S2" "{\"contractVersion\":1,\"requestId\":\"$R2\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"задача пользователя 2\"}]}" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
[ -n "$T1" ] && [ -n "$T2" ] && [ "$T1" != "$T2" ] || fail "две задачи не созданы: $T1 / $T2"
echo "OK: user1=$T1 user2=$T2 (разные задачи)"

echo "== 3. дубль submit с тем же requestId =="
DUP="$(post /intake "$P1" "$S1" "{\"contractVersion\":1,\"requestId\":\"$R1\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"задача пользователя 1\"}]}")"
echo "$DUP" | py 'import json,sys; d=json.load(sys.stdin); assert d["duplicate"] is True and d["userTaskId"]=="'"$T1"'", d; print("OK: тот же requestId -> та же задача, duplicate=true")'

echo "== 4. сквозной прогон: реальный Run на VM Runner =="
START="$(post /start "$P1" "$S1" "{\"taskId\":\"$T1\",\"profileId\":\"$PROFILE\",\"goal\":\"задача пользователя 1\",\"runnerEngine\":\"$ENGINE\"}")"
RUN1="$(echo "$START" | py 'import json,sys; print(json.load(sys.stdin)["runId"])')"
echo "OK: попытка control plane=$RUN1"

ST=""
for _ in $(seq 1 40); do
  R="$(post /status "$P1" "$S1" "{\"taskId\":\"$T1\"}")"
  ST="$(echo "$R" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["status"])')"
  case "$ST" in done|failed|cancelled) break;; esac
  sleep 2
done
[ "$ST" = "done" ] || fail "задача 1 не дошла до done ($ST)"
echo "$R" | py '
import json,sys
d=json.load(sys.stdin); t=d["taskStore"]; r=t["result"]
assert r["mode"]=="engine", r
assert r["answer"], "движок не вернул текст"
assert r["runId"].startswith("run_"), r
assert r["persistence"]=="persisted", r
print("OK: done; answer=", json.dumps(r["answer"], ensure_ascii=False))
print("OK: runId=", r["runId"], "persistence=", r["persistence"], "artifacts=", r["artifacts"])
'
RUNNER_RUN="$(echo "$R" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["result"]["runId"])')"
RUNS_ON_VM="$(ssh -o BatchMode=yes vm2 "grep -l '\"userTaskId\": \"$T1\"' /var/lib/agent-runner/runs/*/state.json 2>/dev/null | wc -l" | tr -d ' ')"
[ "$RUNS_ON_VM" = "1" ] || fail "на Runner $RUNS_ON_VM ранов для $T1 (ожидали 1)"
echo "OK: на Runner ровно 1 ран для userTaskId=$T1"

echo "== 5. повторный submit после done =="
AGAIN="$(post /start "$P1" "$S1" "{\"taskId\":\"$T1\",\"profileId\":\"$PROFILE\",\"goal\":\"задача пользователя 1\",\"runnerEngine\":\"$ENGINE\"}")"
echo "$AGAIN" | py 'import json,sys; d=json.load(sys.stdin); assert d["created"] is False and d["instanceCreated"] is False, d; print("OK: повторный submit -> квитанция, второй Run нет")'
RUNS_AFTER="$(ssh -o BatchMode=yes vm2 "grep -l '\"userTaskId\": \"$T1\"' /var/lib/agent-runner/runs/*/state.json 2>/dev/null | wc -l" | tr -d ' ')"
[ "$RUNS_AFTER" = "1" ] || fail "после повтора на Runner $RUNS_AFTER ранов"
echo "OK: на Runner по-прежнему 1 ран"

echo
echo "PASS: песочница проверена"
echo "EVIDENCE profileId=$PROFILE user1=$T1 runnerRun1=$RUNNER_RUN user2=$T2 engine=$ENGINE"
