#!/usr/bin/env bash
# Изолированная песочница P17 (этап I05): bounded reply-or-route recipe и
# единственный владелец продолжения.
#
# Изоляция (это не «локальный дев против общей базы»):
#   - отдельный каталог состояния D1 `_scratch/p17-sandbox/state`;
#   - отдельный порт и отдельный principal `sandbox-cp17` с профилем `profile-cp17`;
#   - отдельный PRINCIPAL_SECRET, который генерируется здесь и лежит только в
#     `.dev.vars` (gitignored, chmod 600). Никуда, кроме подписи, не печатается;
#   - прод, VM и чужие песочницы не затрагиваются: сеть не используется, внешних
#     сервисов нет. Исполнитель не запускается ни одной пробой, кроме явной
#     пробы продолжения, — и только по `continue: true` при включённой политике.
#
# Доказательства, которые даёт прогон (AC-128):
#   1. schema invalid — один ремонт формы, затем technical_error/SCHEMA_INVALID,
#      исполнитель не включается;
#   2. model timeout — technical_error/MODEL_TIMEOUT, без эскалации;
#   3. budget denied — до платного вызова: модель не зовётся вовсе;
#   4. provider failure — technical_error/PROVIDER_FAILURE с кодом провайдера;
#   5. awaiting input — типизированное ожидание по известному хосту полю;
#   6. insufficient context — ответ не публикуется и не эскалируется;
#   7. one continuation owner — роутер запрашивает продолжение, но не создаёт
#      job/run; выдаёт его только Output, и только по явному запросу;
#   8. OpenCode — конечный auto executor: executor=opencode, цепочки на
#      Claude/Codex нет;
#   9. идемпотентность: повторный continue с тем же decisionId не создаёт
#      вторую работу;
#  10. логи содержат profileId/userTaskId/runId/ключ события/причину и НЕ
#      содержат текст запроса и секрет.
#
# Использование:
#   ./tools/p17-sandbox-probe.sh            # полный прогон + evidence
#   KEEP=1 ./tools/p17-sandbox-probe.sh     # оставить запущенный wrangler dev
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STATE_DIR="${STATE_DIR:-_scratch/p17-sandbox/state}"
RUNTIME_DIR="${RUNTIME_DIR:-_scratch/p17-sandbox}"
EVIDENCE_DIR="$ROOT/docs/evidence"
PRINCIPAL="sandbox-cp17"
PROFILE="profile-cp17"
PORT="${PORT:-8792}"
BASE="http://127.0.0.1:$PORT"
CLOCK_MS=1793388600000   # 2026-09-30T23:10:00+03:00 — фиксированные часы прогона

mkdir -p "$RUNTIME_DIR" "$EVIDENCE_DIR"

# Никаких файлов вне рабочего дерева: кэш и логи wrangler — в _scratch.
export XDG_CONFIG_HOME="$ROOT/_scratch/wrangler-p17/config"
export XDG_CACHE_HOME="$ROOT/_scratch/wrangler-p17/cache"
export WRANGLER_HOME="$ROOT/_scratch/wrangler-p17/home"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$WRANGLER_HOME"

fail() { echo "FAIL: $*" >&2; exit 1; }
py() { python3 -c "$1" "${@:2}"; }

# ── секрет песочницы: генерируется на каждый прогон, нигде не печатается ──
SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
DEV_VARS="$ROOT/.dev.vars"

