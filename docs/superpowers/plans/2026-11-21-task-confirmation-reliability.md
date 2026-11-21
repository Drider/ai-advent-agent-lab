# Task Confirmation Reliability Implementation Plan

> **For agentic workers:** Read the spec and implement tasks in order. Track the checkboxes. Work in the existing branch without overwriting its uncommitted task-lifecycle changes.

**Goal:** Сделать запрос этапа, подтверждение пользователем и последующее чтение результата однозначными для UI и агента; дать исправлять ответы анкеты и видеть профиль до создания.

**Architecture:** SQLite остаётся источником состояния; один `TaskSnapshot` проецируется для UI и нового read-инструмента агента. Переход хранит идентификатор, ревизию и последний исход; подтверждение применяет его транзакционно. UI показывает исход PATCH и запускает следующий ход только по отдельному действию пользователя.

**Tech Stack:** Nuxt 4, Vue 3 (`<script setup lang="ts">`), TypeScript, `better-sqlite3`, AI SDK tools, Vitest.

**Spec:** [2026-11-21-task-confirmation-design.md](../specs/2026-11-21-task-confirmation-design.md). Исходное поведение: [task-lifecycle.md](../../task-lifecycle.md).

## Global Constraints

- Пользователь подтверждает смену этапа; инструмент агента лишь создаёт pending.
- История сообщений не служит источником этапа или ответов. Сервер никогда не принимает `sessionId`/`turnId` из аргументов модели.
- Существующие `/task approve`, `/task reject`, `pendingStage`, `pendingSummary` и старые HTTP-клиенты работают в переходный период.
- Подтверждение анкеты создаёт профиль только после показа точного предпросмотра. Повтор не создаёт второй профиль.
- Учитывать уже изменённое рабочее дерево; этот план не требует коммитов и не включает выполнение кода.

## Review Focus

- Подтверждение в момент истечения TTL: единственный исход, повторное подтверждение возвращает его же (Task 2).
- Старый pending после миграции: остаётся видимым и подтверждаемым, получает ID и срок (Task 1).
- Несовпадающие `expectedRevision` и ID: 409 со свежим снимком, этап не меняется (Task 2).
- Повторное сохранение ответа после правки: предпросмотр соответствует последней ревизии, старый approve не создаёт профиль (Task 5).
- Перезагрузка вкладки после подтверждения: UI и новый ход читают один и тот же исход из БД (Tasks 3–4).

## Карта файлов

| Файл | Ответственность |
| --- | --- |
| `shared/task.ts` | Тип `TaskSnapshot`, граф переходов, ошибки, проекция вопросов и подсказок. |
| `server/persistence/migrations.ts` | Миграция 15→16: ревизия и таблица запросов перехода; сохранение старых заявок. |
| `server/persistence/task-repository.ts` | Атомарные request/approve/reject/cancel, TTL, чтение снимка, правка ответа. |
| `server/tools/tasks/task-tools.ts` | `get_task_state`, уточнённый ответ перехода, `cancel_task_transition`, `amend_task_answer`. |
| `server/agent/chat-agent.ts` | Список/доступность инструментов и правила доказательного сообщения об этапе. |
| `server/api/sessions/[id]/task.patch.ts` | Новый ID + ревизия для действий и совместимость со старым `stage`. |
| `server/api/sessions/[id]/task-answers.patch.ts` | Атомарное сохранение формы анкеты пользователем. |
| `server/persistence/session-repository.ts`, `shared/chat.ts` | Один снимок задачи в ответе GET диалога. |
| `components/TaskPanel.vue` | Pending/исход, предпросмотр профиля, форма правки и кнопка продолжения. |
| `components/ChatWorkspace.vue`, `pages/chat/[id].vue` | Передача action ID/ревизии, показ результата, отдельный запуск нового хода. |
| `server/tasks/onboarding.ts` | Общий форматтер инструкций, предпросмотр имени и создание профиля из утверждённой версии. |
| `server/tasks/metrics.ts` | Агрегирование событий переходов и числа ходов. |
| `tests/task-*.test.ts`, `tests/memory-start-turn.test.ts` | Контракты, гонки, reload и путь до профиля. |

