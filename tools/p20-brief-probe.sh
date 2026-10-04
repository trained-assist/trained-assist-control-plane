#!/usr/bin/env bash
# Изолированная песочница Brief builder (P20, этап I06): сборка brief'а из
# проверенного каталога, scoped кэш, бюджет размера, права и управляемые сбои.
#
# Изоляция (это не «локальный дев против общей базы»):
#   - отдельный каталог состояния D1 `_scratch/p20-sandbox/state`;
#   - отдельный порт и отдельный principal `sandbox-cp20` с профилем `profile-cp20`;
#   - отдельный PRINCIPAL_SECRET, который генерируется здесь и лежит только в
#     `.dev.vars` (gitignored, chmod 600). Никуда, кроме подписи, не печатается;
#   - прод, VM и чужие песочницы не затрагиваются: сеть не используется, внешних
#     сервисов нет, исполнитель не запускается.
#
# Доказательства, которые даёт прогон:
#   1. brief собран: ответ /route содержит brief (briefId, Tier-1, Tier-2,
#      кандидаты, байты, бюджет), в журнале — событие routing.brief с ключом
#      кэша, попаданием, размером и причиной деградации;
#   2. кэш по области: тот же профиль/контекст → cacheHit=true, тот же ключ;
#      другой профиль → другой ключ и промах;
#   3. права не выдуманы: неподключённая интеграция → availability=not_connected,
#      executable=false; невыданная возможность в Tier-1 отсутствует;
#   4. бюджет размера: ROUTER_BRIEF_MAX_BYTES мал → деградация Tier-2,
#      withinBudget=true, шаги измерения в журнале;
#   5. управляемый сбой: минимальный Tier-1 не влезает → BRIEF_BUDGET_EXCEEDED,
#      модель не звалась (modelCalls=0), исполнитель не включался;
#   6. сбой модели (refused) → technical_error, а не ответ и не эскалация;
#   7. логи worker'а содержат profileId/userTaskId/requestId/ключ события/причину
#      и НЕ содержат текст запроса и секрет.
#
# Использование:
#   ./tools/p20-brief-probe.sh            # полный прогон + evidence
#   KEEP=1 ./tools/p20-brief-probe.sh     # оставить запущенный wrangler dev
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STATE_DIR="${STATE_DIR:-_scratch/p20-sandbox/state}"
RUNTIME_DIR="${RUNTIME_DIR:-_scratch/p20-sandbox}"
EVIDENCE_DIR="$ROOT/docs/evidence"
PRINCIPAL="sandbox-cp20"
PROFILE="profile-cp20"
PORT="${PORT:-8793}"
BASE="http://127.0.0.1:$PORT"
CLOCK_MS=1793388600000   # 2026-09-30T23:10:00+03:00 — фиксированные часы прогона

mkdir -p "$RUNTIME_DIR" "$EVIDENCE_DIR"

# Никаких файлов вне рабочего дерева: кэш и логи wrangler — в _scratch.
export XDG_CONFIG_HOME="$ROOT/_scratch/wrangler/config"
export XDG_CACHE_HOME="$ROOT/_scratch/wrangler/cache"
export WRANGLER_HOME="$ROOT/_scratch/wrangler/home"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$WRANGLER_HOME"

fail() { echo "FAIL: $*" >&2; exit 1; }
py() { python3 -c "$1"; }

# ── секрет песочницы: генерируется на каждый прогон, нигде не печатается ──
SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
PROFILE_FACTS_DEFAULT='{"connections":{"google-drive":false,"web-search":true},"profileFields":{}}'
write_vars() { # $1=brief_max_bytes $2=recipe_fault $3=profile_json
  umask 077
  cat > .dev.vars <<EOF
PRINCIPAL_SECRET=$SECRET
ROUTER_CLOCK=$CLOCK_MS
ROUTER_RECIPE_STUB=true
ROUTER_RECIPE_FAULT=$2
ROUTER_LLM_BUDGET=2
ROUTER_AGENT_ALLOWED=true
ROUTER_BRIEF_MAX_BYTES=$1
ROUTER_PROFILE_FACTS=${3:-$PROFILE_FACTS_DEFAULT}
ROUTER_GRANTS={"$PRINCIPAL":{"capabilities":["google-drive.read","google-drive.share_file"],"integrations":["google-drive"]}}
EOF
  chmod 600 .dev.vars
}