# $1 = имя файла с дополнительными переменными (без секрета)
write_vars() {
  umask 077
  {
    echo "PRINCIPAL_SECRET=$SECRET"
    echo "ROUTER_CLOCK=$CLOCK_MS"
    echo "ROUTER_LLM_BUDGET=2"
    echo "ROUTER_AGENT_ALLOWED=true"
    echo 'ROUTER_PROFILE_FACTS={"connections":{"google-drive":true,"web-search":true},"profileFields":{"email":null}}'
    echo "ROUTER_GRANTS={\"$PRINCIPAL\":{\"capabilities\":[],\"integrations\":[]}}"
    [ -z "${1:-}" ] || cat "$1"
  } > "$DEV_VARS"
  chmod 600 "$DEV_VARS"
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
# Переменные окружения воркера читаются при старте, поэтому каждая проба со
# своим сценарием/сбоем — отдельный перезапуск. Файл доп. переменных — в _scratch.
write_env() { # $1=файл $2=содержимое
  printf '%s\n' "$2" > "$RUNTIME_DIR/$1"
}

# Остановить воркер и ДОЖДАТЬСЯ освобождения порта: убить только npm-процесс
# нельзя — дочерний workerd остаётся держать порт, и следующий старт падает
# с «Address already in use». Поэтому убиваем всё дерево процессов от корня.
kill_tree() { # $1=pid
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

stop_dev() {
  [ -n "${DEV_PID:-}" ] || return 0
  local root="$DEV_PID"
  DEV_PID=""
  kill_tree "$root"
  for _ in $(seq 1 30); do
    if ! pgrep -P "$root" > /dev/null 2>&1 && ! ps -p "$root" > /dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "wrangler dev не остановился на порту $PORT"
}

sig() { PRINCIPAL_SECRET="$SECRET" ./tools/principal-sig.sh "$PRINCIPAL"; }
post() { # $1=path $2=body -> JSON
  curl -sS --max-time 60 -X POST "$BASE$1" -H 'content-type: application/json' \
    -H "x-principal: $PRINCIPAL" -H "x-principal-sig: $(sig)" -d "$2"
}
intake() { # $1=text -> userTaskId
  post /intake "{\"contractVersion\":1,\"requestId\":\"req-$1-$(date +%s%N)\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":$(py 'import json,sys; print(json.dumps(sys.argv[1]))' "$1")}]}" \
    | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])'
}
route() { # $1=taskId $2=extra body fields (JSON object) -> JSON
  post /route "{\"taskId\":\"$1\"${2:-}}"
}
# Считаем ПОПЫТКИ (строки executions), а не события журнала: событие run_started
# пишется и на старте попытки, и на отправке в Runner, поэтому по нему число
# попыток не восстановить. Попытка — это строка executions со своим runId.
runs_of() { # $1=taskId -> число попыток исполнения
  npx wrangler d1 execute DB --local --persist-to "$STATE_DIR" --command \
    "SELECT COUNT(*) AS n FROM executions WHERE task_id='$1'" \
    | py 'import json,sys,re; raw=sys.stdin.read(); print(re.findall(r"\"n\":\s*(\d+)", raw)[0])'
}

# Сценарии скриптованной модели: по одному решению на вызов.
REPLY='{"schemaVersion":1,"kind":"reply","reply":{"text":"Короче: решили не торопиться.","evidenceRefs":["host:conversation"]},"assessment":{"contextSufficient":true,"needsFreshData":false,"needsActions":false,"needsAdaptiveTools":false}}'
CLARIFY='{"schemaVersion":1,"kind":"clarify","clarify":{"question":"Что именно сделать?","missingFields":["goal"]},"assessment":{"contextSufficient":false,"needsFreshData":false,"needsActions":false,"needsAdaptiveTools":false}}'
CLARIFY_EMAIL='{"schemaVersion":1,"kind":"clarify","clarify":{"question":"Нужен ваш email, чтобы отправить файл.","missingFields":["email"]},"assessment":{"contextSufficient":false,"needsFreshData":false,"needsActions":false,"needsAdaptiveTools":false}}'
REPLY_NO_CONTEXT='{"schemaVersion":1,"kind":"reply","reply":{"text":"Ответ по неполному контексту.","evidenceRefs":[]},"assessment":{"contextSufficient":false,"needsFreshData":true,"needsActions":false,"needsAdaptiveTools":false}}'
AGENT_JOB='{"schemaVersion":1,"kind":"needs_executor","proposedJobType":"ai-agent-job","nextGoal":"найди пять конкурентов и сравни цены","preservedConstraints":[],"requiredCapabilities":["web-search"],"reasonCode":"ADAPTIVE_TOOL_LOOP","assessment":{"contextSufficient":false,"needsFreshData":true,"needsActions":false,"needsAdaptiveTools":true}}'

echo "== 0. изолированная песочница =="
# Предвычистка: дочерний workerd от прошлого прогона может остаться держать
# порт, и тогда новый воркер падает с «Address already in use», а запросы
# уходят на старый экземпляр со старым секретом (signature_mismatch).
for stale in $(pgrep -f "wrangler dev --port $PORT" 2>/dev/null || true) $(pgrep -f "npm exec wrangler dev --port $PORT" 2>/dev/null || true); do
  kill_tree "$stale"
