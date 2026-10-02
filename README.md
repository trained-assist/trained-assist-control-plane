# trained-assist-control-plane

Trained Assist control plane: Task Store (D1) + Workflow Port (Cloudflare Workflows), поверх них — Input/Router/Output/GTD/Journal/Reporting.

**Статус (02.10.2026): M1.1, M1.2, P04 (приём+квитанция) и P05/P06 (поток событий, replay, восстановление) реализованы и покрыты тестами; деплой на реальный аккаунт Cloudflare НЕ выполнялся** (все прогоны локальные, miniflare; `database_id` в `wrangler.jsonc` — placeholder до команды владельца). Карточки эпика M1 — [trained-agent-architecture#109](https://github.com/trained-assist/trained-agent-architecture/issues/109), PR: #2 (каркас+CI), #3 (Task Store), #5 (Workflow Port), #6 (приём+квитанция), #7 (P05/P06).

## Что здесь лежит

| Путь | Что это |
|---|---|
| `migrations/0001_task_store_v1.sql` | D1-схема Task Store v1 по [TASK-STORE-SCHEMA-V1 §6](https://github.com/trained-assist/trained-agent-architecture/blob/main/TASK-STORE-SCHEMA-V1.md): `durable_tasks`, `task_events`, `task_signals`, `awaiting_inputs`, `conversations` |
| `src/taskstore/` | Репозиторий Task Store: атомарные state/event-переходы, generation fencing, дедуп сигналов, awaiting input, **guard терминальных состояний** (issue #90), приём с квитанцией |
| `src/intake/` | Приём задачи по контракту C01: envelope, профиль/права (scope), детерминированный userTaskId, durable receipt, идемпотентность по requestId |
| `src/events/` | Поток событий C02: envelope с курсором (sequence = task_events.id), тип выводится из kind журнала |
| `src/workflow-port/delivery-worker.ts` | Воркер доставки: единственный владелец отправки, bounded retry, адаптер канала внедряется |
| `src/workflow-port/` | Workflow Port поверх Cloudflare Workflows: `submit/signal/cancel/status/recover`, `StepCtx` для кода планов, демо-план M1.2 |
| `src/index.ts` | `TaskWorkflow` + HTTP-слой (`/start /signal /cancel /status /recover`) |
| `tests/` | vitest **в рантайме workerd** (`@cloudflare/vitest-pool-workers`): D1, Workflows, реальные миграции — 70 тестов |
| `tools/local-smoke.sh` | Воспроизводимый прогон слоя против локального `wrangler dev` |

## Как запустить локально

Требуется Node ≥22 (wrangler 4; Node 20 вне EOL с 04.2026).

```bash
npm ci                 # в этом шелле NODE_ENV=production -> NODE_ENV=development npm ci
npm run typecheck      # tsc --noEmit
npm test               # 39 тестов в workerd (D1 + Workflows), ~15 с
npm run check          # typecheck + test
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

## Контрактные решения

- **Терминальные статусы неизменяемы** (`done/failed/cancelled`): статусный апдейт идёт с `AND status NOT IN ('done','failed','cancelled')`; поздняя запись даёт `TerminalStateError` и событие в `task_events` с `status_after = NULL, payload.rejected = terminal_state`. Закрывает суть [issue #90](https://github.com/trained-assist/trained-agent-architecture/issues/90) на двух уровнях: guard в репозитории (тест `taskstore-terminal-guard`) + «catch» в плане (тест `workflow-port`, «поздний wait_timeout»).
- **Generation fencing (INV-02)**: все записи с устаревшим `ownerGeneration` отклоняются (`FencedError` + событие `fenced`); `cancel`/`bumpGeneration` поднимают поколение.
- **Дедуп сигналов**: `UNIQUE(user_task_id, step_key, idempotency_key)`; дубль = no-op, ранний сигнал (`step_key=''`) буферизуется до парковки шага.
- **Один запуск на submit** решает Task Store (событие `run_started`), а не поведение `wf.create`: в miniflare повторный `create` не бросает ошибку, в проде бросает — решение работает на обеих платформах.
- **Отклонения от TASK-STORE-SCHEMA-V1**: `durable_tasks.result_json` — аддитивная колонка сверх §6 (там `result_json` только у `task_items`, а M1.1/#90 требуют терминальный результат в строке задачи); имя таблицы в карточке «tasks» = `durable_tasks` из §6.
- Маркер `PLAN_VERSION` в payload шагов — условие совместимости деплоя ([#92](https://github.com/trained-assist/trained-agent-architecture/issues/92)): ожидающие экземпляры могут выполнить старый **или** новый код, обе версии обязаны быть совместимы (additive-деплои), имена/порядок шагов при деплое не менять.

## Что осталось

- **Деплой и замеры на реальном аккаунте Cloudflare** — только по явной команде владельца (там же: настоящий `database_id`, latency пробуждения после `wrangler deploy` = [#91](https://github.com/trained-assist/trained-agent-architecture/issues/91), поведение под старым кодом = [#92](https://github.com/trained-assist/trained-agent-architecture/issues/92)). Токены — GCP Secret Manager / GitHub Secrets, в репо их нет и не будет.
- **M1.3** — подключение настоящего Runner (ai-agent-runner): idempotent submit, события, cancellation, финализация артефактов.
- **M1.4** — первый Web vertical slice: пять сообщений одной conversation с рестартом, awaited input, артефакты, единственный delivery owner (нужны `deliveries` как таблица и sandbox Web adapter).
- **M1.5** — пилот и rollback: compatibility-сценарии, разрешённый cohort только для новых задач.
- Схема дальше: таблицы вне скоупа M1.1 (`task_items`, `executions`, `deliveries`, legacy cron/hook) — отдельными аддитивными миграциями; outbox доставки (`deliveries`) и его проекция `delivery_state`.

## Связи

- Границы и ownership: [ARCHITECTURE §9](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md#9-репозитории-и-ownership), §4.1 (Task Store), §4.2 (Workflow Port).
- Порядок и приёмка: [IMPLEMENTATION-AND-INTEGRATION-PLAN, «Ближайший критический путь»](https://github.com/trained-assist/trained-agent-architecture/blob/main/IMPLEMENTATION-AND-INTEGRATION-PLAN.md#ближайший-критический-путь), эпик [M1 #109](https://github.com/trained-assist/trained-agent-architecture/issues/109).
- Схема и контракты: [TASK-STORE-SCHEMA-V1](https://github.com/trained-assist/trained-agent-architecture/blob/main/TASK-STORE-SCHEMA-V1.md), [CONVERSATIONAL-SESSION-CONTRACT](https://github.com/trained-assist/trained-agent-architecture/blob/main/CONVERSATIONAL-SESSION-CONTRACT.md).
- Стартовый код: пилот `pilots/p-db/cf-workflows` в архитектурном репо (логика порта и стора перенесена оттуда, сам пилот не менялся).

Живой сервис этим репозиторием не меняется: реализация идёт параллельно, в собственных sandbox-развёртываниях.

## Контекст репозитория

CI `Repository context` на каждый PR и main собирает карту [REPO-MAP.md](https://github.com/trained-assist/trained-assist-control-plane/blob/repo-context/REPO-MAP.md) и сжатый пакет (I00/Z03). Карта — сгенерированный индекс, не инструкции: архитектура и порядок работ живут в trained-agent-architecture.