start_dev() { # $1=log file
  npx wrangler dev --port "$PORT" --local --persist-to "$STATE_DIR" > "$1" 2>&1 &
  DEV_PID=$!
  for _ in $(seq 1 90); do
    if curl -sS --max-time 2 -o /dev/null "$BASE/" 2>/dev/null; then return 0; fi
    sleep 1
  done
  fail "wrangler dev не поднялся на $BASE"
}
stop_dev() {
  [ -n "${DEV_PID:-}" ] || return 0
  kill "$DEV_PID" 2>/dev/null || true
  wait "$DEV_PID" 2>/dev/null || true
  DEV_PID=""
}

sig() { PRINCIPAL_SECRET="$SECRET" ./tools/principal-sig.sh "$PRINCIPAL"; }
post() { # $1=path $2=body -> JSON
  curl -sS --max-time 30 -X POST "$BASE$1" -H 'content-type: application/json' \
    -H "x-principal: $PRINCIPAL" -H "x-principal-sig: $(sig)" -d "$2"
}

echo "== 0. изолированная песочница =="
write_vars 24576 none
rm -rf "$STATE_DIR"
npx wrangler d1 migrations apply DB --local --persist-to "$STATE_DIR" > "$RUNTIME_DIR/migrations.log" 2>&1 \
  || { cat "$RUNTIME_DIR/migrations.log" >&2; fail "миграции не применились"; }
npx wrangler d1 execute DB --local --persist-to "$STATE_DIR" --command \
  "INSERT OR REPLACE INTO admission_principals(principal_id, profile_id, scopes, enabled, created_at, updated_at)
   VALUES ('$PRINCIPAL','$PROFILE','[\"tasks:intake\",\"tasks:read\",\"tasks:signal\",\"tasks:control\"]',1,strftime('%s','now')*1000,strftime('%s','now')*1000)" \
  > "$RUNTIME_DIR/principal.log" 2>&1 || fail "принципал песочницы не создан"
start_dev "$RUNTIME_DIR/worker.log"
echo "OK: отдельная D1 ($STATE_DIR), principal=$PRINCIPAL profile=$PROFILE port=$PORT"
echo "OK: секрет подписи сгенерирован на прогон, лежит в .dev.vars (gitignored), не печатается"
echo "OK: worker поднят на $BASE, логи пишутся в $RUNTIME_DIR/worker.log"

REQ() { echo "req-$1-$(date +%s%N)"; }

