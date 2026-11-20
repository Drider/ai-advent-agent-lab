# Task State and Optional Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сохранять состояние каждой задачи и обеспечивать кодом порядок действий явно подключённого workflow, включая утверждения, формальные проверки, паузу и восстановление.

**Architecture:** Отдельная библиотека неизменяемых версий workflow и транзакционный сервис задач используют существующую SQLite. HTTP, команды чата и инструменты агента вызывают один сервис; сервер проверяет переходы и рабочие действия. Обычный диалог сохраняет задачу без явного процесса.

**Tech Stack:** Существующие Nuxt 4.6.4, Vue, Nuxt UI, AI SDK 7.0.162, better-sqlite3, Zod 4, Vitest; одна новая прямая зависимость `yaml@^2` для пользовательских схем.

**Spec:** [Согласованный дизайн](../specs/2026-11-20-task-workflow-design.md). Исполнитель читает и спецификацию, и план. Отложенные функции находятся в [roadmap](../../task-workflow-roadmap.md).

## Global Constraints

- «Состояние задачи существует независимо от подключения workflow».
- «Диалог по умолчанию работает без явного workflow»; профильный default равен `null`, пока пользователь явно его не настроил.
- «В одном диалоге одновременно существует только одна незавершённая задача»; `paused` тоже незавершённая.
- «Workflow подключается к текущей задаче с момента подключения и начинает работу с начального этапа».
- «Утверждение плана приходит от пользователя через кнопку или точную команду и относится к конкретной версии плана».
- «Для аналитики достаточно успешных формальных тестов; отдельное принятие результата пользователем не требуется».
- «Анкета — необязательный workflow»; отсутствие анкеты не ограничивает обычные диалоги.
- «Вызов модели и внешние действия не входят в одну длительную транзакцию SQLite».
- «Модель не имеет инструмента “утвердить от имени пользователя”»; все роли и привязки к задаче приходят от сервера.
- Сохраняем `MAX_AGENT_STEPS = 40`, таймаут хода 600 000 мс, безопасное продолжение старого хода без изменяющих инструментов и предел текстовых файлов 16 КиБ.
- Не добавляем аккаунты, выполнение произвольного кода, редактирование репозитория агентом, графический редактор, генерацию/выбор схем агентом и автоматические записи памяти.
- Публикация схемы не меняет начатые задачи; очистка истории удаляет данные задач, самостоятельная память сохраняет существующее поведение.

## Review Focus

1. YAML с повторными ключами, alias, тегами или чрезмерной вложенностью отклоняется до публикации; одинаковые JSON/YAML дают одинаковый хеш. Тесты: Task 1.
2. Двойной клик, повтор после потери ответа и устаревшая вкладка не создают второй переход и не утверждают старую версию плана. Тесты: Tasks 3, 4, 8.
3. Поток оборвался до или после commit итогового материала: соответственно остаётся незавершённая задача либо доступный сохранённый результат `done`. Тесты: Task 7.
4. Скопированные tool parts, старая история и проектная память не восстанавливают права, утверждения и проверки другой задачи. Тесты: Tasks 7, 10.
5. Пауза и смена узла между подготовкой шага и фактическим инструментом, включая один параллельный пакет, запрещают новый эффект; неопределённая запись файла не повторяется. Тесты: Tasks 6, 7.

## Порядок и границы поставки

Tasks 1–5 создают проверяемый серверный автомат; Tasks 6–8 подключают реальные действия, агента и HTTP; Task 9 даёт пользовательский интерфейс; Tasks 10–11 завершают совместимость и приёмку. Это части одной функции с общими инвариантами, а не независимые проекты. Промежуточные коммиты проверяются, но включение функции для пользователя требует завершения всех задач.

До продуктовых изменений исполнитель создаёт изолированную ветку `codex/task-workflows` по `superpowers:using-git-worktrees`, сохраняет текущие пользовательские изменения и получает исходный результат `npm run typecheck`, `npm test`, `npm run build`. Текущие документы не являются результатом выполнения этих проверок.

В Step 5 каждой задачи исполнитель добавляет в индекс только перечисленные изменённые файлы этой задачи и выполняет указанную команду commit.

## Карта файлов

| Файлы | Ответственность |
| --- | --- |
| `shared/workflow.ts`, `server/workflows/schema.ts`, `parse.ts` | Формат процесса, ограниченный JSON/YAML и проверка графа. |
| `server/workflows/repository.ts`, `templates.ts` | Неизменяемые версии библиотеки и три готовых шаблона. |
| `shared/task.ts`, `server/tasks/errors.ts`, `repository.ts`, `commands.ts` | Контракты задачи, чтение, атомарные команды и журнал. |
| `server/tasks/workflow.ts`, `artifacts.ts`, `approvals.ts` | Переходы, версии материалов и пользовательские утверждения. |
| `server/tasks/validation.ts`, `checks.ts` | Запуск проверок, зависимости и детерминированные проверяющие функции. |
| `server/tasks/tool-policy.ts`, `tool-operations.ts`, `recovery.ts` | Проверка фактических вызовов, идемпотентность намерений и восстановление. |
| `server/tasks/context.ts`, `turn-runtime.ts`, `server/tools/tasks/` | Контекст задачи, подготовка шагов и инструменты агента. |
| `server/tasks/command-parser.ts`, `api-errors.ts`, новые API | Точные пользовательские команды, HTTP и единые ошибки. |
| `composables/useTasks.ts`, `useWorkflows.ts`, `components/Task*.vue`, `Workflow*.vue`, `pages/workflows.vue` | Карточка, управление задачей и текстовая библиотека процессов. |
| Существующие persistence, chat, profiles, memory-clear и branch файлы | Интеграция без смены назначения существующих сущностей. |

### Общий контракт для всех задач плана

Типы ниже определяет Task 1. Поздние задачи используют эти имена; дополнительные внутренние типы не входят в публичный контракт.

