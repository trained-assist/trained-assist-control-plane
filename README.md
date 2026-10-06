# trained-assist-control-plane

Durable control plane Trained Assist: Task Store на D1 и Workflow Port на Cloudflare Workflows. Каналы принимают запросы; CP хранит задачу, ownership, маршрут, waits, результат и доставку. Engine execution происходит через Runner API, а не внутри Worker.

Документы содержат действующие требования, контракты и инструкции. Планы выполнения, статусы, ревью прошлых версий и evidence ведутся в GitHub issues/PR/Project. Целевая модель не является утверждением о текущем deployment; его готовность проверяется по конкретным SHA и приёмке.

## Границы и код

| Компонент | Источник |
|---|---|
| Task Store, transitions/fencing | `migrations/`, `src/taskstore/` |
| Intake и durable receipt | `src/intake/` |
| Router/catalog/brief | `src/router/`, [communication contract](docs/COMMUNICATION-V1.md) |
| Workflow Port и доставка | `src/workflow-port/` |
| Awaiting user input | `src/awaiting/`, [credential boundary](docs/CREDENTIAL-READY-V1.md) |
| Расписание и GTD | `src/schedule/`, `src/gtd/`; GTD opt-in, без recursive control |
| Host profile policy | [PROFILE-RUNTIME-POLICY](docs/PROFILE-RUNTIME-POLICY.md) |
| Public HTTP composition | `src/index.ts` |
| Sandbox web slice | `web/` |

## Обязательства

- Task Store — источник истины. Ранний signal не теряется; повторы дедуплицируются; stale generation отвергается.
- Admission receipt отделена от engine start и terminal result. Unknown launch/result сверяется без повторного запуска.
- Engine, workspace publication и channel delivery имеют независимые outcomes и retry budgets.
- Binding/credentials/tool eligibility выдаёт host. Пользовательский input и worker callback не удостоверяют profile/repository.
- Awaiting user input хранится durably и не держит агента живым. Form/choice submission продолжает конкретную задачу.
- Новая версия workflow сохраняет совместимость ожидающих экземпляров. Rollback не повторяет принятые внешние мутации.

## Локальная проверка

Node >=22 согласно package.json. Используйте отдельные local/test D1, Workflows и principals.

```bash
npm ci
npm run typecheck
npm test
npm run check
npm run db:migrate:local
npm run dev
```

`tools/local-smoke.sh` и локальные/operator документы описывают конкретные сценарии. Fixture, source-only verifier и cloud acceptance не взаимозаменяемы. Проверка не разрешает менять production bindings или webhook.

## Навигация

Архитектура: [центральная модель](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md), [Task Store schema](https://github.com/trained-assist/trained-agent-architecture/blob/main/TASK-STORE-SCHEMA-V1.md), [conversation contract](https://github.com/trained-assist/trained-agent-architecture/blob/main/CONVERSATIONAL-SESSION-CONTRACT.md).

Операционные границы: [cohort/rollback](docs/ROLLOUT-COHORT-FLAG-OWNER-ROLLBACK.md), [late-result reconcile](docs/RUNNER-LATE-RESULT-RECONCILIATION.md), [watchdog](docs/WATCHDOG-ACCEPTANCE-RUNBOOK.md). Датированные transcripts — evidence конкретного сценария, не текущий статус deployment.

Статус интеграции — [#140](https://github.com/trained-assist/trained-agent-architecture/issues/140); зависимости — [центральный документ](https://github.com/trained-assist/trained-agent-architecture/blob/main/IMPLEMENTATION-AND-INTEGRATION-PLAN.md); карточки — [Project](https://github.com/orgs/trained-assist/projects/1). Счётчики тестов и readiness здесь не дублируются.

CI Repository context публикует [REPO-MAP](https://github.com/trained-assist/trained-assist-control-plane/blob/repo-context/REPO-MAP.md); сверяйте sourceSha и открывайте исходники перед изменениями.

Retiring GCP VM is not a development or fallback target. Use the own Agent Run API and serverless by default; a necessary persistent service belongs on the existing French VM. Other Google services remain allowed. Exit coordination: https://github.com/trained-assist/trained-agent-architecture/issues/145.