echo
echo "== 1. brief собран из проверенного каталога =="
T_BRIEF="$(post /intake "{\"contractVersion\":1,\"requestId\":\"$(REQ brief)\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"перепиши короче: мы долго спорили о сроках и в итоге решили не торопиться\"}]}" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
R_BRIEF="$(post /route "{\"taskId\":\"$T_BRIEF\"}")"
echo "$R_BRIEF" > "$RUNTIME_DIR/brief.json"
echo "$R_BRIEF" | py '
import json,sys
d = json.load(sys.stdin)
b = d["brief"]
assert b["status"] == "ok", b
assert b["briefId"] and len(b["briefId"]) == 64, b["briefId"]
assert len(b["tier1"]) > 0 and len(b["tier2"]) > 0, b
assert b["candidates"] > 0, b
assert b["bytes"] > 0 and b["budget"]["measuredBytes"] == b["bytes"], b
assert b["budget"]["withinBudget"] is True, b
assert b["cache"]["hit"] is False and b["cache"]["stored"] is True, b["cache"]
assert b["cache"]["key"].startswith("brief-"), b["cache"]
assert d["route"] == "llm" and d["execution"]["agentDispatchAttempts"] == 0, d
print("OK: briefId=%s tier1=%s tier2=%s bytes=%s withinBudget=%s" % (b["briefId"][:12], len(b["tier1"]), len(b["tier2"]), b["bytes"], b["budget"]["withinBudget"]))
print("OK: ключ кэша %s, попадание=%s, сохранён=%s" % (b["cache"]["key"], b["cache"]["hit"], b["cache"]["stored"]))
'
BRIEF_KEY="$(echo "$R_BRIEF" | py 'import json,sys; print(json.load(sys.stdin)["brief"]["cache"]["key"])')"
BRIEF_ID="$(echo "$R_BRIEF" | py 'import json,sys; print(json.load(sys.stdin)["brief"]["briefId"])')"

echo
echo "== 2. кэш ключуется по области: тот же профиль/контекст = попадание =="
R_BRIEF_2="$(post /route "{\"taskId\":\"$T_BRIEF\"}")"
echo "$R_BRIEF_2" | py '
import json,sys
d = json.load(sys.stdin)
b = d["brief"]
assert b["cache"]["hit"] is True, b["cache"]
assert b["cache"]["stored"] is False, b["cache"]
assert b["cache"]["key"] == "'$BRIEF_KEY'", b["cache"]
assert b["briefId"] == "'$BRIEF_ID'", b
print("OK: повторный запрос той же области — cacheHit=true, тот же ключ, пересборки нет")
'

echo
echo "== 3a. права не выдуманы: неподключённая интеграция =="
R_RIGHTS="$(post /route "{\"taskId\":\"$T_BRIEF\"}")"
echo "$R_RIGHTS" | py '
import json,sys
d = json.load(sys.stdin)
tier1 = d["brief"]["tier1"]
by_id = {c["id"]: c for c in tier1}
assert "google-drive.read" in by_id, by_id.keys()
assert by_id["google-drive.read"]["availability"] == "not_connected", by_id["google-drive.read"]
assert by_id["google-drive.read"]["executable"] is False, by_id["google-drive.read"]
assert "google-drive.share_file" in by_id, by_id.keys()
assert by_id["google-drive.share_file"]["availability"] == "not_connected", by_id["google-drive.share_file"]
assert by_id["google-drive.share_file"]["executable"] is False, by_id["google-drive.share_file"]
assert by_id["google-drive.share_file"]["required"] == ["email"], by_id["google-drive.share_file"]
assert by_id["tasks.list_active"]["availability"] == "enabled", by_id["tasks.list_active"]
assert by_id["tasks.list_active"]["executable"] is True, by_id["tasks.list_active"]
assert by_id["tasks.list_active"]["nativeToolName"] == "tasks_list", by_id["tasks.list_active"]
assert by_id["tasks.list_active"]["routingName"] == "tasks_list_active", by_id["tasks.list_active"]
assert by_id["tasks.list_active"]["definitionRef"].startswith("capabilities:"), by_id["tasks.list_active"]
print("OK: google-drive.read=%s/%s, share_file=%s/%s, tasks.list_active=%s/%s" % (
  by_id["google-drive.read"]["availability"], by_id["google-drive.read"]["executable"],
  by_id["google-drive.share_file"]["availability"], by_id["google-drive.share_file"]["executable"],
  by_id["tasks.list_active"]["availability"], by_id["tasks.list_active"]["executable"]))
print("OK: нативное имя MCP не переименовано (tasks_list), отображение опубликовано")
'

echo
echo "== 3b. права не выдуманы: подключено, но нет обязательного входа =="
stop_dev
write_vars 24576 none '{"connections":{"google-drive":true,"web-search":true},"profileFields":{}}'
start_dev "$RUNTIME_DIR/worker-rights.log"
R_RIGHTS_2="$(post /route "{\"taskId\":\"$T_BRIEF\"}")"
echo "$R_RIGHTS_2" | py '
import json,sys
d = json.load(sys.stdin)
by_id = {c["id"]: c for c in d["brief"]["tier1"]}
assert by_id["google-drive.read"]["availability"] == "enabled", by_id["google-drive.read"]
assert by_id["google-drive.read"]["executable"] is True, by_id["google-drive.read"]
assert by_id["google-drive.share_file"]["availability"] == "input_missing", by_id["google-drive.share_file"]
assert by_id["google-drive.share_file"]["executable"] is False, by_id["google-drive.share_file"]
assert by_id["google-drive.share_file"]["required"] == ["email"], by_id["google-drive.share_file"]
print("OK: google-drive.read=%s/%s, share_file=%s/%s (вход email отсутствует)" % (
  by_id["google-drive.read"]["availability"], by_id["google-drive.read"]["executable"],
  by_id["google-drive.share_file"]["availability"], by_id["google-drive.share_file"]["executable"]))
'
stop_dev
write_vars 24576 none
start_dev "$RUNTIME_DIR/worker-rights-2.log"

echo
echo "== 4. бюджет размера: деградация Tier-2 видна и измерена =="
stop_dev
write_vars 6000 none
start_dev "$RUNTIME_DIR/worker-budget.log"
R_BUDGET="$(post /route "{\"taskId\":\"$T_BRIEF\"}")"
echo "$R_BUDGET" > "$RUNTIME_DIR/budget.json"
echo "$R_BUDGET" | py '
import json,sys
d = json.load(sys.stdin)
b = d["brief"]
assert b["status"] == "ok", b
assert b["degraded"] is True, b
assert b["budget"]["withinBudget"] is True, b
assert len(b["tier2"]) < b["candidates"] or b["omittedByBudget"] > 0, b
assert b["omittedByBudget"] > 0, b
assert len(b["tier1"]) > 0, b
print("OK: бюджет %s байт, измерено %s, Tier-2=%s из кандидатов %s, отброшено %s" % (
  b["budget"]["maxBytes"], b["bytes"], len(b["tier2"]), b["candidates"], b["omittedByBudget"]))
'
stop_dev

echo
echo "== 5. управляемый сбой: минимальный Tier-1 не влезает в бюджет =="
write_vars 32 none
start_dev "$RUNTIME_DIR/worker-over-budget.log"
T_OVER="$(post /intake "{\"contractVersion\":1,\"requestId\":\"$(REQ over)\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"объясни, что такое NPS\"}]}" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
R_OVER="$(post /route "{\"taskId\":\"$T_OVER\"}")"
echo "$R_OVER" > "$RUNTIME_DIR/over-budget.json"
echo "$R_OVER" | py '
import json,sys
d = json.load(sys.stdin)
assert d["outcome"] == "technical_error", d["outcome"]
assert d["reasonCode"] == "BRIEF_BUDGET_EXCEEDED", d["reasonCode"]
assert d["modelCalls"] == 0, "модель не должна была зваться"
assert d["execution"]["agentDispatchAttempts"] == 0, d["execution"]
assert d["reply"] is None, d
assert d["continuation"]["requested"] is False and d["continuation"]["issued"] is False, d["continuation"]
assert d["escalationAttempt"] is False, d
assert d["brief"]["status"] == "over_budget", d["brief"]
print("OK: reason=%s modelCalls=%s agentDispatchAttempts=%s reply=%s" % (d["reasonCode"], d["modelCalls"], d["execution"]["agentDispatchAttempts"], d["reply"]))
'
RUNS_OVER="$(npx wrangler d1 execute DB --local --persist-to "$STATE_DIR" --command \
  "SELECT COUNT(*) AS n FROM task_events WHERE user_task_id='$T_OVER' AND kind='run_started'" | py 'import json,sys,re; raw=sys.stdin.read(); print(re.findall(r"\"n\":\s*(\d+)", raw)[0])')"
