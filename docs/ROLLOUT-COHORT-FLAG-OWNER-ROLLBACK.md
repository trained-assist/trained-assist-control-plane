# Production routing, owner и rollback

Production CP сейчас направляет новые задачи всех профилей в новый control plane.
Это соответствует решению владельца убрать preview/pilot/router gates, чтобы видеть
ошибки на рабочем production endpoint. Runner API и workspace admission настраиваются
отдельно и не становятся готовыми от переключения этих CP flags.

Собрано после приёмки own-API dogfood (api client): сквозной прогон CP → VM Runner →
настоящий OpenCode через llm-ladder, snapshot ref, два одновременных OpenCode на
разных слотах, cleanup, чтение после переподключения без второго рана.

## 1. Production values

Механизм реализован в `src/pilot/`; production values находятся в
`wrangler.production.jsonc`.

| Переменная | Production |
|---|---|---|
| `PREVIEW_ONLY` | `false` |
| `PILOT_ENABLED` | `true` |
| `PILOT_ACTIVATED_AT` | `2026-10-12T00:00:00.000Z` |
| `PILOT_COHORT_PROFILE_IDS` | unset — all profiles |
| `PILOT_LEGACY_PROFILE_IDS` | unset |
| `ROUTER_AGENT_ALLOWED` | `true` |

Маршрутизатор выбирает `new-plane` для новой задачи после `PILOT_ACTIVATED_AT`,
если профиль не добавлен в `PILOT_LEGACY_PROFILE_IDS`. До времени активации ранее
принятые задачи остаются на legacy owner. Пустой или отсутствующий cohort не
ограничивает список профилей.

## 2. Один execution/delivery owner

Требование: у каждой задачи ровно один владелец исполнения и ровно один владелец
доставки. Пилот делает это конструктивно — задача либо уходит в новый plane, либо
остаётся legacy, третьего маршрута нет.

| Слой | Владелец | Что именно |
|---|---|---|
| Execution (запуск и финализация) | **control plane нового plane** для `pilotRoute=new-plane`; **legacy owner** для `legacy` | выбор делает `PilotRouter` при приёме, маршрут пишется в `user_value.pilotRoute` и не пересматривается |
| Delivery (доставка ответа) | **тот же владелец, что и execution** | отправка не дублируется: второй owner не создаётся |

`ownerGeneration` в fencing отвечает за «не более одной попытки исполнения»: поздний
результат старого поколения отклоняется. Потеря связи — `unknown`, а не `failed`, и
автоматического второго Run не происходит: повтор с тем же ключом попытки возвращает
тот же Run.

## 3. Процедура rollback

Откат — одно изменение: `PILOT_ENABLED=false` (или снятие переменной) и рестарт
control plane. Runner при этом **не трогается** и продолжает обслуживать уже
созданные раны.

Что происходит после отката:

- все **новые** задачи → `legacy` (Workflow instance не создаётся);
- задачи, уже идущие на новом plane, **не теряются** — они в durable Task Store (D1),
  их доводит `/recover` или `/resume`;
- повтор приёма с тем же `requestId` возвращает прежнюю квитанцию (`duplicate=true`) —
  второй задачи не создаётся;
- события, результаты и артефакты рана читаются и после отката — они в durable store
  Runner'а и в D1.

Откат **не** откатывает данные: он только перестаёт направлять новые задачи.

## 4. Current downstream boundary

The CP flags above are enabled. Production Runner API health and source revision are
verified by the CP release workflow. The Runner API still needs a production key
registry, paired CP API/delegation credentials, France worker credentials, a stable
launch-encryption key, and the intended repository allowlist before it can admit a
user run. Until that pairing is provisioned, CP can expose the Runner configuration
error directly; it must not route around Runner API to a VM or GHA worker.
