# P16 · sanitized transcript песочницы Task Router

Карточка [trained-agent-architecture#55](https://github.com/trained-assist/trained-agent-architecture/issues/55), этап I05 ([SANDBOX](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md#i05--первый-fast-path)).

Прогон воспроизводится одной командой в изолированной песочнице (отдельная D1, отдельный порт,
отдельный принципал и сгенерированный на прогон секрет подписи, без сети и внешних сервисов):

```bash
./tools/p16-sandbox-probe.sh
```

## Изоляция прогона

| Что | Значение |
|---|---|
| Состояние D1 | `<sandbox-state>` — отдельный каталог `_scratch/p16-sandbox/state`, не общий dev-стенд |
| Принципал | `sandbox-cp16` / `profile-cp16`, scopes только приёма и чтения |
| Секрет подписи | сгенерирован на прогон, лежит в `.dev.vars` (gitignored, chmod 600), в evidence не попадает |
| Сеть и внешние сервисы | не используются; исполнитель не запускается — есть только заявка OpenCode |
| Фиксированные часы | `ROUTER_CLOCK=1793388600000` → 2026-09-30T23:10:00+03:00 (детерминированные даты) |

## Что проверялось

| # | Проба | Что видит пользователь | Сигнал в журнале |
|---|---|---|---|
| 1 | PR-23 · ссылка в цитате | быстрый ответ по тексту; страница не открывается | `route=llm`, `agentDispatchAttempts=0`, `agentStarted=false`, `run_started` = 0 |
| 2 | PR-21 · вопрос о живых данных | «передаю исполнителю»; числа нет | `route=agent`, `executor=opencode`, `replyAllowed=false`, `run_started` = 0 |
| 3 | AC-126 · права | право не выводится из текста запроса | `PERMISSION_DENIED`, `needsExecutor=false`, `permissionSource=identity_snapshot`, `run_started` = 0 |
| 4 | управляемый сбой recipe | честная причина, а не «ответ» | `outcome=technical_error`, `schemaOutcome=refused`, `escalationAttempt=false`, `run_started` = 0 |

### Измеренные `run_started` в журнале задач

Считается прямо в D1 песочницы после каждой пробы (`SELECT COUNT(*) … WHERE kind='run_started'`).
Ноль означает: ни одна проба не дошла до запуска попытки исполнения.

| Проба | userTaskId | run_started |
|---|---|---|
| pr23_quoted | ut-61feafcd5133c7a91342 | 0 |
| pr21_live | ut-f091f870048ae4fd3482 | 0 |
| permission | ut-9a083d957d467f658814 | 0 |
| fault_refused | ut-ad2aa70ead5088492c67 | 0 |

## Решения маршрута (журнал worker'а, санитизировано)

| userTaskId | route | mode | reasonCode | outcome | needsExecutor | escalationAttempt | permissionSource |
|---|---|---|---|---|---|---|---|
| ut-61feafcd5133c7a91342 | llm | llm-recipe-job | TEXT_WORK_ON_GIVEN_CONTENT | reply | false | false | identity_snapshot |
| ut-f091f870048ae4fd3482 | agent | ai-agent-job | LIVE_DATA_NO_CAPABILITY | escalated | true | false | identity_snapshot |
| ut-9a083d957d467f658814 | template | template-handler | PERMISSION_DENIED | blocked | false | false | identity_snapshot |
| ut-ad2aa70ead5088492c67 | llm | llm-recipe-job | MODEL_REFUSED | technical_error | false | false | identity_snapshot |

## Ответы проб

В песочнице recipe — заглушка без модели (`ROUTER_RECIPE_STUB`), поэтому её ответ эхом повторяет
входной текст. В **журнал** маршрута текст запроса не пишется: там только идентификаторы,
признаки и причины (проверяется тестом `tests/p16-probe-pr21-live-data.test.ts`).

### pr21.json

```json
{
 "route": "agent",
 "mode": "ai-agent-job",
 "reasonCode": "LIVE_DATA_NO_CAPABILITY",
 "outcome": "escalated",
 "needsExecutor": true,
 "executor": "opencode",
 "replyAllowed": false,
 "capabilityId": null,
 "coverage": "full",
 "schemaOutcome": "not_run",
 "semanticOutcome": "valid",
 "modelCalls": 0,
 "execution": {
  "capabilityExecutions": 0,
  "agentDispatchAttempts": 1,
  "recipeCalls": 0,
  "modelCalls": 0
 },
 "workOrder": {
  "executor": "opencode",
  "originalRequestRef": "task:ut-f091f870048ae4fd3482:request:req-live-1791077295792112000",
  "requiresConfirmation": false
 },
 "reply": null,
 "evidence": {
  "typedCommand": null,
  "matchedCapabilityId": null,
  "matchedAlias": null,
  "urlHosts": [],
  "urlQuoted": false,
  "urlReadIntent": false,
  "embeddedInstructionIgnored": false,
  "intents": [
   "freshness"
  ],
  "permissionSource": "identity_snapshot",
  "authorizationRef": "authz-fb2fabaca7e32bc4",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-f091f870048ae4fd3482:capabilities-v1"
 }
}
```

### pr23.json

```json
{
 "route": "llm",
 "mode": "llm-recipe-job",
 "reasonCode": "TEXT_WORK_ON_GIVEN_CONTENT",
 "outcome": "reply",
 "needsExecutor": false,
 "executor": null,
 "replyAllowed": true,
 "capabilityId": null,
 "coverage": "full",
 "schemaOutcome": "valid",
 "semanticOutcome": "valid",
 "modelCalls": 1,
 "execution": {
  "capabilityExecutions": 0,
  "agentDispatchAttempts": 0,
  "recipeCalls": 1,
  "modelCalls": 1
 },
 "workOrder": null,
 "reply": {
  "text": "[песочница: recipe-заглушка без модели] Черновик по вашему тексту (109 симв.): «Коллега пишет: «см. https://example.com/pricing — там всё дорого». Как вежливо ответить, что посмотрим позже?»"
 },
 "evidence": {
  "typedCommand": null,
  "matchedCapabilityId": null,
  "matchedAlias": null,
  "urlHosts": [
   "example.com"
  ],
  "urlQuoted": true,
  "urlReadIntent": false,
  "embeddedInstructionIgnored": false,
  "intents": [
   "text_work",
   "quoted_text",
   "url_quoted"
  ],
  "permissionSource": "identity_snapshot",
  "authorizationRef": "authz-fb2fabaca7e32bc4",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-61feafcd5133c7a91342:capabilities-v1"
 }
}
```

### permission.json

```json
{
 "route": "template",
 "mode": "template-handler",
 "reasonCode": "PERMISSION_DENIED",
 "outcome": "blocked",
 "needsExecutor": false,
 "executor": null,
 "replyAllowed": false,
 "capabilityId": "google-drive.read",
 "coverage": "full",
 "schemaOutcome": "not_run",
 "semanticOutcome": "valid",
 "modelCalls": 0,
 "execution": {
  "capabilityExecutions": 0,
  "agentDispatchAttempts": 0,
  "recipeCalls": 0,
  "modelCalls": 0
 },
 "workOrder": null,
 "reply": null,
 "evidence": {
  "typedCommand": null,
  "matchedCapabilityId": "google-drive.read",
  "matchedAlias": "таблицу",
  "urlHosts": [],
  "urlQuoted": false,
  "urlReadIntent": false,
  "embeddedInstructionIgnored": false,
  "intents": [
   "read_intent",
   "text_work"
  ],
  "permissionSource": "identity_snapshot",
  "authorizationRef": "authz-fb2fabaca7e32bc4",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-9a083d957d467f658814:capabilities-v1"
 }
}
```

### fault-refused.json

```json
{
 "route": "llm",
 "mode": "llm-recipe-job",
 "reasonCode": "MODEL_REFUSED",
 "outcome": "technical_error",
 "needsExecutor": false,
 "executor": null,
 "replyAllowed": false,
 "capabilityId": null,
 "coverage": "full",
 "schemaOutcome": "refused",
 "semanticOutcome": "not_evaluated",
 "modelCalls": 1,
 "execution": {
  "capabilityExecutions": 0,
  "agentDispatchAttempts": 0,
  "recipeCalls": 1,
  "modelCalls": 1
 },
 "workOrder": null,
 "reply": null,
 "evidence": {
  "typedCommand": null,
  "matchedCapabilityId": null,
  "matchedAlias": null,
  "urlHosts": [],
  "urlQuoted": false,
  "urlReadIntent": false,
  "embeddedInstructionIgnored": false,
  "intents": [
   "text_work"
  ],
  "permissionSource": "identity_snapshot",
  "authorizationRef": "authz-fb2fabaca7e32bc4",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-ad2aa70ead5088492c67:capabilities-v1"
 }
}
```

## Проверка санитизации

Проверяются: значение PRINCIPAL_SECRET этого прогона, e-mail вне доменов RFC 2606, телефоны, абсолютные пути пользователя.

- sha256 санитизированных событий: `2266b4c97ec44a136cef393636816d5cfa7eb729f7d262f528f627af029bafc3`
- строк журнала маршрута в evidence: 4
- сборка из тех же сырых логов даёт тот же sha256: транскрипт воспроизводим;
- текст запроса в журнал не пишется — только идентификаторы, признаки и причины;
- негативные проверки санитизации (секрет, e-mail, домашний путь, телефон) выполняет `tools/p16-evidence-selfcheck.mjs`, он же гоняется в CI (`npm run check:evidence`).
