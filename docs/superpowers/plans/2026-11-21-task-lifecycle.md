> Статус: план одобрен, реализация завершена.

# Задача с этапами: конечный автомат и контролируемый жизненный цикл

## Context

Задание: у задачи должно быть формальное состояние (этап, текущий шаг, ожидаемое действие), список допустимых состояний и разрешённых переходов. Переход проверяет код до применения, а не промпт. Нельзя начать реализацию до утверждённого плана и нельзя завершить задачу без валидации. Нужно проверить паузу на любом этапе, продолжение без повторных объяснений, попытки недопустимых переходов и реакцию агента на них.

Как видит пользователь: шаблоны задач с закреплёнными этапами; старт из интерфейса или командой; переход между этапами только после подтверждения пользователя.

Решения, принятые с пользователем:
- **Команды** — слэш-команды `/task …` в поле ввода. Клиент разбирает их сам и вызывает тот же HTTP API, что и кнопки панели. В модель команды не попадают, поэтому подтвердить переход вместо пользователя модель не может.
- **Инструменты по этапу** — вне этапа реализации сервер убирает `write_file` из набора инструментов хода. Реализацию до утверждённого плана блокирует код.

Главная гарантия: **агент только предлагает переход** (инструмент записывает запрос в БД), **применяет переход только пользователь** (кнопка или `/task approve` → HTTP). Один чистый guard `assertTransition` проверяет переход дважды: когда агент его запрашивает и когда пользователь его подтверждает.

## Модель (shared/task.ts — чистый модуль без зависимостей от сервера)

Шаблоны задаются константами в коде, не в БД: этапы в них закреплены.

```ts
TASK_TEMPLATES = [
  { id: 'dev', name: 'Разработка', stages: [
    { id: 'planning',   title: 'Планирование', agentAction: 'Составить план и предложить переход', next: ['execution'] },
    { id: 'execution',  title: 'Реализация',   agentAction: 'Выполнить план', next: ['validation'], allowWrites: true },
    { id: 'validation', title: 'Валидация',    agentAction: 'Проверить результат по плану', next: ['done', 'execution'] },
    { id: 'done',       title: 'Готово',       agentAction: '', next: [] },
  ]},
  { id: 'bugfix', name: 'Исправление ошибки', stages: [diagnosis → planning → execution → validation → done] },
]
```

- Первый этап шаблона — начальный, этап с `next: []` — терминальный.
- Возврат `validation → execution` — доработка после проваленной проверки.
- `TaskState`: `id, sessionId, templateId, goal, stage, step, status ('active' | 'paused' | 'done' | 'cancelled'), artifacts: Record<stageId, string>, createdAt, updatedAt`, а также необязательные `pendingStage` и `pendingSummary`. По правилу пользователя обязательные поля стоят выше необязательных.
- `TaskError(code)`, коды: `INVALID_INPUT, NOT_FOUND, TASK_EXISTS, SESSION_RUNNING, TURN_NOT_ACTIVE, TRANSITION_NOT_ALLOWED, TASK_PAUSED, TASK_FINISHED, TRANSITION_PENDING, NO_PENDING_TRANSITION, STAGE_MISMATCH, SUMMARY_REQUIRED`.
- `assertTransition(task, to, summary)` — единственный guard. Он проверяет, что задача не завершена, не стоит на паузе, не ждёт подтверждения, что `to ∈ stage.next` и что `summary` не пуст. Отказ `TRANSITION_NOT_ALLOWED` несёт `allowedNext`.
- `getExpectedAction(task)` вычисляется из состояния, а не хранится, поэтому не может разойтись с ним:
  - пауза → пользователь: `/task resume`;
  - есть `pendingStage` → пользователь: `/task approve` | `/task reject`;
  - иначе → агент: `stage.agentAction`.
- `taskBlocksWrites(task)` возвращает true, если задача открыта и при этом стоит на паузе или её этап без `allowWrites`.
- `parseTaskCommand(text)` разбирает `/task start <templateId> <цель…>`, `approve`, `reject`, `pause`, `resume`, `cancel`. На неизвестную команду возвращает ошибку со справкой.

«Нельзя реализацию до плана» обеспечивают три вещи: `planning → execution` требует `summary` (это план, он сохраняется в `artifacts.planning`), требует подтверждения пользователя, а до него `write_file` недоступен. «Нельзя финал без валидации»: `done` есть только в `validation.next`.

## Хранение

