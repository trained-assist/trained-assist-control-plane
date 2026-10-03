# P23 — GTD opt-in и bounded control: transcript на виртуальных часах

Карточка [trained-agent-architecture#62](https://github.com/trained-assist/trained-agent-architecture/issues/62) (этап I07),
AC-142. Документ — logs acceptance этапа: [SANDBOX · I07](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md#i07--расписание-планы-выборочный-gtd).
Границы — [PLAYBOOKS-VS-GETTING-THINGS-DONE-BOUNDARIES §5a/§9](https://github.com/trained-assist/trained-agent-architecture/blob/main/PLAYBOOKS-VS-GETTING-THINGS-DONE-BOUNDARIES.md).

## Как воспроизвести

```bash
npm ci
npm run db:migrate:local      # 0001…0007 в локальную D1 (.wrangler/state)
npm run typecheck && npm test # 170 тестов в workerd, включая tests/p23-gtd.test.ts
npm run dev                   # терминал 1: локальный control plane (:8787)
./tools/local-smoke.sh        # терминал 2: HTTP-прогон, раздел 15 = GTD
```

Пилот для локального прогона включается только локальным `.dev.vars` (в репозиторий не коммитится):
`PILOT_ENABLED=true`, `PILOT_ACTIVATED_AT=2026-01-01T00:00:00Z` — иначе `/start` маршрутизирует
в legacy и экземпляр не создаётся (существующее поведение M1.5, не P23).

Ничего не деплоится и ни одна существующая среда не меняется: D1 и Workflows локальные (`wrangler dev`),
время тика задаётся явно (`now` в теле `/gtd/tick`), внешний гейт — synthetic provider
(`POST /gtd/condition` и сценарий `syntheticSteps` при регистрации).

## Санитизация evidence

* Среда — локальная песочница: `environment: "sandbox"`, синтетический профиль `profile-1`
  (в тестах — `profile-p23-*`), никаких живых профилей и миграций существующих данных.
* Секретов в среде нет: `RUNNER_API_URL`/`RUNNER_API_KEY` не заданы; ключ Runner'а в репозитории
  и в логах отсутствует (тест 8 проверяет: в логах GTD нет `RUNNER_API_KEY`/`Bearer`).
* В логи пишутся только идентификаторы (`profileId`, `userTaskId`, `runId`, `gtdId`, `stepId`,
  `occurrenceKey`, `idempotencyKey`), ключи и причины перехода. Текст задачи пользователя и описания
  критериев в логи GTD не пишутся (тест 8: в логах нет ни цели, ни `required check зелёный`).
* Идентификаторы ниже — эфемерные sandbox-идентификаторы этого прогона, они не переносятся ни в какой прод.

---

## A. HTTP-прогон (tools/local-smoke.sh, раздел 15)

```
== 15.1 обычная задача без контроля: gtdId отсутствует, владелец продолжения output ==
OK: без регистрации контроля нет: gtdId отсутствует, continuationOwner = output
OK: записей контроля нет (GTD не создаётся сам)
== 15.2 явная регистрация: одна запись, детерминированный gtdId ==
OK: запись контроля создана: gtd-64ce255f704660d1da8b (continuationOwner=gtd)
OK: повторная регистрация — тот же gtdId, второй записи нет
== 15.3 managed шаг: критерий не выполнен -> ровно одно продолжение ==
OK: ACK -> одно решение continue, continuationRunId = 6fe875b5-db5d-4043-a153-db5acd44f3b9
OK: критерий выполнен -> complete, новых попыток нет
OK: задача закрыта GTD (done); попыток: 2 | владелец продолжения один
== 15.4 wait по вводу человека: durable ожидание, ответ -> одно продолжение ==
OK: попытка паркована (waiting), живого процесса нет; awaitingInputId = 3bffac4e-5890-4da2-96a8-4e526f605691
OK: ACK -> wait по вводу, продолжения нет
OK: 3 тика без ответа — новых попыток нет (wait не держит токены)
OK: ответ пользователя -> ровно одно продолжение, критерий выполнен
OK: задача закрыта после ответа; попыток: 2
== 15.5 caps завершают прогрессию: обхода новой записью нет ==
OK: попытка 1 -> continue step_failed_retry
OK: попытка 2 -> stop attempt_cap_exhausted
OK: attempt cap -> blocked (stopReason = attempt_cap_exhausted ), попыток: 2
OK: обойти caps новой записью контроля нельзя (409)
== 15.6 неизвестный gtdId у managed outcome: карантин, не тихий fallback ==
OK: исход без записи контроля — quarantined (409), попыток не добавилось
```

Запросы и ответы ключевых шагов:

```http
POST /intake {"contractVersion":1,"requestId":"req-p23-managed-…","profileId":"profile-1","inputItems":[{"text":"довести до конца и проверить CI"}]}
-> 201 {"userTaskId":"ut-…","durable":true,"pilotRoute":"new-plane"}

POST /gtd {"requestId":"gtd-smoke-…","profileId":"profile-1","userTaskId":"ut-…",
  "reason":"довести до конца и проверить CI",
  "criteria":[{"id":"ci-gate","description":"required check зелёный","required":true}],
  "deadlineAt":1791008735000,"maxAttempts":3,
  "syntheticSteps":[{"stepOutcome":"succeeded","criteria":{"ci-gate":true}}]}
-> 201 {"gtdId":"gtd-64ce255f704660d1da8b","state":"active","created":true,"continuationOwner":"gtd"}

POST /gtd  (тот же requestId и условия)
-> 200 {"gtdId":"gtd-64ce255f704660d1da8b","created":false}   # вторая запись не появилась

POST /start {"taskId":"ut-…","profileId":"profile-1","gtdId":"gtd-64ce255f704660d1da8b",
  "stepOutcome":"succeeded","criteria":{"ci-gate":false}}
-> 200 {"created":false,"instanceCreated":true,"runId":"…"}

POST /gtd/ack {"gtdId":"gtd-64ce255f704660d1da8b"}
-> 200 {"processed":[{"outcomeId":"gtd-out-…","stepId":"step-1","attempt":1,
      "decision":"continue","reason":"criteria_not_met","triggerKind":null,"triggerRef":null,
      "continuationRunId":"6fe875b5-…","deferred":false}]}

POST /gtd/ack {"gtdId":"gtd-64ce255f704660d1da8b"}   # повтор по уже подтверждённому исходу
-> 200 {"processed":[],"deferred":0}                  # второго продолжения нет

POST /gtd/ack {"gtdId":"gtd-64ce255f704660d1da8b"}   # исход продолжения: критерий выполнен
-> 200 {"processed":[{"stepId":"step-2","attempt":2,"decision":"complete",
      "reason":"criteria_met","continuationRunId":null}]}

GET /status?taskId=ut-…  -> status=done, result.gtdId=gtd-64ce255f704660d1da8b, попыток: 2

POST /start {"taskId":"ut-…","gtdId":"gtd-…","stepOutcome":"awaiting_user"}
-> задача: status=awaiting_input, stage=waiting_input; попытка: status='waiting' (finished_at не NULL)

POST /gtd/ack  -> decision=wait, reason=awaiting_user_input, triggerKind=input, continuationRunId=null
POST /gtd/tick {"now":…}  ×3 без ответа -> {"continued":0,"waiting":1}  (новых попыток нет)
POST /awaiting/3bffac4e-…/answer {"idempotencyKey":"web:p23-smoke","answer":{"optionId":"opt-a"}}
POST /gtd/tick {"now":…}  -> {"continued":1}  (ровно одно продолжение)

POST /gtd  (повторная регистрация после stopped, другие условия)
-> 409 {"error":"control record already exists for task ut-…: already_registered"}

POST /gtd/outcomes {"gtdId":"gtd-ffffffffffffffffffff","userTaskId":"ut-…","stepId":"step-9",
  "outcome":"failed","idempotencyKey":"ghost:smoke"}
-> 409 {"state":"quarantined","reason":"unknown_control_record","reconciliationRequired":true}
```

## B. Структурные логи control plane (тот же прогон, `wrangler dev`)

```json
{"event":"gtd.registered","profileId":"profile-1","userTaskId":"ut-6d42b45b05bd7bc004b2","gtdId":"gtd-26a76a9a400b1a0baef6","requestId":"reg-req-p23-caps-1790994812","reason":"explicit_opt_in","registrationReason":"довести до конца с проверкой","criteria":["release-ok"],"continuationOwner":"gtd","state":"active","deadlineAt":1791009211000,"maxAttempts":2,"nextCheckAt":null,"supervisedByGtdId":null}
{"event":"gtd.outcome.received","profileId":"profile-1","userTaskId":"ut-6d42b45b05bd7bc004b2","runId":"2f722df1-d903-4376-82ed-fcd02fdfab50","gtdId":"gtd-26a76a9a400b1a0baef6","stepId":"step-1","outcome":"failed","idempotencyKey":"gtd:gtd-26a76a9a400b1a0baef6:step-1:1","inboxState":"pending","continuationOwner":"gtd"}
{"event":"gtd.decision","profileId":"profile-1","userTaskId":"ut-6d42b45b05bd7bc004b2","runId":"2f722df1-d903-4376-82ed-fcd02fdfab50","gtdId":"gtd-26a76a9a400b1a0baef6","outcomeId":"gtd-out-9cc6883908b1ec5128f6","stepId":"step-1","attempt":1,"decision":"continue","reason":"step_failed_retry","continuationOwner":"gtd","continuationRunId":"6d46e622-eb98-4f23-8400-7a4707b4b580","continuationCreated":true,"criteria":null,"triggerKind":null,"triggerRef":null,"recordState":"active","ack":true}
{"event":"gtd.outcome.received","profileId":"profile-1","userTaskId":"ut-6d42b45b05bd7bc004b2","runId":"6d46e622-eb98-4f23-8400-7a4707b4b580","gtdId":"gtd-26a76a9a400b1a0baef6","stepId":"step-2","outcome":"succeeded","idempotencyKey":"gtd:gtd-26a76a9a400b1a0baef6:step-2:2","inboxState":"pending","continuationOwner":"gtd"}
{"event":"gtd.decision","profileId":"profile-1","userTaskId":"ut-6d42b45b05bd7bc004b2","runId":"6d46e622-eb98-4f23-8400-7a4707b4b580","gtdId":"gtd-26a76a9a400b1a0baef6","outcomeId":"gtd-out-bc096e888d40f14dec04","stepId":"step-2","attempt":2,"decision":"stop","reason":"attempt_cap_exhausted","continuationOwner":"gtd","continuationRunId":null,"continuationCreated":false,"criteria":{"met":false,"satisfied":[],"missing":["release-ok"]},"triggerKind":null,"triggerRef":null,"recordState":"stop","ack":true}
{"event":"gtd.registration.rejected","level":"warn","profileId":"profile-1","userTaskId":"ut-6d42b45b05bd7bc004b2","gtdId":"gtd-26a76a9a400b1a0baef6","requestId":"reg-req-p23-caps-1790994812-again","reason":"caps_exhausted_record_closed","existingState":"stopped","stopReason":"attempt_cap_exhausted","attempts":2,"maxAttempts":2}
{"event":"gtd.outcome.quarantined","level":"error","userTaskId":"ut-6d42b45b05bd7bc004b2","runId":null,"gtdId":"gtd-ffffffffffffffffffff","stepId":"step-9","outcome":"failed","idempotencyKey":"ghost:smoke","reason":"unknown_control_record","reconciliationRequired":true,"continuationOwner":"gtd","note":"managed outcome без записи контроля: тихий output-owned recovery запрещён"}
{"event":"gtd.decision","profileId":"profile-1","userTaskId":"ut-f38270147cd6b0f6349f","gtdId":"gtd-b574e8df607fd35ad8b7","stepId":"step-2","attempt":1,"decision":"continue","reason":"input_received","continuationOwner":"gtd","continuationRunId":"3e92d5f5-8951-485f-ad54-43157d4bd862","continuationCreated":true,"triggerKind":"input","triggerRef":"3bffac4e-5890-4da2-96a8-4e526f605691","recordState":"active","ack":true}
{"event":"gtd.decision","profileId":"profile-1","userTaskId":"ut-f38270147cd6b0f6349f","gtdId":"gtd-b574e8df607fd35ad8b7","outcomeId":"gtd-out-e9f7f552d5df0503bc00","stepId":"step-2","attempt":2,"decision":"complete","reason":"criteria_met","continuationOwner":"gtd","continuationRunId":null,"continuationCreated":false,"criteria":{"met":true,"satisfied":["choice-made"],"missing":[]},"triggerKind":null,"triggerRef":null,"recordState":"complete","ack":true}
{"event":"gtd.tick.finished","reason":"completed","now":1790994991000,"profileId":"profile-1","checked":1,"continued":0,"completed":0,"stopped":0,"waiting":1,"deferred":0,"quarantined":0,"errors":0}
```

Читается без интерпретаций: `gtd.registered` несёт причину и критерии, `gtd.outcome.received` —
ключ идемпотентности и `inboxState: pending`, `gtd.decision` — решение, причину, триггер и
`continuationRunId` (или явный `null`), `gtd.registration.rejected` — причину отказа с
`existingState: stopped`, `gtd.outcome.quarantined` — contract error с
`reconciliationRequired: true`.

## C. Жизнь задач под контролем (`GET /status`, тот же прогон)

### C.1 Ожидание ввода человека: `ut-f38270147cd6b0f6349f` (gtd-b574e8df607fd35ad8b7)

```
status=done  stage=finished  generation=2
result={"ok":true,"gtdId":"gtd-b574e8df607fd35ad8b7","continuationOwner":"gtd",
        "completedBy":"gtd","criteria":["choice-made"],"stepId":"step-2","attempt":2,
        "reason":"criteria_met"}

1272 task_accepted            None            -> active         input
1273 run_started              runId=e2b5b3f1… engine=cloudflare-workflows
1274 step_done prepare        managed=true, gtdId=gtd-b574e8df…, stepId=step-1, attempt=1
1275 step_done execute        outcome=awaiting_user
1276 awaiting_opened wait     active -> awaiting_input   (durable ожидание, kind=data)
1277 step_done park           awaiting_input -> awaiting_input
1278 run_finished             outcome=waiting, reason=awaiting_user_input, checkpointRef=awaiting:3bffac4e…
1279 signal_received          user_reply, idempotencyKey=web:p23-smoke, stepKey=3bffac4e…
1280 awaiting_answered wait    awaiting_input -> active
1281 task_status_changed      generationBumped=true, reason=gtd_continuation:input_received, from=1
1282 run_started              runId=3e92d5f5…
1283 run_started              resumed=true, reason=gtd_continuation:input_received
1285 step_done prepare        stepId=step-2, attempt=2
1286 step_done execute        outcome=succeeded
1287 step_done park           inboxState=acked
1288 run_finished             outcome=success
1289 task_status_changed gtd  active -> done   {gtdId, continuationOwner: gtd}
runs: [('e2b5b3f1','waiting',1), ('3e92d5f5','success',2)]
```

Во время ожидания живая попытка отсутствует: попытка 1 закрыта исходом `waiting`
(`finished_at` не NULL), экземпляр завершён, следующая попытка создана только после ответа —
`wait` не держит агент и не расходует токены. Продолжение — тот же `userTaskId`, новый `runId`,
поколение поднято (прежняя попытка лишена прав).

### C.2 Исчерпание caps: `ut-6d42b45b05bd7bc004b2` (gtd-26a76a9a400b1a0baef6)

```
status=blocked  stage=evaluating  generation=2  blocker_reason=attempt_cap_exhausted
result={"ok":false,"gtdId":"gtd-26a76a9a400b1a0baef6","continuationOwner":"gtd",
        "stoppedBy":"gtd","stopReason":"attempt_cap_exhausted","stepId":"step-2",
        "attempt":2,"criteria":["release-ok"]}

1291 run_started   runId=2f722df1…
1292 step_done prepare   stepId=step-1, attempt=1
1293 step_done execute   outcome=failed
1294 step_done park      inboxState=pending
1295 run_finished       outcome=failed
1296 task_status_changed  generationBumped=true, reason=gtd_continuation:step_failed_retry
1297 run_started   runId=6d46e622…
1298 run_started   resumed=true, reason=gtd_continuation:step_failed_retry
1300 step_done prepare   stepId=step-2, attempt=2
1301 step_done execute   outcome=succeeded
1302 step_done park      inboxState=pending
1303 run_finished       outcome=success
1304 task_status_changed gtd  active -> blocked  {gtdId, continuationOwner: gtd, stoppedBy: gtd}
runs: [('2f722df1','failed',1), ('6d46e622','success',2)]
```

Прогрессия завершена по лимиту попыток: новых попыток нет, задача `blocked` с причиной,
запись контроля `stopped`. Повторная регистрация отклонена (409) — обойти caps новой
записью контроля нельзя.

## D. Управляемые сбои (`tests/p23-gtd.test.ts`, виртуальные часы)

| Сбой | Ожидаемый результат | Доказательство |
|---|---|---|
| Повторный ACK по подтверждённому исходу | второго решения и продолжения нет | тест 3: `ackAgain.processed == 0`, попыток по-прежнему 2 |
| Живая попытка ещё идёт, когда исход уже пришёл | исход остаётся `pending`, попытка не прерывается | код: `gtd.outcome.deferred` / `active_run_in_progress` |
| Неизвестный `gtdId` у managed outcome | карантин + явный статус, ни одной новой попытки | тест 7: `state=quarantined`, `runs == []`, задача не изменилась |
| Исчерпание `max_attempts` | `stopped` / `blocked`, без новых попыток | тест 6 + C.2 |
| Дедлайн контроля | `stopped` / `deadline_exceeded`, без новых попыток | тест 6 (вторая часть) |
| Повторная регистрация после `stopped` | 409, записи контроля по-прежнему одна | тест 6 + `gtd.registration.rejected … caps_exhausted_record_closed` |
| Самоконтроль (GTD над GTD) | отказ, записи нет; CHECK в схеме тоже запрещает | тест 2 |
| Регистрация без причины/критериев/дедлайна | отказ до вставки, записи нет | тест 2 |
| Регистрация на терминальную задачу | отказ `task_terminal` | код + smoke 15.2 (повтор на той же задаче) |
| Ответ после закрытия записи | `rejected` / `control_record_closed`, работа не возрождается | тест 3 (поздний исход) |

## E. Соответствие приёмке

| Пункт приёмки | Доказательство |
|---|---|
| AC-142 · одна явная managed task получает G; остальные нет | A/15.1 (обычная задача: `gtdId` отсутствует, `continuationOwner=output`), A/15.2 (одна запись, детерминированный `gtdId`), тест 1 (occurrence расписания и обычная задача — без записи) |
| AC-142 · wait не держит токены | A/15.4 (3 тика без ответа — новых попыток нет), C.1 (попытка `waiting`, экземпляр завершён), тесты 4 и 5 |
| AC-142 · self-GTD не создаётся | тест 2 (`supervisedByGtdId` → отказ, CHECK в схеме), тест 1 (ни один маршрут, кроме `POST /gtd`, запись не создаёт) |
| AC-142 · caps завершают прогрессию, не обходятся новой записью | A/15.5, C.2, тест 6 (`UNIQUE(user_task_id)` + детерминированный `gtdId`) |
| AC-142 · Output → GTD ACK и один owner continuation | A/15.3 (`gtd.decision` с `continuationRunId`, повторный ACK пуст), C.1/C.2 (один `resumed` на решение), тест 3 |
| SANDBOX · I07 · logs | occurrence dedup (P22 не менялся), `gtdId` только opt-in, registration reason, wait/deadline/ACK — разделы A/B |
| Управляемый сбой обязателен | раздел D: 9 сценариев, не только happy path |

## F. Что сознательно вне этой карточки

* **Настоящий Runner для managed-шагов**: исход шага в песочнице приходит от synthetic
  provider'а (`syntheticSteps` при регистрации / `stepOutcome` в `/start`). Подключение
  результата Runner'а (M1.3/#122) — тот же контракт `submit/result`, отдельная карточка.
* **Планы (playbook/plan compiler) и step gates**: P23 хранит критерии и проверяет их
  детерминированно, но не компилирует планы из плейбуков — это P24.
* **Кто вызывает `tick` в проде** (Cloudflare Cron Trigger и т.п.) и когорта записей
  контроля при пилоте/rollback — решение владельца, как у P22.
* **Групповой dashboard расписаний/контроля** — не заводился (§7: «batch/group semantics
  здесь не проектируем»).

## G. Известная косметика (не дефект P23)

`CfWorkflowPort.resume` при завершённом экземпляре пишет событие `error` с
`where: resume.terminate` (`Cannot terminate instance since it is already complete`) — это
существующее поведение пути продолжения (эпик M1 шаг 5): экземпляр уже завершён, `delete` и
`create` проходят, попытка и продолжение корректны. В истории задач это видно как событие
`error` между двумя `run_started`; на приёмку не влияет.