## P0 — устранить недостоверные выводы агента

### Task 1: Версионированное состояние и миграция

**Files:** `shared/task.ts`, `server/persistence/migrations.ts`, `server/persistence/task-repository.ts`; tests `tests/chat-db.test.ts`, `tests/task-repository.test.ts`, `tests/task-state.test.ts`.

**Interfaces:** `getSnapshot(sessionId: string): TaskSnapshot | null`; `TaskSnapshot` и поля из spec. Ревизия увеличивается при каждом `updateTask`; чтение только проецирует данные. Срок pending — 7 дней; при миграции старому pending назначить UUID и 7 дней от момента миграции, чтобы он не исчез сразу.

- [ ] Добавить падающие тесты: миграция БД v15 с pending сохраняет заявку; `getSnapshot` возвращает этап, все пять вопросов с сохранёнными значениями, `allowedTransitions`, revision и `completed`; повторное чтение не меняет строку БД.
- [ ] Запустить `npm test -- --run tests/chat-db.test.ts tests/task-repository.test.ts tests/task-state.test.ts` и подтвердить ожидаемый FAIL.
- [ ] Добавить `tasks.revision` и таблицу `task_transitions(id, task_id, from_stage, to_stage, summary, requested_at, expires_at, outcome, resolved_at)` с уникальным индексом на один незавершённый запрос для задачи; перенести старые pending в таблицу. Реализовать чистую проекцию снимка и инкремент ревизии во всех путях записи.
- [ ] Повторить эти тесты и проверить PASS; `npm run typecheck` должен пройти.

### Task 2: Коррелируемый и идемпотентный переход

**Files:** `shared/task.ts`, `server/persistence/task-repository.ts`, `server/tools/tasks/task-tools.ts`, `server/api/sessions/[id]/task.patch.ts`, `server/tasks/api-errors.ts`; tests `tests/task-repository.test.ts`, `tests/task-tools.test.ts`, `tests/task-api.test.ts`.

**Interfaces:** `requestTransition(sessionId, { to, summary, expectedRevision? }, { turnId })`; `approve/reject(sessionId, { pendingTransitionId?, stage?, expectedRevision? })`; `cancelPending(sessionId, pendingTransitionId, { turnId })`. Новый инструмент возвращает `applied`, `pendingTransitionId`, `revision`, `allowedTransitions`, `confirmationHint`; legacy `awaitingUserConfirmation` остаётся только для активного pending.

- [ ] Добавить падающие тесты для первого и повторного одинакового запроса, уже достигнутого этапа, другого запроса при pending, двойного approve, ошибочного ID/ревизии, истёкшей заявки и её повторного запроса. Проверить, что ни один случай не создаёт второй переход.
- [ ] Запустить `npm test -- --run tests/task-repository.test.ts tests/task-tools.test.ts tests/task-api.test.ts` и подтвердить ожидаемый FAIL.
- [ ] Сделать request/approve/reject/cancel атомарными. Истечение вычислять на чтении без UPDATE; при первой мутации записывать исход `expired`. Для legacy PATCH со `stage` искать единственный действующий pending и применять те же проверки; повтор по старому ID читать из `task_transitions`, конфликт возвращает актуальный снимок.
- [ ] Повторить тесты и `npm run typecheck`; оба должны пройти.

### Task 3: Read-инструмент и инструкции агента

**Files:** `server/tools/tasks/task-tools.ts`, `server/agent/chat-agent.ts`, `shared/task.ts`, `server/tools/tasks/README.md`; tests `tests/task-tools.test.ts`, `tests/task-state.test.ts`, `tests/chat-agent.test.ts`, `tests/memory-start-turn.test.ts`.

**Interfaces:** `get_task_state({}) -> { ok: true, task: TaskSnapshot | null }`; `cancel_task_transition({ pendingTransitionId })`; `getTaskActiveTools` оставляет read-инструмент при паузе, pending и на review.