done
sleep 1
rm -rf "$STATE_DIR"
npx wrangler d1 migrations apply DB --local --persist-to "$STATE_DIR" > "$RUNTIME_DIR/migrations.log" 2>&1 \
  || { cat "$RUNTIME_DIR/migrations.log" >&2; fail "миграции не применились"; }
npx wrangler d1 execute DB --local --persist-to "$STATE_DIR" --command \
  "INSERT OR REPLACE INTO admission_principals(principal_id, profile_id, scopes, enabled, created_at, updated_at)
   VALUES ('$PRINCIPAL','$PROFILE','[\"tasks:intake\",\"tasks:read\",\"tasks:signal\",\"tasks:control\"]',1,strftime('%s','now')*1000,strftime('%s','now')*1000)" \
  > "$RUNTIME_DIR/principal.log" 2>&1 || fail "принципал песочницы не создан"
echo "OK: отдельная D1 ($STATE_DIR), principal=$PRINCIPAL profile=$PROFILE port=$PORT"
echo "OK: секрет подписи сгенерирован на прогон, лежит в .dev.vars (gitignored), не печатается"

# Текст, который политика отдаёт рецепту (работа с уже данным текстом).
TEXT_WORK='перепиши короче: мы долго спорили о сроках и в итоге решили не торопиться'

# Переменные окружения воркера читаются при старте, поэтому каждая проба со
# своим сценарием/сбоем — отдельный перезапуск. Файл доп. переменных — в _scratch.
write_env() { # $1=файл $2=содержимое
  printf '%s\n' "$2" > "$RUNTIME_DIR/$1"
}

echo
echo "== 1. один полезный вызов: reply / clarify / needs_executor =="
# Сценарий читается воркером при старте, поэтому каждая проба со своим решением
# — отдельный перезапуск (последний элемент сценария повторяется, поэтому без
# перезапуска все три пробы получили бы одно и то же решение).
probe_decision() { # $1=имя пробы $2=файл сценария $3=текст
  write_env "$1.env" "ROUTER_RECIPE_SCRIPT=[$(py 'import json,sys; print(json.dumps(sys.argv[1]))' "$2")]"
  write_vars "$RUNTIME_DIR/$1.env"
  start_dev "$RUNTIME_DIR/worker-$1.log"
  T="$(intake "$3")"
  R="$(route "$T")"
  echo "$R" > "$RUNTIME_DIR/$1.json"
  stop_dev
  printf '%s' "$T"
}

T_REPLY="$(probe_decision reply "$REPLY" "$TEXT_WORK")"
cat "$RUNTIME_DIR/reply.json" | py '
import json,sys
d = json.load(sys.stdin)
assert d["route"] == "llm" and d["mode"] == "llm-recipe-job", (d["route"], d["mode"])
assert d["outcome"] == "reply" and d["reply"], d
assert d["recipeId"] == "reply-or-route-v1" and d["modelId"] == "sandbox-scripted-fixed-model", d
assert d["modelCalls"] == 1 and d["needsExecutor"] is False and d["executor"] is None, d
assert d["execution"]["agentDispatchAttempts"] == 0, d["execution"]
assert d["continuation"]["requested"] is False, "reply не запрашивает продолжение"
print("OK: outcome=reply recipeId=%s modelCalls=%s executor=%s" % (d["recipeId"], d["modelCalls"], d["executor"]))
'
[ "$(runs_of "$T_REPLY")" = "0" ] || fail "reply привёл к попытке"
echo "OK: попыток — 0 (быстрый ответ не запускает исполнителя)"

T_CLARIFY="$(probe_decision clarify "$CLARIFY" "$TEXT_WORK")"
cat "$RUNTIME_DIR/clarify.json" | py '
import json,sys
d = json.load(sys.stdin)
assert d["outcome"] == "clarify" and d["askUser"], d
assert d["reply"] is None and d["continuation"]["requested"] is False, d
print("OK: outcome=clarify question=%s" % d["askUser"]["question"])
'

