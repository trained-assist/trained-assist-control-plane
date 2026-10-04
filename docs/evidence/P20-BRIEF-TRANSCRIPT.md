# P20 · sanitized transcript песочницы Brief builder

Карточка [trained-agent-architecture#59](https://github.com/trained-assist/trained-agent-architecture/issues/59), этап I06 ([SANDBOX](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX.md#i06--capability-catalog)).

Прогон воспроизводится одной командой в изолированной песочнице (отдельная D1, отдельный порт,
отдельный принципал и сгенерированный на прогон секрет подписи, без сети и внешних сервисов):

```bash
./tools/p20-brief-probe.sh
```

## Изоляция прогона

| Что | Значение |
|---|---|
| Состояние D1 | отдельный каталог `_scratch/p20-sandbox/state`, не общий dev-стенд |
| Принципал | `sandbox-cp20` / `profile-cp20`, scopes только приёма и чтения |
| Секрет подписи | сгенерирован на прогон, лежит в `.dev.vars` (gitignored, chmod 600), в evidence не попадает |
| Сеть и внешние сервисы | не используются; исполнитель не запускается — есть только заявка OpenCode |
| Фиксированные часы | `ROUTER_CLOCK=1793388600000` → 2026-09-30T23:10:00+03:00 (детерминированные даты) |

## Что проверялось

| # | Проба | Что видно в ответе и журнале |
|---|---|---|
| 1 | brief собран | `routing.brief`: briefId, ключ кэша, попадание, байты, Tier-1/Tier-2, бюджет |
| 2 | кэш по области | тот же профиль/контекст → `cacheHit=true`; тот же ключ, пересборки нет |
| 3a | права не выдуманы | неподключённая интеграция → `availability=not_connected`, `executable=false` |
| 3b | права не выдуманы | подключено, но нет обязательного входа → `input_missing` |
| 4 | бюджет размера | `ROUTER_BRIEF_MAX_BYTES` мал → деградация Tier-2, `withinBudget=true` |
| 5 | управляемый сбой | минимальный Tier-1 не влезает → `BRIEF_BUDGET_EXCEEDED`, модель не звалась |
| 6 | сбой модели | `refused` → `technical_error`, исполнитель не включается |

## Пробы (ответы POST /route)

```json
[
 {
  "probe": "brief.json",
  "decisionId": "ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1",
  "route": "llm",
  "mode": "llm-recipe-job",
  "reasonCode": "TEXT_WORK_ON_GIVEN_CONTENT",
  "outcome": "reply",
  "needsExecutor": false,
  "executor": null,
  "escalationAttempt": false,
  "modelCalls": 1,
  "execution": {
   "capabilityExecutions": 0,
   "agentDispatchAttempts": 0,
   "recipeCalls": 1,
   "modelCalls": 1
  },
  "coverage": "full",
  "schemaOutcome": "valid",
  "semanticOutcome": "valid",
  "permissionSource": "identity_snapshot",
  "authorizationRef": "authz-a980ad427db93cf5",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-2b6c09e178e380b15230:capabilities-v1",
  "brief": {
   "status": "ok",
   "briefId": "2832e0774654cfb15927883ffad255ed1c3ce7aecee3f3b26bb212f0b6ce64b9",
   "tier1": 12,
   "tier2": 10,
   "candidates": 10,
   "omittedByBudget": 0,
   "excludedByScope": 0,
   "degraded": false,
   "bytes": 13866,
   "budget": {
    "maxBytes": 24576,
    "measuredBytes": 13866,
    "withinBudget": true
   },
   "cache": {
    "key": "brief-6d9793bf913e4a968b1f4819",
    "hit": false,
    "stored": true
   }
  }
 },
 {
  "probe": "budget.json",
  "decisionId": "ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1",
  "route": "llm",
  "mode": "llm-recipe-job",
  "reasonCode": "TEXT_WORK_ON_GIVEN_CONTENT",
  "outcome": "reply",
  "needsExecutor": false,
  "executor": null,
  "escalationAttempt": false,
  "modelCalls": 1,
  "execution": {
   "capabilityExecutions": 0,
   "agentDispatchAttempts": 0,
   "recipeCalls": 1,
   "modelCalls": 1
  },
  "coverage": "full",
  "schemaOutcome": "valid",
  "semanticOutcome": "valid",
  "permissionSource": "identity_snapshot",
  "authorizationRef": "authz-a980ad427db93cf5",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-2b6c09e178e380b15230:capabilities-v1",
  "brief": {
   "status": "ok",
   "briefId": "074260eadc1764e7edb0cb768ea7e1249e4f8565d38dc91223e30b7691f43961",
   "tier1": 12,
   "tier2": 2,
   "candidates": 2,
   "omittedByBudget": 8,
   "excludedByScope": 0,
   "degraded": true,
   "bytes": 5680,
   "budget": {
    "maxBytes": 6000,
    "measuredBytes": 5680,
    "withinBudget": true
   },
   "cache": {
    "key": "brief-6d9793bf913e4a968b1f4819",
    "hit": false,
    "stored": true
   }
  }
 },
 {
  "probe": "over-budget.json",
  "decisionId": "ut-35b5f50717aebc416d12:req-over-1791083405696259000:capabilities-v1",
  "route": "llm",
  "mode": "llm-recipe-job",
  "reasonCode": "BRIEF_BUDGET_EXCEEDED",
  "outcome": "technical_error",
  "needsExecutor": false,
  "executor": null,
  "escalationAttempt": false,
  "modelCalls": 0,
  "execution": {
   "capabilityExecutions": 0,
   "agentDispatchAttempts": 0,
   "recipeCalls": 0,
   "modelCalls": 0
  },
  "coverage": "full",
  "schemaOutcome": "valid",
  "semanticOutcome": "not_evaluated",
  "permissionSource": "identity_snapshot",
  "authorizationRef": "authz-a980ad427db93cf5",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-35b5f50717aebc416d12:capabilities-v1",
  "brief": {
   "status": "over_budget",
   "briefId": "e0ed7a20474ed7287ae3307e24a549b7f285a7f67a60708dfca3cba21245bdcf",
   "tier1": 12,
   "tier2": 0,
   "candidates": 10,
   "omittedByBudget": 0,
   "excludedByScope": 0,
   "degraded": true,
   "bytes": 4969,
   "budget": {
    "maxBytes": 32,
    "measuredBytes": 4969,
    "withinBudget": false
   },
   "cache": {
    "key": "brief-0b1adda9748018046faa815e",
    "hit": false,
    "stored": false
   }
  }
 },
 {
  "probe": "fault-refused.json",
  "decisionId": "ut-6e9e58bce69f046ee7bb:req-fault-1791083407684093000:capabilities-v1",
  "route": "llm",
  "mode": "llm-recipe-job",
  "reasonCode": "MODEL_REFUSED",
  "outcome": "technical_error",
  "needsExecutor": false,
  "executor": null,
  "escalationAttempt": false,
  "modelCalls": 1,
  "execution": {
   "capabilityExecutions": 0,
   "agentDispatchAttempts": 0,
   "recipeCalls": 1,
   "modelCalls": 1
  },
  "coverage": "full",
  "schemaOutcome": "refused",
  "semanticOutcome": "not_evaluated",
  "permissionSource": "identity_snapshot",
  "authorizationRef": "authz-a980ad427db93cf5",
  "catalogVersion": "capabilities-v1",
  "contextVersion": "ctx:ut-6e9e58bce69f046ee7bb:capabilities-v1",
  "brief": {
   "status": "ok",
   "briefId": "2832e0774654cfb15927883ffad255ed1c3ce7aecee3f3b26bb212f0b6ce64b9",
   "tier1": 12,
   "tier2": 10,
   "candidates": 10,
   "omittedByBudget": 0,
   "excludedByScope": 0,
   "degraded": false,
   "bytes": 13866,
   "budget": {
    "maxBytes": 24576,
    "measuredBytes": 13866,
    "withinBudget": true
   },
   "cache": {
    "key": "brief-516a311ad9247d295893eb70",
    "hit": false,
    "stored": true
   }
  }
 }
]
```

## События журнала

Только события маршрута и briefа. Проверяются: значение PRINCIPAL_SECRET этого прогона, e-mail вне доменов RFC 2606, телефоны, абсолютные пути пользователя.

```jsonl
{"ts":"2026-10-04T03:10:04.580Z","service":"trained-assist-control-plane","environment":"sandbox","event":"routing.brief","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","reason":null,"briefId":"074260eadc1764e7edb0cb768ea7e1249e4f8565d38dc91223e30b7691f43961","briefKey":"brief-6d9793bf913e4a968b1f4819","cacheHit":false,"cacheStored":true,"purpose":"reply-or-route","catalogVersion":"capabilities-v1","catalogDigest":"324db572fb37afa02d897837502db4bef08dd269f7857336ce8e34d908c520e0","tier1Entries":12,"candidates":2,"tier2Entries":2,"omittedByBudget":8,"excludedByScope":0,"degraded":true,"gaps":["integration_not_connected:google-drive","integration_not_connected:google-drive","missing_input_schema:service.help","missing_input_schema:service.status","missing_input_schema:service.stop","missing_input_schema:tasks.list_active","missing_input_schema:tasks.last","missing_input_schema:tasks.by_day","missing_input_schema:catalog.brief","missing_input_schema:policy.model_facts"],"bytes":5680,"budgetMaxBytes":6000,"budgetWithin":true,"measurements":["full:13866","tier1-only:9685","tier1-minimal:4969","tier1-minimal+tier2:10:9332","tier1-minimal+tier2:9:8910","tier1-minimal+tier2:8:8499","tier1-minimal+tier2:7:7901","tier1-minimal+tier2:6:7369","tier1-minimal+tier2:5:6948","tier1-minimal+tier2:4:6521","tier1-minimal+tier2:3:6092","tier1-minimal+tier2:2:5680"]}
{"ts":"2026-10-04T03:10:04.582Z","service":"trained-assist-control-plane","environment":"sandbox","event":"routing.decision","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","reason":"TEXT_WORK_ON_GIVEN_CONTENT","route":"llm","mode":"llm-recipe-job","reasonCode":"TEXT_WORK_ON_GIVEN_CONTENT","needsExecutor":false,"executor":null,"escalation":"none","escalationAttempt":false,"capabilityId":null,"capabilityVersion":null,"replyAllowed":true,"requiresFreshData":false,"requiresExternalAction":false,"coverage":"full","schemaOutcome":"valid","semanticOutcome":"valid","modelCalls":1,"latencyMs":8,"firstUsefulReplyMs":8,"outcome":"reply","capabilityExecutions":0,"repairAttempts":0,"policyVersion":"route-policy-v1-2026-10-04","intents":["text_work"],"matchedAlias":null,"urlHosts":[],"urlQuoted":false,"urlReadIntent":false,"embeddedInstructionIgnored":false,"permissionSource":"identity_snapshot","authorizationRef":"authz-a980ad427db93cf5","catalogVersion":"capabilities-v1","contextVersion":"ctx:ut-2b6c09e178e380b15230:capabilities-v1","level":"info","source":"http-route"}
{"ts":"2026-10-04T03:10:04.582Z","service":"trained-assist-control-plane","environment":"sandbox","event":"route.dispatched","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","reason":"TEXT_WORK_ON_GIVEN_CONTENT","route":"llm","agentDispatchAttempts":0,"agentStarted":false,"workOrderIssued":false,"continuationRequested":false,"permissionSource":"identity_snapshot","authorizationRef":"authz-a980ad427db93cf5"}
{"ts":"2026-10-04T03:10:07.736Z","service":"trained-assist-control-plane","environment":"sandbox","event":"intake.accepted","profileId":"profile-cp20","userTaskId":"ut-6e9e58bce69f046ee7bb","requestId":"req-fault-1791083407684093000","receiptId":"3753729b-2879-4dcb-bb27-51947c5dad98","reason":"accepted"}
{"ts":"2026-10-04T03:10:07.780Z","service":"trained-assist-control-plane","environment":"sandbox","event":"routing.brief","profileId":"profile-cp20","userTaskId":"ut-6e9e58bce69f046ee7bb","runId":null,"requestId":"req-fault-1791083407684093000","decisionId":"ut-6e9e58bce69f046ee7bb:req-fault-1791083407684093000:capabilities-v1","reason":null,"briefId":"2832e0774654cfb15927883ffad255ed1c3ce7aecee3f3b26bb212f0b6ce64b9","briefKey":"brief-516a311ad9247d295893eb70","cacheHit":false,"cacheStored":true,"purpose":"reply-or-route","catalogVersion":"capabilities-v1","catalogDigest":"324db572fb37afa02d897837502db4bef08dd269f7857336ce8e34d908c520e0","tier1Entries":12,"candidates":10,"tier2Entries":10,"omittedByBudget":0,"excludedByScope":0,"degraded":false,"gaps":["integration_not_connected:google-drive","integration_not_connected:google-drive","missing_input_schema:service.help","missing_input_schema:service.status","missing_input_schema:service.stop","missing_input_schema:tasks.list_active","missing_input_schema:tasks.last","missing_input_schema:tasks.by_day","missing_input_schema:catalog.brief","missing_input_schema:policy.model_facts"],"bytes":13866,"budgetMaxBytes":24576,"budgetWithin":true,"measurements":["full:13866"]}
{"ts":"2026-10-04T03:10:07.780Z","service":"trained-assist-control-plane","environment":"sandbox","event":"routing.decision","decisionId":"ut-6e9e58bce69f046ee7bb:req-fault-1791083407684093000:capabilities-v1","profileId":"profile-cp20","userTaskId":"ut-6e9e58bce69f046ee7bb","runId":null,"requestId":"req-fault-1791083407684093000","reason":"MODEL_REFUSED","route":"llm","mode":"llm-recipe-job","reasonCode":"MODEL_REFUSED","needsExecutor":false,"executor":null,"escalation":"none","escalationAttempt":false,"capabilityId":null,"capabilityVersion":null,"replyAllowed":false,"requiresFreshData":false,"requiresExternalAction":false,"coverage":"full","schemaOutcome":"refused","semanticOutcome":"not_evaluated","modelCalls":1,"latencyMs":8,"firstUsefulReplyMs":null,"outcome":"technical_error","capabilityExecutions":0,"repairAttempts":0,"policyVersion":"route-policy-v1-2026-10-04","intents":["text_work"],"matchedAlias":null,"urlHosts":[],"urlQuoted":false,"urlReadIntent":false,"embeddedInstructionIgnored":false,"permissionSource":"identity_snapshot","authorizationRef":"authz-a980ad427db93cf5","catalogVersion":"capabilities-v1","contextVersion":"ctx:ut-6e9e58bce69f046ee7bb:capabilities-v1","level":"warn","source":"http-route"}
{"ts":"2026-10-04T03:10:07.780Z","service":"trained-assist-control-plane","environment":"sandbox","event":"routing.technical_error","level":"warn","profileId":"profile-cp20","userTaskId":"ut-6e9e58bce69f046ee7bb","runId":null,"decisionId":"ut-6e9e58bce69f046ee7bb:req-fault-1791083407684093000:capabilities-v1","reason":"MODEL_REFUSED","escalationAttempt":false,"code":"MODEL_REFUSED"}
{"ts":"2026-10-04T03:10:07.780Z","service":"trained-assist-control-plane","environment":"sandbox","event":"route.dispatched","profileId":"profile-cp20","userTaskId":"ut-6e9e58bce69f046ee7bb","runId":null,"requestId":"req-fault-1791083407684093000","decisionId":"ut-6e9e58bce69f046ee7bb:req-fault-1791083407684093000:capabilities-v1","reason":"MODEL_REFUSED","route":"llm","agentDispatchAttempts":0,"agentStarted":false,"workOrderIssued":false,"continuationRequested":false,"permissionSource":"identity_snapshot","authorizationRef":"authz-a980ad427db93cf5"}
{"ts":"2026-10-04T03:10:05.756Z","service":"trained-assist-control-plane","environment":"sandbox","event":"intake.accepted","profileId":"profile-cp20","userTaskId":"ut-35b5f50717aebc416d12","requestId":"req-over-1791083405696259000","receiptId":"9ba4a096-c071-4390-acfd-2571c9e1aa58","reason":"accepted"}
{"ts":"2026-10-04T03:10:05.800Z","service":"trained-assist-control-plane","environment":"sandbox","event":"routing.brief","profileId":"profile-cp20","userTaskId":"ut-35b5f50717aebc416d12","runId":null,"requestId":"req-over-1791083405696259000","decisionId":"ut-35b5f50717aebc416d12:req-over-1791083405696259000:capabilities-v1","reason":"over_budget","briefId":"e0ed7a20474ed7287ae3307e24a549b7f285a7f67a60708dfca3cba21245bdcf","briefKey":"brief-0b1adda9748018046faa815e","cacheHit":false,"cacheStored":false,"purpose":"reply-or-route","catalogVersion":"capabilities-v1","catalogDigest":"324db572fb37afa02d897837502db4bef08dd269f7857336ce8e34d908c520e0","tier1Entries":12,"candidates":10,"tier2Entries":0,"omittedByBudget":0,"excludedByScope":0,"degraded":true,"gaps":["integration_not_connected:google-drive","integration_not_connected:google-drive","missing_input_schema:service.help","missing_input_schema:service.status","missing_input_schema:service.stop","missing_input_schema:tasks.list_active","missing_input_schema:tasks.last","missing_input_schema:tasks.by_day","missing_input_schema:catalog.brief","missing_input_schema:policy.model_facts"],"bytes":4969,"budgetMaxBytes":32,"budgetWithin":false,"measurements":["full:13866","tier1-only:9685","tier1-minimal:4969"]}
{"ts":"2026-10-04T03:10:05.800Z","service":"trained-assist-control-plane","environment":"sandbox","event":"route.dispatched","profileId":"profile-cp20","userTaskId":"ut-35b5f50717aebc416d12","runId":null,"requestId":"req-over-1791083405696259000","decisionId":"ut-35b5f50717aebc416d12:req-over-1791083405696259000:capabilities-v1","reason":"BRIEF_BUDGET_EXCEEDED","route":"llm","agentDispatchAttempts":0,"agentStarted":false,"workOrderIssued":false,"continuationRequested":false,"permissionSource":"identity_snapshot","authorizationRef":"authz-a980ad427db93cf5"}
{"ts":"2026-10-04T03:10:02.327Z","service":"trained-assist-control-plane","environment":"sandbox","event":"routing.brief","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","reason":null,"briefId":"a6af7d7e1b9da647ad79a60134d84c7cdcde3120b06051d93e8908a9288f5008","briefKey":"brief-0c97b9ed3af9f009ab60b0e1","cacheHit":false,"cacheStored":true,"purpose":"reply-or-route","catalogVersion":"capabilities-v1","catalogDigest":"324db572fb37afa02d897837502db4bef08dd269f7857336ce8e34d908c520e0","tier1Entries":12,"candidates":11,"tier2Entries":11,"omittedByBudget":0,"excludedByScope":0,"degraded":false,"gaps":["missing_profile_fields:email","missing_input_schema:service.help","missing_input_schema:service.status","missing_input_schema:service.stop","missing_input_schema:tasks.list_active","missing_input_schema:tasks.last","missing_input_schema:tasks.by_day","missing_input_schema:catalog.brief","missing_input_schema:policy.model_facts"],"bytes":14316,"budgetMaxBytes":24576,"budgetWithin":true,"measurements":["full:14316"]}
{"ts":"2026-10-04T03:10:02.328Z","service":"trained-assist-control-plane","environment":"sandbox","event":"routing.decision","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","reason":"TEXT_WORK_ON_GIVEN_CONTENT","route":"llm","mode":"llm-recipe-job","reasonCode":"TEXT_WORK_ON_GIVEN_CONTENT","needsExecutor":false,"executor":null,"escalation":"none","escalationAttempt":false,"capabilityId":null,"capabilityVersion":null,"replyAllowed":true,"requiresFreshData":false,"requiresExternalAction":false,"coverage":"full","schemaOutcome":"valid","semanticOutcome":"valid","modelCalls":1,"latencyMs":8,"firstUsefulReplyMs":8,"outcome":"reply","capabilityExecutions":0,"repairAttempts":0,"policyVersion":"route-policy-v1-2026-10-04","intents":["text_work"],"matchedAlias":null,"urlHosts":[],"urlQuoted":false,"urlReadIntent":false,"embeddedInstructionIgnored":false,"permissionSource":"identity_snapshot","authorizationRef":"authz-a980ad427db93cf5","catalogVersion":"capabilities-v1","contextVersion":"ctx:ut-2b6c09e178e380b15230:capabilities-v1","level":"info","source":"http-route"}
{"ts":"2026-10-04T03:10:02.328Z","service":"trained-assist-control-plane","environment":"sandbox","event":"route.dispatched","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","reason":"TEXT_WORK_ON_GIVEN_CONTENT","route":"llm","agentDispatchAttempts":0,"agentStarted":false,"workOrderIssued":false,"continuationRequested":false,"permissionSource":"identity_snapshot","authorizationRef":"authz-a980ad427db93cf5"}
{"ts":"2026-10-04T03:10:01.005Z","service":"trained-assist-control-plane","environment":"sandbox","event":"intake.accepted","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","requestId":"req-brief-1791083400932335000","receiptId":"cca44c53-3fa1-4be4-90c2-7139b3f4ccf5","reason":"accepted"}
{"ts":"2026-10-04T03:10:01.054Z","service":"trained-assist-control-plane","environment":"sandbox","event":"routing.brief","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","reason":null,"briefId":"2832e0774654cfb15927883ffad255ed1c3ce7aecee3f3b26bb212f0b6ce64b9","briefKey":"brief-6d9793bf913e4a968b1f4819","cacheHit":false,"cacheStored":true,"purpose":"reply-or-route","catalogVersion":"capabilities-v1","catalogDigest":"324db572fb37afa02d897837502db4bef08dd269f7857336ce8e34d908c520e0","tier1Entries":12,"candidates":10,"tier2Entries":10,"omittedByBudget":0,"excludedByScope":0,"degraded":false,"gaps":["integration_not_connected:google-drive","integration_not_connected:google-drive","missing_input_schema:service.help","missing_input_schema:service.status","missing_input_schema:service.stop","missing_input_schema:tasks.list_active","missing_input_schema:tasks.last","missing_input_schema:tasks.by_day","missing_input_schema:catalog.brief","missing_input_schema:policy.model_facts"],"bytes":13866,"budgetMaxBytes":24576,"budgetWithin":true,"measurements":["full:13866"]}
{"ts":"2026-10-04T03:10:01.054Z","service":"trained-assist-control-plane","environment":"sandbox","event":"routing.decision","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","reason":"TEXT_WORK_ON_GIVEN_CONTENT","route":"llm","mode":"llm-recipe-job","reasonCode":"TEXT_WORK_ON_GIVEN_CONTENT","needsExecutor":false,"executor":null,"escalation":"none","escalationAttempt":false,"capabilityId":null,"capabilityVersion":null,"replyAllowed":true,"requiresFreshData":false,"requiresExternalAction":false,"coverage":"full","schemaOutcome":"valid","semanticOutcome":"valid","modelCalls":1,"latencyMs":12,"firstUsefulReplyMs":12,"outcome":"reply","capabilityExecutions":0,"repairAttempts":0,"policyVersion":"route-policy-v1-2026-10-04","intents":["text_work"],"matchedAlias":null,"urlHosts":[],"urlQuoted":false,"urlReadIntent":false,"embeddedInstructionIgnored":false,"permissionSource":"identity_snapshot","authorizationRef":"authz-a980ad427db93cf5","catalogVersion":"capabilities-v1","contextVersion":"ctx:ut-2b6c09e178e380b15230:capabilities-v1","level":"info","source":"http-route"}
{"ts":"2026-10-04T03:10:01.054Z","service":"trained-assist-control-plane","environment":"sandbox","event":"route.dispatched","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","reason":"TEXT_WORK_ON_GIVEN_CONTENT","route":"llm","agentDispatchAttempts":0,"agentStarted":false,"workOrderIssued":false,"continuationRequested":false,"permissionSource":"identity_snapshot","authorizationRef":"authz-a980ad427db93cf5"}
{"ts":"2026-10-04T03:10:01.141Z","service":"trained-assist-control-plane","environment":"sandbox","event":"routing.brief","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","reason":null,"briefId":"2832e0774654cfb15927883ffad255ed1c3ce7aecee3f3b26bb212f0b6ce64b9","briefKey":"brief-6d9793bf913e4a968b1f4819","cacheHit":true,"cacheStored":false,"purpose":"reply-or-route","catalogVersion":"capabilities-v1","catalogDigest":"324db572fb37afa02d897837502db4bef08dd269f7857336ce8e34d908c520e0","tier1Entries":12,"candidates":10,"tier2Entries":10,"omittedByBudget":0,"excludedByScope":0,"degraded":false,"gaps":["integration_not_connected:google-drive","integration_not_connected:google-drive","missing_input_schema:service.help","missing_input_schema:service.status","missing_input_schema:service.stop","missing_input_schema:tasks.list_active","missing_input_schema:tasks.last","missing_input_schema:tasks.by_day","missing_input_schema:catalog.brief","missing_input_schema:policy.model_facts"],"bytes":13866,"budgetMaxBytes":24576,"budgetWithin":true,"measurements":["full:13866"]}
{"ts":"2026-10-04T03:10:01.142Z","service":"trained-assist-control-plane","environment":"sandbox","event":"routing.decision","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","reason":"TEXT_WORK_ON_GIVEN_CONTENT","route":"llm","mode":"llm-recipe-job","reasonCode":"TEXT_WORK_ON_GIVEN_CONTENT","needsExecutor":false,"executor":null,"escalation":"none","escalationAttempt":false,"capabilityId":null,"capabilityVersion":null,"replyAllowed":true,"requiresFreshData":false,"requiresExternalAction":false,"coverage":"full","schemaOutcome":"valid","semanticOutcome":"valid","modelCalls":1,"latencyMs":0,"firstUsefulReplyMs":0,"outcome":"reply","capabilityExecutions":0,"repairAttempts":0,"policyVersion":"route-policy-v1-2026-10-04","intents":["text_work"],"matchedAlias":null,"urlHosts":[],"urlQuoted":false,"urlReadIntent":false,"embeddedInstructionIgnored":false,"permissionSource":"identity_snapshot","authorizationRef":"authz-a980ad427db93cf5","catalogVersion":"capabilities-v1","contextVersion":"ctx:ut-2b6c09e178e380b15230:capabilities-v1","level":"info","source":"http-route"}
{"ts":"2026-10-04T03:10:01.142Z","service":"trained-assist-control-plane","environment":"sandbox","event":"route.dispatched","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","reason":"TEXT_WORK_ON_GIVEN_CONTENT","route":"llm","agentDispatchAttempts":0,"agentStarted":false,"workOrderIssued":false,"continuationRequested":false,"permissionSource":"identity_snapshot","authorizationRef":"authz-a980ad427db93cf5"}
{"ts":"2026-10-04T03:10:01.205Z","service":"trained-assist-control-plane","environment":"sandbox","event":"routing.brief","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","reason":null,"briefId":"2832e0774654cfb15927883ffad255ed1c3ce7aecee3f3b26bb212f0b6ce64b9","briefKey":"brief-6d9793bf913e4a968b1f4819","cacheHit":true,"cacheStored":false,"purpose":"reply-or-route","catalogVersion":"capabilities-v1","catalogDigest":"324db572fb37afa02d897837502db4bef08dd269f7857336ce8e34d908c520e0","tier1Entries":12,"candidates":10,"tier2Entries":10,"omittedByBudget":0,"excludedByScope":0,"degraded":false,"gaps":["integration_not_connected:google-drive","integration_not_connected:google-drive","missing_input_schema:service.help","missing_input_schema:service.status","missing_input_schema:service.stop","missing_input_schema:tasks.list_active","missing_input_schema:tasks.last","missing_input_schema:tasks.by_day","missing_input_schema:catalog.brief","missing_input_schema:policy.model_facts"],"bytes":13866,"budgetMaxBytes":24576,"budgetWithin":true,"measurements":["full:13866"]}
{"ts":"2026-10-04T03:10:01.206Z","service":"trained-assist-control-plane","environment":"sandbox","event":"routing.decision","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","reason":"TEXT_WORK_ON_GIVEN_CONTENT","route":"llm","mode":"llm-recipe-job","reasonCode":"TEXT_WORK_ON_GIVEN_CONTENT","needsExecutor":false,"executor":null,"escalation":"none","escalationAttempt":false,"capabilityId":null,"capabilityVersion":null,"replyAllowed":true,"requiresFreshData":false,"requiresExternalAction":false,"coverage":"full","schemaOutcome":"valid","semanticOutcome":"valid","modelCalls":1,"latencyMs":0,"firstUsefulReplyMs":0,"outcome":"reply","capabilityExecutions":0,"repairAttempts":0,"policyVersion":"route-policy-v1-2026-10-04","intents":["text_work"],"matchedAlias":null,"urlHosts":[],"urlQuoted":false,"urlReadIntent":false,"embeddedInstructionIgnored":false,"permissionSource":"identity_snapshot","authorizationRef":"authz-a980ad427db93cf5","catalogVersion":"capabilities-v1","contextVersion":"ctx:ut-2b6c09e178e380b15230:capabilities-v1","level":"info","source":"http-route"}
{"ts":"2026-10-04T03:10:01.206Z","service":"trained-assist-control-plane","environment":"sandbox","event":"route.dispatched","profileId":"profile-cp20","userTaskId":"ut-2b6c09e178e380b15230","runId":null,"requestId":"req-brief-1791083400932335000","decisionId":"ut-2b6c09e178e380b15230:req-brief-1791083400932335000:capabilities-v1","reason":"TEXT_WORK_ON_GIVEN_CONTENT","route":"llm","agentDispatchAttempts":0,"agentStarted":false,"workOrderIssued":false,"continuationRequested":false,"permissionSource":"identity_snapshot","authorizationRef":"authz-a980ad427db93cf5"}
```

## Измерения

Размер briefа считается в байтах UTF-8 (TextEncoder), а не в «токенах»: одинаковый вход
даёт одинаковый `briefId`, а превышение бюджета видно по шагам измерения
(`full` → `tier1-only` → `tier1-minimal` → `tier1-minimal+tier2:N`).
