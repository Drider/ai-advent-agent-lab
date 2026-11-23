> Статус: реализация и ручной прогон с реальной моделью завершены в текущей ветке `master`; отчёт сохранён в `docs/memory-conflicts-report-2026-11-22.md`.

# Устаревание и конфликты памяти

## Context

Сейчас память только пополняется: `save_memory` всегда вставляет новую строку
(`createWorkingMemoryRepository.create` / `createLongTermMemoryRepository.create`),
поэтому «срок 1 декабря» и «срок 15 декабря» живут рядом и оба уходят в промпт.
Журнала замен нет, после завершения FSM-задачи рабочая память не чистится,
время записи в промпт не попадает.

Цель: память обновляется. Новый факт с тем же ключом заменяет старый, решения
копятся списком, рабочая память чистится после завершения задачи, каждая замена
пишется в журнал (было → стало), в промпте только актуальные значения со временем
записи.

Решения пользователя: очистка по FSM-задаче `done`/`cancelled`; отмена требования —
новый инструмент `forget_memory`; журнал — таблица + API + блок на `/memory`.

## Правила памяти

| Группа | Категории | Поведение |
| --- | --- | --- |
| Перезаписываемые | working `goal`, `constraint`, `state`; long-term `profile`, `knowledge` | Одна живая запись на ключ в своей области. Новое значение заменяет старое, старое уходит в журнал |
| Накапливаемые | working `result`, `note`; long-term `decision` | Каждое сохранение — новая запись, даже с тем же ключом. Все записи живые |
| Удаляемые по завершении задачи | весь рабочий слой проекта | Очищается, когда FSM-задача диалога переходит в `done` или `cancelled`; долговременный слой не трогается |
| Время записи | все | Уже есть `updated_at`; теперь выводится в промпт |

Конфликт = та же область (проект для working; global или тот же проект для
long-term) + перезаписываемая категория + тот же ключ после нормализации
`key.trim().toLocaleLowerCase()` (в JS, т.к. SQLite `lower()` не знает кириллицу).
Категория при замене может смениться (срок сохранили как `constraint`, потом как `state`).

Приоритет по времени: `upsert` принимает `recordedAt` (по умолчанию `now`). Если у
сохранённой записи `updated_at` новее — замена не применяется, возвращается
`status: 'stale'` и текущее значение.

## Изменения

### 1. Миграция v19 — `server/persistence/migrations.ts`
`CHAT_SCHEMA_VERSION = 19`, таблица по образцу `invariant_changes`:

```sql
CREATE TABLE IF NOT EXISTS memory_changes (
  id TEXT PRIMARY KEY,
  layer TEXT NOT NULL CHECK (layer IN ('working', 'long_term')),
  entry_id TEXT NOT NULL,
  project_id TEXT,
  category TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('replace', 'forget', 'task_cleanup')),
  old_value TEXT NOT NULL,
  new_value TEXT,
  source_session_id TEXT,
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_changes_changed_at_idx ON memory_changes (changed_at DESC, id DESC);
```
Без FK на `entry_id`: запись в журнале переживает удалённую запись памяти.

### 2. Журнал — новый `server/memory/change-log.ts`
- `recordMemoryChange(db, change)` — один INSERT.
- `listMemoryChanges(db, { projectId?, limit })` — новые сверху; с `projectId` —
  записи проекта + глобальные long-term.
- Тип `MemoryChange` в `shared/memory.ts` (обязательные поля выше опциональных).

### 3. Репозитории — `working-repository.ts`, `long-term-repository.ts`
- `update()` — если `value` изменился, пишет `replace` (old → new) в той же транзакции.
  Так в журнал попадают и правки со страницы `/memory`.
- `remove()` — пишет `forget` со старым значением.
- Новый `upsert(input & { recordedAt?: string })` → `{ status: 'created' | 'replaced' | 'appended' | 'stale', entry, previousValue? }`:
  накапливаемая категория → `create`; перезаписываемая → ищет конфликт в области,
  нашла → проверка времени → `update(id, { category, value, expectedRevision })`; иначе `create`.
- Новый `forgetByKey(scope, key)` — удаляет все записи с этим ключом в области
  (любой категории) через `remove()`, возвращает удалённые значения.
- working: `clearForFinishedTask(projectId, sessionId)` — `INSERT … SELECT` в журнал с
  `task_cleanup`, затем `DELETE` по проекту. Ручной `clear()` со страницы не логируется
  (это явная массовая очистка пользователем).

### 4. Очистка по завершении задачи — `server/persistence/task-repository.ts`
В `approve()` при `terminal` и в `cancel()`, внутри уже открытой транзакции:
взять `project_id` сессии; если есть — `createWorkingMemoryRepository(db).clearForFinishedTask(...)`.
Долговременный слой не трогается.