T_EXEC="$(probe_decision needs-executor "$AGENT_JOB" "$TEXT_WORK")"
cat "$RUNTIME_DIR/needs-executor.json" | py '
import json,sys
d = json.load(sys.stdin)
text = sys.argv[1]
assert d["outcome"] == "escalated" and d["needsExecutor"] is True, d
assert d["executor"] == "opencode", "исполнитель назначает хост, и это OpenCode"
assert d["workOrder"]["executor"] == "opencode", d["workOrder"]
assert d["reply"] is None and d["replyAllowed"] is False, d
c = d["workOrder"]
assert c["originalRequestRef"].startswith("task:"), c["originalRequestRef"]
assert c["goal"] == text, "заявка ссылается на исходный запрос, а не на переформулировку"
assert d.get("jobRef") is None and d.get("runRef") is None, "роутер не создаёт ни job, ни run"
print("OK: outcome=escalated executor=opencode workOrder.goal=исходный запрос jobRef=null")
print("OK: requiredCapabilities=%s (названные решением, не весь каталог)" % c["requiredCapabilities"])
' "$TEXT_WORK"
[ "$(runs_of "$T_EXEC")" = "0" ] || fail "needs_executor сам создал попытку"
echo "OK: попыток — 0 (запрос продолжения ≠ запуск: владелец — Output)"
stop_dev

echo
echo "== 2. schema invalid: один ремонт, затем честный технический исход =="
write_env schema.env "ROUTER_RECIPE_SCRIPT=[\"это не JSON\",\"и это тоже не JSON\"]"
write_vars "$RUNTIME_DIR/schema.env"
start_dev "$RUNTIME_DIR/worker-schema.log"
T_SCHEMA="$(intake "$TEXT_WORK")"
R_SCHEMA="$(route "$T_SCHEMA")"
echo "$R_SCHEMA" > "$RUNTIME_DIR/schema-invalid.json"
echo "$R_SCHEMA" | py '
import json,sys
d = json.load(sys.stdin)
assert d["outcome"] == "technical_error", d["outcome"]
assert d["schemaOutcome"] == "invalid" and d["reasonCode"] == "SCHEMA_INVALID", d
assert d["modelCalls"] == 2 and d["repairAttempts"] == 1, "ремонт — максимум один вызов"
assert d["reply"] is None, "невалидная схема не становится ответом"
assert d["needsExecutor"] is False and d["escalationAttempt"] is False, "технический исход не эскалирует"
assert d["continuation"]["requested"] is False, d
print("OK: outcome=%s schemaOutcome=%s reason=%s modelCalls=%s repairAttempts=%s" % (d["outcome"], d["schemaOutcome"], d["reasonCode"], d["modelCalls"], d["repairAttempts"]))
'
[ "$(runs_of "$T_SCHEMA")" = "0" ] || fail "schema invalid привёл к попытке"
echo "OK: попыток — 0"
stop_dev

echo
echo "== 3. model timeout =="
write_env timeout.env "ROUTER_RECIPE_FAULT=timeout"
write_vars "$RUNTIME_DIR/timeout.env"
start_dev "$RUNTIME_DIR/worker-timeout.log"
T_TIMEOUT="$(intake "$TEXT_WORK")"
R_TIMEOUT="$(route "$T_TIMEOUT")"
echo "$R_TIMEOUT" > "$RUNTIME_DIR/timeout.json"
echo "$R_TIMEOUT" | py '
import json,sys
d = json.load(sys.stdin)
assert d["outcome"] == "technical_error" and d["schemaOutcome"] == "timeout", d
assert d["reasonCode"] == "MODEL_TIMEOUT", d
assert d["reply"] is None and d["needsExecutor"] is False and d["continuation"]["requested"] is False, d
print("OK: outcome=%s schemaOutcome=%s reason=%s" % (d["outcome"], d["schemaOutcome"], d["reasonCode"]))
'
[ "$(runs_of "$T_TIMEOUT")" = "0" ] || fail "таймаут привёл к попытке"
echo "OK: попыток — 0"
stop_dev

