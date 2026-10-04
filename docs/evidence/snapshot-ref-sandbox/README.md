# Snapshot/input ref через публичный Task API — первый сквозной прогон (issue #52 шаг 1)

Транскрипт прогона `snap-e2e.mjs` на песочной связке: локальный инстанс control plane
на задеплоенном коммите `8eace71` (#28) → VM2 Runner (`3516fa3`, PR #69) → настоящий
OpenCode через llm-ladder (`ladder/free`).

**14/14 проверок пройдено.**

| | |
|---|---|
| Хост | VM2, Runner `vm2-final-cp23-r9`, `sourceCommit 3516fa3d065e27145994f6899c862af9ca944954` |
| Движок | `opencode`, provider `ladder`, `OPENCODE_LADDER_TOKEN`, rung `free` (бесплатный) |
| Обвязка CP | `RUN_SPEC_ENV_ALLOWLIST=OPENCODE_LADDER_TOKEN`, `RUN_SPEC_OUTPUTS=[{"path":"result.md"}]` |
| Модель | платный профиль не объявлен, `paid.allowed=false` |

## Что доказано

| строка приёмки | результат |
|---|---|
| разрешённый snapshot ref доезжает от клиента до Runner | `intake inputItems[].snapshotId` → `user_value.snapshotIds` → `input.refs[].snapshotId` → `POST /v1/runs` |
| ра�� A экспортирует выход, снимок — указатель на его байты | `result.md` 7 Б, `sha256 3c0690f0…`; `snapshot-file … action=link` → `artifacts=1`; `action=commit` |
| следующий ра�� получает байты в свой workspace | `inputs_materialized status=materialized files=1 bytes=7` |
| движок реально прочитал содержимое из снимка | в журнале рана B есть `SEED-42` — строка, которую записал только ра�� A |
| несуществующий снимок → отказ **до** spawn | `MATERIALIZE_REF_INVALID … does not exist`, `exitReason=preflight_refused`, движок не запускался |
| дубль приёма → та же задача | `duplicate=true`, тот же `userTaskId` |
| оба рана дошли до `done` | A и B — `done`, `persistence: persisted` |

## Что пришлось добавить в control plane

`InputRef` знал только `ref` и `version`, поэтому снимок нельзя было объявить
в задаче: Runner#69 принимает `snapshotId`, а CP его не умел передать. Добавлено
поле `snapshotId` — сквозной путь `envelope → user_value → attachmentRefsOf → RunSpecInput.refs → input.refs`.
Валидация та же, что у Runner: `[A-Za-z0-9][A-Za-z0-9._:-]*`, длина ≤ 200.

## Границы

- Снимок коммитится **до** того, как становится входом: `active` → `MATERIALIZE_REF_INVALID`
  («only a committed snapshot is a released pointer to durable bytes»). Пустой снимок
  (без `action=link`) отклоняется как «carries no materialized artifacts».
- Материализованный вход ложится в `.inputs/<snapshotId>/`, а не в корень workspace.
  Поэтому файл с тем же именем, что и объявленный выход, **не** закрывает выход:
  экспорт ищет его в корне. Это граница, а не дефект.
- Проба идёт через локальный инстанс CP, потому что `PRINCIPAL_SECRET` развёрнутого
  воркера недоступен с этой машины; связка CP→Runner и Runner→OpenCode — настоящие.
- `RUN_SPEC_OUTPUTS` — политика хоста на все раны: отсутствующий объявленный выход
  даёт `export_not_persisted` и задача `failed`.

```bash
sha256sum -c transcript.sha256
```