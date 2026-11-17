# Agent Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить три независимых слоя памяти, проекты с общей рабочей памятью, явное сохранение фактов и страницу управления со статистикой и настраиваемыми бюджетами.

**Architecture:** Существующая SQLite остаётся единственным источником состояния. Рабочие записи, долговременные факты, связи, настройки и числовые события хранятся отдельно; сервер создаёт неизменяемый снимок памяти на ход и добавляет его к результату существующей обработки истории. Очистка истории — отдельная возобновляемая операция с блокировкой новых ходов до удаления диагностического лога.

**Tech Stack:** Nuxt 4.6.4, Vue 3, AI SDK 7.0.162, TypeScript, better-sqlite3 13, Vitest 5, существующий Nuxt UI. Новые runtime-зависимости не нужны.

**Spec:** [Три слоя памяти агента](../specs/2026-11-17-agent-memory-design.md), согласован 2026-11-17 с настраиваемыми бюджетами. Исполнитель читает дизайн и план.

## Global Constraints

- Проект представляет одну задачу и объединяет несколько диалогов с общей рабочей памятью; вложенных задач нет.
- Слои хранятся раздельно. Пользователь явно выбирает содержание и слой для самостоятельных записей.
- Краткосрочная память поддерживает просмотр и полную очистку истории; редактирование и удаление отдельных сообщений отложены.
- Очистка выбранного слоя сохраняет самостоятельные записи других слоёв.
- Бюджеты рабочего и долговременного слоёв по умолчанию равны 2 000 оценочных токенов каждый, настраиваются независимо и сохраняются в SQLite для всего приложения.
- Переполнение не приводит к скрытому отбрасыванию записей или двойному учёту токенов. Бюджеты ограничивают включение в промпт, а не хранение.
- Память подключается при любой стратегии обработки истории; блоки памяти не записываются в сообщения, сводки или диагностические логи как скрытые копии.
- Статистика не содержит текст сообщений, ключи или значения фактов. Попадание в контекст не означает влияние на ответ.
- Новая миграция сохраняет прежние сообщения, настройки и ветки. Sticky Facts не преобразуются автоматически в подтверждённые записи.
- В рабочей копии уже изменены `app/assets/css/main.css`, `components/ChatSessionList.vue`, `docs/chat-branching.md`, `tests/branch-repository.test.ts`. Сохранить эти изменения; перед исполнением прочитать их diff и согласовать собственные правки с текущим содержимым.

## Review Focus

1. Очистка конкурирует с поздней записью логгера и перезапуском: старый лог не появляется снова, а новые ходы заблокированы до завершения операции. Проверки: Task 6.
2. Источник факта удалён, а ветка содержит независимую копию истории: факт и ветка сохраняются, ссылка на источник корректно исчезает. Проверки: Tasks 3 и 6.
3. Невалидные, очень большие или уменьшенные бюджеты и маленькое окно модели: настройка проверяется на сервере, используются фактические объёмы, отказ не создаёт новую реплику при переполнении самостоятельного слоя. Проверки: Tasks 1 и 4.
4. Несколько вкладок редактируют запись или подключают старый диалог с ветками: конфликты не перезаписывают данные, назначения проектов не распространяются скрыто на родственников. Проверки: Tasks 2 и 3.
5. `raw`-логирование и ошибки провайдера содержат копию входа: прямые синтетические блоки памяти исключаются, обычный пользовательский текст не удаляется по совпадению слов. Проверки: Task 4.

## Структура файлов и общие контракты

| Файлы | Ответственность |
| --- | --- |
| `shared/memory.ts` | Публичные типы, валидация записей и бюджетов, диапазоны значений. |
| `server/persistence/migrations.ts`, `server/memory/settings-repository.ts` | Миграция и сохранённые настройки. |
| `server/persistence/project-repository.ts`, существующие репозитории диалогов и веток | Проекты, принадлежность диалогов и наследование проекта. |
| `server/memory/working-repository.ts`, `long-term-repository.ts` | Независимые операции записей и связей. |
| `server/memory/context.ts`, `start-turn.ts` | Снимок, сериализация, оценка и атомарное начало хода. |
| `server/memory/usage-repository.ts`, `statistics.ts` | Числовые события отбора и агрегаты для страницы. |
| `server/memory/clear-repository.ts`, `clear-service.ts` | Транзакционная очистка содержимого и возобновляемое удаление логов. |
| `server/api/projects/**`, `server/api/memory/**`, новые операции `server/api/sessions/[id]/**` | Тонкие HTTP-обработчики над репозиториями и сервисами. |
| `components/ProjectSelector.vue`, `MemoryEntryForm.vue`, `MemoryBudgetSettings.vue`, `MemoryStatistics.vue`, `MemoryRecordList.vue`, `MemoryClearDialog.vue` | Выбор проекта, форма записей, бюджеты, показатели, списки и подтверждение очистки. |
| `composables/useMemory.ts`, `pages/memory.vue`, существующие страницы чата | Загрузка состояния, операции пользователя и навигация. |
| `tests/helpers/memory-db.ts`, новые `tests/*memory*.test.ts` | Временная база и проверки изоляции, бюджета, очистки, телеметрии. |

