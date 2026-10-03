#!/usr/bin/env bash
# Живая приёмка adapter control plane → РЕАЛЬНЫЙ Runner (issue #122, эпик #109).
#
# Доказывает, что adapter ходит в настоящий Serverless Agent API на песочной VM2,
# а не в stub: runId движка виден в журнале Runner, результат/события/артефакты
# читаются через контракт Runner, а обрыв связи посреди попытки не теряет задачу
# и не плодит второй Run (стабильный ключ попытки).
#
# Требования:
#   - VM2 доступна по ssh-алиасу `vm2`, Runner слушает 127.0.0.1:8787;
#   - ключ — GCP Secret Manager `RUNNER_API_KEY` (читается здесь, НИГДЕ не печатается);
#   - движок по умолчанию `fake` (бесплатный сценарий Runner; opencode требует
#     привязки креденшелов — отдельный слайс).
#
# Использование:
#   ./tools/runner-live-smoke.sh            # туннель поднимается сам
#   KEEP_TUNNEL=1 ./tools/runner-live-smoke.sh
#
# Секрет попадает только в `.dev.vars` (gitignored, chmod 600) — в репозиторий и в
# вывод он не попадает. Удалить после прогона: rm .dev.vars
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8790}"
PRINCIPAL="${PRINCIPAL:-sandbox-live}"
PROFILE="${PROFILE:-profile-live}"
ENGINE="${ENGINE:-fake}"
RUNNER_API_URL="${RUNNER_API_URL:-http://127.0.0.1:8787}"
RUNNER_LOCAL_PORT="${RUNNER_LOCAL_PORT:-8787}"
RUNTIME_DIR="${RUNTIME_DIR:-${TMPDIR:-/tmp}/runner-live-smoke}"
TUNNEL_PID_FILE="$RUNTIME_DIR/tunnel.pid"
mkdir -p "$RUNTIME_DIR"

py() { python3 -c "$1"; }
post() { curl -sS -X POST "$BASE$1" -H 'content-type: application/json' -H "X-Principal: $PRINCIPAL" -H "x-principal-sig: $(principal_sig)" -d "$2"; }
get() { curl -sS -H "X-Principal: $PRINCIPAL" -H "x-principal-sig: $(principal_sig)" "$BASE$1"; }
# task_id аргументом не задаётся — берётся первая задача смоука; фазы 2-3
# (обрыв туннеля, восстановление) ждут СВОЮ задачу, иначе ждали бы уже
# закрытую задачу первой фазы и ждали бы вечно.
task_status() { post /status "{\"taskId\":\"${1:-$TASK}\"}" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["status"])'; }
wait_status() {
  local want="$1" tid="${2:-$TASK}" st="" i
  for i in $(seq 1 120); do
    st="$(task_status "$tid")"
    [ "$st" = "$want" ] && return 0
    sleep 0.5
  done
  echo "FAIL: ждали status=$want, получили st=$st (task=$tid)" >&2
  exit 1
}
runner_get() { # $1 = путь на Runnerе (через туннель)
  curl -sS -H "Authorization: Bearer $RUNNER_API_KEY" "$RUNNER_API_URL$1"
}
runs_of() { # $1 = userTaskId -> сколько раннер-ранов с таким userTaskId на VM2
  ssh -o BatchMode=yes vm2 "grep -l '\"userTaskId\": \"$1\"' /var/lib/agent-runner/runs/*/state.json 2>/dev/null | wc -l" | tr -d ' '
}

