# M1 Пилот и Rollback — Runbook

## Область применения

Sandbox / локальная среда. Продюшн VM и RU VM **не трогаются**. Все команды выполняются на `vm2` (ssh vm2).

## Архитектура пилота

Механизм маршрутизации реализован как конфиг-гейт (`src/pilot/`):

- **`PilotConfig`** — feature flag (`PILOT_ENABLED`) + временная метка активации (`PILOT_ACTIVATED_AT`) + списки cohort (`PILOT_COHORT_PROFILE_IDS`, `PILOT_LEGACY_PROFILE_IDS`).
- **`PilotRouter`** — принимает решение при приёме задачи, логирует структурированно, сохраняет маршрут в `user_value.pilotRoute`.
- **`CfWorkflowPort.submit()`** — проверяет `pilotRoute` перед созданием экземпляра Workflow: `legacy` → не создаёт, `new-plane` → создаёт.

### Правила маршрутизации (приоритет сверху вниз)

1. Пилот выключен → `legacy`.
2. `profileId` в `PILOT_LEGACY_PROFILE_IDS` → `legacy`.
3. `PILOT_COHORT_PROFILE_IDS` задан и `profileId` не в списке → `legacy`.
4. Задача создана **до** `PILOT_ACTIVATED_AT` → `legacy`.
5. Иначе → `new-plane`.

**Ключевое свойство**: cohort — только для **новых** задач. Существующие задачи (созданные до включения пилота) продолжают выполняться legacy owner'ом. Ни одна живая задача не переезжает.

## Переменные окружения

| Переменная | Описание | Пример |
|---|---|---|
| `PILOT_ENABLED` | Включить пилот | `true` / `false` |
| `PILOT_ACTIVATED_AT` | ISO-8601 timestamp включения | `2026-10-02T12:00:00Z` |
| `PILOT_COHORT_PROFILE_IDS` | ProfileId для cohort (comma-separated) | `profile-pilot` |
| `PILOT_LEGACY_PROFILE_IDS` | ProfileId, всегда legacy (comma-separated) | `profile-legacy` |

Все значения — только из окружения. Ничего не записывается в репозиторий.

## Включение пилота (включение маршрутизации новых задач на новый plane)

```bash
# На vm2 (sandbox)
ssh vm2
export PILOT_ENABLED=true
export PILOT_ACTIVATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export PILOT_COHORT_PROFILE_IDS=profile-pilot

# Запуск control plane (локально, песочница)
wrangler dev
```

**Проверка**: новая задача от `profile-pilot` → `pilotRoute=new-plane` (Workflow instance создан). Старая задача от `profile-other` → `pilotRoute=legacy` (без Workflow instance).

## Отключение пилота (rollback)

```bash
# На vm2
unset PILOT_ENABLED
# или
export PILOT_ENABLED=false
```

**Что происходит**:
- Все новые задачи → `legacy` (без Workflow instance).
- Задачи, уже запущенные на новом plane, **не теряются** — они живут в durable Task Store (D1). После rollback их можно довести через `/recover` или `/resume`.
- Повтор приёма с тем же `requestId` возвращает прежнюю квитанцию (идемпотентность C01) — дублей не создаётся.

## Проверяемый прогон (checklist)

### 1. Включение пилота

```bash
# Включить пилот
export PILOT_ENABLED=true
export PILOT_ACTIVATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Новая задача → new-plane
curl -X POST http://localhost:8787/intake \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"pilot-new-1","profileId":"profile-pilot","inputItems":[{"text":"hello"}]}'
# Ожидается: pilotRoute=new-plane, durable=true

# Старая задача (profileId не в cohort) → legacy
curl -X POST http://localhost:8787/intake \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"pilot-old-1","profileId":"profile-other","inputItems":[{"text":"hello"}]}'
# Ожидается: pilotRoute=legacy
```

### 2. Rollback

```bash
# Отключить пилот
unset PILOT_ENABLED

# Новая задача → legacy (даже если создана после activation)
curl -X POST http://localhost:8787/intake \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"pilot-after-rollback","profileId":"profile-pilot","inputItems":[{"text":"hello"}]}'
# Ожидается: pilotRoute=legacy, reason=pilot_disabled
```

### 3. Идемпотентность / отсутствие дублей

```bash
# Повтор с тем же requestId после rollback → та же задача, duplicate=true
curl -X POST http://localhost:8787/intake \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"pilot-after-rollback","profileId":"profile-pilot","inputItems":[{"text":"hello"}]}'
# Ожидается: duplicate=true, тот же userTaskId
```

### 4. Управляемый сбой (controlled failure)

```bash
# Включить пилот
export PILOT_ENABLED=true
export PILOT_ACTIVATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Создать задачу на новом plane
curl -X POST http://localhost:8787/intake \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"cf-new-1","profileId":"profile-pilot","inputItems":[{"text":"test"}]}'

# Имитировать падение нового plane (остановить wrangler dev)
# Ctrl+C в терминале wrangler

# Отключить пилот (rollback)
unset PILOT_ENABLED

# Новая задача → legacy (без дубля, без потери состояния)
curl -X POST http://localhost:8787/intake \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"cf-after-failure","profileId":"profile-pilot","inputItems":[{"text":"test"}]}'
# Ожидается: pilotRoute=legacy, duplicate=false

# Проверить что первая задача (cf-new-1) всё ещё в Task Store
curl http://localhost:8787/status?taskId=ut-...
```

## Логи

Каждое решение маршрутизации логируется структурированно (JSON, `console.log`):

```json
{
  "ts": "2026-10-02T12:00:00.000Z",
  "service": "trained-assist-control-plane",
  "environment": "sandbox",
  "event": "pilot.route_decision",
  "level": "info",
  "profileId": "profile-pilot",
  "userTaskId": "ut-abc123",
  "requestId": "req-xyz",
  "pilotRoute": "new-plane",
  "pilotReason": "pilot_active_cohort_match",
  "pilotEnabled": true,
  "pilotActivatedAt": 1759416000000
}
```

Ключи событий:
- `pilot.route_decision` — решение о маршрутизации при приёме задачи
- `pilot.route_legacy` — workflow port пропустил задачу на legacy
- `pilot.config_updated` — изменение конфига (rollback)
- `pilot.config_invalid` — ошибка валидации конфига

Все логи содержат `profileId`, `userTaskId`, `requestId`, `pilotRoute`, `pilotReason`. Секретов и личных данных в логах нет.

## Доказательства (evidence)

Для отчёта в #109:

1. **Логи прогона** — вывод `npm test` (тесты `pilot-rollback.test.ts`).
2. **Логи управляемого сбоя** — вывод curl-команд из раздела "Проверяемый прогон".
3. **Номер PR** — ссылка на PR в `trained-assist-control-plane`.
4. **Отсутствие дублей** — проверка `duplicate=true` при повторе после rollback.
5. **Сохранение состояния** — проверка что задачи на новом plane не теряются после rollback (Task Store durable).

## Сводка сценариев

| Сценарий | Ожидаемый результат |
|---|---|
| Пилот включён, новая задача в cohort | `new-plane`, Workflow instance создан |
| Пилот включён, задача не в cohort | `legacy`, без Workflow instance |
| Пилот включён, задача создана до activation | `legacy`, без Workflow instance |
| Пилот выключен (rollback) | `legacy` для всех новых задач |
| Повтор с тем же requestId после rollback | `duplicate=true`, тот же userTaskId |
| Падение нового plane + rollback | Новые задачи идут на legacy, старые на новом plane сохранены в D1 |
| Два параллельных приёма одного requestId | Одна задача, одна квитанция |