Зафиксировать следующие имена в `shared/memory.ts`; остальные поля следуют модели в дизайне:

- `Project`: `id`, `name`, `revision`, `createdAt`, `updatedAt`.
- `MemorySource`: необязательные `sourceSessionId` и `sourceMessageId`.
- `MemoryEntryBase`: `id`, `key`, `value`, `enabled`, `revision`, `createdAt`, `updatedAt` и `MemorySource`.
- `WorkingMemoryEntry`: база плюс `projectId` и `category: 'goal' | 'constraint' | 'state' | 'result' | 'note'`.
- `LongTermFact`: база плюс `category: 'profile' | 'decision' | 'knowledge'`, `global: boolean`, `projectIds: string[]`.
- `CreateWorkingEntry`: `projectId`, `category`, `key`, `value`, `enabled` и необязательный источник. `CreateLongTermFact`: `category`, `key`, `value`, `enabled`, `global`, `projectIds` и необязательный источник.
- `UpdateWorkingEntry`: изменяемые поля создания без проекта и источника плюс `expectedRevision`. `UpdateLongTermFact`: изменяемые поля создания без источника плюс `expectedRevision`. PATCH допускает частичное изменение полей, но требует ревизию.
- `MemoryBudgets`: `{ workingTokens: number; longTermTokens: number; revision: number }`. `MemoryBudgetPatch`: `{ workingTokens?: number; longTermTokens?: number; expectedRevision: number }`.
- `MemoryScope`: `{ kind: 'dialogue'; sessionId: string } | { kind: 'project'; projectId: string } | { kind: 'global' }`.
- `MemoryListQuery`: `{ cursor?: string; limit?: number; text?: string; category?: string }`; `MemoryPage<T>`: `{ items: T[]; nextCursor?: string }`.
- `MemoryLayerPreview`: `{ count: number; bytes: number; estimatedTokens: number; budgetTokens: number; percent: number; exceeded: boolean }`; `MemoryPreview`: `{ projectId?: string; working: MemoryLayerPreview; longTerm: MemoryLayerPreview }`.
- `MemorySelectionRef`: `{ id: string; revision: number; reasons: Array<'working_project' | 'global' | 'project'> }`.
- `MemoryUsageEvent`: `id`, `snapshotId`, `sessionId`, необязательные `projectId` и `turnId`, `preparedAt`, `contextCleared`, числовые `shortTerm`/`working`/`longTerm` (`count`, `bytes`, `estimatedTokens`) и массивы `workingRefs`/`longTermRefs`. Значений фактов в типе нет.
- `MemoryStatistics`: `scope`, `collectionStartedAt`, `stored` с числами сообщений, сводок, фактов и байтов по слоям, `preparedTurns`, `lastPrepared?: MemoryUsageEvent`, `recordUsage` с `id`, `layer`, `preparedTurns`, `lastPreparedAt` и признаком несовпадения ревизии. Provider usage возвращать отдельно только при наличии, без обещания его сохранности после очистки.
- `HistoryClearResult`: `{ operationId: string; sessionId: string; status: 'pending_files' | 'completed'; error?: string }`.

Репозитории принимают `Database.Database`. Доменные ошибки экспортировать из `server/memory/errors.ts` как `MemoryError` с `code` из `'NOT_FOUND' | 'INVALID_INPUT' | 'REVISION_CONFLICT' | 'PROJECT_ALREADY_ASSIGNED' | 'HISTORY_CLEAR_PENDING' | 'SESSION_RUNNING' | 'MEMORY_BUDGET_EXCEEDED'`; лимитная ошибка также несёт слой и оценку. HTTP: 404 для отсутствия, 409 для конфликтов/выполняющейся очистки/активного хода, 400 для входа, 422 для превышения бюджета.

Общие авторские ограничения для реализации: бюджеты — целые `100..100000`, имя проекта — `1..120` символов после trim, ключ — `1..80`, значение — `1..10000`. Страница списка — 30 по умолчанию, максимум 100. Это пределы ввода, а не автоматическое сокращение текста.

---

### Task 1: Схема, контракты и сохраняемые бюджеты

**Files:** Create `shared/memory.ts`, `server/memory/errors.ts`, `server/memory/settings-repository.ts`, `tests/helpers/memory-db.ts`, `tests/memory-settings.test.ts`. Modify `server/persistence/migrations.ts`, `tests/chat-db.test.ts`, `tests/chat-backup.test.ts`.

**Interfaces:** Produces общие контракты выше; `createMemorySettingsRepository(db)` с `get(): MemoryBudgets`, `update(patch: MemoryBudgetPatch): MemoryBudgets`; `createMemoryTestDatabase(): Promise<{ db: Database.Database; cleanup(): Promise<void> }>` для тестов.