### 5. Инструменты — `server/tools/memory/`
- `save-memory-tool.ts`: вместо `create` — `upsert`; ответ дополняется `status` и
  `previousValue`. В описание: правила групп; «чтобы обновить факт, используй тот же
  ключ, что в блоке памяти»; выбранный подход/срок/статус/версия — перезаписываемые
  категории, `decision` — отдельное новое решение.
- Новый `forget-memory-tool.ts` (`forget_memory`, вход `layer`, `scope`, `key`), та же
  валидация проекта, что у `save_memory`. Экспорт в `index.ts`.
- Подключение по образцу `save_memory`: `server/agent/chat-agent.ts` (тип набора
  инструментов, список имён в инструкции, `recordToolExecution`) и
  `server/api/chat.post.ts:187`.
- Инструкция агента (`chat-agent.ts:55-58`): если пользователь называет новое
  значение уже сохранённого факта или отменяет его — обнови через `save_memory` с тем
  же ключом или `forget_memory`, не дожидаясь слова «запомни». Новые факты — по-прежнему
  только по явной просьбе.

### 6. Промпт — `server/memory/selection.ts`
- Строка: `- [state] срок (2026-11-22 14:05 UTC): 15 декабря` — `PromptEntry` добавляет `updatedAt`.
- Заголовок блока дополняется: в памяти последние значения; если запись противоречит
  более ранним сообщениям диалога, верна запись.
- Обновить ожидаемые строки/байты в `tests/memory-selection.test.ts`, `tests/memory-context.test.ts`.

### 7. API и UI
- `server/api/memory/changes.get.ts` — по образцу `statistics.get.ts`: `?projectId=&limit=`,
  `Cache-Control: no-store`, ошибки через `toMemoryHttpError`.
- `composables/useMemory.ts` — метод загрузки журнала.
- `pages/memory.vue` — `<details>` «Журнал изменений» под статистикой: последние 20 записей,
  `ключ: было → стало` / `удалено` / `очищено по завершении задачи`, время, слой.
  Перезагрузка вместе со статистикой после правок.

### 8. Документация
- `docs/agent-memory.md`: раздел «Обновление и конфликты» (таблица правил, приоритет
  по времени, журнал, очистка по задаче), убрать фразу «даты в блоки не входят»,
  обновить «Ограничения первой версии».
- `docs/memory-conflicts-scenario.md`: сценарий ручной проверки + таблица результатов (ниже).

## Проверка

Автотесты (`npm test`, `npm run typecheck`):
- `tests/working-memory.test.ts`, `tests/long-term-memory.test.ts`: замена по ключу
  (регистр, кириллица, смена категории) пишет old/new; накапливаемые категории дают
  две записи; `recordedAt` старше сохранённого → `stale`, значение не меняется;
  `forgetByKey` удаляет и логирует; global и project-факты с одним ключом не конфликтуют.
- `tests/task-repository.test.ts`: финальный `approve` и `cancel` чистят рабочую
  память проекта, долговременная остаётся, в журнале `task_cleanup`; диалог без
  проекта — без ошибок.
- `tests/memory-context.test.ts`: после замены `createMemorySnapshot(...).transientMemory`
  содержит новое значение и не содержит старое.
- `tests/chat-db.test.ts`: миграция до v19 создаёт `memory_changes`.
- `tests/chat-agent.test.ts`: `forget_memory` есть в наборе инструментов.

Ручной сценарий (реальная модель, диалог в проекте, запущена FSM-задача):
1. «Запомни в память проекта: срок — 1 декабря; требование — экспорт в PDF; подход — REST; версия API — v1». Решение «БД — SQLite» — в долговременную память.
2. «Срок сдвинулся на 15 декабря» → «Какой сейчас срок?»
3. «Экспорт в PDF больше не нужен» → «Какие требования актуальны?»
4. «Переходим на GraphQL вместо REST» → «Какой подход выбран?»
5. «Версия API теперь v2» → «Какая версия API?»
6. После каждого ответа — отметить в таблице, назвал ли агент устаревшее значение;
   итог: число устаревших ответов из 4.
7. Проверить промпт: в run log хода (`transientMemory.messages`) и в
   `GET /api/memory/preview` нет `1 декабря`, `PDF`, `REST`, `v1`; на `/memory` в журнале 4 записи.
   Ограничение: краткосрочная история сама содержит старые реплики пользователя —
   проверяются блоки памяти, а не история.
8. Завершить задачу (довести FSM до финала или отменить) → на `/memory` рабочий слой
   пуст, в журнале `task_cleanup`, долговременное решение «БД — SQLite» на месте.

Результаты записать в `docs/memory-conflicts-scenario.md`.

## После одобрения
Сохранить план в `docs/superpowers/plans/2026-11-22-memory-conflicts.md` со статусом
«план одобрен, реализация не начата» и ждать команды на реализацию.