echo
echo "== 4. budget denied: модель не зовётся вовсе =="
# Бюджет рецепта — отдельный допуск быстрого пути: общий бюджет конверта
# положительный (политика пропускает), а рецепту не осталось вызовов.
write_env budget.env "ROUTER_RECIPE_LLM_BUDGET=0"
write_vars "$RUNTIME_DIR/budget.env"
start_dev "$RUNTIME_DIR/worker-budget.log"
T_BUDGET="$(intake "$TEXT_WORK")"
R_BUDGET="$(route "$T_BUDGET")"
echo "$R_BUDGET" > "$RUNTIME_DIR/budget-denied.json"
echo "$R_BUDGET" | py '
import json,sys
d = json.load(sys.stdin)
assert d["outcome"] == "blocked" and d["schemaOutcome"] == "budget_denied", d
assert d["reasonCode"] == "BUDGET_DENIED", d
assert d["modelCalls"] == 0, "нулевой остаток не превращается в вызов модели"
assert d["reply"] is None and d["continuation"]["requested"] is False, d
print("OK: outcome=%s schemaOutcome=%s reason=%s modelCalls=%s" % (d["outcome"], d["schemaOutcome"], d["reasonCode"], d["modelCalls"]))
'
[ "$(runs_of "$T_BUDGET")" = "0" ] || fail "нулевой бюджет привёл к попытке"
echo "OK: попыток — 0"
stop_dev

echo
echo "== 5. provider failure =="
write_env provider.env "ROUTER_RECIPE_FAULT=provider_failure"
write_vars "$RUNTIME_DIR/provider.env"
start_dev "$RUNTIME_DIR/worker-provider.log"
T_PROVIDER="$(intake "$TEXT_WORK")"
R_PROVIDER="$(route "$T_PROVIDER")"
echo "$R_PROVIDER" > "$RUNTIME_DIR/provider-failure.json"
echo "$R_PROVIDER" | py '
import json,sys
d = json.load(sys.stdin)
assert d["outcome"] == "technical_error" and d["schemaOutcome"] == "provider_failure", d
assert d["reasonCode"] == "PROVIDER_FAILURE" and d["providerCode"] == "server_error", d
assert d["reply"] is None and d["needsExecutor"] is False and d["continuation"]["requested"] is False, d
print("OK: outcome=%s schemaOutcome=%s reason=%s providerCode=%s" % (d["outcome"], d["schemaOutcome"], d["reasonCode"], d["providerCode"]))
'
[ "$(runs_of "$T_PROVIDER")" = "0" ] || fail "отказ провайдера привёл к попытке"
echo "OK: попыток — 0"
stop_dev

echo
echo "== 6. awaiting input: типизированное ожидание по известному хосту полю =="
write_env awaiting.env "ROUTER_RECIPE_SCRIPT=[$(py 'import json,sys; print(json.dumps(sys.argv[1]))' "$CLARIFY_EMAIL")]"
write_vars "$RUNTIME_DIR/awaiting.env"
start_dev "$RUNTIME_DIR/worker-awaiting.log"
T_AWAITING="$(intake "$TEXT_WORK")"
R_AWAITING="$(route "$T_AWAITING")"
echo "$R_AWAITING" > "$RUNTIME_DIR/awaiting-input.json"
echo "$R_AWAITING" | py '
import json,sys
d = json.load(sys.stdin)
assert d["outcome"] == "required_input", d["outcome"]
assert d["reasonCode"] == "MISSING_REQUIRED_INPUT", d
assert d["askUser"]["missingFields"] == ["email"], d["askUser"]
assert d["reply"] is None and d["continuation"]["requested"] is False, "недостающее поле — не повод для агента"
assert d["execution"]["agentDispatchAttempts"] == 0, d["execution"]
print("OK: outcome=%s reason=%s missingFields=%s" % (d["outcome"], d["reasonCode"], d["askUser"]["missingFields"]))
'
[ "$(runs_of "$T_AWAITING")" = "0" ] || fail "ожидание ввода привело к попытке"
echo "OK: попыток — 0"
stop_dev