- [ ] **Step 1: Добавить failing-проверки миграции и настроек.** После обновления базы версии 8 сообщения/ветки/Sticky Facts сохраняются; отдельные таблицы существуют; новая и повторно открытая база дают `{workingTokens: 2000, longTermTokens: 2000, revision: 0}`. Изменение только рабочего бюджета до 4000 сохраняет долговременный 2000. Проверить отклонение `0`, `-1`, `1.5`, `NaN`, `Infinity`, `100001`, строк; конфликт старой ревизии не перезаписывает настройку.

  Ключевые assertions теста `keeps independent budgets after reopening`:
  ```ts
  expect(settings.get()).toEqual({ workingTokens: 2000, longTermTokens: 2000, revision: 0 })
  expect(settings.update({ workingTokens: 4000, expectedRevision: 0 })).toEqual({ workingTokens: 4000, longTermTokens: 2000, revision: 1 })
  ```

- [ ] **Step 2: Выполнить `npm test -- tests/chat-db.test.ts tests/memory-settings.test.ts`.** Ожидание: новые проверки падают из-за отсутствующих контрактов/миграции.
- [ ] **Step 3: Добавить миграцию версии 9 и настройки.** Таблицы: `projects`, `working_memory_entries`, `long_term_facts`, `project_long_term_facts`, `memory_settings`, `memory_usage_events`, `history_clear_operations`, `cleared_requests`, `cleared_tool_calls`. Добавить nullable `sessions.project_id`. Источники записей используют nullable FK с `ON DELETE SET NULL`; проектные факты имеют уникальность пары. Новые таблицы не содержат активирующей автоматической миграции Sticky Facts. Операции очистки сохраняют только ID, статус, даты и безопасную ошибку; очищенные запросы и вызовы — только идентификаторы и минимальную принадлежность диалогу. События хранят структурированную числовую телеметрию, без текста записей. На сессию допускается только одна незавершённая очистка. Расширить тест резервной копии новыми таблицами и настройкой.
- [ ] **Step 4: Выполнить `npm test -- tests/chat-db.test.ts tests/memory-settings.test.ts tests/chat-backup.test.ts`.** Ожидание: PASS, включая повторное открытие и сохранение прежней истории.
- [ ] **Step 5: Сохранить только файлы задачи коммитом `feat: persist memory contracts and configurable budgets`.**

### Task 2: Проекты и принадлежность диалогов

**Files:** Create `server/persistence/project-repository.ts`, `server/api/projects/index.get.ts`, `index.post.ts`, `server/api/projects/[id].patch.ts`, `server/api/sessions/[id]/project.patch.ts`, `tests/project-repository.test.ts`. Modify `shared/chat.ts`, `server/persistence/session-repository.ts`, `branch-repository.ts`, `server/api/sessions/index.get.ts`, `index.post.ts`, `tests/session-repository.test.ts`, `tests/branch-repository.test.ts`.

**Interfaces:** Consumes `Project`, ошибки Task 1. Produces `createProjectRepository(db)` с `create(name: string): Project`, `list(query?: MemoryListQuery): MemoryPage<Project>`, `rename(id: string, name: string, expectedRevision: number): Project`, `assignSession(sessionId: string, projectId: string): void`. Расширить `SessionSummary` необязательным `projectId`. Существующий `createSession(options?: {projectId?: string}): SessionSummary`; `listSessions` получает фильтр `projectId?: string | null` (`undefined` — все, `null` — без проекта).

- [ ] **Step 1: Добавить failing-тесты.** Создать проекты A/B и диалоги; проверить фильтр и прежнюю общую выдачу, разовое подключение старого диалога, отказ для несуществующего проекта и повторного переноса. Подключение родителя не меняет проект существующей ветки; новая ветка наследует проект. Родитель/старая ветка могут быть явно подключены к A/B независимо. Операции назначения при активном ходе или pending-очистке отклоняются.
- [ ] **Step 2: Выполнить `npm test -- tests/project-repository.test.ts tests/session-repository.test.ts tests/branch-repository.test.ts`.** Ожидание: новые проверки FAIL.
- [ ] **Step 3: Реализовать репозиторий и тонкие API.** `GET/POST /api/projects`, `PATCH /api/projects/:id {name,expectedRevision}`, `PATCH /api/sessions/:id/project {projectId}`, `POST /api/sessions {projectId?}`, `GET /api/sessions?projectId=…` и `projectId=none`. Выбирать проект по БД; имя проекта не является идентификатором. Проверка состояния и назначение выполняются в одной транзакции. Изменения списка/деталей диалога включают projectId, ветвление сохраняет прежнюю независимость истории.
- [ ] **Step 4: Повторить команду Step 2.** Ожидание: PASS, исходные проверки ветвления сохраняются.
- [ ] **Step 5: Коммит `feat: group agent dialogues into projects`.**