# Регистрация артефакта рана тем же кодом, что и сервис (POST /v1/artifacts — это
# slice D2, поэтому out-of-band, как в собственном харнессе Runner. Секрет
# share-ссылки остаётся на VM2: читается внутри удалённой команды.
ingest_artifact() { # $1=runId $2=userTaskId $3=name -> JSON манифеста
  ssh -o BatchMode=yes vm2 "cd /opt/sb/ai-agent-runner && node --input-type=module -e '
    import { readFileSync } from \"node:fs\";
    import { join } from \"node:path\";
    import { ArtifactStore } from \"./dist/storage/artifact-store.js\";
    import { createLocalFsBlobStore } from \"./dist/storage/local-fs.js\";
    const [dataDir, runId, userTaskId, profileId, name] = process.argv.slice(1);
    const bytes = readFileSync(join(dataDir, \"workspaces\", runId, name));
    const store = new ArtifactStore({ rootDir: dataDir, blob: createLocalFsBlobStore({ rootDir: join(dataDir, \"blobs\") }) });
    const manifest = await store.put({ runId, userTaskId, profileId, name, mime: \"text/plain\", bytes });
    process.stdout.write(JSON.stringify(manifest));
  ' /var/lib/agent-runner $1 $2 profile-sandbox $3"
}

# --- туннель к Runner (поднимаем сами, чтобы оборвать его посреди попытки) ---
tunnel_up() {
  if curl -sS -o /dev/null --max-time 3 "$RUNNER_API_URL/v1/capabilities" 2>/dev/null; then
    # Туннель уже поднят (вручную) — запоминаем его PID, чтобы фазе сбоя было что рвать.
    tunnel_pid > "$TUNNEL_PID_FILE" 2>/dev/null || true
    return 0
  fi
  ssh -N -f -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -L "$RUNNER_LOCAL_PORT:127.0.0.1:8787" vm2
  sleep 2
  tunnel_pid > "$TUNNEL_PID_FILE" 2>/dev/null || true
}
tunnel_down() {
  [ -f "$TUNNEL_PID_FILE" ] && kill "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null || true
  rm -f "$TUNNEL_PID_FILE"
  sleep 1
}
tunnel_pid() { lsof -ti ":$RUNNER_LOCAL_PORT" 2>/dev/null | head -1; }

# --- ключ Runner: только в env, ни в вывод, ни в репозиторий ---
export RUNNER_API_KEY="$(gcloud secrets versions access latest --secret=RUNNER_API_KEY 2>/dev/null)"
[ -n "$RUNNER_API_KEY" ] || { echo "FAIL: RUNNER_API_KEY не прочитан из Secret Manager" >&2; exit 1; }

# Проверяющая аутентификация control plane: секрет только из SM/env.
export PRINCIPAL_SECRET="${PRINCIPAL_SECRET:-$(gcloud secrets versions access latest --secret=PRINCIPAL_SECRET 2>/dev/null)}"
[ -n "$PRINCIPAL_SECRET" ] || { echo "FAIL: PRINCIPAL_SECRET не прочитан из Secret Manager" >&2; exit 1; }
principal_sig="$(./tools/principal-sig.sh "$PRINCIPAL")"

# --- .dev.vars для `wrangler dev` (gitignored): URL и ключ, chmod 600 ---
# Пилот (M1.5) включён для профиля приёмки: без него задачи уходят на legacy и
# экземпляр не создаётся вообще (pilotRoute=legacy -> runId=null).
PILOT_VARS="PILOT_ENABLED=true
PILOT_ACTIVATED_AT=$(date -u +%Y-%m-%dT00:00:00Z)
PILOT_COHORT_PROFILE_IDS=$PROFILE"
if [ ! -f .dev.vars ] || ! grep -q '^RUNNER_API_KEY=' .dev.vars; then
  umask 077
  { printf 'RUNNER_API_URL=%s\nRUNNER_API_KEY=%s\n' "$RUNNER_API_URL" "$RUNNER_API_KEY"; printf '%s\n' "$PILOT_VARS"; } > .dev.vars
  chmod 600 .dev.vars
fi

echo "== 0. туннель и контракт Runner =="
tunnel_up
CAPS="$(runner_get /v1/capabilities)"
echo "$CAPS" | py '
import json,sys
d=json.load(sys.stdin)
assert d["idempotency"]["header"]=="Idempotency-Key", d
assert d["disconnect"]["connectionLostIsNotFailed"] is True, d
assert d["interaction"]["engineResume"]=="unsupported", d
assert "fake" in d["engines"], d
print("OK: capabilities — connectionLostIsNotFailed, engineResume=unsupported, engines=", d["engines"])
'
HEALTH="$(get /runner/health)"
echo "$HEALTH" | py '
import json,sys
d=json.load(sys.stdin)
assert d["configured"] is True and d["reachable"] is True, d
print("OK: /runner/health reachable (404 на несуществующий run = Runner ответил)")
'

# Локальный sandbox: принципал приёма (identity + scope, без секретов).
npx wrangler d1 execute control-plane-task-store --local --command \
  "INSERT OR REPLACE INTO admission_principals(principal_id, profile_id, scopes, enabled, created_at, updated_at)
   VALUES ('$PRINCIPAL','$PROFILE','[\"tasks:intake\",\"tasks:read\",\"tasks:signal\",\"tasks:control\"]',1,strftime('%s','now')*1000,strftime('%s','now')*1000)" \
  >/dev/null

echo "== 1. сквозной прогон: intake -> start -> реальный Run на Runner =="
REQ1="req-live-$(date +%s)"
INTAKE="$(post /intake "{\"contractVersion\":1,\"requestId\":\"$REQ1\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"собери отчёт одним предложением\"}]}")"
TASK="$(echo "$INTAKE" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
echo "$INTAKE" | py 'import json,sys; d=json.load(sys.stdin); assert d["durable"] is True and d["duplicate"] is False, d' 
echo "OK: 201, userTaskId=$TASK"

START="$(post /start "{\"taskId\":\"$TASK\",\"profileId\":\"$PROFILE\",\"goal\":\"собери отчёт одним предложением\",\"runnerEngine\":\"$ENGINE\"}")"
ATTEMPT="$(echo "$START" | py 'import json,sys; print(json.load(sys.stdin)["runId"])')"
echo "OK: попытка control plane=$ATTEMPT (engine=$ENGINE)"

wait_status awaiting_input
AID="$(post /status "{\"taskId\":\"$TASK\"}" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["awaiting_input_id"])')"
echo "OK: awaiting_input, awaitingInputId=$AID"

# Артефакт рана регистрируем на Runner ДО ответа человека: план читает манифесты
# при финализации (outputRefs у движка пустые — регистрация вне контура API).
RUN1="$(post /status "{\"taskId\":\"$TASK\"}" | py 'import json,sys; print(json.load(sys.stdin)["runs"][0]["session_id"])')"
MANIFEST="$(ingest_artifact "$RUN1" "$TASK" ran.txt)"
echo "$MANIFEST" | py '
import json,sys
m=json.load(sys.stdin)
assert m["storageKey"] and m["sha256"] and m["size"]>0, m
print("OK: артефакт зарегистрирован на Runner:", m["name"], "size=", m["size"], "sha256=", m["sha256"][:12]+"...")
'
echo "OK: артефакт доступен по контракту: $(runner_get "/v1/runs/$RUN1/artifacts" | py 'import json,sys; d=json.load(sys.stdin); print("count="+str(d["count"]))')"

ANSWERED="$(post "/awaiting/$AID/answer" '{"idempotencyKey":"web:live-1","answer":{"answer":"да"}}')"
echo "$ANSWERED" | py 'import json,sys; d=json.load(sys.stdin); assert d["applied"] is True, d'

wait_status done
FINAL="$(post /status "{\"taskId\":\"$TASK\"}")"
echo "$FINAL" | py '
import json,sys
d=json.load(sys.stdin); t=d["taskStore"]
assert t["status"]=="done", t["status"]
r=t["result"]
assert r["runId"].startswith("run_"), r                      # настоящий runId движка
assert r["persistence"]=="persisted", r
assert r["ownerGeneration"]==1, r
assert r["artifacts"], r
kinds=[e["kind"] for e in t["history"]]
for k in ["task_accepted","run_started","awaiting_opened","awaiting_answered","task_status_changed"]:
    assert k in kinds, (k, kinds)
print("OK: done; runId=", r["runId"], "; persistence=", r["persistence"], "; artifacts=", r["artifacts"])
print("OK: history =", " -> ".join(kinds))
'
RUN1="$(echo "$FINAL" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["result"]["runId"])')"
RUNS1="$(runs_of "$TASK")"
[ "$RUNS1" = "1" ] || { echo "FAIL: на Runner $RUNS1 ранов для $TASK (ожидали 1)" >&2; exit 1; }
echo "OK: на Runner ровно 1 ран для userTaskId=$TASK (runId=$RUN1)"
echo "OK: артефакт рана доступен по контракту: $(runner_get "/v1/runs/$RUN1/artifacts" | py 'import json,sys; d=json.load(sys.stdin); print("count="+str(d["count"]))')"
ART_ID="$(echo "$MANIFEST" | py 'import json,sys; print(json.load(sys.stdin)["artifactId"])')"
echo "OK: скачивание артефакта: HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $RUNNER_API_KEY" "$RUNNER_API_URL/v1/artifacts/$ART_ID")"

echo "== 2. управляемый сбой: обрыв туннеля посреди попытки =="
REQ2="req-live-fail-$(date +%s)"
INTAKE2="$(post /intake "{\"contractVersion\":1,\"requestId\":\"$REQ2\",\"profileId\":\"$PROFILE\",\"inputItems\":[{\"text\":\"потеряем связь посреди попытки\"}]}")"
TASK2="$(echo "$INTAKE2" | py 'import json,sys; print(json.load(sys.stdin)["userTaskId"])')"
START2="$(post /start "{\"taskId\":\"$TASK2\",\"profileId\":\"$PROFILE\",\"goal\":\"потеряем связь посреди попытки\",\"runnerEngine\":\"$ENGINE\"}")"
ATTEMPT2="$(echo "$START2" | py 'import json,sys; print(json.load(sys.stdin)["runId"])')"
echo "OK: задача 2 принята, попытка=$ATTEMPT2; рвём туннель"
tunnel_down
LOST=""
for i in $(seq 1 60); do
  LOST="$(post /status "{\"taskId\":\"$TASK2\"}" | py 'import json,sys; d=json.load(sys.stdin); r=[x for x in d["runs"] if x["id"]=="'"$ATTEMPT2"'"]; print(r[0]["status"] if r else "")')"
  [ "$LOST" = "unknown" ] && break
  sleep 0.5
done
[ "$LOST" = "unknown" ] || { echo "FAIL: попытка 2 не стала unknown ($LOST)" >&2; exit 1; }
echo "OK: попытка 2 = unknown (не failed), задача: $(task_status "$TASK2")"
post /status "{\"taskId\":\"$TASK2\"}" | py '
import json,sys
d=json.load(sys.stdin); t=d["taskStore"]
assert t["status"]=="active", t["status"]            # задача не потеряна
assert t["awaiting_input_id"] is None, t            # ожидание не открывалось
r=[x for x in d["runs"] if x["id"]=="'"$ATTEMPT2"'"][0]
assert r["error_class"]=="runner_unavailable", r
print("OK: задача цела (active), попытка unknown/runner_unavailable, второго рана нет")
'
echo "OK: на Runner ранов для $TASK2: $(runs_of "$TASK2") (submit не дошёл)"

echo "== 3. восстановление: тот же ключ попытки -> тот же Run, не второй =="
tunnel_up
RECOVERED=""
for i in $(seq 1 120); do
  RECOVERED="$(post /status "{\"taskId\":\"$TASK2\"}" | py 'import json,sys; d=json.load(sys.stdin); r=[x for x in d["runs"] if x["id"]=="'"$ATTEMPT2"'"]; print(r[0]["session_id"] or "")')"
  [ -n "$RECOVERED" ] && break
  sleep 1
done
[ -n "$RECOVERED" ] || { echo "FAIL: попытка 2 не получила runId Runner после восстановления" >&2; exit 1; }
RUN2="$RECOVERED"
RUNS2="$(runs_of "$TASK2")"
[ "$RUNS2" = "1" ] || { echo "FAIL: на Runner $RUNS2 ранов для $TASK2 (второй Run!)" >&2; exit 1; }
echo "OK: тот же ключ попытки вернул тот же Run: runId=$RUN2, ранов на Runner=$RUNS2"

wait_status awaiting_input "$TASK2"
AID2="$(post /status "{\"taskId\":\"$TASK2\"}" | py 'import json,sys; print(json.load(sys.stdin)["taskStore"]["awaiting_input_id"])')"
post "/awaiting/$AID2/answer" '{"idempotencyKey":"web:live-2","answer":{"answer":"да"}}' >/dev/null
wait_status done "$TASK2"
post /status "{\"taskId\":\"$TASK2\"}" | py '
import json,sys
d=json.load(sys.stdin); t=d["taskStore"]
assert t["status"]=="done", t["status"]
assert t["result"]["runId"]=="'"$RUN2"'", t["result"]
print("OK: задача 2 дошла до done с тем же runId Runner")
'

echo
echo "PASS: живой прогон завершён"
echo "EVIDENCE profileId=$PROFILE userTask1=$TASK run1=$RUN1 userTask2=$TASK2 run2=$RUN2 engine=$ENGINE"
