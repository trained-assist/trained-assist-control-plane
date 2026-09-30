# trained-assist-control-plane

Trained Assist control plane: Task Store, Workflow Port, Input/Router/Output/GTD/Journal/Reporting

Статус: создан 30.09.2026, кода пока нет.

## Что здесь будет

Один репозиторий на модули над общим Task Store: Input, Router, Output, GTD, Journal, Reporting API; Workflow Port и его адаптеры (стартовая точка — пилот pilots/p-db/cf-workflows).

## Откуда берётся работа

- Границы и ownership: [ARCHITECTURE §9](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md#9-репозитории-и-ownership).
- Порядок и карточки с приёмкой: [план реализации и интеграции](https://github.com/trained-assist/trained-agent-architecture/blob/main/IMPLEMENTATION-AND-INTEGRATION-PLAN.md) — первый интеграционный slice (новый control plane + Web, P10/P12), затем расписание P22.
- Правила разработки и песочниц: [Engineering Approach](https://github.com/trained-assist/trained-agent-architecture/blob/main/ENGINEERING-APPROACH.md), [Sandbox Plan](https://github.com/trained-assist/trained-agent-architecture/blob/main/SANDBOX-PLAN.md).

Живой сервис этим репозиторием не меняется: реализация идёт параллельно, в собственных sandbox-развёртываниях.

## Контекст репозитория

CI `Repository context` на каждый PR и main собирает карту [REPO-MAP.md](https://github.com/trained-assist/trained-assist-control-plane/blob/repo-context/REPO-MAP.md) и сжатый пакет (I00/Z03).