### Task 3: Независимые записи памяти и явные подключения

**Files:** Create `server/memory/working-repository.ts`, `server/memory/long-term-repository.ts`, `server/memory/api-errors.ts`, `server/api/memory/settings.get.ts`, `server/api/memory/settings.patch.ts`, `tests/working-memory.test.ts`, `tests/long-term-memory.test.ts`. В каждой из директорий `server/api/memory/working/` и `server/api/memory/long-term/` создать `index.get.ts`, `index.post.ts`, `[id].patch.ts`, `[id].delete.ts`, `clear.post.ts`; дополнительно создать `server/api/memory/long-term/detach-project.post.ts`.

**Interfaces:** Consumes контракты и настройки Task 1, проекты Task 2. Produces `createWorkingMemoryRepository(db)` с `list(projectId: string, query?: MemoryListQuery): MemoryPage<WorkingMemoryEntry>`, `create(input: CreateWorkingEntry): WorkingMemoryEntry`, `update(id: string, patch: UpdateWorkingEntry): WorkingMemoryEntry`, `remove(id: string): void`, `clear(projectId: string): number`; `createLongTermMemoryRepository(db)` с `list(query?: MemoryListQuery & {projectId?: string}): MemoryPage<LongTermFact>`, `create`, `update`, `remove`, `clear(): number`, `detachProject(projectId: string): number` (типы create/update — общие контракты).

- [ ] **Step 1: Добавить failing-проверки.** Запись проекта A отсутствует в B; удаление рабочего слоя не меняет факты, связи или сообщения. Глобальный факт с двумя проектными связями хранит один текст. Две правки одной ревизии дают один успех и один конфликт. Удаление исходного сообщения обнуляет источник и сохраняет значение. Сохранение двух записей с одинаковым ключом не заменяет существующую; несуществующий источник/проект отвергается. Большая выключенная запись сохраняется независимо от бюджета.
- [ ] **Step 2: Выполнить `npm test -- tests/working-memory.test.ts tests/long-term-memory.test.ts`.** Ожидание: FAIL новых контрактов.
- [ ] **Step 3: Реализовать репозитории, валидацию и API.** Маршруты: `GET/POST /api/memory/working?projectId=…`, `PATCH/DELETE /api/memory/working/:id`, `POST /api/memory/working/clear {projectId}`; аналогичные список/create/update/delete для `/api/memory/long-term`, `POST /api/memory/long-term/clear`, `POST /api/memory/long-term/detach-project {projectId}`. Тело создания рабочего слоя явно содержит projectId; UI покажет его пользователю. `GET/PATCH /api/memory/settings` возвращают/изменяют сохранённые бюджеты. Ошибки отображать через `toMemoryHttpError(error: unknown)` из `api-errors.ts`. Очистка списков использует транзакцию; глобальные факты после detach продолжают включаться по глобальному флагу. Сортировка списков — категория, ключ, ID; фильтр текста — буквальная подстрока, без внедрения SQL из query.
- [ ] **Step 4: Повторить команду Step 2 и `npm test -- tests/memory-settings.test.ts`.** Ожидание: PASS, независимость слоёв подтверждена.
- [ ] **Step 5: Коммит `feat: add explicit working and long-term memory records`.**

### Task 4: Снимок памяти, бюджеты и сборка промпта

**Files:** Create `server/memory/context.ts`, `start-turn.ts`, `server/api/memory/preview.get.ts`, `tests/memory-context.test.ts`, `tests/memory-start-turn.test.ts`. Modify `server/context-compaction/prepare.ts`, `server/api/chat.post.ts`, `server/agent/chat-agent.ts`, `server/utils/run-logger.ts`, `tests/context-compaction.test.ts`, `tests/chat-agent.test.ts`, `tests/run-logger.test.ts`.

**Interfaces:** Consumes записи/бюджеты Tasks 1–3. Produces `MemorySnapshot` из `context.ts`: `id`, `sessionId`, `projectId?`, `budgets`, выбранные копии рабочих/долговременных записей, `workingRefs`, `longTermRefs`, `messages: UIMessage[]`, `preview: MemoryPreview`. Экспорты: `createMemorySnapshot(db, sessionId: string): MemorySnapshot`, `previewMemory(db, projectId?: string): MemoryPreview`, `assertMemoryBudgets(snapshot: MemorySnapshot): void`. `startMemoryAwareTurn(db, input: {request: ChatRequestBody; modelId: string; agentConfig: Record<string, unknown>}): {turnId: string; snapshot: MemorySnapshot}`. `prepareSessionContext` получает необязательный `memorySnapshot` без повторного чтения записей.

