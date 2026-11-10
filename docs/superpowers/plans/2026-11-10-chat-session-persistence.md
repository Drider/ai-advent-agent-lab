# Chat Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сохранять локальные диалоги агента в SQLite, открывать их из бокового меню и безопасно продолжать после прерывания.

**Architecture:** SQLite — источник истины для сессий, ходов, полных `UIMessage` и вызовов инструментов; JSON находится в отдельных столбцах с версией формата. Сервер получает от браузера только новое сообщение или команду продолжения, сам строит контекст, а диагностические JSON-логи остаются независимыми.

**Tech Stack:** Node.js 22.18+, Nuxt 4/Vue 3/TypeScript, AI SDK 7, `better-sqlite3@13.0.3` с `@types/better-sqlite3@9.6.0`, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-chat-session-persistence-design.md`

`better-sqlite3` выбран как локальный драйвер с транзакциями и резервным копированием; встроенный `node:sqlite` в минимальном Node 22.18 ещё имеет статус active development. Цена выбора — нативный модуль, поэтому `npm run build` входит в ранний контрольный шаг. См. [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) и [Node 22 SQLite](https://nodejs.org/download/release/v22.18.0/docs/api/sqlite.html).

## Global Constraints

- Первый выпуск работает локально с одним процессом Node.js и постоянной папкой `data/`; база — `data/chat.sqlite`.
- История сохраняется независимо от `LLM_LOG_LEVEL`; существующие `data/runs/*.json` остаются диагностическими файлами.
- Завершённые сообщения и подтверждённые вызовы инструментов восстанавливаются полностью. Частичный ответ помечается прерванным; новая реплика продолжает его только по действию пользователя.
- Не выполнять заново инструмент с побочным эффектом при загрузке страницы или при неизвестном результате его прошлого вызова.
- В первом выпуске предел контекста: не больше 100 `UIMessage` и 256 КиБ сериализованных сообщений; при превышении показать явную ошибку. Полная история в БД не обрезается. Автоматические сводки — следующий этап.
- Никаких аккаунтов, распределённых потоков и импорта старых JSON-логов в пользовательскую историю в первом выпуске.
- Значения `sessionId` и `requestId` — UUID. `run_log_id` остаётся ISO-временем для совместимости с нынешними диагностическими инструментами.
- Все данные из БД перед передачей модели проверяются через `validateUIMessages`; API-ключ и URL с секретами никогда не попадают в БД.
- Статусы хода: `running`, `completed`, `failed`, `stopped`, `interrupted`, `needs_review`; сообщения: `complete`, `partial`, `interrupted`; инструмента: `running`, `completed`, `failed`.

## Review Focus

1. Повторная отправка того же `requestId` после сетевого сбоя должна оставить одно сообщение пользователя и не исполнить инструмент вторично — Task 3 и Task 6.
2. Сбой между записью намерения и результатом `write_file` должен оставить ход в состоянии проверки, а не создать файл повторно — Task 5 и Task 7.
3. Повреждённый JSON или неподдерживаемая версия сохранённого `UIMessage` должны дать ошибку загрузки без вызова модели — Task 2 и Task 4.
4. Превышение предела контекста должно сохранить видимую историю и показать понятную ошибку вместо молчаливой обрезки — Task 4 и Task 8.
5. Отсутствующий последний открытый диалог должен приводить к самому недавно активному либо к новой сессии без смешения сообщений — Task 8.

## File Map

| Файл | Ответственность |
| --- | --- |
| `server/persistence/db.ts`, `migrations.ts` | Открытие SQLite, PRAGMA, миграции и singleton для серверных маршрутов. |
| `server/persistence/session-repository.ts` | Создание, чтение, список и активация диалогов. |
| `server/persistence/turn-repository.ts` | Транзакции ходов, сообщения, снимки, состояния и журнал инструментов. |
| `server/persistence/dice-roll-repository.ts` | История бросков в БД, одноразовый импорт CSV и экспорт CSV. |
| `server/utils/session-context.ts` | Сборка проверенного контекста и явные пределы. |
| `server/utils/chat-request.ts`, `shared/chat.ts` | Новый контракт запроса и публичные типы сессии. |
| `server/agent/chat-agent.ts`, `server/agent/recorded-tools.ts` | Запись исполнения инструментов, шагов, частичного и итогового ответа. |
| `server/api/sessions/**`, `server/api/chat.post.ts`, `server/plugins/chat-recovery.ts` | API истории, запуск и продолжение, восстановление после перезапуска. |
| `components/ChatWorkspace.vue`, `components/ChatSessionList.vue`, `pages/index.vue`, `pages/chat/[id].vue`, `app/assets/css/main.css` | Загрузка и выбор диалогов, отображение прерывания, новая сессия. |
| `scripts/backup-chat-db.mjs`, `README.md` | Резервная копия работающей БД и инструкция по эксплуатации. |

---

### Task 1: SQLite schema and connection

**Files:** Create `server/persistence/db.ts`, `server/persistence/migrations.ts`, `tests/chat-db.test.ts`; modify `package.json`, `package-lock.json`.

**Interfaces:** `openChatDatabase(filePath?: string): Database.Database`; `getChatDatabase(): Database.Database`. `openChatDatabase` creates parent directory, enables WAL, `foreign_keys=ON`, `busy_timeout=1000`, `synchronous=FULL`, and applies migrations by `PRAGMA user_version`. `getChatDatabase` lazily opens `data/chat.sqlite` once per process.

- [ ] **Step 1: Write failing tests** for reopening a migrated temp DB, repeated migration, `PRAGMA foreign_keys`, `PRAGMA journal_mode`, invalid `payload_json`, duplicate `(session_id, position)`, and FK rejection. Use `mkdtemp` and cleanup as in existing tests.
  ```ts
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  expect(() => insertMalformedMessage(db)).toThrow()
  ```
- [ ] **Step 2: Verify red.** Run `npx vitest run tests/chat-db.test.ts`; expect missing module/schema failures.
- [ ] **Step 3: Implement schema.** Tables: `sessions`, `turns`, `messages`, `tool_executions`, `dice_rolls` with columns from the spec; `CHECK(json_valid(...))` on non-null JSON, foreign keys, unique `request_id`, `(session_id, position)`, `(turn_id, tool_call_id)`, and `(source, source_row_index)` for CSV import. Index `sessions(updated_at DESC,id DESC)`, `sessions(last_opened_at DESC)`, `messages(session_id,position)`, `turns(session_id,position)`. Create `data/` with mode `0700` and the database with mode `0600` on Unix. Defer `context_checkpoints` until summaries are implemented.
- [ ] **Step 4: Verify green and build.** Run `npx vitest run tests/chat-db.test.ts`, `npm run typecheck`, `npm run build`; all pass. If Nitro cannot load the native addon, externalize only `better-sqlite3` in `nuxt.config.ts` and rerun build.
- [ ] **Step 5: Commit.** `git add package.json package-lock.json nuxt.config.ts server/persistence tests/chat-db.test.ts` (omit unchanged path); `git commit -m "feat: add chat SQLite schema"`.

### Task 2: Session repository and history loading

**Files:** Create `server/persistence/session-repository.ts`, `tests/session-repository.test.ts`; modify `shared/chat.ts`.

**Interfaces:** `createSessionRepository(db: Database.Database)` returns `createSession(): SessionSummary`, `listSessions({ limit, cursor }): { items: SessionSummary[]; nextCursor?: string; preferredSessionId?: string }`, `getSession(id): Promise<SessionDetail | null>`, `activateSession(id): void`. `SessionDetail.messages` contains validated `ChatUIMessage[]` and `lastTurn`. `title` is `Новый диалог` until the first user message, then its first 60 characters. Cursor encodes `(updated_at,id)`; default page size 30, max 100. `preferredSessionId` is queried separately from the page and is always an existing ID (last opened, otherwise most recently updated).

- [ ] **Step 1: Write failing tests.** Create two sessions at the same clock tick and assert unique UUIDs/`run_log_id`; insert messages and assert order plus full `parts`/metadata after reopen; assert stable pagination and preferred session; assert malformed persisted JSON/version raises a typed storage error rather than returning partial history.
  ```ts
  expect(first.id).not.toBe(second.id)
  expect(first.runLogId).not.toBe(second.runLogId)
  expect((await reopened.getSession(first.id))?.messages).toEqual(savedMessages)
  ```
- [ ] **Step 2: Verify red.** Run `npx vitest run tests/session-repository.test.ts`.
- [ ] **Step 3: Implement repository.** Keep SQL and JSON decoding here; add `storageVersion: 1` alongside each stored `UIMessage`, validate with `validateUIMessages` when loading. Generate collision-free ISO `run_log_id` by advancing one millisecond if necessary.
- [ ] **Step 4: Verify green.** Run `npx vitest run tests/session-repository.test.ts` and `npm run typecheck`.
- [ ] **Step 5: Commit.** `git add shared/chat.ts server/persistence/session-repository.ts tests/session-repository.test.ts`; `git commit -m "feat: store and list chat sessions"`.

### Task 3: Turn transactions and restart recovery

**Files:** Create `server/persistence/turn-repository.ts`, `server/plugins/chat-recovery.ts`, `tests/turn-repository.test.ts`.

**Interfaces:** `createTurnRepository(db)` returns `beginUserTurn({sessionId,requestId,modelId,message,agentConfig})`, `beginContinuation({sessionId,requestId,sourceTurnId,modelId,agentConfig})`, `saveAssistantSnapshot({turnId,message,status})`, `recordToolStart({turnId,toolCallId,stepIndex,name,input})`, `recordToolEnd({turnId,toolCallId,output,error})`, `finishTurn({turnId,message,status})`, `getLastTurn(sessionId)`, `markStopped(turnId)`, `recoverRunningTurns(): number`. Each method that changes a turn uses a short transaction; `begin*` enforces one active turn per session. `requestId` is also the new `turnId`.

- [ ] **Step 1: Write failing tests.** Assert user message and `running` turn appear atomically; duplicate `requestId` creates no extra message; a second concurrent turn is rejected; final assistant message and session status commit together; recovery marks only `running` turns as `interrupted` after reopen; `stopped` stays stopped.
  ```ts
  expect(() => repo.beginUserTurn(sameRequest)).toThrow('TURN_ALREADY_EXISTS')
  expect((await sessions.getSession(sessionId))?.messages).toHaveLength(1)
  expect(repo.recoverRunningTurns()).toBe(1)
  ```
- [ ] **Step 2: Verify red.** Run `npx vitest run tests/turn-repository.test.ts`.
- [ ] **Step 3: Implement transactions** and the Nitro startup plugin that invokes `recoverRunningTurns()` once when a local process starts. Do not infer completed execution from an absent stream.
- [ ] **Step 4: Verify green.** Run `npx vitest run tests/turn-repository.test.ts` and `npm run typecheck`.
- [ ] **Step 5: Commit.** `git add server/persistence/turn-repository.ts server/plugins/chat-recovery.ts tests/turn-repository.test.ts`; `git commit -m "feat: persist chat turns and recover interrupted runs"`.

### Task 4: Session API and server-owned context

**Files:** Create `server/api/sessions/index.get.ts`, `server/api/sessions/index.post.ts`, `server/api/sessions/[id].get.ts`, `server/api/sessions/[id]/activate.post.ts`, `server/utils/session-context.ts`, `tests/session-context.test.ts`; modify `shared/chat.ts`, `server/utils/chat-request.ts`, `tests/chat-request.test.ts`, `tests/server-chat-request.test.ts`.

**Interfaces:** `ChatRequestBody` becomes `{kind:'message';sessionId:string;requestId:string;model?:string;message:UIMessage} | {kind:'continue';sessionId:string;requestId:string;sourceTurnId:string;model?:string}`. `buildSessionContext(sessionId, repository): Promise<UIMessage[]>` loads and validates server history, excludes an interrupted trailing text fragment, and throws `CONTEXT_LIMIT_REACHED` at 100 messages or 256 KiB. These numeric limits reuse today's request limits as an implementation choice. `parseChatPayload(raw): Promise<ChatRequestBody>` validates UUIDs, one user message, 10,000-character text and 256 KiB request body. Session endpoints return public DTOs, `404` for unknown IDs and `400` for malformed cursors.

- [ ] **Step 1: Write failing tests.** Update old request tests for the new discriminated union; assert a malicious client-supplied `messages` array is rejected; assert 101 stored messages and a 256 KiB context fail explicitly while `getSession()` still returns all; assert invalid stored tool parts prevent model context construction.
  ```ts
  expect(() => validateChatRequest({ messages: forgedHistory })).toThrow()
  await expect(buildSessionContext(sessionId, sessions)).rejects.toMatchObject({ code: 'CONTEXT_LIMIT_REACHED' })
  expect((await sessions.getSession(sessionId))?.messages).toHaveLength(101)
  ```
- [ ] **Step 2: Verify red.** Run `npx vitest run tests/chat-request.test.ts tests/server-chat-request.test.ts tests/session-context.test.ts`.
- [ ] **Step 3: Implement contracts, pure context builder and endpoints.** Keep authorization seam in repository/API arguments, but do not add a fake `owner_id` before accounts exist. Set `Cache-Control: no-store` on history responses.
- [ ] **Step 4: Verify green.** Run the three targeted tests and `npm run typecheck`.
- [ ] **Step 5: Commit.** `git add shared/chat.ts server/utils/chat-request.ts server/utils/session-context.ts server/api/sessions tests/chat-request.test.ts tests/server-chat-request.test.ts tests/session-context.test.ts`; `git commit -m "feat: expose persisted chat sessions"`.

### Task 5: Durable tool calls and dice history

**Files:** Create `server/agent/recorded-tools.ts`, `server/persistence/dice-roll-repository.ts`, `tests/recorded-tools.test.ts`, `tests/dice-roll-repository.test.ts`; modify `server/tools/dice/dice-tool.ts`, `server/tools/dice/dice-roll-csv.ts`, `server/tools/files/file-tools.ts`, `tests/dice-tool.test.ts`, `tests/dice-roll-csv.test.ts`, `tests/file-tools.test.ts`.

**Interfaces:** `recordToolExecution<TInput,TOutput>(tool, {turnId,getStepIndex,repository}): Tool<TInput,TOutput>` wraps `execute(input, {toolCallId,...})`: commit intent before invoking the original function, commit output/error after it. `getStepIndex(): number` reads the current agent step set by `onStepStart`; parallel tool calls share that step index. A failed intent write must prevent execution. `createDiceRollRepository(db)` exposes `rollOnce({toolCallId,sides,draw,at}): DieRoll`, `listRolls(): SavedDiceRoll[]`, `importLegacyCsv(path): number`, `exportCsv(): string`. `rollOnce` stores the roll and its result atomically and returns the old result for the same ID.

- [ ] **Step 1: Write failing tests.** For a fake mutating tool, assert intent is stored before execution and DB failure prevents side effect; assert a result-write failure leaves `running`/uncertain state. For dice, assert duplicate `toolCallId` yields one roll, one-time CSV import survives restart, and export preserves `result,date,time` order. For `write_file`, an unknown outcome must be `needs_review`, never automatic retry.
  ```ts
  expect(events).toEqual(['intent-committed', 'tool-executed', 'result-committed'])
  expect(executeSpy).not.toHaveBeenCalled() // intent write failed
  expect(diceStore.listRolls()).toHaveLength(1) // same toolCallId was retried
  ```
- [ ] **Step 2: Verify red.** Run `npx vitest run tests/recorded-tools.test.ts tests/dice-roll-repository.test.ts tests/dice-tool.test.ts tests/dice-roll-csv.test.ts tests/file-tools.test.ts`.
- [ ] **Step 3: Implement wrapper and dice repository.** Use the AI SDK tool `execute` options to obtain `toolCallId`; do not rely on `onToolExecutionStart/End` for durability because the installed SDK suppresses callback errors. Keep the old CSV parser for one-time import and CSV export; stop appending new rolls to the file. Record a path/content hash before `write_file`; if the DB result is absent after a crash, show `needs_review` even when the file appears to match.
- [ ] **Step 4: Verify green.** Run targeted tests and `npm run typecheck`.
- [ ] **Step 5: Commit.** `git add server/agent/recorded-tools.ts server/persistence/dice-roll-repository.ts server/tools/dice server/tools/files/file-tools.ts tests`; `git commit -m "feat: journal tool execution and dice rolls"`.

### Task 6: Persist the streamed agent response

**Files:** Modify `server/agent/chat-agent.ts`, `server/api/chat.post.ts`, `tests/chat-agent.test.ts`; create `tests/persisted-chat.test.ts`.

**Interfaces:** `streamChatAgent(input)` gains `sessionId`, `turnId`, `turnRepository` and server-loaded `messages`; it still returns `Promise<Response>`. `/api/chat` calls `beginUserTurn` or `beginContinuation` before the provider, passes the DB `run_log_id` to the existing diagnostic tools, and rejects duplicate `requestId` with `409 TURN_ALREADY_EXISTS`. A context-limit error marks the already saved user turn `failed`. Generate assistant message IDs on the server. `onUIMessageStepEnd` saves full message checkpoints; an AI SDK `experimental_transform` tap of `text-delta` parts saves a best-effort partial text snapshot at most once per second; awaited `onEnd` saves the final message before stream completion.

- [ ] **Step 1: Write failing streamed tests** with `MockLanguageModelV3`: complete reply including tool parts and metadata survives DB reopen with `LLM_LOG_LEVEL=off`; duplicate request never calls the model twice; fake-clock text deltas produce at most one partial write per second; abort/provider failure leaves partial or interrupted state; a failed final DB write does not mark the turn completed; `get_current_session` still sees its correct diagnostic `run_log_id`; stored `agent_config_json` has instructions/version but no API key.
  ```ts
  expect((await sessions.getSession(sessionId))?.messages.at(-1)?.parts).toEqual(expectedToolAndTextParts)
  expect(model.doStreamCalls).toHaveLength(1) // same requestId was retried
  expect(turns.getLastTurn(sessionId)?.status).not.toBe('completed') // final DB write failed
  ```
- [ ] **Step 2: Verify red.** Run `npx vitest run tests/chat-agent.test.ts tests/persisted-chat.test.ts`.
- [ ] **Step 3: Implement.** Preserve `MAX_AGENT_STEPS=10`, 30-second timeout and current error copy. Persist the exact agent instruction text/hash, tool-set version and limits in `agent_config_json`, never provider credentials. Use the wrapped tools from Task 5; flush a full checkpoint after each UI step and before normal completion. AI SDK swallows `onUIMessageStepEnd` callback errors, so capture the failure, abort the run, and prevent final `completed` status. Partial snapshots from the transform are best effort; their errors must be visible to server logging. Diagnostic log failures still do not invalidate a committed answer.
- [ ] **Step 4: Verify green.** Run targeted tests, `npm run typecheck`, `npm run build`.
- [ ] **Step 5: Commit.** `git add server/agent/chat-agent.ts server/api/chat.post.ts tests/chat-agent.test.ts tests/persisted-chat.test.ts`; `git commit -m "feat: persist agent streams and responses"`.

### Task 7: Safe continuation and explicit stop

**Files:** Modify `server/persistence/turn-repository.ts`, `server/utils/session-context.ts`, `server/api/chat.post.ts`; create `server/api/sessions/[id]/turns/[turnId]/stop.post.ts`, `tests/chat-continuation.test.ts`.

**Interfaces:** `assessContinuation(sourceTurnId): 'safe' | 'needs_review' | 'not_available'` considers the last committed UI step and every tool execution after it. `kind:'continue'` starts a new turn referencing `sourceTurnId`, keeps the interrupted assistant message visible and creates a new assistant message. During continuation, mutating tools (`rollDie`, `write_file`) are disabled; already saved tool results are supplied through the last complete checkpoint. `POST .../stop` marks the active `requestId`/turn as `stopped`; reload alone produces `interrupted`.

- [ ] **Step 1: Write failing tests.** A safe checkpoint produces a new assistant message ID without another `rollDie`/`write_file` execution; a tool with unknown result yields `needs_review`; repeated continue request ID is idempotent; explicit stop stays stopped after startup recovery and cannot be overwritten by an abort callback; a fresh user message remains possible from `needs_review`.
  ```ts
  expect(assessContinuation(uncertainTurnId)).toBe('needs_review')
  expect(mutatingToolSpy).not.toHaveBeenCalled()
  expect(turns.getLastTurn(sessionId)?.status).toBe('stopped') // after restart
  ```
- [ ] **Step 2: Verify red.** Run `npx vitest run tests/chat-continuation.test.ts`.
- [ ] **Step 3: Implement continuation guard and stop endpoint.** Build the model prompt from confirmed history plus an internal continuation instruction; do not persist that instruction as a user message. Reject a continuation that would require an unconfirmed tool result. Avoid `useChat`'s automatic stream resume path, which is a separate feature.
- [ ] **Step 4: Verify green.** Run targeted tests and `npm run typecheck`.
- [ ] **Step 5: Commit.** `git add server/persistence/turn-repository.ts server/utils/session-context.ts server/api/chat.post.ts server/api/sessions tests/chat-continuation.test.ts`; `git commit -m "feat: continue interrupted chats safely"`.

### Task 8: Session list, restore and interruption UI

**Files:** Create `components/ChatWorkspace.vue`, `components/ChatSessionList.vue`, `pages/chat/[id].vue`, `shared/session-navigation.ts`, `tests/session-navigation.test.ts`; modify `pages/index.vue`, `app/assets/css/main.css`, `components/ChatToolCall.vue` if needed.

**Interfaces:** `selectInitialSession({preferredSessionId,items}): string | null` chooses the valid server-returned preferred ID even if it is outside the first page, else the newest `updatedAt`, else null. `ChatWorkspace` receives `SessionDetail`, initializes `useChat({id:session.id,messages:session.messages,transport})` and sends `{sessionId,requestId,kind:'message',message,model}`; `sendMessage(undefined,{body:{kind:'continue',sourceTurnId,requestId}})` handles continuation. The selected model starts from `lastTurn.modelId` or the configured default for an empty chat. The page keys `ChatWorkspace` by `session.id` so histories never mix.

- [ ] **Step 1: Write failing navigation tests** for preferred outside the page, no preferred, empty list, and equal timestamps. Add a manual UI checklist covering session switching, reload, mobile sidebar, visible tool parts, stop, `needs_review`, and context limit.
  ```ts
  expect(selectInitialSession({ preferredSessionId: oldId, items: firstPage })).toBe(oldId)
  expect(selectInitialSession({ preferredSessionId: undefined, items: [] })).toBeNull()
  ```
- [ ] **Step 2: Verify red.** Run `npx vitest run tests/session-navigation.test.ts`.
- [ ] **Step 3: Implement UI.** Move current chat body from `pages/index.vue` into `ChatWorkspace.vue`; root route opens preferred/last active or creates a session; `/chat/:id` loads history and shows a 404 state for an unknown ID. `prepareSendMessagesRequest` sends only the last user message or the `body` override for continuation. The sidebar lists paginated sessions, pins the selected session if it falls outside the loaded page, has «Новая сессия», and disables switching while the current stream runs. `handleStop` posts the known `requestId` before calling `stop()`; retry after failure uses `kind:'continue'` instead of `regenerate()`.
- [ ] **Step 4: Verify green.** Run `npx vitest run tests/session-navigation.test.ts`, `npm run typecheck`, `npm run build`; execute the manual checklist with a local mock/OpenAI-compatible provider and reload during a tool call.
- [ ] **Step 5: Commit.** `git add components pages shared/session-navigation.ts tests/session-navigation.test.ts app/assets/css/main.css`; `git commit -m "feat: restore and navigate saved chats"`.

### Task 9: Backup, docs and full verification

**Files:** Create `scripts/backup-chat-db.mjs`, `tests/chat-backup.test.ts`; modify `package.json`, `README.md`, `server/tools/sessions/README.md`.

**Interfaces:** `npm run backup:chat` writes `data/backups/chat-<ISO>.sqlite` using `better-sqlite3`'s live backup API, never plain file copy. `scripts/backup-chat-db.mjs` accepts optional `--source` and `--output` paths for testing or manual restore. Document that `data/chat.sqlite` contains message/tool data, that old `data/runs/*.json` remain diagnostic, and that the first release has an explicit context limit.

- [ ] **Step 1: Write a failing backup test.** Write a session, run the backup script against temp paths, reopen the backup and assert the session and messages exist while the source DB remains writable.
  ```ts
  expect((await backupSessions.getSession(sessionId))?.messages).toEqual(savedMessages)
  expect(() => sourceSessions.createSession()).not.toThrow()
  ```
- [ ] **Step 2: Verify red.** Run `npx vitest run tests/chat-backup.test.ts`.
- [ ] **Step 3: Implement backup and documentation.** Create backup files with mode `0600` on Unix. Include Node/Nitro native-addon requirement, persistent disk, CSV migration, restore from backup, plaintext sensitivity, and the later PostgreSQL/`owner_id` migration boundary.
- [ ] **Step 4: Verify green.** Run `npm test`, `npm run typecheck`, `npm run build`; run `npm run backup:chat` against a disposable test DB; inspect the resulting database with the repository loader. Stop after these gates pass.
- [ ] **Step 5: Commit.** `git add package.json package-lock.json scripts/backup-chat-db.mjs tests/chat-backup.test.ts README.md server/tools/sessions/README.md`; `git commit -m "docs: add chat backup and recovery guide"`.

## Deferred follow-up

Automatic `context_checkpoints`/summaries are a separate implementation plan after the first release. Their source is the same complete SQLite history; they must not overwrite or delete original messages. Authentication and per-owner access checks are another separate plan when multiple users become an actual requirement. PostgreSQL is only needed when the app runs on multiple server instances or SQLite write contention becomes measurable.

## Plan self-review

- Spec coverage: Tasks 1–8 cover storage, server-owned context, logs, tools, interruption, continuation and UI; Task 9 covers backup and operating constraints. Summaries and multi-user work are explicitly deferred as agreed.
- Interfaces: `sessionId` identifies a chat, `requestId` is the turn ID, `run_log_id` remains a diagnostic filename key. `ChatUIMessage` is the same format in DB, API and `useChat`.
- Risk gates: native addon build in Task 1; tool side-effect boundary in Task 5; stream persistence in Task 6; safe continuation in Task 7; UI restore and full build in Tasks 8–9.