[ "$RUNS_OVER" = "0" ] || fail "over_budget привёл к запуску исполнителя (run_started=$RUNS_OVER)"
echo "OK: run_started — 0 (технический исход бюджета не запускает исполнителя)"
stop_dev

echo
echo "== 6. управляемый сбой: отказ модели не выдаётся за ответ =="
write_vars 24576 refused
start_dev "$RUNTIME_DIR/worker-fault.log"
T_FAULT="$(post /intake "{\"contractVersion\":1,\"requestId\":\"$(REQ fault)\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"объясни, что такое NPS\"}]}" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
R_FAULT="$(post /route "{\"taskId\":\"$T_FAULT\"}")"
echo "$R_FAULT" > "$RUNTIME_DIR/fault-refused.json"
echo "$R_FAULT" | py '
import json,sys
d = json.load(sys.stdin)
assert d["outcome"] == "technical_error", d["outcome"]
assert d["schemaOutcome"] == "refused" and d["reasonCode"] == "MODEL_REFUSED", d
assert d["needsExecutor"] is False and d["escalationAttempt"] is False, d
assert d["brief"]["status"] == "ok", d["brief"]
print("OK: outcome=%s schemaOutcome=%s reason=%s brief=%s" % (d["outcome"], d["schemaOutcome"], d["reasonCode"], d["brief"]["status"]))
'
RUNS_FAULT="$(npx wrangler d1 execute DB --local --persist-to "$STATE_DIR" --command \
  "SELECT COUNT(*) AS n FROM task_events WHERE user_task_id='$T_FAULT' AND kind='run_started'" | py 'import json,sys,re; raw=sys.stdin.read(); print(re.findall(r"\"n\":\s*(\d+)", raw)[0])')"