- [ ] **Step 1: Написать failing-тесты отбора и жизненного цикла.** Общая память двух диалогов A, изоляция B, глобальные факты без проекта, dedup глобального/подключённого факта, исключение выключенных/неподключённых. После изменения записи созданный снимок неизменен, новый ход читает новую версию. Бюджеты 2000/2000 на старте, 4000/1000 после правки; повышение лимита без новых записей не увеличивает оценочный вход. Все четыре стратегии получают оба слоя. Превышение отдельного слоя возвращает `MEMORY_BUDGET_EXCEEDED` и не сохраняет реплику/ход. Маленькое модельное окно отклоняет фактический суммарный вход. Ни счётчик шагов, ни история, ни вызов summarizer не получают синтетические сообщения как исходную историю.
- [ ] **Step 2: Выполнить `npm test -- tests/memory-context.test.ts tests/memory-start-turn.test.ts tests/context-compaction.test.ts`.** Ожидание: новые проверки FAIL.
- [ ] **Step 3: Реализовать снимок и подключение.** Сериализовать только категорию/ключ/значение, стабильным порядком, в двух синтетических user-сообщениях с серверными уникальными ID. Системная инструкция определяет их как данные и приоритет текущего запроса. Оценка слоя включает его сериализованную оболочку по текущей формуле UTF-8/2. Создание снимка, проверка самостоятельных бюджетов и начало хода проходят в одном синхронном DB-согласованном участке, где pending-очистка и активный ход проверяются повторно. В `chat.post` использовать `startMemoryAwareTurn` вместо дублированного начала нового/продолженного хода. Для решения Summary добавить оценку памяти к overhead истории; для финальной проверки передать фактические блоки и исходный overhead, не удваивая оценку. В stream originalMessages остаётся только пользовательская история.
- [ ] **Step 4: Исключить прямые блоки из диагностики и проверить отрицательные случаи.** Передавать в логгер transient-метаданные синтетических ID, полного текста блоков и числовых размеров. Они не сохраняются. Проецирование request заменяет только серверные синтетические сообщения; существующее скрытие значений также исключает полный блок из вложенных сериализованных error/request bodies. Сохранить обычный ответ и отдельные упоминания факта как самостоятельное содержимое. В `run-logger.test.ts` проверить `detailed`/`raw`, вложенный JSON ошибки, отсутствие прямого блока на диске, сохранность обычного пользовательского текста с таким же словом и неизменность входа модели. `GET /api/memory/preview?projectId=…` использует тот же отбор и оценку, включая глобальные факты и dedup.
- [ ] **Step 5: Выполнить `npm test -- tests/memory-context.test.ts tests/memory-start-turn.test.ts tests/context-compaction.test.ts tests/sticky-facts.test.ts tests/chat-agent.test.ts tests/run-logger.test.ts`.** Ожидание: PASS, прежние стратегии и tool-loop работают.
- [ ] **Step 6: Коммит `feat: compose bounded memory snapshots for agent turns`.**

### Task 5: События отбора и статистика

**Files:** Create `server/memory/usage-repository.ts`, `statistics.ts`, `server/api/memory/statistics.get.ts`, `tests/memory-usage.test.ts`, `tests/memory-statistics.test.ts`. Modify `server/api/chat.post.ts`.

**Interfaces:** Consumes снимок Task 4. Produces `createMemoryUsageRepository(db)` с `recordPrepared(input: {turnId: string; snapshot: MemorySnapshot; shortTerm: {count: number; bytes: number; estimatedTokens: number}}): MemoryUsageEvent`, `markSessionContextCleared(sessionId: string): void`; `getMemoryStatistics(db, scope: MemoryScope): MemoryStatistics`.

- [ ] **Step 1: Написать failing-тесты.** Один ход с несколькими модельными шагами даёт одно событие; повтор recordPrepared того же turnId не удваивает счётчик. Подготовленный ход с последующей ошибкой провайдера учитывается, отказ до подготовки — нет. Проект объединяет собственные диалоги и ветки, общий список — приложение. После изменения факта прежняя ревизия отмечается как изменённая, старый текст не реконструируется. После очистки самого позднего диалога lastPrepared имеет `contextCleared`, не заменяется старым чужим событием. JSON телеметрии не содержит секретного текста фикстуры/ключа факта; старые ходы не получают событий задним числом.
- [ ] **Step 2: Выполнить `npm test -- tests/memory-usage.test.ts tests/memory-statistics.test.ts`.** Ожидание: FAIL новых функций.
- [ ] **Step 3: Записывать событие после успешной подготовки всего контекста.** Unique turnId обеспечивает идемпотентность; независимый ID события сохраняется после обнуления удалённого turnId. Использовать отдельные числа для исходного объёма хранения и подготовленного входа. Последнее событие выбирается по preparedAt и ID. `GET /api/memory/statistics?scope=dialogue&sessionId=…`, `scope=project&projectId=…`, `scope=global` возвращает единый тип; scope/ID проверяются. Фактический provider usage получать из прежних данных только когда доступен, показывая отсутствие после их удаления.
- [ ] **Step 4: Повторить команду Step 2.** Ожидание: PASS; события не зависят от уровня диагностического логирования.
- [ ] **Step 5: Коммит `feat: track memory selection statistics without stored content`.**