- `JsonValue`: JSON-значение с конечными числами и строковыми ключами. Ключи `__proto__`, `prototype`, `constructor` запрещены во входных структурированных данных.
- `ExpectedAction`: `{ actor: 'agent' | 'user' | 'system'; kind: 'input' | 'artifact' | 'approval' | 'validation' | 'result'; label: string; artifactKey?: string }`.
- `WorkflowDefinition`: `{ schemaVersion: 1; entryNodeId: string; resultArtifactKey: string; artifactSlots: ArtifactSlot[]; nodes: WorkflowNode[]; transitions: WorkflowTransition[]; checks: CheckDefinition[]; completionCheckIds: string[]; contextExports: string[] }`. `resultArtifactKey` указывает итоговый slot; проверенный отчёт нельзя заменить другим материалом в момент finish.
- `ArtifactSlot`: `{ key: string; type: 'plan' | 'answers' | 'dataset' | 'implementation' | 'report' | 'result' | 'note' }`.
- `WorkflowNode`: `{ id: string; kind: 'work' | 'approval' | 'validation' | 'success'; stage: string; label: string; expected: ExpectedAction; allowedTools: string[]; writableArtifacts: string[]; requiredApprovalKeys: string[]; checkIds: string[] }`.
- `WorkflowTransition`: `{ id: string; from: string; to: string; actor: 'agent' | 'user' | 'system'; event: 'advance' | 'approve' | 'checks_passed' | 'checks_failed'; guards: Guard[]; invalidateApprovalKeys: string[] }`. `Guard` — tagged union `artifact_present { artifactKey }`, `approval_current { artifactKey }`, `checks_current { checkIds }`, `checks_failed_current { checkIds }`.
- `CheckDefinition`: `{ id: string; kind: 'fields' | 'sections' | 'tool_success' | 'file_matches' | 'numeric'; artifactKeys: string[]; options: JsonValue }`. Для каждого `kind` Zod проверяет свой закрытый набор options, определённый в Task 5; произвольных интерпретируемых выражений нет.
- `WorkflowVersion`: `{ workflowId: string; version: number; definition: WorkflowDefinition; hash: string; createdAt: string }`. ID встроенных процессов: `questionnaire`, `code`, `analytics`; пользовательские ID генерирует сервер.
- `WorkflowSummary`: `{ id: string; name: string; latestVersion: number }`. Название процесса относится к библиотеке, а не к идентификатору узла или роли инициатора.
- `ArtifactRef`: `{ id: string; key: string; type: ArtifactSlot['type']; version: number; hash: string }`. `TaskArtifact` добавляет `taskId`, `content: JsonValue`, `sourceMessageIds: string[]`, `sourceToolCallIds: string[]`, `createdAt`.
- `TaskSnapshot`: `{ id: string; sessionId: string; task: string; status: 'active' | 'paused' | 'done' | 'cancelled'; workflowId: string | null; workflowVersion: number | null; nodeId: string | null; nodeVisitId: string | null; stage: string; step: string; expected: ExpectedAction; progress: string; revision: number; artifacts: ArtifactRef[]; result: ArtifactRef | null; recovery: 'clear' | 'needs_review'; createdAt: string; updatedAt: string }`. Для режима без workflow `stage` равен `execution`, после успеха — `done`; промежуточный `step` является заметкой, а не источником прав.
- `TaskActorContext`: `{ role: 'user' | 'agent' | 'system'; sessionId: string; turnId?: string; stepNodeVisitId?: string | null; stepIndex?: number }`. Контекст создаёт доверенный обработчик; модель его не заполняет.
- `TaskCommand`: tagged union `update_progress { progress, expected? }`, `submit_artifact { key, content, sourceMessageIds, sourceToolCallIds }`, `transition { transitionId }`, `validate`, `finish { resultArtifactId?; resultText? }`, `attach { workflowId, version }`, `pause`, `resume`, `cancel`, `complete_basic`, `approve { approvalId }`, `resolve_recovery { operationId, outcome: 'completed' | 'failed' }`. Строки ограничиваются общими лимитами; `finish` принимает ровно один источник результата.
- `TaskCommandEnvelope`: `{ operationId: string; expectedRevision: number; command: TaskCommand }`. `TaskCommandResult`: `{ ok: true; task: TaskSnapshot; resumeRequestId?: string } | { ok: false; error: { code: TaskErrorCode; message: string }; task: TaskSnapshot | null }`. `resumeRequestId` — сохранённый UUID следующего обычного хода после resume, одинаковый при повторе команды.
- `TaskErrorCode`: закрытый enum, включающий `INVALID_INPUT`, `NOT_FOUND`, `TASK_ALREADY_ACTIVE`, `TASK_PAUSED`, `TASK_CANCELLED`, `TASK_TERMINAL`, `STALE_TASK_REVISION`, `TRANSITION_NOT_ALLOWED`, `PLAN_APPROVAL_REQUIRED`, `VALIDATION_REQUIRED`, `RECOVERY_REVIEW_REQUIRED`, `SESSION_RUNNING`, `OPERATION_CONFLICT`, `CONTEXT_LIMIT`.
- `TaskView`: `{ task: TaskSnapshot | null; actions: Array<{ type: TaskCommand['type']; label: string; approvalId?: string; recoveryOperationId?: string }>; approvals: Array<{ id: string; artifact: ArtifactRef; status: 'pending' | 'approved' | 'obsolete' }>; validations: ValidationResult[]; recoveryOperations: Array<{ id: string; toolName: string; status: string; path?: string; expectedHash?: string; observedHash?: string }> }`.
- `ValidationResult`: `{ id: string; taskId: string; checkId: string; checkerVersion: 1; nodeVisitId: string; inputs: ArtifactRef[]; outcome: 'passed' | 'failed' | 'error'; details: JsonValue; createdAt: string }`.

Лимиты первой версии: схема 65 536 байт UTF-8, не более 64 узлов, 256 переходов, 16 слотов материалов и 32 проверок; вложенность JSON/YAML до 20; ID внутри схемы — ASCII `[a-z][a-z0-9_]{0,79}`; подписи до 200 символов. Материал — не более 16 384 байт сериализованного UTF-8 JSON; прогресс до 2 000 символов; цель до 500. Обязательный снимок с материалами и экспортированный контекст имеют раздельные пределы по 16 384 байт; переполнение возвращает явную ошибку. Хеш — SHA-256 канонического JSON с сортировкой ключей объектов, без перестановки массивов.

---

### Task 1: Контракты и проверяемый формат workflow

**Files:** Create `shared/task.ts`, `shared/workflow.ts`, `server/tasks/errors.ts`, `server/workflows/schema.ts`, `server/workflows/parse.ts`; modify `package.json`, `package-lock.json`; test `tests/workflow-schema.test.ts`.

**Interfaces:** Produces перечисленные выше типы; `parseWorkflowSource(source: string, format: 'json' | 'yaml'): WorkflowDefinition`; `validateWorkflowDefinition(input: unknown): WorkflowDefinition`; `workflowHash(definition: WorkflowDefinition): string`. Ошибки схемы содержат массив `{ path: string; message: string }`.

- [ ] **Step 1: Написать падающие тесты формата.**

```ts
it('canonicalizes equivalent JSON and YAML', () => {
  expect(workflowHash(parseWorkflowSource(jsonFixture, 'json')))
    .toBe(workflowHash(parseWorkflowSource(yamlFixture, 'yaml')))
})
```

Добавить `it.each` для дублирующегося ID, отсутствующего начального узла, недостижимого узла, неизвестной цели/проверки/инструмента, пустых completion checks, отсутствующего пути к success, alias, повторных ключей, тегов, `__proto__`, глубины 21 и схемы 65 537 байт. Проверять отказ с путём поля; корректный цикл доработки принимается. Для JSON тоже проверять повторные ключи: обычного `JSON.parse` недостаточно.

