# trained-assist-control-plane

Trained Assist control plane: Task Store (D1) + Workflow Port (Cloudflare Workflows), поверх них — Input/Router/Output/GTD/Journal/Reporting.

**Статус (04.10.2026): M1.1, M1.2, P04 (приём+квитанция), P05/P06 (поток событий, replay, восстановление), P16 (route policy и высокоточные правила fast path), P22 (расписание) и P23 (GTD opt-in и bounded control) реализованы и покрыты тестами; деплой на реальный аккаунт Cloudflare НЕ выполнялся** (все прогоны локальные, miniflare; `database_id` в `wrangler.jsonc` — placeholder до команды владельца). Карточки эпика M1 — [trained-agent-architecture#109](https://github.com/trained-assist/trained-agent-architecture/issues/109), PR: #2 (каркас+CI), #3 (Task Store), #5 (Workflow Port), #6 (приём+квитанция), #7 (P05/P06).

## Что здесь лежит

Опциональный [communication selector v1](docs/COMMUNICATION-V1.md): `ROUTER_SELECTOR=communication_v1`, shared MCP → health/capabilities или agent, durable quick-answer result и Output dispatch принятой задачи. Без флага остаётся существующая fixture-маршрутизация.

Опциональная [host policy по durable profile](docs/PROFILE-RUNTIME-POLICY.md) отделяет обычные текстовые задачи Telegram от обязательного CSV старого integration-профиля; ключ Runner выбирается только из доверенных bindings.

Изолированная [credential readiness boundary v1](docs/CREDENTIAL-READY-V1.md) связывает проверенное событие доверенного host с существующим ожиданием и продолжением той же задачи. Provider OAuth/validation и native Runner checkpoint resume не реализованы; без `CREDENTIAL_HOST_PRINCIPALS` callback закрыт.

[Read-only credential-boundary verifier](docs/CREDENTIAL-BOUNDARY-VERIFY.md) проверяет checkpoint, typed-ready wait, одну успешную Workflow-попытку после readiness и native final-answer channel без ready/start/recover. Native engine и время его запуска не доказаны; CSV readback остаётся отдельной проверкой.

| Путь | Что это |
|---|---|
| `migrations/0001_task_store_v1.sql` | D1-схема Task Store v1 по [TASK-STORE-SCHEMA-V1 §6](https://github.com/trained-assist/trained-agent-architecture/blob/main/TASK-STORE-SCHEMA-V1.md): `durable_tasks`, `task_events`, `task_signals`, `awaiting_inputs`, `conversations` |
| `src/taskstore/` | Репозиторий Task Store: атомарные state/event-переходы, generation fencing, дедуп сигналов, awaiting input, **guard терминальных состояний** (issue #90), приём с квитанцией |
| `src/intake/` | Приём задачи по контракту C01: envelope, профиль/права (scope), детерминированный userTaskId, durable receipt, идемпотентность по requestId |
| `src/events/` | Поток событий C02: envelope с курсором (sequence = task_events.id), тип выводится из kind журнала |
| `src/workflow-port/delivery-worker.ts` | Воркер доставки: единственный владелец отправки, bounded retry, адаптер канала внедряется |
| `src/workflow-port/` | Workflow Port поверх Cloudflare Workflows: `submit/signal/cancel/status/recover`, `StepCtx` для кода планов, демо-план M1.2 |
| `src/index.ts` | `TaskWorkflow` + HTTP-слой (`/start /signal /cancel /status /recover`) |
| `web/` | Web-срез (M1, шаг 7): тонкий клиент к API control plane, страница одной conversation, сквозной прогон с рестартом посередине. Подключение — только из env |
| `src/awaiting/` | Ожидание человека: маппинг purpose→kind, durable-ожидание (истина в Task Store, движок только будит) |
| `migrations/0006_schedule_v1.sql` + `src/schedule/` | Расписание (P22, этап I07): `schedules`/`schedule_occurrences`, cron в IANA-зоне расписания, дедуп occurrence в БД, политики overlap/catch-up, виртуальные часы. Occurrence — обычная задача; `gtd_id` всегда `NULL` |
| `src/router/` | Task Router (P16, этап I05): признаки текста, снимок прав, проверенный каталог, route policy, исполнение, события `routing.*`, replay корпуса P18 |
| `eval/fast-replies/` | Пинned-снимок корпуса P18 (sha256 из манифеста) и артефакт решений route policy в формате стенда P18 |
| `tools/p16-sandbox-probe.sh` + `tools/p16-evidence.mjs` | Изолированная песочница I05 и сборка sanitized evidence (fail closed) |
| `migrations/0007_gtd_v1.sql` + `src/gtd/` | GTD (P23, этап I07): запись контроля одной User Task (opt-in), durable inbox Output→GTD, решения прогрессии, внешние условия (synthetic CI). `gtdId` — тот же идентификатор, что в `schedule_occurrences.gtd_id` |
| `tests/` | vitest **в рантайме workerd** (`@cloudflare/vitest-pool-workers`): D1, Workflows, реальные миграции — 241 тест (в т.ч. `tests/p16-*.test.ts`, `tests/p22-schedule.test.ts`, `tests/p23-gtd.test.ts`) |
| `tools/local-smoke.sh` | Воспроизводимый прогон слоя против локального `wrangler dev` |

## Как запустить локально

Требуется Node ≥22 (wrangler 4; Node 20 вне EOL с 04.2026).

```bash
npm ci                 # в этом шелле NODE_ENV=production -> NODE_ENV=development npm ci
npm run typecheck      # tsc --noEmit
npm test               # 241 тест в workerd (D1 + Workflows), ~25 с
npm run check          # typecheck + test + проверки санитизации evidence
```

Ручной прогон через HTTP-слой:

```bash
npm run db:migrate:local   # применить миграции в локальной D1 (.wrangler/state)
npm run dev                # терминал 1: wrangler dev на :8787
./tools/local-smoke.sh     # терминал 2: приём -> квитанция -> запуск -> ... -> негативные
```

Локальный sandbox: принципал приёма (identity + scope, без секретов) засеивается в D1:

```bash
npx wrangler d1 execute control-plane-task-store --local --command \
  "INSERT OR REPLACE INTO admission_principals(principal_id, profile_id, scopes, enabled, created_at, updated_at)
   VALUES ('sandbox-local','profile-1','[\"tasks:intake\",\"tasks:read\",\"tasks:signal\",\"tasks:control\"]',1,strftime('%s','now')*1000,strftime('%s','now')*1000)"
```

То же руками:

```bash
# Приём (P04/C01): квитанция = durable acceptance, НЕ запуск
curl -X POST localhost:8787/intake -H 'content-type: application/json' -H 'X-Principal: sandbox-local' \
  -d '{"contractVersion":1,"requestId":"req-1","profileId":"profile-1","inputItems":[{"text":"привет"}]}'
# -> 201 {"receiptId":"...","userTaskId":"ut-...","durable":true,"duplicate":false}
# Повтор того же requestId -> 200 с той же квитанцией (duplicate=true);
# другой payload с тем же ключом -> 409; без X-Principal -> 401 (до любой записи)
curl "localhost:8787/receipt?taskId=ut-..."   # чтение квитанции

# Маршрут по принятой задаче (P16): решение маршрута, ответ/заявка исполнителя
curl -X POST localhost:8787/route -H 'content-type: application/json' -H 'X-Principal: sandbox-local' \
  -d '{"taskId":"ut-..."}'

curl -X POST localhost:8787/start  -H 'content-type: application/json' \
  -d '{"taskId":"ut-1","profileId":"demo","goal":"привет"}'
# ранний ответ: {"taskId":"ut-1","created":true,...} — задача ещё не завершена
curl -X POST localhost:8787/status -H 'content-type: application/json' -d '{"taskId":"ut-1"}'
# ... ждём status=awaiting_input
curl -X POST localhost:8787/signal -H 'content-type: application/json' \
  -d '{"taskId":"ut-1","type":"user_reply","payload":{"answer":"да"},"idempotencyKey":"web:1"}'
curl -X POST localhost:8787/status -H 'content-type: application/json' -d '{"taskId":"ut-1"}'
# -> status=done, result={"answer":"да","ok":true,"version":"m1-conversation-v1"}
```

Итог прогона `tools/local-smoke.sh` (порядок журнала — доказательство сквозной цепочки; приём и запуск — разные шаги, `created=false` на `/start` после приёма):

```
task_accepted -> run_started -> step_done -> awaiting_opened -> signal_received
-> step_woken -> awaiting_answered -> step_done -> task_status_changed
```

CI на каждый PR: `npm ci` + `npm run typecheck` + `npm test` (`.github/workflows/ci.yml`).

## Приём задачи и квитанция (P04/C01)

- **Envelope** (`src/intake/envelope.ts`): `contractVersion, requestId, conversationRef, sessionId, projectId, audienceId, destinationId, inputItems, requestedExecutionPolicy, replyToRef` — имена из C01. Принципал не приходит из тела: `X-Principal` — проверенная аутентификация (C01), тело несёт только профиль и вход.
- **Квитанция = durable acceptance** (`requestId, userTaskId, acceptedAt, durable=true`), не запуск и не результат. Выдаётся только после успешного сохранения: строка задачи и событие `task_accepted` (с `event_id = receiptId`) пишутся одной D1-транзакцией; сбой записи квитанции откатывает и задачу (тест с инжектированным триггером).
- **Идемпотентность**: `UNIQUE(profile_id, request_id)` на `durable_tasks.request_id` (scope ключа включает проверенного вызывающего). Повтор с тем же payload → прежняя квитанция (`duplicate=true`); другой payload с тем же ключом → 409 conflict (хэш канонической формы envelope). `userTaskId` детерминирован от `(profileId, requestId)` — параллельные приёмы одного запроса дают один PK и ровно одну задачу.
- **Профиль/права**: реестр `admission_principals` (identity + профиль + scope `tasks:intake|tasks:read|tasks:signal`). Неизвестный принципал → 401, чужой профиль или отсутствующий scope → 403 — до любой записи в Task Store. Секреты (API keys, C13) здесь не хранятся: проверка credential — зона credential broker.
- **Логи** (C12): `intake.accepted / intake.duplicate / intake.conflict / intake.forbidden / intake.unauthorized` с `profileId, userTaskId, requestId, receiptId, reason` — без текста входа и содержимого артефактов.

## Поток событий, replay и восстановление (P05/P06)

- **Курсор событий (C02)**: `GET /events?taskId&after&limit` — страницы по `sequence` (= `task_events.id`), `nextCursor`/`hasMore`; разрыв потока не теряет итог: переподключение с последним курсором воспроизводит недостающие события и финальный результат. Envelope C02 (`eventId, userTaskId, runId?, sequence, type, occurredAt, payload, artifactRefs?`) строится поверх журнала `task_events`, второй журнал не заводится; тип выводится из `kind` (`task_accepted→accepted`, `run_started→started`, `awaiting_opened→waiting`, `task_status_changed→result_ready|task_failed|stopped` по `status_after`).
- **Replay без rerun**: `POST /replay {taskId, fromStep?}` — перезапуск экземпляра с сохранением кэша шагов; план идемпотентен (повторный `prepare` не меняет состояние, `mark-awaiting` возвращает существующий `awaitingInputId`), при рестарте после терминала план выходит без шагов.
- **status — только чтение** (P05: «status не запускает агента»): `GET /status` не создаёт событий, не меняет `revision`/`generation` и не запускает попыток. Фазы различимы по контрактным полям: `status`+`stage` задачи (`active/queued → awaiting_input/waiting_input → done/finished`) и `status` попытки (`running`).
- **cancel requested ≠ stopped (C03/AC-67)**: `POST /cancel` сначала пишет `cancel_requested` и поднимает поколение (fencing), затем останавливает экземпляр; `status='cancelled'` ставится только после подтверждения остановки. Сбой `terminate` оставляет задачу не-терминальной с видимым `cancel_requested`. Отмена адресна: затронута только своя задача.
- **Потеря связи = отдельное состояние** (P06, ARCHITECTURE §4.6): `POST /connection-lost {runId}` → попытка `unknown` с `error_class='connection_lost'`, `finished_at = NULL` (исход неизвестен, это не `failed`); задача не меняется. `POST /heartbeat {runId}` продлевает lease. Истечение lease — только сводка (`sweepExpiredLeases`), ни timeout, ни lease сами по себе не запускают агента повторно.
- **Возобновление (AC-69)**: `POST /resume {taskId, reason?, instructions?}` — новый `runId`, тот же `userTaskId`, поколение поднято (старая попытка лишена прав), прежний экземпляр остановлен и удалён, новый запущен с новым поколением. Повтор сигнала дедуплицируется по ключу.
- **Таблица `executions`** (имя и состав из A2 §6): попытки с `runId`, `generation`, `lease_until`, `last_heartbeat_at`. Статусы: `running/unknown/success/failed/interrupted/cancelled/waiting`; `unknown` — исход неизвестен, не `failed`.

## Отмена и доставка (эпик #109, шаг 6)

- **Отмена раздельная**: «запрос отмены» (`cancel_requested` + подъём поколения, fencing прежней попытки) и «подтверждённая остановка» (`status='cancelled'` + `task_cancelled` со `stopConfirmed`). Пока остановка не подтверждена, задача остаётся не-терминальной — `requested` не выдаётся за `stopped` (C03, AC-67).
- **Один владелец доставки**: `claimDelivery` атомарно переводит `pending → accepted` одним UPDATE с подзапросом — две конкурентные отправки не могут забрать одну строку. Адаптер канала внедряется (`DeliveryAdapter`); в песочнице — локальная заглушка, настоящий канал подключает M1.4.
- **Доставка имеет свой статус** (C02, A2 §5.5): `deliveries.status` не связан со статусом задачи; `delivery_state` — проекция, которая обновляется и на терминальной задаче (результат доставляют после `done`). Повтор того же `logicalMessageId` — no-op; `provider_message_id` гасит дубль у провайдера.
- **Retry доставки не повторяет execution**: `failDelivery` трогает только строку `deliveries` (+ проекция и события `delivery_failed/delivery_sent`). Статус задачи, поколение, результат, попытки (`executions`) и шаги не меняются — проверено тестом.
- **Отмена подавляет retry доставки** (C03: stop suppresses technical retries, включая outbox): подтверждённая остановка переводит `pending/accepted` доставки задачи в `failed` с `last_error='suppressed_by_cancel'` без `next_attempt_at`.
- **Артефакты переживают отмену** (ARCHITECTURE §4.6): `task_artifacts` хранит только ссылку, размер и контрольную сумму (байты в Artifact Storage); отмена задачи артефакты не удаляет, а `message_json` доставки несёт ссылки, а не байты.
- **HTTP**: `POST /deliveries` (постановка), `POST /deliveries/deliver` (забор+отправка владельцем), `GET|POST /artifacts`.

## Sandbox Web и сквозная приёмка (M1, шаг 7)

Отдельный web-адаптер к API control plane: приём задачи по envelope с
идемпотентным ключом, чтение журнала **по курсору** (C02), ответ в awaited
input с дедупликацией, рестарт процесса посередине без перезапуска попытки,
терминальный результат и ссылка на артефакт. Подключение и ключ — **только из
env** (`CONTROL_PLANE_URL`, `CONTROL_PLANE_PRINCIPAL`, `CONTROL_PLANE_PROFILE`,
`CONTROL_PLANE_API_KEY`): в репозитории и логах секретов нет.

```bash
npm test                       # 241 тест, из них web-срез, сквозной прогон и P16
node web/e2e/run-m1-web-slice-e2e.mjs   # живой прогон против настоящего control plane
```

Сквозной сценарий и четыре управляемых сбоя (оборванная доставка пробуждения,
рестарт посреди ожидания, потеря связи, потерянный ответ) —
[`docs/M1-STEP7-WEB-SLICE.md`](docs/M1-STEP7-WEB-SLICE.md), отчёт живого
прогона — `docs/e2e/m1-step7-live-report.json`.

## Sandbox Web и сквозная приёмка (M1, шаг 7)

Отдельный web-адаптер к API control plane: приём задачи по envelope с
идемпотентным ключом, чтение журнала **по курсору** (C02), ответ в awaited
input с дедупликацией, рестарт процесса посередине без перезапуска попытки,
терминальный результат и ссылка на артефакт. Подключение и ключ — **только из
env** (`CONTROL_PLANE_URL`, `CONTROL_PLANE_PRINCIPAL`, `CONTROL_PLANE_PROFILE`,
`CONTROL_PLANE_API_KEY`): в репозитории и логах секретов нет.

```bash
npm test                       # 241 тест, из них web-срез, сквозной прогон и P16
node web/e2e/run-m1-web-slice-e2e.mjs   # живой прогон против настоящего control plane
```

Сквозной сценарий и четыре управляемых сбоя (оборванная доставка пробуждения,
рестарт посреди ожидания, потеря связи, потерянный ответ) —
[`docs/M1-STEP7-WEB-SLICE.md`](docs/M1-STEP7-WEB-SLICE.md), отчёт живого
прогона — `docs/e2e/m1-step7-live-report.json`.

## Ожидание человека и разговор (эпик #109, шаг 5, гейт #115)

Гейт #115 выбрал host-owned interaction tool через MCP: **durable wait живёт в HOST/Task Store, а не в движке**. Здесь реализована host-сторона этого взаимодействия.

- **Явный адрес ответа**: `awaiting_inputs.awaiting_input_id` — одноразовый адрес ответа; `POST /awaiting` открывает ожидание, `GET /awaiting/{id}` читает, `POST /awaiting/{id}/answer` отвечает по этому адресу. Одно открытое ожидание на задачу (partial unique index) — второе открытие отклоняется.
- **Дедуп ответа**: ответ адресуется ключом идемпотентности реплики (`requestId` канала) и хранится в `task_signals`. Повтор того же ключа — **no-op с прежним результатом** (возвращаются тот же ответ и тот же `answeredAt`); другой ключ на уже отвеченном ожидании — **409 conflict**; поздний ответ на `expired`/`cancelled` — отказ, задача **не возобновляется**.
- **purpose → kind (маппинг, без второго набора терминов)**: `preference → choice`, `missing_fact → data`, `credential → approval`, `approval → approval`. `kind` остаётся лексикой A2 §5.4, `purpose` — «зачем спрашиваем». Для `credential` ответом является **подтверждение**: сам секрет приходит через credential broker и в ответе/логах не появляется. Варианты выбора хранятся со **стабильными option ID** (не переинтерпретируется изменившийся текст кнопки, #115).
- **Ожидание переживает смерть движка**: истина ответа — строка `awaiting_inputs`. Движок ждёт событие-срез (по умолчанию 60 с), затем **перечитывает durable состояние**; ответ, пришедший только событием движка, **сразу сохраняется durable**. Потеря пробуждения не теряет ответ (#116).
- **Явное продолжение**: при возобновлении экземпляр получает адрес последнего ожидания и продолжает **от него** — шаги до ожидания не переигрываются (проверено: `prepare` выполняется один раз). Новая попытка помечена явно: **новый `runId`, тот же `userTaskId`, подъём поколения** (прежняя попытка лишена прав) и перечень `availableData` (открытое ожидание, артефакты, наличие результата) в событии `run_started`. Это явная семантика продолжения, а не молчаливый повтор всей задачи.
- **Ссылки движка** (`engine_session_ref`, `engine_request_ref`, `tool_call_ref`) хранятся как корреляция: engine ID **не заменяют** platform ID (`userTaskId`, `awaitingInputId`, `generation`).
- **HTTP**: `POST /awaiting` (`tasks:control`), `GET /awaiting/{id}` (`tasks:read`), `POST /awaiting/{id}/answer` (`tasks:signal`; 200/409). Логи: `awaiting.opened / awaiting.answered / awaiting.answer_duplicate / awaiting.answer_rejected` с `profileId`, `userTaskId`, `runId`, `requestId`, `awaitingInputId`, `idempotencyKey`, `reason`.

## Расписание без обязательного GTD (P22, этап I07)

Карточка [trained-agent-architecture#61](https://github.com/trained-assist/trained-agent-architecture/issues/61),
границы — [PLAYBOOKS-VS-GETTING-THINGS-DONE-BOUNDARIES §7](https://github.com/trained-assist/trained-agent-architecture/blob/main/PLAYBOOKS-VS-GETTING-THINGS-DONE-BOUNDARIES.md). Transcript и разбор приёмки — [`docs/P22-SCHEDULE-VIRTUAL-CLOCK-TRANSCRIPT.md`](docs/P22-SCHEDULE-VIRTUAL-CLOCK-TRANSCRIPT.md).

- **Occurrence ≠ контроль.** Расписание создаёт **срабатывания**, срабатывание — обычную задачу со своим `userTaskId` через тот же Task Submission API. Запись контроля не создаётся: `schedule_occurrences.gtd_id = NULL`, в терминальном результате **нет** `gtdId`, control loop не начинается (простой cron → шаги `prepare → execute → finalize`, без ожидания человека).
- **Дедуп в БД, а не в поведении платформы**: `UNIQUE(schedule_id, occurrence_key)` + детерминированный `userTaskId` от `(profileId, occurrenceId)`. Повторный tick, replay после краша и две гонки на одном моменте дают одно occurrence и одну задачу.
- **Крэш не теряет и не дублирует**: occurrence в состоянии `due`/`failed` — обещание, а не мусор; следующий `tick` доставляет его с теми же ключами (`reason: recovered_after_crash`). Попытки приёма ограничены `max_admit_attempts` (1..10) — бесконечного retry нет.
- **Disable ≠ cancel**: выключение меняет только `enabled`; уже принятые задачи доходят до результата (`acceptedTasksCancelled: 0` в логе). `enable` пересчитывает курсор на ближайшее **будущее** срабатывание — выключенное окно не отыгрывается.
- **Политики явные**: `overlap_policy` = `allow|skip` (пропуск с причиной `overlap_policy_skip`, задача не создаётся), `catch_up_policy` = `coalesce|skip` (одно срабатывание на окно либо ничего; счётчик `misfires` в отчёте и логах).
- **Время — вход модуля** (`Clock`): песочница гоняет hour/day waits на виртуальных часах; в рантайме — системное время. Cron (5 полей) считается **в зоне расписания**, несуществующее локальное время при переходе на летнее время срабатыванием не считается, обратный переход берёт первый момент.
- **HTTP**: `POST /schedules` (`tasks:intake`), `GET /schedules`, `POST /schedules/enable|disable` (`tasks:control`), `POST /schedules/tick` (проход планировщика; `now` — только для песочницы на виртуальных часах), `GET /schedules/occurrences` (`tasks:read`). Авторизация — по профилю расписания; `/schedules/tick` ограничен профилем принципала.
- **Логи**: `schedule.created / .duplicate / .enabled / .disabled / .tick.started / .tick.finished / .occurrence.admitted / .occurrence.deduplicated / .occurrence.skipped / .occurrence.failed`, `schedule.misfire.coalesced / .skipped` — с `profileId`, `scheduleId`, `occurrenceId`, `occurrenceKey`, `userTaskId`, `runId`, `gtdId` и причиной перехода.

## GTD opt-in и bounded control (P23, этап I07)

Карточка [trained-agent-architecture#62](https://github.com/trained-assist/trained-agent-architecture/issues/62),
границы — [PLAYBOOKS-VS-GETTING-THINGS-DONE-BOUNDARIES §5a/§9](https://github.com/trained-assist/trained-agent-architecture/blob/main/PLAYBOOKS-VS-GETTING-THINGS-DONE-BOUNDARIES.md).
Transcript и разбор приёмки — [`docs/P23-GTD-OPTIN-BOUNDED-CONTROL-TRANSCRIPT.md`](docs/P23-GTD-OPTIN-BOUNDED-CONTROL-TRANSCRIPT.md).

- **Контроль только opt-in.** Запись контроля создаётся лишь явной регистрацией `POST /gtd`
  (причина, критерии завершения, дедлайн, лимит попыток). Обычная задача, occurrence
  расписания и продолжения GTD остаются без `gtdId` (AC-141 P22 не меняется): у такой работы
  `continuationOwner = output`.
- **Одна запись на задачу.** `UNIQUE(user_task_id)` + детерминированный `gtdId` от
  `(profileId, userTaskId)`: вторая запись невозможна, поэтому исчерпание caps нельзя обойти
  «новой записью контроля» — повторная регистрация возвращает ту же (уже `stopped`) строку.
  Самоконтроль запрещён и сервисом, и CHECK в схеме.
- **Один владелец продолжения.** `continuationOwner = gtd` у managed work: решение о следующем
  шаге принимает только GTD (`gtd_progressions`, `UNIQUE(gtd_id, step_id, attempt)`), Output
  собственный follow-up не создаёт. Продолжение — явное: новый `runId`, тот же `userTaskId`,
  подъём поколения.
- **Wait не держит токены.** Ожидание — строка `gtd_records` (`state` + `next_trigger`) и, для
  человека, уже существующая строка `awaiting_inputs`; попытка паркуется (`executions.status =
  waiting`), живого процесса нет. Следующая попытка создаётся только после события: ответ
  человека, внешнее условие (`POST /gtd/condition`, synthetic CI песочницы I07) или таймер.
- **Решения детерминированы.** Критерии проверяются по структурированному свидетельству исхода
  (`{criterionId: true}`), без LLM в цикле контроля. Исход шага сохраняется в durable inbox
  **до** решения GTD; повтор по ключу идемпотентности — no-op.
- **Caps завершают прогрессию.** Исчерпание попыток или дедлайна даёт `stopped`/`blocked` с
  причиной (`attempt_cap_exhausted`, `deadline_exceeded`), а не новый контроль и не бесконечный
  retry. Неизвестный `gtdId` у managed outcome — contract error: карантин с явной причиной и
  `reconciliationRequired`, а не тихий переход к output-owned recovery.
- **Managed-шаг в плане** (`prepare → execute → report-outcome → park`): план исполняет шаг,
  отчитывается структурированным исходом и **не закрывает задачу** — терминальный статус ставит
  только GTD (`complete`/`stop`). В песочнице исход шага приходит от synthetic provider'а
  (`syntheticSteps` при регистрации, `stepOutcome` в `/start`); в проде его отдаст Runner (M1.3).
- **HTTP**: `POST /gtd` (`tasks:control`), `GET /gtd`, `GET /gtd/{gtdId}`, `POST /gtd/tick`
  (проход контроля; `now` — только для песочницы на виртуальных часах), `POST /gtd/ack`
  (durable ACK), `POST /gtd/outcomes` (`tasks:signal`), `POST /gtd/condition` (synthetic CI),
  `POST /gtd/cancel`. `/start` принимает `gtdId` с host-проверкой принадлежности и открытости
  записи. Логи: `gtd.registered / .registration.rejected / .outcome.received / .outcome.duplicate /
  .outcome.deferred / .outcome.rejected / .outcome.quarantined / .decision / .wait / .stopped /
  .cancelled / .condition.reported / .tick.started / .tick.finished` — с `profileId`, `userTaskId`,
  `runId`, `gtdId`, `stepId`, ключом идемпотентности и причиной перехода.

## Route policy и высокоточные правила (P16, этап I05)

Карточка [trained-agent-architecture#55](https://github.com/trained-assist/trained-agent-architecture/issues/55),
контракт — [TASK-ROUTER-AND-MCP §11](https://github.com/trained-assist/trained-agent-architecture/blob/main/TASK-ROUTER-AND-MCP.md),
правила маршрутов и ловушки — [FAST-REPLIES](https://github.com/trained-assist/trained-agent-architecture/blob/main/stories/FAST-REPLIES.md)
и [PROBES PR-21/PR-23](https://github.com/trained-assist/trained-agent-architecture/blob/main/stories/PROBES.md).
Песочница и transcript — [`docs/evidence/P16-SANDBOX-TRANSCRIPT.md`](docs/evidence/P16-SANDBOX-TRANSCRIPT.md).

- **Три вещи разделены, а не смешаны.** ПРИЗНАКИ (`src/router/text-features.ts`) — что видно в тексте;
  РЕШЕНИЕ (`src/router/policy.ts`) — чистая функция от признаков, проверенного каталога и снимка прав;
  ПРАВА (`src/router/authorization.ts`) — только из идентичности. Ссылка и ключевое слово — признак,
  а не маршрут.
- **Порядок правил** (§11.2): typed-сигнал/служебная команда → данные пользователя из снимка хоста →
  шаблон каталога/политики → объявленная capability (не подключена → шаблон со шагом подключения;
  нет обязательного входа → `required_input`; нет права → `blocked`) → закрывающая реплика (новый сбор
  данных не запускается) → подтверждение → внешнее действие / самостоятельный выбор инструментов /
  живые данные → исполнитель → уточнение → работа по уже данному тексту (один recipe-вызов без
  инструментов). Технические предпосылки проверяются ПЕРВЫМИ: нет снимка каталога, нет снимка
  готовности, нулевой бюджет, запрет исполнителя — это отказ с причиной, а не запуск агента.
- **Цитата отделяется от просьбы ДО анализа намерений.** Текст внутри `«…»` — данные: ссылка в цитате
  не открывается (PR-23), а императив внутри цитаты помечается `embeddedInstructionIgnored` и
  исполнением не становится. Глагол чтения засчитывается в голове сообщения или рядом с объектом,
  поэтому «что посмотрим позже?» не читается как просьба открыть страницу.
- **Алиас capability обязан покрывать весь запрос.** Иначе детерминированный путь молча выбросил бы
  вторую просьбу, а это `false-fast`. Неоднозначность (два capability с алиасом одинаковой
  специфичности) даёт уточнение, а не выбор наугад.
- **Права не выводятся regex.** Единственный источник `AuthorizationSnapshot` —
  `deriveAuthorization(identity, catalog)`, в сигнатуре которой нет текста запроса; `POST /route`
  адресуется принятой задаче в Task Store, поэтому профиль и текст в выдачу не попадают. Нет права →
  `blocked` с причиной, а не «запустить агента вместо проверки» (§11.4).
- **Живой вопрос не получает выдуманный ответ.** Если нужны данные, которых нет в сообщении и нет
  объявленной read-only capability, решение эскалируется в OpenCode с `reasonCode`, а `replyAllowed`
  равен `false`. Если capability объявлена (например, чтение известной страницы), вопрос обслуживается
  детерминированно — «ссылка ⇒ агент» не является правилом.
- **Исполнитель — только OpenCode, лестницы нет.** `AgentWorkOrder` собирается, но не исполняется:
  запуск остаётся за M1.3/P17 после host-проверки прав, бюджета и подтверждения. Технический исход
  recipe (отказ/таймаут/невалидный/обрезанный JSON) даёт `technical_error` и НЕ эскалирует;
  `escalationAttempt` в журнале всегда `false`.
- **Ограниченное исполнение:** одна capability на решение, максимум один repair схемы, бюджет
  проверяется до платного вызова, неполное покрытие входа (`attachment_pending`) ждёт извлечения,
  вместо ответа по пустому.
- **HTTP**: `POST /route` (`tasks:read`) — текст и профиль из принятой задачи, контекст/манифест
  вложений/typed-сигнал от шлюза, снимок прав из проверенной личности. Логи: `routing.decision`,
  `routing.escalated`, `routing.blocked`, `routing.technical_error`, `route.dispatched` — с
  `profileId`, `userTaskId`, `runId`, ключом события и причиной перехода; ключи события совпадают с
  `REQUIRED_EVENT_KEYS` стенда P18.

### Проверка

```bash
npm test                                   # 241 тест, из них P16: политика, PR-21, PR-23, корпус
npm run eval:fast-replies                  # пересобрать артефакт решений по корпусу P18
./tools/fetch-fast-replies-corpus.sh       # сверить пинned-снимок корпуса с манифестом P18
./tools/p16-sandbox-probe.sh               # изолированная песочница + sanitized evidence
npm run check:evidence                     # негативные проверки санитизации evidence
```

- **Корпус P18 переигран целиком:** 35/35 верных маршрутов (dev + holdout), `false_fast` = 0, ноль
  ложно-быстрых ответов о живых данных. Решения лежат в
  `eval/fast-replies/decisions/p16-route-policy.v1.jsonl` в формате стенда P18; CI пересчитывает их
  и требует байт-в-байтного совпадения, поэтому подогнать результат нельзя.
- **Пробы PR-21/PR-23** идут через настоящий HTTP-поток (приём задачи → `POST /route` с подписью
  принципала) и проверяют обе половины ловушки: что видит пользователь и что в журнале.
- **Двойное доказательство «агент не стартовал»:** `run_started` = 0 в журнале самой задачи (считается
  прямо в D1 песочницы) плюс корроборация на песочном Runner'е VM2 — там для пробных задач нет ни
  одного рана (read-only, ssh; если алиас недоступен, это фиксируется в транскрипте явно).
- **Evidence собирается fail closed:** секрет прогона, e-mail вне RFC 2606, телефон или домашний путь
  в сырых логах останавливают сборку транскрипта.

### Чего эта карточка не доказывает

- Recipe — заглушка без модели (`ROUTER_RECIPE_STUB`): настоящий вызов (одна модель без инструментов)
  и его таймауты/отказы — P17.
- Каталог возможностей песочничный (12 capability) и выдаётся binding'ом `ROUTER_GRANTS`: компилятор
  каталога, brief и чтение реальных данных capability — P14/P19/P20, credential broker прав — P13.
- Исполнитель не запускается: доказательство «агент не стартовал» — это отсутствие `run_started` в
  Task Store и `agentDispatchAttempts`, а не прогон реального OpenCode (M1.3/P17).
- Корпус синтетический (35 диалогов, P18), ground truth по живым логам не ревьюирован
  (`human_reviewed = 0`): нулевая ошибка на корпусе не доказывает нулевую ошибку в проде (§11.9).
- Задержка и стоимость на живых данных не измерены: измеряется только маршрут и признаки.
- Смешанная просьба, разделённая союзом «и» без effect/adaptive/live-признаков, может быть
  обслужена объявленной capability, если её алиас покрывает запрос целиком; ловится это эскалацией
  только при наличии соответствующих признаков.

## Brief builder и retrieval (P20, этап I06)

Карточка [trained-agent-architecture#59](https://github.com/trained-assist/trained-agent-architecture/issues/59),
контракт — [CAPABILITY-CATALOG-AND-FAST-REPLIES](https://github.com/trained-assist/trained-agent-architecture/blob/main/CAPABILITY-CATALOG-AND-FAST-REPLIES.md),
сборка контекста — [TASK-ROUTER-AND-MCP §6 и §11.1](https://github.com/trained-assist/trained-agent-architecture/blob/main/TASK-ROUTER-AND-MCP.md).
Песочница и transcript — [`docs/evidence/P20-BRIEF-TRANSCRIPT.md`](docs/evidence/P20-BRIEF-TRANSCRIPT.md).

- **Brief — проекция проверенного каталога, а не новый источник истины** (`src/router/brief/`).
  Tier-1 (`compiler.ts`) несёт явное читаемое имя, mode tags, эффект, потребность в данных
  (`none/prepared/live`), обязательные входы и факт доступности для РАЗРЕШЁННЫХ возможностей;
  Tier-2 — полные input/output schemas и ограничения ТОЛЬКО для выбранных кандидатов. Каждое entry
  ссылается на оригинальное определение (`definitionRef`), а `catalogDigest` показывает, что
  каталог не менялся.
- **Summary не придумывает права** (`summary.ts`). Строка собирается детерминированно из проверенных
  полей; единственное утверждение о доступе — факт снимка в поле `availability`. Если заголовок
  каталога сам обещает доступ («Подключено: …»), компилятор вырезает обещание и пишет
  `access_claim_in_title:<id>` в `gaps`. Невыданная возможность в Tier-1 не попадает вовсе
  (`excludedByScope`), неподключённая — остаётся фактом `not_connected` с `executable=false`.
- **Нативные имена MCP не переименовываются.** `routingName` — явная аннотация маршрутизации,
  `nativeToolName` публикуется как отображение; коллизии имён и режим вне `supportedModes`
  отлавливает `validateCatalog` до решения.
- **Кэш ключуется по области, а не по тексту** (`cache.ts`): tenant/profile, снимок прав,
  связывания профиля, версии каталога/политики, версия контекста, назначение и версия схемы.
  Одинаковый текст разных профилей не смешивается; в ключ и в значение не попадают текст запроса,
  вложения и секреты (проверяется тестом).
- **Размер измеряется в байтах UTF-8** (`TextEncoder`), а не в «токенах». Бюджет применяется
  детерминированно и видно по шагам: `full` → `tier1-only` → `tier1-minimal` →
  `tier1-minimal+tier2:N`. Если минимальный Tier-1 не влезает — технический исход
  `BRIEF_BUDGET_EXCEEDED`: модель не зовётся, исполнитель не включается. Невалидный снимок
  каталога — `BRIEF_METADATA_INVALID` до решения политики.
- **Модель получает brief, а не весь каталог** (`recipe.ts`): в запросе рецепта — имена, mode tags,
  ограничения, факты доступности, ссылки на оригинал, кандидаты и их схемы, бюджет и ключ кэша.
  Discovery-индекс исполнителя содержит только разрешённые возможности (§12).
- **HTTP**: `POST /route` возвращает блок `brief` (статус, briefId, размер, бюджет, кэш, Tier-1 и
  Tier-2). Журнал: событие `routing.brief` с `profileId`, `userTaskId`, `runId`, `requestId`,
  ключом кэша, попаданием, байтами, числом entries/кандидатов и причиной деградации.

### Проверка

```bash
npm test                                   # 285 тестов, из них P20: brief, кэш, бюджет, интеграция
./tools/p20-brief-probe.sh                 # изолированная песочница + sanitized evidence
npm run check:evidence                     # негативные проверки санитизации evidence (P16+P20)
```

- **Кэш проверен на изоляцию:** смена профиля, прав, связываний, каталога, политики, контекста и
  назначения даёт другой ключ; запись с `maxEntries=1` вытесняется детерминированно.
- **Управляемые сбои — в песочнице и в тестах:** `ROUTER_BRIEF_MAX_BYTES=32` →
  `BRIEF_BUDGET_EXCEEDED` при `modelCalls=0` и `agentDispatchAttempts=0`; `refused` модели →
  `technical_error` без эскалации. `run_started` = 0 в журнале задачи и на Runner VM2.
- **Evidence собирается fail closed** тем же принципом, что у P16: секрет прогона, e-mail вне
  RFC 2606, телефон или домашний путь в сырых логах останавливают сборку транскрипта.

### Чего эта карточка не доказывает

- Каталог по-прежнему песочничный (12 capability) и выдаётся binding'ом `ROUTER_GRANTS`: компилятор
  читает версионированные манифесты доменов, а не этот снимок; чтение реальных данных capability
  (P14/P19) и credential broker прав (P13) — отдельные карточки.
- Размер brief'а измерен на песочном каталоге; на реальном каталоге (десятки доменов и сотни
  инструментов) бюджет и число кандидатов надо перемерить — это измеряемые гипотезы (§11.10),
  а не доказанные константы.
- Кандидаты выбираются по явным именам/алиасам каталога; семантический retrieval по смыслу
  (векторный/BM25) не делался — в контракте каталога его нет, а «угадывание» кандидатов по
  названию запрещено.
- Исполнитель по-прежнему не запускается: discovery-индекс собирается, запуск — за M1.3/P17.

## Контрактные решения

- **Терминальные статусы неизменяемы** (`done/failed/cancelled`): статусный апдейт идёт с `AND status NOT IN ('done','failed','cancelled')`; поздняя запись даёт `TerminalStateError` и событие в `task_events` с `status_after = NULL, payload.rejected = terminal_state`. Закрывает суть [issue #90](https://github.com/trained-assist/trained-agent-architecture/issues/90) на двух уровнях: guard в репозитории (тест `taskstore-terminal-guard`) + «catch» в плане (тест `workflow-port`, «поздний wait_timeout»).
- **Generation fencing (INV-02)**: все записи с устаревшим `ownerGeneration` отклоняются (`FencedError` + событие `fenced`); `cancel`/`bumpGeneration` поднимают поколение.
- **Дедуп сигналов**: `UNIQUE(user_task_id, step_key, idempotency_key)`; дубль = no-op, ранний сигнал (`step_key=''`) буферизуется до парковки шага.
- **Один запуск на submit** решает Task Store (событие `run_started`), а не поведение `wf.create`: в miniflare повторный `create` не бросает ошибку, в проде бросает — решение работает на обеих платформах.
- **Отклонения от TASK-STORE-SCHEMA-V1**: `durable_tasks.result_json` — аддитивная колонка сверх §6 (там `result_json` только у `task_items`, а M1.1/#90 требуют терминальный результат в строке задачи); имя таблицы в карточке «tasks» = `durable_tasks` из §6.
- Маркер `PLAN_VERSION` в payload шагов — условие совместимости деплоя ([#92](https://github.com/trained-assist/trained-agent-architecture/issues/92)): ожидающие экземпляры могут выполнить старый **или** новый код, обе версии обязаны быть совместимы (additive-деплои), имена/порядок шагов при деплое не менять.

## Что осталось

### Bootstrap и readiness sandbox Telegram UX

`npm run sandbox:preflight:telegram-ux` проверяет привязку к ожидаемому Cloudflare account и точным sandbox Worker/D1/Workflow, плюс Worker liveness. Если текущая версия уже содержит endpoint, проверяет также authenticated read-only readiness; для первой установки endpoint появится только после deploy, поэтому preflight явно сообщает `not_deployed`. `npm run sandbox:deploy:telegram-ux` синхронизирует уже существующий Keychain secret `PRINCIPAL_SECRET_TELEGRAM_UX`, деплоит только `wrangler.telegram-ux-v1.jsonc`, затем вызывает аутентифицированный read-only `/internal/sandbox/readiness` и отдельный intake smoke. Readiness не создаёт задачи; если профиль содержит любую nonterminal задачу, проверка возвращает `409 sandbox_lane_has_nonterminal_task` и deploy flow останавливается до smoke. Intake smoke создаёт durable `accept_only` задачу, но не запускает Runner.

Команда не генерирует и не ротирует ключи. CP и Runner владеют разными копиями credentials; нельзя менять только одну. Общий `/internal/sandbox/readiness` блокирует Telegram UX lane при незавершённых задачах и не запускает Runner. Отдельный sandbox-only `POST /internal/sandbox/runner-mock-probe` использует выделенную mock identity, не создаёт CP D1/Workflow задачу и проверяет Runner `mock-test` → `pong`. Runner сохраняет одну синтетическую admission запись; повтор использует тот же idempotency key и тот же результат. Probe не заменяет обычный Telegram UX ключ и не доказывает запуск Worker/модели. До разрешения старых task/admission/collector состояний не отправлять новые Telegram сообщения и не очищать общее состояние. Cloudflare operator auth, SSH доступ, Telegram bot token, provider/model credentials и MCP credentials выдаются своими системами и должны быть заранее настроены. Evidence содержит только revision/resource/secret names и результаты boundary probes, никогда значения ключей.

Обнаруженные credential hops для Telegram UX sandbox:

| Направление | Имя/владелец | Проверка и статус |
| --- | --- | --- |
| Оператор/тестовый клиент → CP | `PRINCIPAL_SECRET_TELEGRAM_UX`; операторская копия — macOS Keychain, Worker-копия — Cloudflare CP sandbox | Локальный deploy script ссылается на точное Keychain service/account; names-only inventory Worker подтвердил наличие binding 2026-10-09. Сами значения и их равенство не проверялись. |
| CP → Runner API (Telegram UX) | `RUNNER_API_KEY_TELEGRAM_UX`; Cloudflare CP sandbox и Runner test key registry | Имя задано в profile override; names-only inventory подтверждён 2026-10-09, значение и live pairing не проверены. Не использовать это имя для mock identity. |
| CP → Runner API (`mock-test`) | Публичный sandbox URL `SANDBOX_RUNNER_MOCK_TEST_URL` и отдельный secret `RUNNER_API_KEY_TELEGRAM_UX_MOCK_TEST`; Cloudflare CP sandbox и отдельные Runner synthetic tenant/profile | URL pinned на `https://169-58-15-230.sslip.io/runner-mcp-test`; обычные `RUNNER_API_URL` и Telegram UX ключ не используются. Повторная authenticated CP-проба 2026-10-09 вернула `succeeded / pong` с тем же run ID, `cpTaskCreated=false`, `workerOrModelCalled=false`; это подтверждает один synthetic Runner admission и stable idempotency, но не реальный Worker/model запуск, task/Workflow CP, MCP invocation или Telegram delivery. |
| CP → MCP Host discovery | `MCP_TEST_AUTH_TOKEN`; CP Worker и Host `trained-assist-mcp-host-test-160` | Имя и discovery-only scope описаны в [MCP test discovery contract](docs/MCP-TEST-DISCOVERY-TELEGRAM-UX-V1.md); live secret names/auth не проверены. |
| Runner → MCP Host invocation | Runner private signing key в mode-0600 env; public JWK и policy на Host Worker | Контракт и владельцы задокументированы; Host deployment settings не полностью отражены в checked-in config, live подпись не проверена. |
| CP → Communication service | `COMMUNICATION_TOKEN` при вызове `COMMUNICATION_SERVICE` | Имя есть в Worker env contract, sandbox использует service binding; live credential presence/authorization не проверены. |
| CP → Ingress Buffer | `INGRESS_BUFFER_TOKEN`; CP Worker и `trained-assist-ingress-buffer-sandbox` | Нужен только для artifact manifest/content path; имена и владельцы описаны в [artifact contract](docs/INGRESS-ARTIFACT-MANIFEST-V1.md); live auth не проверена. |
| Runner → Model Ladder | `LLM_LADDER_TOKEN`; источник — GCP Secret Manager, Runner получает allowlisted env | Имя разрешено в sandbox RunSpec; актуальная выдача/доступность модели в этом прогоне не проверена. |

На 2026-10-09 проверены repository bindings/docs и Cloudflare account ID. Значения секретов не читались. Из-за сетевого сбоя Cloudflare API inventory и все live downstream auth probes остаются `UNKNOWN`; этот PR не объявляет всю цепочку READY.

- **Деплой и замеры на реальном аккаунте Cloudflare** — только по явной команде владельца (там же: настоящий `database_id`, latency пробуждения после `wrangler deploy` = [#91](https://github.com/trained-assist/trained-agent-architecture/issues/91), поведение под старым кодом = [#92](https://github.com/trained-assist/trained-agent-architecture/issues/92)). Токены — GCP Secret Manager / GitHub Secrets, в репо их нет и не будет.
- **M1.3** — подключение настоящего Runner (ai-agent-runner): idempotent submit, события, cancellation, финализация артефактов.
- **M1.4** — первый Web vertical slice: пять сообщений одной conversation с рестартом, awaited input, артефакты, единственный delivery owner (нужны `deliveries` как таблица и sandbox Web adapter). **Web adapter и сквозная приёмка — в PR `feat/m1-web-slice`** (страница разговора, клиент к API, сквозной прогон с рестартом); `deliveries` как таблица и единственный delivery owner — остаются на шаг 8.
- **M1.5** — пилот и rollback: реализован в `src/pilot/`. Конфиг-гейт (feature flag `PILOT_ENABLED` + cohort `PILOT_COHORT_PROFILE_IDS`), маршрутизация новых задач на новый control plane, rollback мгновенно возвращает на legacy, durable Task Store сохраняет состояние задач, начатых на новом plane. Runbook: `docs/M1-PILOT-ROLLBACK-RUNBOOK.md`.
- **GTD (P23) — следующие шаги, не в этой карточке**: планы/плейбуки и step gates (P24), подключение настоящего Runner'а к managed-шагам (M1.3/#122), решение владельца о том, кто вызывает `tick` по часам в проде (Cloudflare Cron Trigger и т.п.), когорта записей контроля при пилоте/rollback (M1, шаг 8).
- Схема дальше: таблицы вне скоупа M1.1 (`task_items`, `executions`, `deliveries`, legacy cron/hook) — отдельными аддитивными миграциями; outbox доставки (`deliveries`) и его проекция `delivery_state`.

## Связи

- Границы и ownership: [ARCHITECTURE §9](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md#9-репозитории-и-ownership), §4.1 (Task Store), §4.2 (Workflow Port).
- Порядок и приёмка: [IMPLEMENTATION-AND-INTEGRATION-PLAN, «Ближайший критический путь»](https://github.com/trained-assist/trained-agent-architecture/blob/main/IMPLEMENTATION-AND-INTEGRATION-PLAN.md#ближайший-критический-путь), эпик [M1 #109](https://github.com/trained-assist/trained-agent-architecture/issues/109).
- Схема и контракты: [TASK-STORE-SCHEMA-V1](https://github.com/trained-assist/trained-agent-architecture/blob/main/TASK-STORE-SCHEMA-V1.md), [CONVERSATIONAL-SESSION-CONTRACT](https://github.com/trained-assist/trained-agent-architecture/blob/main/CONVERSATIONAL-SESSION-CONTRACT.md).
- Стартовый код: пилот `pilots/p-db/cf-workflows` в архитектурном репо (логика порта и стора перенесена оттуда, сам пилот не менялся).

### Изолированный staging и production target

Control Plane имеет отдельные конфиги `wrangler.staging.jsonc` и `wrangler.production.jsonc`; каждый использует свою D1 и Workflow. Production target создан пустым в WEUR и не связан с Telegram, Agent, Runner или пользовательскими данными. До отдельного принятого сценария cutover он не заменяет живой legacy сервис.

После merge в защищённый `main` CI применяет миграции, деплоит staging и проверяет точный `BUILD_SHA` и анонимный отказ приватного health-read (`401`), затем выполняет те же шаги для production. GitHub environments доступны только с protected branches (сейчас это `main`), без ручной reviewer-паузы. `workflow_dispatch` доступен только на `main`, выключен по умолчанию и служит повтором этого же gate. В production smoke ошибка блокирует зелёный релиз. Rollback возвращает Worker на прошлую версию, но не откатывает D1 миграции:

```bash
npx wrangler deployments list --name trained-assist-cp-production
npx wrangler rollback <previous-version-id> --name trained-assist-cp-production --message 'Rollback after failed release smoke' --yes
node tools/deployment-smoke.mjs https://trained-assist-cp-production.skillset-apply.workers.dev <previous-build-sha>
```

Данные D1 в WEUR остаются пустыми до решения по data residency. Нынешние deploy smoke подтверждают только живость Worker, revision и fail-closed anonymous access; они не утверждают готовность профиля, Runner или Telegram.

## Контекст репозитория

CI `Repository context` на каждый PR и main собирает карту [REPO-MAP.md](https://github.com/trained-assist/trained-assist-control-plane/blob/repo-context/REPO-MAP.md) и сжатый пакет (I00/Z03). Карта — сгенерированный индекс, не инструкции: архитектура и порядок работ живут в trained-agent-architecture.

## Observability — Error Watcher

Этот репозиторий публикует error-события в [trained-assist-error-watcher](https://github.com/trained-assist/trained-assist-error-watcher) — общую точку сбора ошибок платформы.

- [Error Watcher](https://github.com/trained-assist/trained-assist-error-watcher)
- [Архитектура](https://github.com/trained-assist/trained-agent-architecture)
- [SYSTEM-ERROR-WATCHER.md](https://github.com/trained-assist/trained-agent-architecture/blob/main/SYSTEM-ERROR-WATCHER.md) — спека
- [OBSERVABILITY-AND-ERROR-CONTRACT.md](https://github.com/trained-assist/trained-agent-architecture/blob/main/OBSERVABILITY-AND-ERROR-CONTRACT.md) — контракт observability/error

## Observability — Error Watcher

Control Plane publishes C12 error events to [trained-assist-error-watcher](https://github.com/trained-assist/trained-assist-error-watcher) for every `logStructured({level:'error'})` call. Events are fire-and-forget (never block the user path) and include `userTaskId`/`runId`/`requestId` correlation.

Set `ERROR_WATCHER_URL` and `ERROR_WATCHER_KEY` as Worker secrets to enable publishing. The `system_health` scenario includes watcher health (`GET /health` → `{status, reasons, alarmId}`).

- Error event contract: [OBSERVABILITY-AND-ERROR-CONTRACT.md](https://github.com/trained-assist/trained-agent-architecture/blob/main/OBSERVABILITY-AND-ERROR-CONTRACT.md)
- Watcher spec: [SYSTEM-ERROR-WATCHER.md](https://github.com/trained-assist/trained-agent-architecture/blob/main/SYSTEM-ERROR-WATCHER.md)
- Architecture: [trained-agent-architecture](https://github.com/trained-assist/trained-agent-architecture)