### Task 6: Независимая очистка истории и возобновляемое удаление логов

**Files:** Create `server/memory/clear-repository.ts`, `clear-service.ts`, `server/api/sessions/[id]/history/clear.post.ts`, `tests/memory-clear.test.ts`, `tests/memory-clear-recovery.test.ts`. Modify `server/utils/run-logger.ts`, `server/plugins/chat-recovery.ts`, `server/persistence/turn-repository.ts`, `session-repository.ts`, `project-repository.ts`, `branch-repository.ts`, `server/memory/start-turn.ts`, `tests/run-logger.test.ts`, `tests/session-repository.test.ts`, `tests/chat-continuation.test.ts`.

**Interfaces:** Consumes usage Task 5 и состояние Task 1. Produces `createHistoryClearRepository(db)` с `begin(sessionId: string, operationId: string): HistoryClearResult`, `pending(): Array<HistoryClearResult & {oldRunLogId: string; newRunLogId: string}>`, `complete(operationId: string): HistoryClearResult`, `fail(operationId: string, safeError: string): HistoryClearResult`; `assertHistoryAvailable(db, sessionId: string): void`. `closeAndDeleteRunLog(runId: string, directory?: string): Promise<void>` в логгере. `createHistoryClearService(db, options?: {deleteLog?: typeof closeAndDeleteRunLog; logDirectory?: string})` с `clear(sessionId: string, operationId: string): Promise<HistoryClearResult>`, `resumePending(): Promise<number>`.

- [ ] **Step 1: Написать failing-тесты доменной очистки.** Заполнить два диалога и ветку, обе памяти, сводки, Sticky Facts, tool-результат и событие использования. Очистка выбранного диалога удаляет только его содержимое/производные данные и обнуляет источники, сохраняя значения фактов, рабочие записи, ветку, файл и бросок. История пуста, настройки/projectId сохраняются, заголовок сброшен, последний старый ход недоступен. Повтор старого requestId отклонён даже после рестарта. Удаление оболочки после очистки сохраняет прежнюю семантику deleteSession для бросков через минимальную связь очищенного tool_call_id. При активном ходе изменений нет.
- [ ] **Step 2: Написать failing-тесты восстановления и гонки логгера.** Ожидающая запись и поздний append старого runId не восстанавливают файл после завершения очистки. Сбой удаления оставляет pending-операцию и блокирует новый ход, продолжение, ветвление, назначение проекта и удаление оболочки. Повтор того же operationId завершает операцию; восстановление после открытия БД повторяет её без удаления новых данных. Отсутствующий лог, включая режим off, считается успешным удалением.
- [ ] **Step 3: Выполнить `npm test -- tests/memory-clear.test.ts tests/memory-clear-recovery.test.ts tests/run-logger.test.ts`.** Ожидание: новые проверки FAIL.
- [ ] **Step 4: Реализовать транзакционную часть.** begin проверяет отсутствие running-хода/pending-другой операции, сохраняет минимальные ID запросов и подтверждённых tool_call_id, помечает usage как очищенный, удаляет сообщения/сводки/maintenance-содержимое/ходы/tool payloads, обнуляет источник ветки и источники самостоятельных записей, меняет заголовок и оставляет pending. Сессию не удалять, проекты/факты/рабочие записи/внешние результаты не менять. Старые requestId проверять в beginUserTurn и beginContinuation до записи. getLastTurn и assessContinuation не возвращают очищенные ходы. Расширить deleteSession поиском бросков через cleared_tool_calls. Все операции над pending-сессией используют assertHistoryAvailable внутри своей транзакции.
- [ ] **Step 5: Реализовать файловую часть.** closeAndDeleteRunLog запрещает новые записи старого runId до ожидания имеющихся pendingWrites, затем удаляет только соответствующий файл; поздние append для закрытого runId не пишут его заново. complete назначает заранее сохранённый новый runLogId и снимает блокировку; fail оставляет возобновляемую операцию. `POST /api/sessions/:id/history/clear {operationId}` идемпотентен; статус pending возвращается с безопасной причиной и возможностью повтора, не как успешное завершение. Nitro recovery сначала возобновляет pending-очистки и не оживляет очищенные ходы. Сетевой повтор завершённого operationId ничего не очищает повторно. Отдельные clear-операции рабочего и долговременного слоёв из Task 3 остаются независимыми.
- [ ] **Step 6: Выполнить `npm test -- tests/memory-clear.test.ts tests/memory-clear-recovery.test.ts tests/run-logger.test.ts tests/chat-continuation.test.ts tests/session-repository.test.ts tests/branch-repository.test.ts`.** Ожидание: PASS, включая старые правила продолжения и удаления.
- [ ] **Step 7: Коммит `feat: clear dialogue memory without deleting other layers`.**

### Task 7: Проекты в интерфейсе и явная форма сохранения