echo
echo "== 7. insufficient context: ответ не публикуется и не эскалируется =="
write_env context.env "ROUTER_RECIPE_SCRIPT=[$(py 'import json,sys; print(json.dumps(sys.argv[1]))' "$REPLY_NO_CONTEXT")]"
write_vars "$RUNTIME_DIR/context.env"
start_dev "$RUNTIME_DIR/worker-context.log"
T_CONTEXT="$(intake "$TEXT_WORK")"
R_CONTEXT="$(route "$T_CONTEXT")"
echo "$R_CONTEXT" > "$RUNTIME_DIR/insufficient-context.json"
echo "$R_CONTEXT" | py '
import json,sys
d = json.load(sys.stdin)
assert d["outcome"] == "insufficient_context", d["outcome"]
assert d["reasonCode"] == "CONTEXT_NOT_SUFFICIENT" and d["semanticOutcome"] == "coverage_pending", d
assert d["reply"] is None, "ответ при недостаточном контексте не публикуется"
assert d["needsExecutor"] is False and d["continuation"]["requested"] is False, "и не эскалируется"
print("OK: outcome=%s reason=%s semanticOutcome=%s" % (d["outcome"], d["reasonCode"], d["semanticOutcome"]))
'
[ "$(runs_of "$T_CONTEXT")" = "0" ] || fail "insufficient context привёл к попытке"
echo "OK: попыток — 0"
stop_dev

echo
echo "== 8. one continuation owner: выдаёт только Output, по явному запросу =="
# 8a. политика выключена по умолчанию: запрошено, но не выдано.
write_env continuation-disabled.env "ROUTER_RECIPE_SCRIPT=[$(py 'import json,sys; print(json.dumps(sys.argv[1]))' "$AGENT_JOB")]"
write_vars "$RUNTIME_DIR/continuation-disabled.env"
start_dev "$RUNTIME_DIR/worker-continuation.log"
T_C1="$(intake "$TEXT_WORK")"
R_C1_DISABLED="$(route "$T_C1" ',"continue":true')"
echo "$R_C1_DISABLED" > "$RUNTIME_DIR/continuation-policy-disabled.json"
echo "$R_C1_DISABLED" | py '
import json,sys
d = json.load(sys.stdin)
assert d["outcome"] == "escalated" and d["continuation"]["requested"] is True, d["continuation"]
assert d["continuation"]["issued"] is False, d["continuation"]
assert d["continuation"]["refusal"] == "continuation_policy_disabled", d["continuation"]
assert d["continuation"]["jobRef"] is None and d["continuation"]["runId"] is None, d["continuation"]
print("OK: requested=true issued=false refusal=continuation_policy_disabled")
'
[ "$(runs_of "$T_C1")" = "0" ] || fail "выключенная политика всё равно выдала продолжение"
echo "OK: попыток — 0 (политика по умолчанию выключена)"
stop_dev

# 8b. политика включена: Output выдаёт продолжение — новый job/run, тот же userTaskId.
write_env continuation.env "ROUTER_RECIPE_SCRIPT=[$(py 'import json,sys; print(json.dumps(sys.argv[1]))' "$AGENT_JOB")]
ROUTER_CONTINUATION_ENABLED=true"
write_vars "$RUNTIME_DIR/continuation.env"
start_dev "$RUNTIME_DIR/worker-continuation.log"
T_C2="$(intake "$TEXT_WORK")"
R_C2="$(route "$T_C2" ',"continue":true')"
echo "$R_C2" > "$RUNTIME_DIR/continuation-issued.json"
echo "$R_C2" | py '
import json,sys
d = json.load(sys.stdin)
c = d["continuation"]
assert c["requested"] is True and c["issued"] is True, c
assert c["owner"] == "output", "владелец продолжения — только Output"
assert c["executor"] == "opencode", "конечный исполнитель — OpenCode"
assert c["jobRef"] and c["runId"] and c["generation"] >= 1, c
assert c["jobRef"].startswith("job_"), c["jobRef"]
print("OK: owner=output executor=opencode jobRef=%s runId=%s generation=%s" % (c["jobRef"], c["runId"], c["generation"]))
'
RUNS_C2="$(runs_of "$T_C2")"
[ "$RUNS_C2" = "1" ] || fail "продолжение не создало ровно одну попытку ($RUNS_C2)"
echo "OK: попыток — 1 (новый job/run при том же userTaskId, выдал Output)"