`server/persistence/migrations.ts`: `CHAT_SCHEMA_VERSION = 14`, блок `if (currentVersion < 14)`:

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL, goal TEXT NOT NULL, stage TEXT NOT NULL, step TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active','paused','done','cancelled')),
  pending_stage TEXT, pending_summary TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(artifacts_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX tasks_one_open_per_session ON tasks (session_id) WHERE status IN ('active','paused');
```

Новый файл `server/persistence/task-repository.ts` построен по образцу `user-profile-repository.ts`: каждая запись идёт в `db.transaction(...).immediate()`.

- `getForSession(sessionId)` возвращает последнюю задачу диалога. Завершённая задача тоже видна в панели.
- `start(sessionId, { templateId, goal })` проверяет шаблон, длину цели (1–2000) и что диалог свободен, затем создаёт задачу на первом этапе.
- Действия агента требуют активного хода (`turnId` в статусе `running`, та же проверка, что в `selectForSession`):
  - `requestTransition(sessionId, { to, summary }, { turnId })` вызывает `assertTransition` и записывает `pending_*`;
  - `updateStep(sessionId, step, { turnId })` проверяет, что задача активна, и обновляет шаг.
- Действия пользователя запрещены, пока идёт ход (`SESSION_RUNNING`, как у профилей):
  - `approve(sessionId, stage)` требует `stage === pending_stage`, иначе `STAGE_MISMATCH`, и повторно вызывает `assertTransition`. Затем: `artifacts[from] = pending_summary`, `stage = to`, шаг сбрасывается, pending очищается. Если новый этап терминальный, статус становится `done`.
  - `reject(sessionId, stage)` очищает pending.
  - `pause` / `resume` / `cancel` меняют `status` по разрешённой таблице: `active ↔ paused`, `active|paused → cancelled`. Пауза допустима на любом этапе, в том числе пока переход ждёт подтверждения.

## Агент

- `server/memory/start-turn.ts`: внутри уже существующей транзакции снять снимок `createTaskRepository(db).getForSession()`, передать его в `createAgentConfig(profile, task)` и вернуть `taskSnapshot`. Так же сейчас делается снимок профиля.
- `server/agent/chat-agent.ts`:
  - `buildAgentInstructions(profile, disableMutatingTools, task?)` для открытой задачи добавляет блок `<task_state>`: шаблон, цель, этап и `agentAction`, шаг, статус, ожидающий переход, `allowedNext`, артефакты пройденных этапов (утверждённый план и т. д.). Благодаря этому после паузы, перезагрузки или сжатия истории агент продолжает без повторных объяснений: блок живёт в инструкциях, а не в истории.
  - Правила в блоке:
    - работай только над текущим этапом;
    - этап меняет только пользователь;
    - когда работа этапа готова, вызови `request_task_transition` со сводкой и попроси подтвердить;
    - если пользователь просит перейти на какой-либо этап, вызови инструмент ровно с этим этапом и передай отказ сервера дословно; никогда не утверждай, что этап сменился;
    - на паузе не продвигай задачу.
  - В первую строку `AGENT_INSTRUCTIONS` добавить имена новых инструментов.
  - `getAgentConfig(..., task)` пишет `task: { id, stage, status }`, `toolSetVersion: 5`.
  - `createChatAgent`: новый параметр `taskTools` и опция `task`. Если `taskBlocksWrites(task)` и это не продолжение, задать `activeTools = Object.keys(tools).filter(n => n !== 'write_file')`. Существующий allowlist для `disableMutatingTools` не меняется, новые инструменты в него не попадают и при продолжении недоступны.
  - `streamChatAgent`: обернуть `taskTools` через `recordToolExecution`. Три одинаковых IIFE-обёртки заменить локальным хелпером `recordTools(tools)`: поведение то же, кода меньше.
- Новый каталог `server/tools/tasks/` (`index.ts`, `task-tools.ts`) по образцу `user-profile-tools.ts`. Отказ возвращается как `{ ok: false, error: { code, message, allowedNext? } }`, поэтому `getToolCallStatus` показывает его в чате как ошибку.
  - `update_task_step({ step })`, шаг 1–500 символов.
  - `request_task_transition({ to, summary })`, сводка 1–8000 символов. Возвращает `{ ok: true, from, to, awaitingUserConfirmation: true }`.
- `server/api/chat.post.ts`: передать `taskSnapshot` и `taskTools: createTaskTools({ db, sessionId, turnId })`.

## HTTP API

- `shared/chat.ts`: в `SessionDetail` добавить `task: TaskState | null`. В `session-repository.getSession` заполнить его через `getForSession(id) ?? null`. Клиент получит задачу при загрузке и после каждого хода через уже существующий `handleUpdated`.
- `server/api/sessions/[id]/task.post.ts` — старт задачи, тело `{ templateId, goal }`.
- `server/api/sessions/[id]/task.patch.ts` — тело `{ action: 'approve'|'reject'|'pause'|'resume'|'cancel', stage? }`, `stage` обязателен для approve и reject. Лишние ключи дают 400.
- Оба отвечают `{ task }` и ставят `Cache-Control: no-store`. Ошибки переводит один хелпер `server/tasks/api-errors.ts` по образцу `server/user-profiles/api-errors.ts`: 400 — неверные данные, 404 — нет диалога или задачи, 409 — ошибки переходов и занятый диалог.

## UI

- Новый `components/TaskPanel.vue` стоит в `ChatWorkspace.vue` между шапкой и сообщениями, рядом с панелью sticky facts. Пропсы: `task`, `busy`, `error`. События: `start`, `action`.
  - Задачи нет или она завершена: кнопка «Начать задачу» раскрывает выбор шаблона и поле цели.
  - Задача открыта: цель, цепочка этапов (пройденные / текущий / будущие), шаг, «Ожидается: …», бейдж статуса, кнопки «Пауза» / «Продолжить» / «Отменить».
  - Есть `pendingStage`: блок «Агент предлагает перейти A → B» со сводкой (планом) и кнопками «Подтвердить» / «Отклонить».
  - Пока идёт генерация, всё отключено.
- `ChatWorkspace.handleSubmit`: если текст начинается с `/task`, вызвать `parseTaskCommand`. Для approve и reject подставить `stage` из `props.session.task.pendingStage`. Затем отправить те же события, что у панели, и очистить черновик. В `sendMessage` команда не уходит. Ошибку разбора показать в `error` панели.
- `pages/chat/[id].vue`: `handleTaskStart` и `handleTaskAction` устроены как `handleSelectProfile`: `$fetch`, затем `session.value = { ...current, task }`, ошибка пишется в `taskError`.

## Документация

- `docs/task-lifecycle.md` по образцу `docs/user-profiles.md`: шаблоны, таблица переходов, команды, API, что происходит при паузе, ветвлении и очистке истории. Добавить ссылку из `README.md`.
- Короткий `server/tools/tasks/README.md` по образцу соседних.

## Тесты (vitest, `openChatDatabase(':memory:')`, как в `tests/user-profile-turn.test.ts`)

- `tests/task-state.test.ts` (чистый модуль):
  - разрешённые переходы обоих шаблонов;
  - отказ на `planning → validation`, `planning → done`, `execution → done`;
  - отказы на паузе, при ожидающем переходе, на завершённой задаче, без сводки;
  - `getExpectedAction` для всех веток;
  - `taskBlocksWrites`;
  - `parseTaskCommand`.
- `tests/task-repository.test.ts`:
  - старт и одна открытая задача на диалог;
  - запрос агента → pending → approve применяет переход и сохраняет артефакт;
  - reject очищает pending;
  - approve с чужим `stage` даёт `STAGE_MISMATCH`, approve без pending даёт `NO_PENDING_TRANSITION`;
  - pause и resume на каждом этапе;
  - действия пользователя во время хода дают `SESSION_RUNNING`, действия агента без активного хода дают `TURN_NOT_ACTIVE`;
  - удаление диалога каскадно удаляет задачу.
- `tests/task-tools.test.ts`: запрещённый переход возвращает `ok: false` и `allowedNext`, состояние в БД не меняется.
- Снимок в ходе (`startMemoryAwareTurn`): `<task_state>` с целью и утверждённым планом есть в `agentConfig.instructions` и не попадает в историю.
- Существующие тесты обновить там, где они ломаются: проверки `CHAT_SCHEMA_VERSION` и `user_version` (`tests/chat-db.test.ts`), фикстуры `SessionDetail` (grep `userProfileId:` в `tests/`), `toolSetVersion`.

## Проверка

1. Запустить `npm test` и `npm run typecheck`.
2. Ручной сценарий в `npm run dev` (порт 3535) на реальной модели. Он закрывает пункты «Проверьте» из задания:
   1. `/task start dev Сделай отчёт по docs/*.md в report.md`. Панель показывает «Планирование», ожидается действие агента.
   2. Попросить: «сразу запиши report.md» — `write_file` недоступен, агент объясняет, что идёт этап планирования.
   3. Попросить: «перейди сразу в done» — агент вызывает `request_task_transition(done)`, в чате видна ошибка `TRANSITION_NOT_ALLOWED` с `allowedNext: [execution]`, этап не изменился.
   4. Агент готовит план и запрашивает `execution`. Затем `/task pause`, пара посторонних вопросов, перезагрузка страницы, `/task resume`, «продолжай». Агент продолжает с того же места и не переспрашивает цель.
   5. `/task approve` → реализация, файл записан. Запрос `done` из реализации отклоняется, `validation` подтверждается. Агент проверяет результат, `done` подтверждается, статус становится «Готово».
   6. Напрямую API: `curl -X PATCH localhost:3535/api/sessions/<id>/task -H 'content-type: application/json' -d '{"action":"approve","stage":"done"}'` при отсутствии pending даёт 409. Этап в БД не изменился.

## Не делаем (осознанно)

- Шаблоны, редактируемые из UI или БД.
- Несколько открытых задач в одном диалоге.
- Журнал всех переходов: результат каждого этапа хранится в `artifacts`, отказы видны в вызовах инструментов.
- Наследование задачи веткой диалога: ветка стартует без задачи.
- Переход по инициативе пользователя без запроса агента.
- AI SDK `needsApproval`: кастомный транспорт отправляет только последнее сообщение, а pending в БД переживает паузу и перезагрузку.

## После одобрения плана

План сохранён в `docs/superpowers/plans/2026-11-21-task-lifecycle.md`; реализация выполнена по команде пользователя.