**Files:** Create `components/ProjectSelector.vue`, `components/MemoryEntryForm.vue`, `composables/useMemory.ts`. Modify `pages/chat/[id].vue`, `components/ChatSessionList.vue`, `components/ChatWorkspace.vue`, `pages/index.vue`, `app/assets/css/main.css`.

**Interfaces:** Consumes API Tasks 2–6. `ProjectSelector` принимает `projects: Project[]`, `modelValue?: string`, `disabled?: boolean`; emits `update:modelValue`, `create(name)`, `rename({id,name,expectedRevision})`, `assignSession(projectId)`. `MemoryEntryForm` принимает `{open, layer: 'working'|'long_term', projectId?, source?: MemorySource, initialText?: string, entry?: WorkingMemoryEntry|LongTermFact}`; emits `saved`/`cancel`. `useMemory()` экспортирует методы `loadProjects`, `listWorking`, `listLongTerm`, `saveWorking`, `saveLongTerm`, `deleteWorking`, `deleteLongTerm`, `loadBudgets`, `updateBudgets`, `loadPreview`, `loadStatistics`, `clearWorking`, `clearLongTerm`, `detachProject`, `clearHistory`; типы аргументов совпадают с API/общими контрактами. Кэш и ошибки принадлежат вызвавшей странице.

- [ ] **Step 1: Проверить текущий diff пользовательских UI-файлов и зафиксировать ручные сценарии.** Без проекта видна старая история; создание проекта не переносит диалоги; новый диалог создаётся внутри выбранного проекта; старый подключается явно; обновление страницы сохраняет принадлежность. Форма не отправляет запись до кнопки сохранения, сообщает выбранный слой/проект и позволяет править текст; для long-term начальное состояние `global=false`, `projectIds=[]`. Подключение в проект выбирается явным действием.
- [ ] **Step 2: Добавить выбор/создание/переименование проекта и фильтрацию диалогов существующими компонентами.** Сохранить прежние действия и метки веток. Смена проекта фильтра не переносит открытый диалог в другой проект. Если открыта существующая сессия, projectId для запроса и формы берётся из неё, не из произвольного фильтра списка.
- [ ] **Step 3: Добавить «Сохранить в память» для видимого текста сообщения и ручное создание записи.** Использовать одну форму для create/edit; не вызывать LLM. Рабочая запись требует проект, долговременная показывает способ включения и категорию. Ошибка ревизии сохраняет черновик и предлагает загрузить актуальную запись. Добавить переход к `/memory` с выбранным проектом/диалогом.
- [ ] **Step 4: Выполнить `npm run typecheck`, затем ручные сценарии Step 1 в dev-приложении.** Ожидание: типы PASS; пользовательские изменения sidebar/CSS сохранены; незавершённая форма не создаёт запись. Для UI использовать существующее оформление, доступные подписи полей и управление клавиатурой, без новых зависимостей.
- [ ] **Step 5: Коммит собственных изменений `feat: manage project memory explicitly from chat`.** Не включать непроверенные посторонние hunks в пользовательских файлах.

### Task 8: Страница памяти, настройка бюджетов и подтверждение очистки

**Files:** Create `pages/memory.vue`, `components/MemoryBudgetSettings.vue`, `MemoryStatistics.vue`, `MemoryRecordList.vue`, `MemoryClearDialog.vue`, `tests/memory-statistics-view.test.ts`. Modify `composables/useMemory.ts`, `components/ChatWorkspace.vue`, `pages/chat/[id].vue`, `app/assets/css/main.css`.

**Interfaces:** Consumes `MemoryStatistics`, `MemoryPreview`, `MemoryBudgets` и API. `MemoryBudgetSettings` принимает `{budgets: MemoryBudgets; preview: MemoryPreview; saving: boolean}`; emits `save(MemoryBudgetPatch)`. `MemoryStatistics` принимает `{statistics: MemoryStatistics; preview?: MemoryPreview}`. `MemoryClearDialog` принимает `{open, layer: 'short_term'|'working'|'long_term', scopeLabel: string, affectedCount: number, pending?: HistoryClearResult}`; emits `confirm`/`cancel`/`retry`. Данные краткосрочного списка загружаются существующим GET session, остальные списки — API Task 3.