- [ ] Добавить падающие тесты: чтение не требует `turnId` и ничего не меняет; ответы возвращаются из БД после перезагрузки; read-инструмент доступен на всех открытых этапах; агенту не предлагаются несуществующие команды.
- [ ] Запустить `npm test -- --run tests/task-tools.test.ts tests/chat-agent.test.ts tests/memory-start-turn.test.ts` и подтвердить ожидаемый FAIL.
- [ ] В описании перехода и `<task_state>` указать точный handoff: `applied:false` означает «запрос ожидает пользователя»; после нового действия агент читает `get_task_state`; заявлять о смене этапа можно только по `applied:true` или свежему снимку. `confirmationHint` передавать буквально, не конструировать команду самостоятельно. Добавить свежий снимок в успешные ответы task-инструментов и `allowedTransitions` в их отказы.
- [ ] Повторить тесты и `npm run typecheck`; оба должны пройти.

### Task 4: Видимый результат подтверждения и следующий ход

**Files:** `components/TaskPanel.vue`, `components/ChatWorkspace.vue`, `pages/chat/[id].vue`, `shared/chat.ts`, `server/persistence/session-repository.ts`; tests `tests/task-api.test.ts`, `tests/task-session.test.ts` и ручной UI сценарий.

**Interfaces:** `TaskPanel` получает `TaskSnapshot`, emits `action({ action, pendingTransitionId, expectedRevision })` и `continueTask()`. `pages/chat/[id].vue` использует ответ PATCH как актуальное состояние, при 409 перезагружает снимок. `ChatWorkspace` запускает обычный ход после нажатия «Продолжить задачу».

- [ ] Добавить проверку API/сессии: ответ PATCH, последующий GET и следующий снимок хода сообщают одинаковый `stage`, `revision`, `lastTransition.id/outcome`; после reload результат не теряется.
- [ ] Запустить `npm test -- --run tests/task-api.test.ts tests/task-session.test.ts` и подтвердить ожидаемый FAIL.
- [ ] Показать в панели ожидающий переход, время истечения и итог approve/reject; передавать ID/ревизию с действиями. После подтверждения предложить отдельную кнопку «Продолжить задачу»; она отправляет обычный пользовательский запрос, а не скрытую подделку. Развести это действие с существующим `continue` прерванного хода.
- [ ] Повторить тесты и вручную проверить: запрос → кнопка подтверждения → видимый новый этап → «Продолжить задачу» → агент вызывает `get_task_state` и называет верный этап. Проверить refresh между каждым шагом.

## P1 — анкета и предпросмотр профиля

### Task 5: Правка ответа на review и точный предпросмотр

**Files:** `shared/task.ts`, `server/persistence/task-repository.ts`, `server/tools/tasks/task-tools.ts`, `server/tasks/onboarding.ts`, `components/TaskPanel.vue`, `server/agent/chat-agent.ts`; tests `tests/task-onboarding.test.ts`, `tests/task-tools.test.ts`, `tests/task-repository.test.ts`.

**Interfaces:** `amendAnswer(sessionId, { questionId, answer, expectedRevision }, { turnId })`; `amend_task_answer({ questionId, answer, expectedRevision })`; `buildOnboardingPreview(db, task): { name, instructions, taskRevision }`. Чистую функцию `formatOnboardingInstructions(task)` используют и preview, и `completeOnboarding`.

- [ ] Добавить падающие тесты: один ответ меняется на review без отката и остальные сохраняются; при активном pending правка запрещена; preview равен созданному профилю; старый approve после правки/конфликта имени не создаёт профиль; повтор approve не дублирует профиль.
- [ ] Запустить `npm test -- --run tests/task-onboarding.test.ts tests/task-tools.test.ts tests/task-repository.test.ts` и подтвердить ожидаемый FAIL.
- [ ] Реализовать amend и preview. Показывать точный текст до запроса `done`; при изменении ревизии сбрасывать подтверждение. После коллизии имени пересчитать preview и потребовать повторного подтверждения.
- [ ] Повторить тесты и `npm run typecheck`; оба должны пройти.