- [ ] **Step 2: Выполнить `npm test -- tests/workflow-schema.test.ts`.** Ожидается FAIL из-за отсутствующего модуля, а не ошибки окружения.
- [ ] **Step 3: Реализовать контракты, закрытые Zod-схемы, проверку графа и канонизацию.** Во время исполнения плана установить `npm install yaml@^2`. Использовать `parseDocument`, проверять `errors`, `uniqueKeys: true`, `version: '1.2'`, `schema: 'core'`, `stringKeys: true`; до преобразования отклонять alias, anchors и нестандартные tags, после — не-JSON значения и предельную глубину. В JSON-режиме сначала проверять строгий синтаксис через `JSON.parse`, затем проверять исходный текст document-парсером для обнаружения повторных ключей. Публичный API и AST описаны в [официальной документации yaml v2](https://eemeli.org/yaml/). Реестр известных инструментов включает существующие рабочие инструменты; task-control не выдаётся через пользовательские `allowedTools`.
- [ ] **Step 4: Повторить тест и `npm run typecheck`.** Ожидается PASS; новых импортов без объявления типов нет.
- [ ] **Step 5: Зафиксировать перечисленные файлы:** `git commit -m "feat: define task and workflow contracts"`.

### Task 2: SQLite и неизменяемая библиотека процессов

**Files:** Modify `server/persistence/migrations.ts`, `server/persistence/user-profile-repository.ts`, `shared/user-profile.ts`; create `server/tasks/repository.ts`, `server/workflows/repository.ts`; test `tests/task-db.test.ts`, `tests/workflow-repository.test.ts`; update `tests/chat-db.test.ts`.

**Interfaces:** Consumes Task 1. Produces `createWorkflowRepository(db)` with `list(): WorkflowSummary[]`, `get(id: string, version?: number): WorkflowVersion | null`, `create(name: string, definition: WorkflowDefinition): WorkflowVersion`, `publish(id: string, expectedVersion: number, definition: WorkflowDefinition): WorkflowVersion`; `createTaskRepository(db)` with `get(id): TaskSnapshot | null`, `getUnfinished(sessionId): TaskSnapshot | null`, `list(sessionId): TaskSnapshot[]`. Mutations задач доступны только сервисам следующих задач, не HTTP. Ошибки библиотеки: `NOT_FOUND` и `OPERATION_CONFLICT` для устаревшей expectedVersion.

- [ ] **Step 1: Написать падающие тесты миграции и версий.**

```ts
it('does not rewrite a published workflow version', () => {
  const v1 = workflows.create('Аналитика', definition)
  workflows.publish(v1.workflowId, 1, changedDefinition)
  expect(workflows.get(v1.workflowId, 1)?.hash).toBe(v1.hash)
})
```

Проверить миграцию файла версии 13 и повторное открытие версии 14, сохранение старых сообщений и профилей, `default_workflow_id IS NULL`, невозможность второй `active/paused` задачи в диалоге и независимость двух диалогов проекта. Обновить существующие точные ожидания версии и списка таблиц, сохранив старые сценарии миграций.

- [ ] **Step 2: Запустить `npm test -- tests/task-db.test.ts tests/workflow-repository.test.ts tests/chat-db.test.ts`.** Ожидается FAIL на новой схеме.
- [ ] **Step 3: Добавить миграцию 14 и репозитории.** Создать таблицы из дизайна плюс `task_tool_operations` для стабильных намерений; nullable FK `turns.task_id`, `tool_executions.task_id`, `tool_executions.task_operation_id` и `user_profiles.default_workflow_id`. Частичный UNIQUE `(session_id)` для `status IN ('active','paused')`; UNIQUE `(workflow_id,version)`, `(task_id,key,version)`, глобальный `task_commands.operation_id`, UNIQUE `(task_id,COALESCE(node_visit_id,''),action_key)` для намерений: обычный NULL не обеспечил бы уникальность basic-операций. Все данные имеют FK и проверяемый JSON, терминальные статусы — CHECK. Версии и материалы не обновляются на месте. `task_commands` хранит session ID, nullable task ID, хеш входа, phase `running/completed/rejected` и квитанцию; события отказа не увеличивают ревизию задачи. UserProfile/summary/snapshot получают nullable `defaultWorkflowId`; существующие поля и инструкции не меняются. Все записи нового слоя удаляются каскадно с задачей/диалогом; источники сообщений/ходов могут обнуляться.
- [ ] **Step 4: Повторить тесты, `npm run typecheck`.** Ожидается PASS, данные версии 13 сохранены.
- [ ] **Step 5: Коммит:** `git commit -m "feat: persist task state and workflow versions"`.

### Task 3: Базовый жизненный цикл и атомарные команды

**Files:** Create `server/tasks/commands.ts`; extend `server/tasks/repository.ts`; test `tests/task-lifecycle.test.ts`, `tests/task-transactions.test.ts`.

**Interfaces:** Consumes Task 2. Produces `createTaskService(db, options?: { now?: () => string; newId?: () => string })` with `create(input: { sessionId: string; task: string; operationId: string; workflow?: { id: string; version: number } | null }, actor: TaskActorContext): TaskCommandResult`, `apply(taskId: string, envelope: TaskCommandEnvelope, actor: TaskActorContext): Promise<TaskCommandResult>`, `view(taskId: string, sessionId: string): TaskView`, `reserveForTurn(input: { sessionId: string; kind: 'message' | 'continue'; requestId: string; sourceTurnId?: string; messageText: string; workflow?: { id: string; version: number } | null }, actor: TaskActorContext): TaskSnapshot | null`. Последний метод синхронный, вызывается system-контекстом внутри start-turn транзакции; legacy continue возвращает null. В этой задаче workflow-команды возвращают `TRANSITION_NOT_ALLOWED` до Task 4; базовые команды уже работают.

- [ ] **Step 1: Написать падающие тесты жизненного цикла и идемпотентности.**

```ts
it('replays a committed command after response loss', async () => {
  const first = await service.apply(task.id, pauseCommand, userContext)
  expect(await service.apply(task.id, pauseCommand, userContext)).toEqual(first)
  expect(countEvents(task.id, 'paused')).toBe(1)
})
```

Проверить active→paused→active, отмену в обоих состояниях, запрет новой задачи до terminal, ручное завершение basic из паузы, terminal immutable, отказ агента на pause/cancel/complete_basic, пустой результат, одинаковый operation ID с другим содержимым, stale revision, старый request после очистки. Инъекция ошибки между UPDATE и INSERT события должна откатить оба; две отдельные SQLite connection с одной ревизией дают один успех и один stale/conflict.

- [ ] **Step 2: Выполнить `npm test -- tests/task-lifecycle.test.ts tests/task-transactions.test.ts`.** Ожидается FAIL по отсутствующему сервису.
- [ ] **Step 3: Реализовать короткую транзакцию команды.** Проверять tombstone operation ID в `cleared_requests`, затем повтор operation ID до проверки ревизии и возвращать исходную квитанцию; сравнивать также session/task, роль и хеш входа. При принятии атомарно менять state/revision, событие и квитанцию. При отказе сохранять отрицательную квитанцию без изменения state/revision. Успешный resume сохраняет в квитанции новый resumeRequestId для одного последующего хода. Для `finish` basic сохранять итоговый материал и `done` вместе; при expected.actor=user завершение агентом запрещено. В basic произвольные разрешённые ключи материалов сохраняются как note, итог — как result; Task 4 выносит эту запись в общий artifact store. При создании блокировать работающий ход, pending history clear и unresolved tool operation. Для пустой задачи initial цель «Новая задача», expected — ввод пользователя. Не держать транзакцию открытой через `await`.
- [ ] **Step 4: Повторить тесты и `npm run typecheck`.** Ожидается PASS, после reopen сохраняются узел ожидания, прогресс и итоговый материал.
- [ ] **Step 5: Коммит:** `git commit -m "feat: enforce transactional task lifecycle"`.

### Task 4: Переходы workflow, материалы и утверждения

**Files:** Create `server/tasks/workflow.ts`, `artifacts.ts`, `approvals.ts`; extend `commands.ts`; test `tests/workflow-transitions.test.ts`, `tests/task-approvals.test.ts`, `tests/task-artifacts.test.ts`.

**Interfaces:** Consumes Tasks 1–3. Produces `evaluateTransition(task: TaskSnapshot, definition: WorkflowDefinition, transitionId: string, evidence: { artifacts: TaskArtifact[]; approvals: TaskView['approvals']; validations: ValidationResult[] }, actor: TaskActorContext): { allowed: true; targetNodeId: string } | { allowed: false; code: TaskErrorCode }`; `createArtifactStore(db).latest(taskId, key): TaskArtifact | null`; approvals, material writes и attach/transition обрабатываются только `TaskService.apply`.

- [ ] **Step 1: Написать падающие тесты запретов и версий.**

```ts
it('rejects implementation before the current plan is approved', async () => {
  const before = service.view(task.id, sessionId).task!
  const result = await service.apply(task.id, implementationCommand, agentContext)
  expect(result).toMatchObject({ ok: false, error: { code: 'PLAN_APPROVAL_REQUIRED' } })
  expect(service.view(task.id, sessionId).task!.revision).toBe(before.revision)
})
```

Проверить неизвестный переход, прямой planning→done, `actor=user` от агента, чужой диалог/артефакт/approval, утверждение v1 после публикации v2, attach к текущей basic-задаче без зачёта старой истории, запрет повторного attach и смены версии, паузу в каждом узле. Возврат в планирование создаёт новое посещение и обесценивает старое утверждение, даже если текст ещё не поменялся.

- [ ] **Step 2: Выполнить `npm test -- tests/workflow-transitions.test.ts tests/task-approvals.test.ts tests/task-artifacts.test.ts`.** Ожидается FAIL на неработающих workflow-командах Task 3.
- [ ] **Step 3: Реализовать engine и обработчики в общей транзакции.** Состояние stage/step/expected выводить из закреплённого узла. Material version увеличивать только для нового материала; проверять источники и разрешённый slot. Вход в approval-узел создаёт pending request, привязанный к версии/хешу материала и посещению. Только пользовательский approve подтверждает request и применяет его единственный user/approve-переход. Для каждого требуемого slot хранить ссылку на активный approval request: она сохраняется при движении вперёд, сбрасывается при изменении его материала и переходе с `invalidateApprovalKeys`. Не сравнивать source approval visit с текущим execution visit: это разные посещения. Подмена role из envelope невозможна. Completion сначала проверяет актуальные глобальные completion checks, даже если схема пытается зайти в success другим путём; для явного workflow finish принимает только актуальный resultArtifactKey, а resultText допустим только в basic. Никакой инструмент не меняет stage напрямую.
- [ ] **Step 4: Повторить новые тесты и тесты Tasks 2–3.** Ожидается PASS; каждый отказ сохраняет прежнюю ревизию.
- [ ] **Step 5: Коммит:** `git commit -m "feat: guard workflow transitions and plan approval"`.

### Task 5: Формальные проверки и три готовых процесса

**Files:** Create `server/tasks/checks.ts`, `validation.ts`, `server/workflows/templates.ts`, `server/plugins/task-workflows.ts`; extend schema/commands; test `tests/task-validation.test.ts`, `tests/workflow-templates.test.ts`.

**Interfaces:** Consumes Task 4. Produces `evaluateCheck(check: CheckDefinition, inputs: TaskArtifact[], context: { toolResults: Array<{ toolCallId: string; name: string; output: JsonValue }>; readTextFile: (path: string) => Promise<string> }): Promise<Pick<ValidationResult, 'outcome' | 'details'>>`; `runTaskValidation(db, input: { taskId: string; checkIds: string[]; actor: TaskActorContext; operationId: string; expectedRevision: number }): Promise<TaskCommandResult>`; `seedBuiltInWorkflows(db): void`. `TaskService.apply(validate)` делегирует этому исполнителю; он владеет квитанцией асинхронной команды.

- [ ] **Step 1: Написать падающие тесты арифметики, схем и зависимостей.**

```ts
it('fails a claimed total that differs from the saved dataset', async () => {
  const result = await evaluateCheck(sumCheck, [dataset([10, 20]), report({ sum: 31 })], context)
  expect(result.outcome).toBe('failed')
})
```

Проверить count=2, sum=30, mean=15 на том же наборе; пустой массив, NaN/Infinity, отсутствие поля, иной хеш входа, отсутствующий файл, `{ok:false}`, исключение проверяющего кода и JSON/YAML с неизвестными options. Изменение любого зависимого материала блокирует done до повторной проверки. Неподключённая анкета не вводит ограничений; подключённая не пропускает обязательный ответ. Seed идемпотентен и не перезаписывает опубликованные версии.

- [ ] **Step 2: Выполнить `npm test -- tests/task-validation.test.ts tests/workflow-templates.test.ts`.** Ожидается FAIL по отсутствующим проверкам/шаблонам.
- [ ] **Step 3: Реализовать закрытый реестр и шаблоны.** Options: `fields` — `fields[{path,type,required,min?,max?,enum?}]`; `sections` — `headings:string[]`; `tool_success` — `{toolName}` с адаптером реального output; `file_matches` — `{pathField,contentField}`; `numeric` — `{datasetKey,recordsPath,valuePath,reportKey,metric:'count'|'sum'|'mean',reportedPath,tolerance}`. Paths ограничены сегментами ключей, без прототипов и исполняемых выражений. Пустой набор для mean — failed; tolerance конечен и неотрицателен. tool_success использует receipts из источников проверяемого материала, а не любой успешный вызов в диалоге. Входы и phase=running резервируются короткой транзакцией до async I/O; итоговая квитанция, результаты и event коммитятся вместе только при прежних версиях и подходящем состоянии. Повтор завершённой команды возвращает квитанцию, running — временный OPERATION_CONFLICT без второго запуска; после restart чтение можно безопасно повторить. Внешний файл читается через существующий workspace. Общий completion rerun выполняет весь набор проверок текущих версий.

Шаблон `questionnaire`: collect_answers→validate_answers→answer_request→validate_result→done; поля `goal`, `experience`, `responseFormat`; exports `answers`, resultArtifactKey=`result`. `code`: draft_plan→approve_plan→implementation→validation→done; plan slot обязателен, implementation — `{language,files:[{path,content}]}`, проверка структурная, resultArtifactKey=`implementation`. `analytics`: draft_plan→approve_plan→collect_data→report→validation→done; dataset `{records:[{value:number}]}`, report `{sourceRefs,count,sum,mean,markdown,path}`; заголовки «Данные», «Результаты», «Выводы», допуск `1e-9`, подтверждённый write_file и совпадение content/hash, resultArtifactKey=`report`. Dataset импортируется из подтверждённого read_file текущей задачи: сервер сравнивает canonical content с разобранным JSON receipt и отклоняет подмену значений моделью. Plan=`{text:string}`. Для rework задать явные обратные переходы; возврат к draft_plan сбрасывает approval. Встроенные схемы проходят тот же публичный валидатор, что пользовательские.

- [ ] **Step 4: Повторить тесты, `npm run typecheck`.** Ожидается PASS; доказательством успеха являются только сохранённые результаты реестра.
- [ ] **Step 5: Коммит:** `git commit -m "feat: validate task results and seed workflow templates"`.

### Task 6: Проверка реальных инструментов, пауза и восстановление

**Files:** Create `server/tasks/tool-policy.ts`, `tool-operations.ts`, `recovery.ts`; modify `server/agent/recorded-tools.ts`, `server/persistence/turn-repository.ts`, `server/plugins/chat-recovery.ts`; test `tests/task-tool-policy.test.ts`, `tests/task-operation-recovery.test.ts`; extend `tests/recorded-tools.test.ts`.

**Interfaces:** Consumes Tasks 3–5. Produces `assertTaskToolAllowed(db, input: { taskId: string; toolName: string; actor: TaskActorContext }): void`; `createTaskToolOperations(db)` with `reserve(input: { taskId; toolName; nodeVisitId; actionKey; input: JsonValue; toolCallId; turnId }): { kind: 'execute'; id: string } | { kind: 'replay'; id: string; output: JsonValue }`, `complete(id, output)`, `fail(id, error)`, `resolve(id, actor: TaskActorContext): Promise<void>`. `nodeVisitId` nullable для basic; строковые поля имеют тип `string`.

- [ ] **Step 1: Написать падающие тесты фактического эффекта.**

```ts
it('does not write after pause committed between prepareStep and execute', async () => {
  const invoke = preparedWrite()
  await pauseTask()
  await expect(invoke()).rejects.toMatchObject({ code: 'TASK_PAUSED' })
  expect(writeSpy).not.toHaveBeenCalled()
})
```

Проверить переход+write_file в одном пакете, повтор того же action key с новым tool_call_id без повторного I/O, изменённый input при том же key, ошибку записи намерения, падение после записи файла до receipt, отсутствие auto-retry неизвестного эффекта, late result после отмены и запрет следующей задачи до разрешения неопределённости. Чтение не блокируется ложным конфликтом из-за параллельной записи заметки прогресса.

- [ ] **Step 2: Выполнить `npm test -- tests/task-tool-policy.test.ts tests/task-operation-recovery.test.ts tests/recorded-tools.test.ts`.** Ожидается FAIL на отсутствии task-политики.
- [ ] **Step 3: Реализовать две защиты.** На каждом вызове атомарно проверять running turn, статус задачи, recovery, server-captured step visit и права узла, затем фиксировать намерение. Для task-bound изменяющих инструментов внешний schema-adapter добавляет обязательный `actionKey` (ASCII ID до 80 символов); перед вызовом исходного execute удаляет это поле. Прежний schema/execute остаётся для standalone-тестов без task runtime. UNIQUE по task/visit/actionKey фиксирует логическое намерение независимо от tool_call_id; новый key — новое намерение, универсальная семантическая дедупликация не обещается. Replay возвращает сохранённый output. Реестр явно перечисляет read-only/mutating и смысл успешного результата каждого подключённого инструмента; неизвестный инструмент явного workflow запрещён.

После I/O сохранять реальный receipt даже при pause/cancel, но запрещать продвижение старого узла. Task mutation, task event и durable tool receipt для операций внутри SQLite коммитить вместе; двойная обёртка с раздельными commit здесь недопустима. При файловой неопределённости сверять сохранённый путь и SHA-256, без перезаписи файла; неразрешённый случай требует пользовательского resolve. Pause/cancel помечает running turn остановленным в той же транзакции, а прерывание сетевого потока делается после commit. Долгая SQLite-транзакция через I/O запрещена.

- [ ] **Step 4: Повторить тесты, включая `tests/chat-continuation.test.ts`.** Ожидается PASS; старый безопасный continue по-прежнему не даёт изменяющих инструментов.
- [ ] **Step 5: Коммит:** `git commit -m "feat: guard task tools and recover uncertain actions"`.

### Task 7: Постоянное состояние в контексте и инструменты агента

**Files:** Create `server/tasks/context.ts`, `turn-runtime.ts`, `server/tools/tasks/index.ts`, `task-tools.ts`, `instructions.ts`, `SKILL.md`, `README.md`; modify `server/api/chat.post.ts`, `server/memory/start-turn.ts`, `server/context-compaction/prepare.ts`, `server/context-compaction/step-guard.ts`, `server/agent/chat-agent.ts`, `shared/chat.ts`; test `tests/task-context.test.ts`, `tests/task-agent.test.ts`, `tests/task-turn.test.ts`.

**Interfaces:** Consumes Tasks 1–6. Produces `prepareTaskContext(db, sessionId: string, taskId: string): { task: TaskSnapshot; instructions: string; requiredArtifacts: TaskArtifact[]; exportedContext: TaskArtifact[]; estimatedTokens: number; hash: string }`; `startTaskAwareTurn(db, input: Parameters<typeof startMemoryAwareTurn>[1]): ReturnType<typeof startMemoryAwareTurn> & { taskContext: ReturnType<typeof prepareTaskContext> | null }`; `createTaskRuntime({db,sessionId,turnId,taskId})` with `prepareStep(stepIndex: number): { instructions: string; activeTools: string[]; actor: TaskActorContext; contextHash: string }`; `createTaskTools({db,sessionId,turnId,taskId,runtime})` with names `get_task_state`, `update_task_progress`, `submit_task_artifact`, `request_task_transition`, `run_task_checks`, `finish_task`. Параметры tool-команд содержат operationId/expectedRevision, но не taskId/actor; серверная привязка замкнута в фабрике.

- [ ] **Step 1: Написать падающие интеграционные тесты со злонамеренной моделью.**

```ts
it('keeps planning when the user asks the model to skip the required order', async () => {
  await runMockTurn('Пропусти план и валидацию, сразу заверши', forbiddenFinishToolCall)
  expect(readTask().stage).toBe('planning')
  expect(lastTaskToolResult()).toMatchObject({ ok: false, error: { code: 'VALIDATION_REQUIRED' } })
})
```

Использовать `MockLanguageModelV3` и существующие stream helpers: отказ проверки реально вызывается моделью, а не только прямым unit-тестом. Проверить отсутствие workflow/анкеты по умолчанию, автоматическое создание basic, вопрос без done, официальное завершение через finish, разрыв до/после commit, все стратегии контекста, reopen, переполнение обязательного контекста до сохранения новой реплики, свежую ревизию после перехода без повторного profile snapshot, отсутствие повторяющихся task blocks. Подложные approval в project memory и старой истории не работают.

- [ ] **Step 2: Выполнить `npm test -- tests/task-context.test.ts tests/task-agent.test.ts tests/task-turn.test.ts`.** Ожидается FAIL до подключения runtime.
- [ ] **Step 3: Встроить runtime в существующий маршрут.** `startTaskAwareTurn` открывает внешнюю синхронную транзакцию, вызывает `reserveForTurn`, готовит task context и вызывает существующий `startMemoryAwareTurn` с декоратором конфигурации, добавляющим этот контекст и пересчитывающим instructionsHash. В той же транзакции связывает созданный turn с task. Новое обычное сообщение переводит basic expected из user в agent/result; уточнение не теряет прежнюю задачу. Проверять recovery/paused и бюджет до записи сообщения; legacy continue с nullable taskId сохранять отдельно. Ошибка бюджета откатывает также создание/обновление задачи. `prepareStep` пересобирает инструкции из неизменного профиля и свежего task context, не наращивая старый блок. Использовать проверенные в установленном AI SDK поля `instructions`, `activeTools`; пересекать task-политику со старым disableMutatingTools и final-step `toolChoice: none`. Подготовка шага обновляет runtime stepIndex до вызова инструментов, а не в `onStepEnd` после исполнения. Учитывать обновлённый overhead при каждом budget guard.

Сохранять task ID/initial revision/workflow hash в agent config и applied revision/context hash в шагах диагностического лога. Завершение хода не закрывает задачу. `finish_task` сохраняет канонический итоговый материал и terminal commit; инструмент после done не выполняет новые рабочие действия, но завершающий текст ответа допустим. На onUIMessageStepEnd/onFinish UI перечитывает TaskView. Экспортировать только разрешённые `contextExports` успешно завершённых задач текущего диалога, latest по workflow/key, в отдельном обозначенном блоке; чужие approvals не экспортировать. Скилл входит в runtime instructions через общий `instructions.ts`, а `SKILL.md` описывает тот же контракт; общего менеджера скиллов не создавать.

- [ ] **Step 4: Повторить новые тесты и регрессионные `tests/chat-agent.test.ts`, `tests/persisted-chat.test.ts`, `tests/memory-start-turn.test.ts`, `tests/chat-continuation.test.ts`, `tests/user-profile-turn.test.ts`.** Ожидается PASS; тесты без task runtime сохраняют прежние интерфейсы фабрик.
- [ ] **Step 5: Коммит:** `git commit -m "feat: connect persistent task state to agent turns"`.

### Task 8: HTTP, точные команды пользователя и профильный default

**Files:** Create `server/tasks/api-errors.ts`, `command-parser.ts`; create `server/api/workflows/index.get.ts`, `index.post.ts`, `[id].get.ts`, `[id]/versions.post.ts`, `validate.post.ts`; create `server/api/sessions/[id]/tasks/index.get.ts`, `index.post.ts`; create `server/api/tasks/[id].get.ts`, `[id]/actions.post.ts`; create `server/api/sessions/[id]/task-command.post.ts`; create `server/api/user-profiles/[id]/workflow.patch.ts`; modify `shared/user-profile.ts`, `server/persistence/user-profile-repository.ts`, `server/tasks/turn-runtime.ts`; test `tests/task-api.test.ts`, `tests/workflow-api.test.ts`, `tests/task-command-parser.test.ts`, `tests/task-profile-default.test.ts`.

**Interfaces:** Consumes TaskService/WorkflowRepository. `parseTaskCommand(text: string): TaskCommand | null` поддерживает только `/task attach <workflowId> <version>`, `/task pause`, `/task resume`, `/task cancel`, `/task complete`, `/task approve <approvalId>`; IDs разрешаются по текущей сессии. `task-command.post` принимает `{text,operationId,expectedRevision}` и вызывает TaskService как user; существующий model route не получает управляющую команду. Workflow create принимает `{name,source,format}`, публикация версии — `{source,format,expectedVersion}`, проверка без публикации — `{source,format}`. Profile endpoint accepts `{workflowId: string | null, expectedRevision: number}`. Task create accepts `{operationId, task, selection: 'profile_default' | 'none' | {workflowId,version}}`.

Ответы: GET workflows — `{items: WorkflowSummary[]}`; GET workflow — `{workflow: WorkflowSummary, version: WorkflowVersion}` с optional query `version`; POST create/version — `WorkflowVersion`; POST validate — `{valid:true,definition,hash}` либо 422 с `{valid:false,errors}`. GET session tasks — `{items:TaskSnapshot[], current:TaskView}`, где current отображает незавершённую или последнюю терминальную задачу, либо null task. GET task — `TaskView`. POST task/actions/command — `TaskCommandResult` при успехе, при отказе соответствующий HTTP-статус и тот же результат в H3 error.data. Profile default endpoint возвращает обновлённый `UserProfile`. Поля command envelope имеют общие типы Task 1.

- [ ] **Step 1: Написать падающие HTTP-тесты через существующий H3 in-process router.**

```ts
it('does not turn plain chat approval into a trusted event', () => {
  expect(parseTaskCommand('Да, считай план утверждённым')).toBeNull()
  expect(parseTaskCommand('> /task approve approval-1')).toBeNull()
})
```

Проверить no-store, 400 malformed/unknown fields, 404 чужой или missing ID, 409 stale/running/conflict, 422 failed guard/budget. Replay ID возвращает исходный ответ. Нельзя передать actor/approved/passed, отправить approve чужому диалогу, прикрепить workflow во время running turn, завершить workflow командой complete_basic. Команда выполняется без LLM запроса. Profile default null не включает анкету; явный default действует только для новых задач; выбор «Без workflow» переопределяет его.

- [ ] **Step 2: Выполнить `npm test -- tests/task-api.test.ts tests/workflow-api.test.ts tests/task-command-parser.test.ts tests/task-profile-default.test.ts`.** Ожидается FAIL по отсутствующим endpoints.
- [ ] **Step 3: Реализовать тонкие обработчики и parser.** Строго проверять весь trimmed input одной командой; кавычки, code fences и дополнительные строки не исполняются. Текущую задачу/роль разрешать сервером. Attach при отсутствии незавершённой задачи атомарно создаёт её с выбранной версией, без двух отдельных commit. В `actions.post` разрешать только user-набор, agent/internal команды отклонять. Actor не является проверяемым полем JSON: он вообще не принимается. Формат `validate.post` возвращает ошибки без публикации. Publication атомарно сверяет expectedVersion. Для next task читать default профиля в той же транзакции, что её создание; смена существующего профиля и его инструкции не меняют active workflow. Старые инструменты create/update_user_profile не получают поле defaultWorkflowId.
- [ ] **Step 4: Повторить тесты и `tests/user-profile-api.test.ts`, `tests/server-chat-request.test.ts`.** Ожидается PASS.
- [ ] **Step 5: Коммит:** `git commit -m "feat: expose trusted task controls and workflow API"`.

### Task 9: Управление задачей и текстовая библиотека в интерфейсе

**Files:** Create `composables/useTasks.ts`, `useWorkflows.ts`, `components/TaskStateCard.vue`, `TaskHistory.vue`, `TaskArtifactViewer.vue`, `WorkflowSelector.vue`, `WorkflowEditor.vue`, `pages/workflows.vue`; modify `components/ChatWorkspace.vue`, `pages/chat/[id].vue`, `components/UserProfileEditor.vue`, `pages/profiles.vue`; create `shared/task-ui.ts` for command/action request mapping; test `tests/task-ui.test.ts`, `tests/task-state-card.test.ts`.

**Interfaces:** Consumes `TaskView` and Task 8 APIs. `useTasks(sessionId: MaybeRefOrGetter<string>)` exposes reactive `view/history/loading/error`, `refresh(): Promise<void>`, `act(command: TaskCommand): Promise<TaskCommandResult>`, `submitCommand(text: string): Promise<{ handled: boolean; result?: TaskCommandResult }>`. `useWorkflows()` exposes `items`, `load()`, `validate(source,format)`, `publish(input)`. UI генерирует operationId один раз на действие и сохраняет его при retry; expectedRevision берёт из отображённого TaskView. `TaskStateCard` props `{view:TaskView;busy:boolean;error?:string|null}`, emits `{action:[TaskCommand];openArtifact:[string]}`.

- [ ] **Step 1: Написать падающие тесты значимого отображения и запросов.**

```ts
it('shows an optional workflow without requesting a questionnaire', async () => {
  const html = await renderTaskCard(basicTaskView)
  expect(html).toContain('Без workflow')
  expect(html).toContain('Подключить workflow')
  expect(html).not.toContain('Заполните анкету')
})
```

Для SSR-компонента использовать существующий подход `tests/project-selector.test.ts`, не добавлять новый тестовый стек. Проверить paused с сохранённым этапом, pending approval точной версии, сохранённый terminal result, запрет кнопки из отсутствующего server action, повтор mutation после сетевой ошибки с прежним ID, stale response из предыдущего sessionId. Resume после подтверждения автоматически отправляет один обычный запрос с сохранённым resumeRequestId и без повторного ввода цели; retry не создаёт другой request ID. Тестировать mapping команд в endpoint, не статические CSS-строки.

- [ ] **Step 2: Выполнить `npm test -- tests/task-ui.test.ts tests/task-state-card.test.ts`.** Ожидается FAIL по отсутствующим компонентам/mapper.
- [ ] **Step 3: Добавить карточку, историю и библиотеку на существующем Nuxt UI.** До sendMessage распознавать полный `/task` ввод и направлять в trusted command endpoint; server parser остаётся защитой. После команды обновлять TaskView без LLM. Исключение — подтверждённый resume: затем UI автоматически вызывает sendMessage с текстом «Продолжи текущую задачу с сохранённого шага», kind=message и сохранённым resumeRequestId. Transport должен сохранять этот переданный UUID вместо генерации нового; повтор requestId блокирует существующий turn repository. «Продолжить ответ» сохраняет прежнюю кнопку и kind=continue. Кнопки pause/cancel доступны при streaming: сначала серверная команда, затем локальный `stop()`. Watch завершённых server tool parts вызывает refresh один раз на новую пару toolCallId/output-state; onFinish также обновляет состояние. Polling без события не вводить. На смене диалога игнорировать старые async responses.

Страница workflows даёт список, JSON/YAML textarea, preview ошибок и публикацию версии. Подключение выбирает фиксированную версию и подтверждается действием пользователя. Для profile default отдельное nullable поле и отдельный endpoint; обычный save инструкций его не отправляет. Не добавлять граф, drag-and-drop или генерацию процессов. Показать busy/error и сохранять пользовательский черновик при ошибке публикации.

- [ ] **Step 4: Повторить тесты и `npm run typecheck`.** Затем вручную проверить обычный чат, подключение посередине, кнопку/команду approve, паузу и отмену. Изменение состояния отображается после подтверждения сервера.
- [ ] **Step 5: Коммит:** `git commit -m "feat: add task controls and workflow library UI"`.

### Task 10: Ветки, очистка, экспорт контекста и старые диалоги

**Files:** Create `server/tasks/cleanup.ts`; modify `server/memory/clear-repository.ts`, `clear-service.ts`, `server/persistence/branch-repository.ts`, `session-repository.ts`, `server/tasks/context.ts`, `server/tasks/turn-runtime.ts`; test `tests/task-dialogue-lifecycle.test.ts`; extend `tests/branch-repository.test.ts`, `tests/memory-clear.test.ts`, `tests/memory-clear-recovery.test.ts`, `tests/chat-backup.test.ts`.

**Interfaces:** Consumes Tasks 2–9. Produces `assertTaskSessionQuiescent(db, sessionId: string): void`, `clearSessionTaskData(db, sessionId: string): void` — вызываются внутри существующей транзакции очистки, до удаления сообщений/ходов. SessionDetail добавляет `taskView: TaskView`, `taskHistory: TaskSnapshot[]`; legacy absent task возвращает `taskView.task=null`.

- [ ] **Step 1: Написать падающие интеграционные тесты жизненного цикла диалога.**

```ts
it('branches context without inheriting task authority', async () => {
  const child = branches.createBranch({ parentSessionId, throughMessageId })
  expect(tasks.getUnfinished(child.id)).toBeNull()
  expect(countApprovals(child.id)).toBe(0)
  expect((await sessions.getSession(child.id))!.messages.length).toBeGreaterThan(0)
})
```

Проверить clear удаляет task/artifact/event/command/approval/validation/operation/export, не удаляет самостоятельную память и внешние файлы, блокируется при running/uncertain operation. Старые task IDs/approval IDs/request IDs нельзя повторно использовать. Pending log cleanup по-прежнему блокирует диалог. Экспорт анкеты читается только в том же диалоге после успешного завершения; другая ветка/проект не получает его как новый авторитетный блок. Backup/reopen сохраняет paused задачу и корректное продолжение. Legacy interrupted response продолжается без фиктивной задачи/утверждений.

- [ ] **Step 2: Выполнить `npm test -- tests/task-dialogue-lifecycle.test.ts tests/branch-repository.test.ts tests/memory-clear.test.ts tests/memory-clear-recovery.test.ts tests/chat-backup.test.ts`.** Ожидается FAIL на отсутствии task cleanup/изоляции.
- [ ] **Step 3: Встроить cleanup и чтение состояния.** Сначала проверять отсутствие running/uncertain operations; до удаления `task_commands` сохранять их operation IDs в существующий `cleared_requests` с sessionId/clearedAt. Это блокирует также повтор старого attach/create после очистки, когда исходной задачи уже нет. Затем удалять task data и старые контексты в общей транзакции. Не сохранять скрытые копии материалов в новых диагностических метаданных; существующая ротация/удаление run log остаётся общей. Ветка не копирует задачи, экспортные bindings, approvals или validations; скопированные UI tool parts не анализируются как доказательство. История проекта не становится списком одной общей задачи. Текущая project memory остаётся общей и явно маркируется как контекст.
- [ ] **Step 4: Повторить тесты.** Ожидается PASS, включительно с reopening и pending cleanup recovery.
- [ ] **Step 5: Коммит:** `git commit -m "fix: isolate task state across dialogue lifecycle"`.

### Task 11: Сквозная приёмка, документация и итоговые проверки

**Files:** Create `tests/task-workflow-acceptance.test.ts`, `docs/task-workflows.md`, `docs/task-workflows-manual-test.md`; modify `README.md`, `docs/agent-memory.md`, `docs/chat-session-persistence.md`, `docs/chat-branching.md`, `docs/user-profiles.md`, `server/tools/README.md`; update design/roadmap statuses только после фактического завершения.

**Interfaces:** Consumes готовые публичные API, реальные engine/tool wrappers и MockLanguageModelV3; новых обходных тестовых маршрутов не создаёт.

- [ ] **Step 1: Написать приёмочные тесты трёх процессов через реальный путь приложения.**

```ts
it('completes analytics only after independent numeric and file checks pass', async () => {
  await executeAnalyticsScenario({ values: [10, 20], initialReportedSum: 31 })
  expect(snapshotBeforeCorrection().status).toBe('active')
  expect(finalSnapshot().status).toBe('done')
  expect(validatedMetrics()).toMatchObject({ count: 2, sum: 30, mean: 15 })
})
```

В сценариях использовать настоящий временный файл, SQLite reopen и злонамеренные tool calls модели. Отдельно: неподключённая анкета не запускается; questionnaire не пропускает ответы и возвращается к исходному запросу; code не публикует implementation до approve; direct skip возвращает отказ; пауза/продолжение работает для каждого узла. Тесты не должны сами напрямую выставлять approved/passed/done в базе.

- [ ] **Step 2: Запустить `npm test -- tests/task-workflow-acceptance.test.ts`.** Если обнаружится gap — получить FAIL на реальном дефекте; исправить владеющий модуль, без ослабления утверждений и без нового обходного API.
- [ ] **Step 3: Обновить документацию и ручной сценарий.** Удалить устаревшее отождествление «проект = одна задача» в текущих пользовательских документах; исторические specs/plans не переписывать. Описать три уровня состояния, отсутствие workflow по умолчанию, добровольную анкету, точные команды, старую и новую операции продолжения, границы структурной проверки кода и свободного текста, экспорт только внутри диалога, поведение очистки/ветки. Roadmap не помечать выполненным: генерация, граф и редактор остаются отложенными.
- [ ] **Step 4: Выполнить `npm run typecheck`, `npm test`, `npm run build` и ручной сценарий.** Ожидается exit code 0 для всех трёх команд. Для ручного прогона сохранить результаты действий и убедиться в неизменном node/revision при запрещённом переходе, включая прямую просьбу нарушить порядок. Падения исходной базы проверок отделить от новых; завершение не заявлять, пока относящиеся к изменению дефекты не исправлены.
- [ ] **Step 5: Коммит:** `git commit -m "test: verify task workflow enforcement end to end"`.

## Покрытие спецификации и самопроверка плана

| Требование | Задачи |
| --- | --- |
| Обязательное состояние, basic без workflow, последовательные задачи | 2, 3, 7, 9 |
| Структурные пользовательские схемы и неизменяемые версии | 1, 2, 4, 8, 9 |
| Подключение к текущей задаче с начального узла | 4, 8, 9 |
| Запрет перепрыгивания и независимое утверждение | 4, 6, 7, 8, 11 |
| Формальные тесты и актуальность доказательств | 4, 5, 11 |
| Пауза, отмена, restart, неизвестный внешний эффект | 3, 6, 7, 10, 11 |
| Профиль и скилл без отмены серверного контроля | 7, 8, 9 |
| Память, бюджеты и продолжение без повторных объяснений | 7, 10 |
| Необязательная анкета только в выбранном диалоге | 5, 7, 9, 10, 11 |
| Ветки, legacy, cleanup, backup | 2, 7, 10 |
| Визуализация и генерация остаются в roadmap | 9, 11 |

План проверен по секциям спецификации, входным/выходным интерфейсам задач и пяти Review Focus. Все тесты, команды и чекбоксы выше относятся к будущему исполнению; написание плана не означает их прохождения.

## Передача в реализацию

Пользователь проверяет план и выбирает способ исполнения до продуктовых изменений. Рекомендация для этой работы — subagent-driven: серверные команды, доказательства, реальный tool execute и streaming имеют несколько границ безопасности, для которых полезна независимая проверка каждого завершённого блока. Native остаётся доступным вариантом с меньшими затратами на координацию.