- [ ] **Step 1: Добавить failing SSR-проверки числовых показателей по существующему подходу `tests/chat-request-metrics.test.ts`.** При бюджете 2000 и оценке 1000 отображаются «оценка» и 50%; после настройки 4000 — 25%. 2500/2000 показывает превышение, не скрывая число и не обрезая записи. «Хранится» и «Включено в контекст» различаются; недоступный provider usage не равен нулю; изменённая ревизия не выдаётся за старый текст; cleared lastPrepared не отображает прежний состав. Режим хранения всех фактов не делит их суммарный объём на бюджет одного проекта.
- [ ] **Step 2: Выполнить `npm test -- tests/memory-statistics-view.test.ts`.** Ожидание: FAIL отсутствующих компонентов.
- [ ] **Step 3: Собрать `/memory`.** Выбор слоя и области отражается в query-параметрах и переживает reload. Поддержать списки с пагинацией/поиском/категорией, create/edit/delete/enable формой Task 7, источник с корректным пустым состоянием, глобальные и проектные подключения. Показывать состояние загрузки/ошибки/пустого слоя. Short-term предоставляет только просмотр и полную очистку; сводки/Sticky Facts подписаны как автоматически полученные. Для предварительного заполнения использовать тот же preview API после изменения активных записей, связей и бюджетов.
- [ ] **Step 4: Добавить независимое редактирование бюджетов и очистку.** Сохранение бюджетов отправляет expectedRevision и показывает диапазон 100..100000; drafts сохраняются при сетевой ошибке. Прогресс отображает оценку, бюджет и процент; изменение бюджета не меняет число хранимых записей. Подтверждение очистки указывает слой, область и число элементов. Отдельно представить отключение long-term от проекта. При pending-очистке диалога показывать повтор той же операции и заблокированный composer; после завершения перезагрузить session и сбросить useChat только этой сессии. API-ошибка бюджета из Task 4 восстанавливает неотправленный текст в composer, даже если UI transport успел оптимистично добавить его локально.
- [ ] **Step 5: Выполнить `npm test -- tests/memory-statistics-view.test.ts` и `npm run typecheck`, затем проверить страницу вручную.** Сценарии: A/B проекты; два диалога A; общий факт; выключенная запись; правка из двух вкладок; изменение бюджета и reload; превышение до отправки; очистка каждого слоя; повтор pending-очистки; сохранность факта после очистки источника; мобильная ширина и клавиатура. Ожидание: PASS без потери черновика или изменения соседних слоёв.
- [ ] **Step 6: Коммит `feat: add memory management and budget statistics page`.**

### Task 9: Проверка всей функции и документация

**Files:** Create `docs/agent-memory.md`. Modify `README.md`, `docs/chat-context-compaction.md`, `docs/chat-branching.md`, `docs/token-accounting.md`, `docs/agent-memory-roadmap.md`, при необходимости интеграционные тесты из предыдущих задач.

**Interfaces:** Consumes завершённую функцию Tasks 1–8. Новых продуктовых контрактов не добавляет.

- [ ] **Step 1: Сопоставить все десять проверок дизайна с тестами и ручными сценариями Tasks 1–8.** Заполнить реальные пробелы в проверках изоляции, ревизий, независимой очистки, восстановления и общего бюджета. Не добавлять тесты, повторяющие разметку или очевидные вызовы тонких обработчиков.
- [ ] **Step 2: Запустить `npm test`, затем `npm run typecheck`, затем `npm run build`.** Ожидание: каждая команда завершается с кодом 0. Повторять проверки только после исправлений или новых ошибок. При необходимости сетевых загрузок build запросить штатное разрешение среды, не менять продукт ради обхода ограничений.
- [ ] **Step 3: Выполнить один ручной прогон из пустой временной базы и один после обновления копии базы версии 8.** Не очищать реальную пользовательскую историю ради проверки. Прогон включает перезапуск и live-backup/восстановление новой схемы; запрос к реальному провайдеру используется только при доступной конфигурации, иначе отметить предел проверки mock-моделью.
- [ ] **Step 4: Написать пользовательскую документацию.** Объяснить области трёх слоёв, проекты, ручное сохранение и подключения, отдельное хранение и попадание в промпт, настраиваемые бюджеты с default 2000, оценки вместо точных токенов, независимую очистку и сохранность резервных копий/веток/самостоятельных фактов. Обновить описание ветвления общей рабочей памяти и статистики; roadmap остаётся списком отложенного развития.
- [ ] **Step 5: Выполнить `git diff --check`, проверить локальные ссылки, оценить только собственный diff и завершить независимым обзором по выбранному способу исполнения.** Ожидание: нет пробелов в покрытии дизайна и несогласованных изменений текущих пользовательских правок. Коммит `docs: explain agent memory layers and management`.

## Самопроверка плана

- Контракты Task 1 используются без переименования в репозиториях, API, snapshot, телеметрии и UI. Контекстные серверные типы определяет Task 4.
- Проекты/ветки покрывает Task 2; независимые записи — Task 3; правила промпта и бюджет — Task 4; статистику — Task 5; очистку и восстановление — Task 6; действия пользователя и страницу — Tasks 7–8.
- Обновлённый дизайн требует настраиваемые бюджеты: сохранение и диапазоны есть в Task 1/3, применение без фиктивного резервирования — Task 4, предварительное заполнение и UI — Task 8.
- Все пять Review Focus имеют конкретные проверки в указанных задачах. Общие проверки и документация сведены в Task 9.
- Тесты на UI-изменения ограничены смыслом показателей и ручными сценариями; новый браузерный тестовый фреймворк не устанавливается.