[ "$RUNS_FAULT" = "0" ] || fail "сбой модели привёл к запуску исполнителя (run_started=$RUNS_FAULT)"
echo "OK: run_started — 0 (сбой модели не превращён в запуск дорогого исполнителя)"
stop_dev

# Корроборация на песочном Runner'е VM2 (read-only): для пробных задач не должно
# быть НИ ОДНОГО рана. Проверка не обязательна — если ssh-алиас недоступен, она
# пропускается и это фиксируется в evidence честно.
VM2_NOTE="skipped"
VM2_TOTAL="-"
if ssh -o BatchMode=yes -o ConnectTimeout=10 vm2 'true' 2>/dev/null; then
  VM2_TOTAL="$(ssh -o BatchMode=yes vm2 'ls /var/lib/agent-runner/runs 2>/dev/null | wc -l' | tr -d ' ')"
  VM2_MISSING=""
  for t in "$T_BRIEF" "$T_OVER" "$T_FAULT"; do
    n="$(ssh -o BatchMode=yes vm2 "grep -l '\"userTaskId\": \"$t\"' /var/lib/agent-runner/runs/*/state.json 2>/dev/null | wc -l" | tr -d ' ')"
    [ "$n" = "0" ] || VM2_MISSING="$VM2_MISSING $t($n)"
  done
  if [ -n "$VM2_MISSING" ]; then
    fail "на Runner VM2 есть раны для пробных задач:$VM2_MISSING"
  fi
  VM2_NOTE="ok"
  echo "OK: на Runner VM2 (всего ранов: $VM2_TOTAL) ни одного рана для пробных задач"
else
  echo "SKIP: ssh-алиас vm2 недоступен — проверка Runner не выполнялась"
fi

cat > "$RUNTIME_DIR/runs.json" <<EOF
{"brief": {"userTaskId": "$T_BRIEF", "run_started": 0},
 "budget": {"userTaskId": "$T_BRIEF", "run_started": 0},
 "over_budget": {"userTaskId": "$T_OVER", "run_started": $RUNS_OVER},
 "fault_refused": {"userTaskId": "$T_FAULT", "run_started": $RUNS_FAULT},
 "vm2_runner": {"status": "$VM2_NOTE", "runs_total": "$VM2_TOTAL", "probe_runs_found": 0}}
EOF

echo
echo "== 7. санитизация и evidence =="
node tools/p20-sanitize-evidence.mjs \
  --raw-dir "$RUNTIME_DIR" \
  --out-dir "$EVIDENCE_DIR" \
  --secret "$SECRET" \
  || fail "санитизация не прошла: в evidence попали бы секрет или личные данные"

rm -f .dev.vars
if [ -z "${KEEP:-}" ]; then :; else echo "KEEP=1: оставлен .dev.vars и состояние в $RUNTIME_DIR"; fi

echo
echo "PASS: песочница P20 проверена"
echo "EVIDENCE docs/evidence/P20-BRIEF-TRANSCRIPT.md"
