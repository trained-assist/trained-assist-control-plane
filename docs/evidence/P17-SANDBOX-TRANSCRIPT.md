# P17 · sanitized transcript песочницы bounded reply-or-route

Карточка [trained-agent-architecture#56](https://github.com/trained-assist/trained-agent-architecture/issues/56), этап I05 ([SANDBOX](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md#i05--первый-fast-path)).

Прогон воспроизводится одной командой в изолированной песочнице (отдельная D1, отдельный порт,
отдельный принципал и сгенерированный на прогон секрет подписи, без сети и внешних сервисов):

```bash
./tools/p17-sandbox-probe.sh
```

## Изоляция прогона

| Что | Значение |
|---|---|
| Состояние D1 | `<sandbox-state>` — отдельный каталог `_scratch/p17-sandbox/state`, не общий dev-стенд |
| Принципал | `sandbox-cp17` / `profile-cp17`, scopes только приёма и чтения |
| Секрет подписи | сгенерирован на прогон, лежит в `.dev.vars` (gitignored, chmod 600), в evidence не попадает |
| Модель | скриптованная, без сети и без ключа: проверяются контракт решения, границы и исходы, а не качество живой модели (§11.7.5/§11.7.6) |
| Исполнитель | не запускается ни одной пробой, кроме явной пробы продолжения, — и только по `continue: true` при включённой политике |
| Фиксированные часы | `ROUTER_CLOCK=1793388600000` → 2026-09-30T23:10:00+03:00 |

## Что проверялось (AC-128)

| # | Проба | Что видит пользователь | Что измерено |
|---|---|---|---|
| 1 | готовый reply | быстрый ответ, исполнитель не включается | `outcome=reply`, `recipeId=reply-or-route-v1`, `modelId=sandbox-scripted-fixed-model`, `modelCalls=1`, попыток 0 |
| 2 | clarify | один вопрос, без агента | `outcome=clarify`, `askUser` задан, `reply=null`, попыток 0 |
| 3 | needs_executor | заявка OpenCode, запуск не происходит | `outcome=escalated`, `executor=opencode`, `workOrder.executor=opencode`, `workOrder.goal` = исходный запрос, `jobRef` отсутствует, попыток 0 |
| 4 | schema invalid | один ремонт формы, затем честный технический исход | `outcome=technical_error`, `schemaOutcome=invalid`, `reasonCode=SCHEMA_INVALID`, `modelCalls=2`, `repairAttempts=1`, попыток 0 |
| 5 | model timeout | честная причина, без эскалации | `outcome=technical_error`, `schemaOutcome=timeout`, `reasonCode=MODEL_TIMEOUT`, попыток 0 |
| 6 | budget denied | модель не зовётся вовсе | `outcome=blocked`, `schemaOutcome=budget_denied`, `reasonCode=BUDGET_DENIED`, `modelCalls=0`, попыток 0 |
| 7 | provider failure | код провайдера в решении | `outcome=technical_error`, `schemaOutcome=provider_failure`, `reasonCode=PROVIDER_FAILURE`, `providerCode=server_error`, попыток 0 |
| 8 | awaiting input | типизированное ожидание по известному хосту полю | `outcome=required_input`, `reasonCode=MISSING_REQUIRED_INPUT`, `missingFields=[email]`, попыток 0 |
| 9 | insufficient context | ответ не публикуется и не эскалируется | `outcome=insufficient_context`, `reasonCode=CONTEXT_NOT_SUFFICIENT`, `semanticOutcome=coverage_pending`, попыток 0 |
| 10 | политика выключена | запрошено, но не выдано | `continuation.requested=true`, `issued=false`, `refusal=continuation_policy_disabled`, попыток 0 |
| 11 | one continuation owner | Output выдаёт новый job/run при том же userTaskId | `continuation.owner=output`, `issued=true`, `executor=opencode`, `generation` поднято, попыток 1 |
| 12 | идемпотентность продолжения | тот же decisionId — та же работа | `refusal=already_continued` с теми же `jobRef`/`runId`, попыток 1 |
| 13 | без `continue: true` | продолжение не запрашивается и не выдаётся | `continuation.requested=false`, попыток 0 |

### Измеренные попытки исполнения

Считаются прямо в D1 песочницы после каждой пробы: `SELECT COUNT(*) FROM executions WHERE task_id=…`.
Считаются ПОПЫТКИ (строки `executions` со своим `runId`), а не события `run_started`: это событие
пишется и на старте попытки, и на отправке в Runner, поэтому по нему число попыток не восстановить.
Ноль означает: проба не дошла до запуска попытки исполнения. Единица только у пробы продолжения — её выдаёт Output.

| Проба | userTaskId | попыток |
|---|---|---|
| reply | ut-95ed87e6f4245589c771 | 0 |
| clarify | ut-04eb999fd038f423f90f | 0 |
| needs_executor | ut-326591c82c83078b60c1 | 0 |
| schema_invalid | ut-85c48426421f95d97228 | 0 |
| timeout | ut-ee564e7e9eb3d073cb83 | 0 |
| budget_denied | ut-e3f76218b59f343abc6d | 0 |
| provider_failure | ut-1f4bda461a987b89f0ee | 0 |
| awaiting_input | ut-79c8ed53d01e766491e4 | 0 |
| insufficient_context | ut-ec3a05a59904d8709907 | 0 |
| continuation_policy_disabled | ut-b1beca3487e70b2ba4f9 | 0 |
| continuation_issued | ut-5034b8f8099da4dde2c7 | 1 |
| continuation_idempotent | ut-5034b8f8099da4dde2c7 | 1 |
| continuation_not_requested | ut-c8efe8139c015ba175ff | 0 |

Корроборация на песочном Runner'е **VM2** (read-only, ssh): ран для пробных задач — **0** при 246 ранах всего в песочнице.

## Решения маршрута (журнал worker'а, санитизировано)

| userTaskId | route | mode | reasonCode | outcome | schemaOutcome | semanticOutcome | modelCalls | repairAttempts | needsExecutor | executor | escalationAttempt |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ut-95ed87e6f4245589c771 | llm | llm-recipe-job | TEXT_WORK_ON_GIVEN_CONTENT | reply | valid | valid | 1 | 0 | false | null | false |
| ut-85c48426421f95d97228 | llm | llm-recipe-job | SCHEMA_INVALID | technical_error | invalid | not_evaluated | 2 | 1 | false | null | false |
| ut-ee564e7e9eb3d073cb83 | llm | llm-recipe-job | MODEL_TIMEOUT | technical_error | timeout | not_evaluated | 1 | 0 | false | null | false |
| ut-e3f76218b59f343abc6d | llm | llm-recipe-job | BUDGET_DENIED | blocked | budget_denied | not_evaluated | 0 | 0 | false | null | false |
| ut-1f4bda461a987b89f0ee | llm | llm-recipe-job | PROVIDER_FAILURE | technical_error | provider_failure | not_evaluated | 1 | 0 | false | null | false |
| ut-79c8ed53d01e766491e4 | llm | llm-recipe-job | MISSING_REQUIRED_INPUT | required_input | valid | valid | 1 | 0 | false | null | false |
| ut-ec3a05a59904d8709907 | llm | llm-recipe-job | CONTEXT_NOT_SUFFICIENT | insufficient_context | valid | coverage_pending | 1 | 0 | false | null | false |
| ut-5034b8f8099da4dde2c7 | llm | llm-recipe-job | ADAPTIVE_TOOL_LOOP | escalated | valid | valid | 1 | 0 | true | opencode | false |
| ut-5034b8f8099da4dde2c7 | llm | llm-recipe-job | ADAPTIVE_TOOL_LOOP | escalated | valid | valid | 1 | 0 | true | opencode | false |
| ut-c8efe8139c015ba175ff | llm | llm-recipe-job | ADAPTIVE_TOOL_LOOP | escalated | valid | valid | 1 | 0 | true | opencode | false |

## Ответы проб

В журнал маршрута текст запроса не пишется: только идентификаторы, признаки и причины.
Модель песочницы скриптована, поэтому решения воспроизводимы и не зависят от провайдера.

### reply.json

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
  "text": "Короче: решили не торопиться."
 },
 "continuation": {
  "owner": "output",
  "requested": false,
  "issued": false,
  "refusal": null,
  "jobRef": null,
  "runId": null,
  "generation": null
 },
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
  "authorizationRef": "authz-711a5ef70ce2e35c",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-95ed87e6f4245589c771:capabilities-v1"
 }
}
```

### clarify.json

```json
{
 "route": "llm",
 "mode": "llm-recipe-job",
 "reasonCode": "AMBIGUOUS_WITHOUT_CONTEXT",
 "outcome": "clarify",
 "needsExecutor": false,
 "executor": null,
 "replyAllowed": false,
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
 "reply": null,
 "continuation": {
  "owner": "output",
  "requested": false,
  "issued": false,
  "refusal": null,
  "jobRef": null,
  "runId": null,
  "generation": null
 },
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
  "authorizationRef": "authz-711a5ef70ce2e35c",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-04eb999fd038f423f90f:capabilities-v1"
 }
}
```

### needs-executor.json

```json
{
 "route": "llm",
 "mode": "llm-recipe-job",
 "reasonCode": "ADAPTIVE_TOOL_LOOP",
 "outcome": "escalated",
 "needsExecutor": true,
 "executor": "opencode",
 "replyAllowed": false,
 "capabilityId": null,
 "coverage": "full",
 "schemaOutcome": "valid",
 "semanticOutcome": "valid",
 "modelCalls": 1,
 "execution": {
  "capabilityExecutions": 0,
  "agentDispatchAttempts": 1,
  "recipeCalls": 1,
  "modelCalls": 1
 },
 "workOrder": {
  "executor": "opencode",
  "originalRequestRef": "task:ut-326591c82c83078b60c1:request:req-перепиши короче: мы долго спорили о сроках и в итоге решили не торопиться-1791082520210140000",
  "requiresConfirmation": false
 },
 "reply": null,
 "continuation": {
  "owner": "output",
  "requested": false,
  "issued": false,
  "refusal": null,
  "jobRef": null,
  "runId": null,
  "generation": null
 },
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
  "authorizationRef": "authz-711a5ef70ce2e35c",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-326591c82c83078b60c1:capabilities-v1"
 }
}
```

### schema-invalid.json

```json
{
 "route": "llm",
 "mode": "llm-recipe-job",
 "reasonCode": "SCHEMA_INVALID",
 "outcome": "technical_error",
 "needsExecutor": false,
 "executor": null,
 "replyAllowed": false,
 "capabilityId": null,
 "coverage": "full",
 "schemaOutcome": "invalid",
 "semanticOutcome": "not_evaluated",
 "modelCalls": 2,
 "execution": {
  "capabilityExecutions": 0,
  "agentDispatchAttempts": 0,
  "recipeCalls": 1,
  "modelCalls": 2
 },
 "workOrder": null,
 "reply": null,
 "continuation": {
  "owner": "output",
  "requested": false,
  "issued": false,
  "refusal": null,
  "jobRef": null,
  "runId": null,
  "generation": null
 },
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
  "authorizationRef": "authz-711a5ef70ce2e35c",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-85c48426421f95d97228:capabilities-v1"
 }
}
```

### timeout.json

```json
{
 "route": "llm",
 "mode": "llm-recipe-job",
 "reasonCode": "MODEL_TIMEOUT",
 "outcome": "technical_error",
 "needsExecutor": false,
 "executor": null,
 "replyAllowed": false,
 "capabilityId": null,
 "coverage": "full",
 "schemaOutcome": "timeout",
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
 "continuation": {
  "owner": "output",
  "requested": false,
  "issued": false,
  "refusal": null,
  "jobRef": null,
  "runId": null,
  "generation": null
 },
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
  "authorizationRef": "authz-711a5ef70ce2e35c",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-ee564e7e9eb3d073cb83:capabilities-v1"
 }
}
```

### budget-denied.json

```json
{
 "route": "llm",
 "mode": "llm-recipe-job",
 "reasonCode": "BUDGET_DENIED",
 "outcome": "blocked",
 "needsExecutor": false,
 "executor": null,
 "replyAllowed": false,
 "capabilityId": null,
 "coverage": "full",
 "schemaOutcome": "budget_denied",
 "semanticOutcome": "not_evaluated",
 "modelCalls": 0,
 "execution": {
  "capabilityExecutions": 0,
  "agentDispatchAttempts": 0,
  "recipeCalls": 1,
  "modelCalls": 0
 },
 "workOrder": null,
 "reply": null,
 "continuation": {
  "owner": "output",
  "requested": false,
  "issued": false,
  "refusal": null,
  "jobRef": null,
  "runId": null,
  "generation": null
 },
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
  "authorizationRef": "authz-711a5ef70ce2e35c",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-e3f76218b59f343abc6d:capabilities-v1"
 }
}
```

### provider-failure.json

```json
{
 "route": "llm",
 "mode": "llm-recipe-job",
 "reasonCode": "PROVIDER_FAILURE",
 "outcome": "technical_error",
 "needsExecutor": false,
 "executor": null,
 "replyAllowed": false,
 "capabilityId": null,
 "coverage": "full",
 "schemaOutcome": "provider_failure",
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
 "continuation": {
  "owner": "output",
  "requested": false,
  "issued": false,
  "refusal": null,
  "jobRef": null,
  "runId": null,
  "generation": null
 },
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
  "authorizationRef": "authz-711a5ef70ce2e35c",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-1f4bda461a987b89f0ee:capabilities-v1"
 }
}
```

### awaiting-input.json

```json
{
 "route": "llm",
 "mode": "llm-recipe-job",
 "reasonCode": "MISSING_REQUIRED_INPUT",
 "outcome": "required_input",
 "needsExecutor": false,
 "executor": null,
 "replyAllowed": false,
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
 "reply": null,
 "continuation": {
  "owner": "output",
  "requested": false,
  "issued": false,
  "refusal": null,
  "jobRef": null,
  "runId": null,
  "generation": null
 },
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
  "authorizationRef": "authz-711a5ef70ce2e35c",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-79c8ed53d01e766491e4:capabilities-v1"
 }
}
```

### insufficient-context.json

```json
{
 "route": "llm",
 "mode": "llm-recipe-job",
 "reasonCode": "CONTEXT_NOT_SUFFICIENT",
 "outcome": "insufficient_context",
 "needsExecutor": false,
 "executor": null,
 "replyAllowed": false,
 "capabilityId": null,
 "coverage": "full",
 "schemaOutcome": "valid",
 "semanticOutcome": "coverage_pending",
 "modelCalls": 1,
 "execution": {
  "capabilityExecutions": 0,
  "agentDispatchAttempts": 0,
  "recipeCalls": 1,
  "modelCalls": 1
 },
 "workOrder": null,
 "reply": null,
 "continuation": {
  "owner": "output",
  "requested": false,
  "issued": false,
  "refusal": null,
  "jobRef": null,
  "runId": null,
  "generation": null
 },
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
  "authorizationRef": "authz-711a5ef70ce2e35c",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-ec3a05a59904d8709907:capabilities-v1"
 }
}
```

### continuation-policy-disabled.json

```json
{
 "route": "llm",
 "mode": "llm-recipe-job",
 "reasonCode": "ADAPTIVE_TOOL_LOOP",
 "outcome": "escalated",
 "needsExecutor": true,
 "executor": "opencode",
 "replyAllowed": false,
 "capabilityId": null,
 "coverage": "full",
 "schemaOutcome": "valid",
 "semanticOutcome": "valid",
 "modelCalls": 1,
 "execution": {
  "capabilityExecutions": 0,
  "agentDispatchAttempts": 1,
  "recipeCalls": 1,
  "modelCalls": 1
 },
 "workOrder": {
  "executor": "opencode",
  "originalRequestRef": "task:ut-b1beca3487e70b2ba4f9:request:req-перепиши короче: мы долго спорили о сроках и в итоге решили не торопиться-1791082535395382000",
  "requiresConfirmation": false
 },
 "reply": null,
 "continuation": {
  "owner": "output",
  "requested": true,
  "issued": false,
  "refusal": "continuation_policy_disabled",
  "jobRef": null,
  "runId": null,
  "generation": null
 },
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
  "authorizationRef": "authz-711a5ef70ce2e35c",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-b1beca3487e70b2ba4f9:capabilities-v1"
 }
}
```

### continuation-issued.json

```json
{
 "route": "llm",
 "mode": "llm-recipe-job",
 "reasonCode": "ADAPTIVE_TOOL_LOOP",
 "outcome": "escalated",
 "needsExecutor": true,
 "executor": "opencode",
 "replyAllowed": false,
 "capabilityId": null,
 "coverage": "full",
 "schemaOutcome": "valid",
 "semanticOutcome": "valid",
 "modelCalls": 1,
 "execution": {
  "capabilityExecutions": 0,
  "agentDispatchAttempts": 1,
  "recipeCalls": 1,
  "modelCalls": 1
 },
 "workOrder": {
  "executor": "opencode",
  "originalRequestRef": "task:ut-5034b8f8099da4dde2c7:request:req-перепиши короче: мы долго спорили о сроках и в итоге решили не торопиться-1791082537418531000",
  "requiresConfirmation": false
 },
 "reply": null,
 "continuation": {
  "owner": "output",
  "requested": true,
  "issued": true,
  "jobRef": "job_ut-5034b8f8099da4dde2c7_g2",
  "runId": "2739a459-f34b-45fb-a192-6b7ffb6fd714",
  "generation": 2,
  "executor": "opencode"
 },
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
  "authorizationRef": "authz-711a5ef70ce2e35c",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-5034b8f8099da4dde2c7:capabilities-v1"
 }
}
```

### continuation-idempotent.json

```json
{
 "route": "llm",
 "mode": "llm-recipe-job",
 "reasonCode": "ADAPTIVE_TOOL_LOOP",
 "outcome": "escalated",
 "needsExecutor": true,
 "executor": "opencode",
 "replyAllowed": false,
 "capabilityId": null,
 "coverage": "full",
 "schemaOutcome": "valid",
 "semanticOutcome": "valid",
 "modelCalls": 1,
 "execution": {
  "capabilityExecutions": 0,
  "agentDispatchAttempts": 1,
  "recipeCalls": 1,
  "modelCalls": 1
 },
 "workOrder": {
  "executor": "opencode",
  "originalRequestRef": "task:ut-5034b8f8099da4dde2c7:request:req-перепиши короче: мы долго спорили о сроках и в итоге решили не торопиться-1791082537418531000",
  "requiresConfirmation": false
 },
 "reply": null,
 "continuation": {
  "owner": "output",
  "requested": true,
  "issued": false,
  "refusal": "already_continued",
  "jobRef": "job_ut-5034b8f8099da4dde2c7_g2",
  "runId": "2739a459-f34b-45fb-a192-6b7ffb6fd714",
  "generation": 2
 },
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
  "authorizationRef": "authz-711a5ef70ce2e35c",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-5034b8f8099da4dde2c7:capabilities-v1"
 }
}
```

### continuation-not-requested.json

```json
{
 "route": "llm",
 "mode": "llm-recipe-job",
 "reasonCode": "ADAPTIVE_TOOL_LOOP",
 "outcome": "escalated",
 "needsExecutor": true,
 "executor": "opencode",
 "replyAllowed": false,
 "capabilityId": null,
 "coverage": "full",
 "schemaOutcome": "valid",
 "semanticOutcome": "valid",
 "modelCalls": 1,
 "execution": {
  "capabilityExecutions": 0,
  "agentDispatchAttempts": 1,
  "recipeCalls": 1,
  "modelCalls": 1
 },
 "workOrder": {
  "executor": "opencode",
  "originalRequestRef": "task:ut-c8efe8139c015ba175ff:request:req-перепиши короче: мы долго спорили о сроках и в итоге решили не торопиться-1791082539189234000",
  "requiresConfirmation": false
 },
 "reply": null,
 "continuation": {
  "owner": "output",
  "requested": false,
  "issued": false,
  "refusal": null,
  "jobRef": null,
  "runId": null,
  "generation": null
 },
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
  "authorizationRef": "authz-711a5ef70ce2e35c",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-c8efe8139c015ba175ff:capabilities-v1"
 }
}
```

## Проверка санитизации

Проверяются: значение PRINCIPAL_SECRET этого прогона, e-mail вне доменов RFC 2606, телефоны, абсолютные пути пользователя.

- sha256 санитизированных событий: `44761c3414ec0a0fe305726903cfe1e23df5df05bd7ecae8cdf1a4ce573a2f5a`
- строк журнала маршрута в evidence: 10
- сборка из тех же сырых логов даёт тот же sha256: транскрипт воспроизводим;
- текст запроса в журнал не пишется — только идентификаторы, признаки и причины;
- негативные проверки санитизации (секрет, e-mail, домашний путь, телефон) выполняет `tools/p16-evidence-selfcheck.mjs`, он же гоняется в CI (`npm run check:evidence`).