### Task 6: Ускоренная форма и типизированные варианты

**Files:** `shared/task.ts`, `server/persistence/task-repository.ts`, `server/api/sessions/[id]/task-answers.patch.ts`, `components/TaskPanel.vue`, `components/ChatWorkspace.vue`, `pages/chat/[id].vue`, `server/tools/tasks/task-tools.ts`, `server/agent/chat-agent.ts`; tests `tests/task-state.test.ts`, `tests/task-repository.test.ts`, `tests/task-api.test.ts`, `tests/task-onboarding.test.ts`.

**Interfaces:** `saveAnswers(sessionId, { answers, expectedRevision })` для одной атомарной пользовательской отправки пяти полей через `PATCH /api/sessions/:id/task-answers`; при активном ходе сервер отвечает `SESSION_RUNNING`. `level: beginner|intermediate|expert`, `style: brief|detailed` для новых ответов. Агентский `record_task_answer` нормализует только однозначные варианты, иначе просит выбрать из списка. Старые текстовые значения остаются доступными и явно требуют проверки, если не распознаны.

- [ ] Добавить падающие тесты: форма сохраняет все пять ответов одним действием; неверный enum не меняет ни одного ответа; неизвестный старый текст не конвертируется; после каждого одиночного ответа инструмент возвращает `recordedValue` и `remainingCount`.
- [ ] Запустить целевые task-тесты и подтвердить ожидаемый FAIL.
- [ ] Добавить форму в панели как быстрый путь и сохранить пошаговые вопросы для чата/мобильного ввода; агент повторяет `recordedValue` пользователю. Не менять смысл уже записанных анкет.
- [ ] Повторить целевые тесты, `npm run typecheck` и ручной проход с широким и узким экраном.

## P2 — наблюдаемость

### Task 7: Измерение реальных переходов

**Files:** `server/persistence/task-repository.ts`, `server/utils/run-logger.ts` или отдельный `server/tasks/metrics.ts`; tests `tests/task-repository.test.ts`.

**Interfaces:** запись события `{ taskId, pendingTransitionId, action, revision, at }` для `requested|approved|rejected|expired|cancelled`, одна запись на исход. Метрики: число пользовательских/агентских ходов от `onboarding` до `done`, доля повторных запросов и время ожидания подтверждения.

- [ ] Добавить падающие тесты на единственную запись при повторном approve и на корректные время/исход после reload.
- [ ] Запустить целевой тест и подтвердить ожидаемый FAIL.
- [ ] Добавить структурированные события и агрегирование. «Ложное подтверждение» оценивать сравнением текста ответа со снимком и выборочной проверкой; не выдавать регулярное выражение за точную метрику.
- [ ] Повторить целевой тест и `npm run typecheck`; оба должны пройти.

## Финальная проверка

- [ ] `npm test` и `npm run typecheck` проходят после каждой соответствующей фазы.
- [ ] Ручной сценарий `docs/task-lifecycle-scenario.md`: новый pending, approve/reject, пауза, reload, истечение, правка анкеты, preview, `done` и новый профиль.
- [ ] Документация `docs/task-lifecycle.md`, `docs/task-lifecycle-scenario.md` и `server/tools/tasks/README.md` описывает фактический контракт и временную совместимость.
- [ ] Перед реализацией Task 7 снять базовые показатели; целевое число ходов 2–3 проверять отдельно для формы и чата. Пошаговая анкета закономерно требует больше ходов.

## Порядок и границы

Tasks 1–4 закрывают инцидент с недостоверным подтверждением. Task 5 устраняет дрейф анкеты и риск скрытого создания профиля. Task 6 улучшает скорость, Task 7 измеряет результат. `stageRevision` отдельно не нужен: единая `revision` защищает также ответы. Автоматический ход модели после PATCH не входит в этот план: он потребует отдельного протокола `task_event` и гарантий от повторного запуска.