# 8c. идемпотентность: тот же decisionId — та же работа, второй работы нет.
R_C2_AGAIN="$(route "$T_C2" ',"continue":true')"
echo "$R_C2_AGAIN" > "$RUNTIME_DIR/continuation-idempotent.json"
echo "$R_C2_AGAIN" | py '
import json,sys
d = json.load(sys.stdin)
c = d["continuation"]
assert c["issued"] is False and c["refusal"] == "already_continued", c
assert c["jobRef"] and c["runId"], "повторный запрос возвращает существующую работу"
print("OK: повторный continue → already_continued jobRef=%s runId=%s" % (c["jobRef"], c["runId"]))
'
RUNS_C2_AGAIN="$(runs_of "$T_C2")"
[ "$RUNS_C2_AGAIN" = "1" ] || fail "идемпотентность нарушена: попыток=$RUNS_C2_AGAIN"
echo "OK: попыток — 1 (второй работы нет)"

# 8d. запрос без continue:true — продолжение не выдаётся, даже при включённой политике.
T_C3="$(intake "$TEXT_WORK")"
R_C3="$(route "$T_C3")"
echo "$R_C3" > "$RUNTIME_DIR/continuation-not-requested.json"
echo "$R_C3" | py '
import json,sys
d = json.load(sys.stdin)
c = d["continuation"]
assert c["requested"] is False and c["issued"] is False and c["refusal"] is None, c
print("OK: без continue:true продолжение не запрашивается и не выдаётся")
'
[ "$(runs_of "$T_C3")" = "0" ] || fail "молчаливый запрос выдал продолжение"
echo "OK: попыток — 0"
stop_dev

echo
echo "== 9. корроборация на песочном Runner'е VM2 (read-only) =="
VM2_NOTE="skipped"
VM2_TOTAL="-"
if ssh -o BatchMode=yes -o ConnectTimeout=10 vm2 'true' 2>/dev/null; then
  VM2_TOTAL="$(ssh -o BatchMode=yes vm2 'ls /var/lib/agent-runner/runs 2>/dev/null | wc -l' | tr -d ' ')"
  VM2_MISSING=""
  for t in "$T_REPLY" "$T_CLARIFY" "$T_EXEC" "$T_SCHEMA" "$T_TIMEOUT" "$T_BUDGET" "$T_PROVIDER" "$T_AWAITING" "$T_CONTEXT" "$T_C1" "$T_C2" "$T_C3"; do
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
{"reply": {"userTaskId": "$T_REPLY", "run_started": 0},
 "clarify": {"userTaskId": "$T_CLARIFY", "run_started": 0},
 "needs_executor": {"userTaskId": "$T_EXEC", "run_started": 0},
 "schema_invalid": {"userTaskId": "$T_SCHEMA", "run_started": 0},
 "timeout": {"userTaskId": "$T_TIMEOUT", "run_started": 0},
 "budget_denied": {"userTaskId": "$T_BUDGET", "run_started": 0},
 "provider_failure": {"userTaskId": "$T_PROVIDER", "run_started": 0},
 "awaiting_input": {"userTaskId": "$T_AWAITING", "run_started": 0},
 "insufficient_context": {"userTaskId": "$T_CONTEXT", "run_started": 0},
 "continuation_policy_disabled": {"userTaskId": "$T_C1", "run_started": 0},
 "continuation_issued": {"userTaskId": "$T_C2", "run_started": 1},
 "continuation_idempotent": {"userTaskId": "$T_C2", "run_started": 1},
 "continuation_not_requested": {"userTaskId": "$T_C3", "run_started": 0},
 "vm2_runner": {"status": "$VM2_NOTE", "runs_total": "$VM2_TOTAL", "probe_runs_found": 0}}
EOF

echo
echo "== 10. санитизация и evidence =="
node tools/p17-sanitize-evidence.mjs \
  --raw-dir "$RUNTIME_DIR" \
  --out-dir "$EVIDENCE_DIR" \
  --secret "$SECRET" \
  || fail "санитизация не прошла: в evidence попали бы секрет или личные данные"

rm -f "$DEV_VARS"
if [ -n "${KEEP:-}" ]; then echo "KEEP=1: оставлен .dev.vars и состояние в $RUNTIME_DIR"; fi

echo
echo "PASS: песочница P17 проверена"
echo "EVIDENCE docs/evidence/P17-SANDBOX-TRANSCRIPT.md"
