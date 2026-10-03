# P22 — Schedule без обязательного GTD: transcript на виртуальных часах

Карточка [trained-agent-architecture#61](https://github.com/trained-assist/trained-agent-architecture/issues/61) (этап I07),
AC-140 / AC-141. Документ — logs acceptance этапа: [SANDBOX · I07](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md#i07--расписание-планы-выборочный-gtd).

## Как воспроизвести

```bash
npm ci
npm run db:migrate:local      # 0001…0006 в локальную D1 (.wrangler/state)
npm run typecheck && npm test # 162 теста в workerd, включая tests/p22-schedule.test.ts
npm run dev                   # терминал 1: локальный control plane (:8787)
./tools/local-smoke.sh        # терминал 2: HTTP-прогон, раздел 14 = расписание
```

Ничего не деплоится и ни одна существующая среда не меняется: D1 и Workflows локальные (`wrangler dev`),
время срабатываний задаётся явно (`now` в теле `/schedules/tick`), реальные часы не используются и сон не нужен.

## Санитизация evidence

* Среда — локальная песочница: `environment: "sandbox"`, синтетический профиль `profile-1`
  (в тестах — `profile-p22-*`), никаких живых профилей и миграций существующих данных.
* Секретов в среде нет: `RUNNER_API_URL`/`RUNNER_API_KEY` не заданы, ключ Runner'а в репозитории и в логах
  отсутствует (тест 8 это проверяет: в логах расписания нет `RUNNER_API_KEY`/`Bearer`).
* В логи пишутся только идентификаторы (`profileId`, `scheduleId`, `occurrenceId`, `occurrenceKey`,
  `userTaskId`, `runId`), ключи и причины перехода. Текст задачи пользователя в логи расписания не пишется;
  вхождение цели видно только в терминальном результате задачи (`result.goal`).
* Идентификаторы ниже — эфемерные sandbox-идентификаторы этого прогона, они не переносятся ни в какой прод.

---

## A. HTTP-прогон (tools/local-smoke.sh, раздел 14)

Расписание `0 * * * *`, зона `Europe/Moscow`, момент срабатывания задан явно: `V = 1790992800000`
(2026-10-03T02:00:00Z = 05:00 МСК), следующий час `V2 = 1790996400000`.

```
== 14. расписание без обязательного GTD (P22, виртуальные часы) ==
OK: расписание создано, gtdId=null (контроль не регистрировался): sch-4a620f87baa5757eb327
OK: occurrence принят на 2026-10-03T02:00:00Z | gtd_id = None | task = ut-9277c462c86175510046
OK: hourly task -> Output без gtdId; history = task_accepted -> run_started -> step_done -> step_done -> task_status_changed -> run_finished
== 14.1 повторный tick на том же моменте = нет второго срабатывания ==
OK: occurrence по-прежнему один
== 14.2 disable расписания != отмена принятой задачи ==
OK: disable не отменил задачу (status=done); час, прошедший при выключенном расписании, не превратился в occurrence
== 14.3 enable = ближайшее будущее срабатывание, окно не отыгрывается пачкой ==
OK: включено, ближайшее срабатывание = 1790992800000
OK: после enable одно новое occurrence (coalesce), gtd_id = None | всего occurrence: 2
```

Запросы и ответы этого раздела:

```http
POST /schedules
{"requestId":"sched-smoke-1790991341-90701","profileId":"profile-1",
 "cron":"0 * * * *","timezone":"Europe/Moscow","goal":"local smoke hourly"}
-> 201 {"created":true,"gtdId":null,"schedule":{"schedule_id":"sch-4a620f87baa5757eb327",
      "cron_expr":"0 * * * *","timezone":"Europe/Moscow","overlap_policy":"skip",
      "catch_up_policy":"coalesce","max_admit_attempts":5,"enabled":1,"next_due_at":1790992800000}}

POST /schedules/tick {"now":1790992800000}
-> 200 {"now":1790992800000,"dueSchedules":1,"admitted":1,"recovered":0,"deduplicated":0,
        "skipped":0,"failed":0,"misfires":0,"errors":[]}

GET /schedules/occurrences?scheduleId=sch-4a620f87baa5757eb327
-> 200 {"occurrences":[{"occurrence_key":"2026-10-03T02:00:00Z","state":"admitted",
        "gtd_id":null,"user_task_id":"ut-9277c462c86175510046","attempts":1,"reason":"submitted"}]}

POST /schedules/tick {"now":1790992800000}      # повтор на том же моменте
-> 200 {"admitted":0,"deduplicated":0,"failed":0}   # occurrence по-прежнему один

POST /schedules/disable {"scheduleId":"sch-4a620f87baa5757eb327"}
-> 200 {"schedule":{"enabled":0}}

POST /schedules/tick {"now":1790996400000}      # следующий час при выключенном расписании
-> 200 {"dueSchedules":0,"admitted":0}

GET /status?taskId=ut-9277c462c86175510046     # задача occurrence не отменена, а завершена
-> 200 status=done, result={"ok":true,"mode":"auto","version":"m1-conversation-v2",
                             "goal":"local smoke hourly"}

POST /schedules/enable {"scheduleId":"sch-4a620f87baa5757eb327"}
-> 200 {"schedule":{"enabled":1,"next_due_at":1790992800000}}

POST /schedules/tick {"now":1790996400000}      # окно из двух моментов -> одно срабатывание
-> 200 {"admitted":1,"misfires":1}
```

## B. Структурные логи control plane (тот же прогон, `wrangler dev`)

```json
{"event":"schedule.created","profileId":"profile-1","scheduleId":"sch-4a620f87baa5757eb327","requestId":"sched-smoke-1790991341-90701","reason":"accepted","cron":"0 * * * *","timezone":"Europe/Moscow","overlapPolicy":"skip","catchUpPolicy":"coalesce","enabled":true,"nextDueAt":1790992800000,"gtdId":null,"controlRegistration":"not_requested"}
{"event":"schedule.tick.started","reason":"scan","now":1790992800000,"profileId":"profile-1"}
{"event":"schedule.occurrence.admitted","profileId":"profile-1","userTaskId":"ut-9277c462c86175510046","runId":"233052ed-f4c1-4a55-b2cd-cc199de72f52","scheduleId":"sch-4a620f87baa5757eb327","occurrenceId":"occ-60120fcac9248537a84c","occurrenceKey":"2026-10-03T02:00:00Z","scheduledFor":1790992800000,"attempts":1,"state":"admitted","reason":"submitted","taskCreated":true,"gtdId":null,"controlRegistration":"not_requested"}
{"event":"schedule.tick.finished","reason":"completed","now":1790992800000,"profileId":"profile-1","dueSchedules":1,"admitted":1,"recovered":0,"deduplicated":0,"skipped":0,"failed":0,"misfires":0,"errors":0}
{"event":"schedule.tick.started","reason":"scan","now":1790992800000,"profileId":"profile-1"}
{"event":"schedule.tick.finished","reason":"completed","now":1790992800000,"profileId":"profile-1","dueSchedules":0,"admitted":0,"recovered":0,"deduplicated":0,"skipped":0,"failed":0,"misfires":0,"errors":0}
{"event":"schedule.disabled","profileId":"profile-1","scheduleId":"sch-4a620f87baa5757eb327","reason":"future_occurrences_only","inFlightOccurrences":0,"acceptedTasksCancelled":0,"note":"disable != cancel: принятые occurrence продолжаются"}
{"event":"schedule.tick.started","reason":"scan","now":1790996400000,"profileId":"profile-1"}
{"event":"schedule.tick.finished","reason":"completed","now":1790996400000,"profileId":"profile-1","dueSchedules":0,"admitted":0,"recovered":0,"deduplicated":0,"skipped":0,"failed":0,"misfires":0,"errors":0}
{"event":"schedule.enabled","profileId":"profile-1","scheduleId":"sch-4a620f87baa5757eb327","reason":"future_occurrences_resumed","nextDueAt":1790992800000,"skippedMissed":0}
{"event":"schedule.misfire.coalesced","profileId":"profile-1","scheduleId":"sch-4a620f87baa5757eb327","reason":"catch_up_coalesce","missed":1,"selectedFor":"2026-10-03T03:00:00.000Z"}
{"event":"schedule.occurrence.admitted","profileId":"profile-1","userTaskId":"ut-ac4af59e6485b0994dff","runId":"a2ad00fd-f4b5-4e12-b7a0-8e572722e75f","scheduleId":"sch-4a620f87baa5757eb327","occurrenceId":"occ-ed2821c84b6f56b68234","occurrenceKey":"2026-10-03T03:00:00Z","scheduledFor":1790996400000,"attempts":1,"state":"admitted","reason":"submitted","taskCreated":true,"gtdId":null,"controlRegistration":"not_requested"}
{"event":"schedule.tick.finished","reason":"completed","now":1790996400000,"profileId":"profile-1","dueSchedules":1,"admitted":1,"recovered":0,"deduplicated":0,"skipped":0,"failed":0,"misfires":1,"errors":0}
```

## C. Жизнь задачи occurrence (`GET /status?taskId=ut-9277c462c86175510046`)

```
status=done  stage=finished  generation=1  awaiting_input_id=null
result={"ok":true,"mode":"auto","version":"m1-conversation-v2","goal":"local smoke hourly"}

396 task_accepted      payload: contractVersion=1, origin=schedule, scheduleId=sch-4a62…, occurrenceId=occ-6012…, occurrenceKey=2026-10-03T02:00:00Z
397 run_started        payload: runId=233052ed…, engine=cloudflare-workflows
398 step_done  prepare  payload: version=m1-conversation-v2
399 step_done  execute  payload: mode=auto, version=m1-conversation-v2
400 task_status_changed  finalize  payload: mode=auto, version=m1-conversation-v2, gtdId=null, controlRegistration=not_requested
401 run_finished      payload: runId=233052ed…, outcome=success
runs: [('233052ed', 'success')]
```

Читается без интерпретаций: у задачи расписания **нет** `awaiting_opened` (человека не спрашивали),
нет сигналов, в `result_json` **нет ключа `gtdId`**, а `schedule_occurrences.gtd_id = NULL`.
Простой cron не начинает control loop: шаги `prepare → execute → finalize`, терминальный результат сразу.

## D. Управляемый сбой: crash replay и ошибки запусков (`tests/p22-schedule.test.ts`, виртуальные часы)

### D.1 Крэш после claim, до submit + недвинутый курсор расписания

Сценарий: submitter падает на первом вызове (`occurrence` уже записан в БД), затем курсор
`schedules.next_due_at` возвращается на тот же момент — как если бы процесс умер до его сдвига.

```json
{"event":"schedule.tick.started","reason":"scan","now":1773136800000,"profileId":"profile-p22-replay"}
{"event":"schedule.occurrence.failed","level":"error","profileId":"profile-p22-replay","userTaskId":"ut-73935cb745e05cc5511e","scheduleId":"sch-bf48cec17e01413b97be","occurrenceId":"occ-9772f878f900097a338c","occurrenceKey":"2026-03-10T10:00:00Z","attempts":1,"maxAdmitAttempts":5,"reason":"submit_failed","error":"injected crash: control plane умер между claim и submit"}
{"event":"schedule.tick.finished","reason":"completed","now":1773136800000,"profileId":"profile-p22-replay","dueSchedules":1,"admitted":0,"recovered":0,"deduplicated":0,"skipped":0,"failed":1,"misfires":0,"errors":0}
```

Следующий проход на том же моменте (`1773136800000` = 2026-03-10T10:00:00Z):

```json
{"event":"schedule.occurrence.admitted","profileId":"profile-p22-replay","userTaskId":"ut-73935cb745e05cc5511e","runId":"b38dee6f-4c05-47f4-8d77-7611c82a90ff","scheduleId":"sch-bf48cec17e01413b97be","occurrenceId":"occ-9772f878f900097a338c","occurrenceKey":"2026-03-10T10:00:00Z","attempts":2,"state":"admitted","reason":"recovered_after_crash","taskCreated":true,"gtdId":null,"controlRegistration":"not_requested"}
{"event":"schedule.occurrence.deduplicated","profileId":"profile-p22-replay","scheduleId":"sch-bf48cec17e01413b97be","occurrenceId":"occ-9772f878f900097a338c","occurrenceKey":"2026-03-10T10:00:00Z","state":"admitted","reason":"occurrence_key_exists"}
{"event":"schedule.tick.finished","reason":"completed","now":1773136800000,"profileId":"profile-p22-replay","dueSchedules":1,"admitted":0,"recovered":1,"deduplicated":1,"skipped":0,"failed":0,"misfires":0,"errors":0}
```

Тот же `occurrenceId`, та же задача `ut-73935cb745e05cc5511e`, одна строка occurrence, одна попытка исполнения:
replay не создал второго срабатывания (AC-140). Третий проход на том же моменте — пустой
(`dueSchedules: 0, admitted: 0, deduplicated: 0`).

### D.2 Ошибка приёма видна и повторы ограничены (`maxAdmitAttempts = 2`)

```json
{"event":"schedule.occurrence.failed","level":"error","profileId":"profile-p22-logs","userTaskId":"ut-8a29d7a7069f8a2b0333","scheduleId":"sch-7682f3ce443f66e10152","occurrenceId":"occ-b5907cca33310c947e2e","occurrenceKey":"2026-03-10T10:00:00Z","attempts":2,"maxAdmitAttempts":2,"reason":"submit_failed","error":"injected: runner недоступен"}
{"event":"schedule.occurrence.failed","level":"error","profileId":"profile-p22-logs","userTaskId":"ut-8a29d7a7069f8a2b0333","scheduleId":"sch-7682f3ce443f66e10152","occurrenceId":"occ-b5907cca33310c947e2e","occurrenceKey":"2026-03-10T10:00:00Z","attempts":2,"maxAdmitAttempts":2,"reason":"admit_attempts_exhausted","state":"failed"}
```

После исчерпания лимита новых попыток приёма нет (тест фиксирует, что submitter не вызывается):
бесконечного retry не возникает, а причина видна в логах с `profileId`/`scheduleId`/`occurrenceKey`.

## E. Соответствие приёмке

| Пункт приёмки | Доказательство |
|---|---|
| AC-140 · disable расписания ≠ отмена принятой задачи | A/14.2, B (`schedule.disabled … acceptedTasksCancelled: 0`), C (`status=done`, нет `cancel_requested`/`task_cancelled`), тест 3 |
| AC-140 · crash replay не создаёт второй occurrence | D.1 (тот же `occurrenceId`, `recovered=1` + `deduplicated=1`), тест 2 |
| AC-140 · ошибки запусков видны | D.2 (`schedule.occurrence.failed … reason`), тест 7 |
| AC-141 · простой cron не создаёт GTD events, `gtdId` отсутствует | C (`result` без `gtdId`, `awaiting_input_id=null`), A/14 (`gtd_id = None`), B (`gtdId: null, controlRegistration: not_requested`), тесты 1 и 8 |
| SANDBOX · I07 · logs | occurrence dedup, gtdId только opt-in, wait/deadline/ACK — вне скоупа P22 (это P23/этап I07 GTD-пилот) |
| Перенесённая проверка «Disable Schedule не путается с cancel текущего Run» | тест 3 + A/14.2: cancel вызывается только `/cancel`, disable не трогает ни occurrence, ни задачу |

## F. Что сознательно вне этой карточки

* **GTD opt-in и control loop** (P23): регистрация на контроль, ожидания/deadline/ACK, лимиты прогрессии.
  Здесь `gtd_id` — всегда `NULL`, это проверяемое «отсутствует», а не «ещё не придумали где хранить».
* **Настоящий Runner для задач расписания**: occurrence исполняется `autoRun`-веткой плана в песочнице;
  подключение реального Runner'а (M1.3/#122) — тот же контракт `submit/result`, отдельная карточка.
* **Пилот/rollback для расписаний** (эпик M1, шаг 8): расписание выполняется на новом plane; решение о
  когорте расписаний при rollback — владельца, здесь не заводится.
* **Часовой триггер в проде**: модуль даёт идемпотентный `tick(now)`; кто и как вызывает его по расписанию
  (Cloudflare Cron Trigger и т.п.) — решение владельца, в песочнице тик вызывается явно.
