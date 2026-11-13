# Chat Context Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inspectable rolling conversation summaries that reduce model input while preserving full chat history and accounting for every compaction call.

**Architecture:** Keep policy, estimator, checkpoint persistence, summarizer, and orchestration inside `server/context-compaction/`. The chat endpoint passes a validated settings snapshot into that module; AI SDK receives compacted `uiMessages` for the model and full `originalMessages` for stream reconciliation. Persist compaction attempts by turn so usage survives a failed agent response.

**Tech Stack:** Nuxt 4, TypeScript, AI SDK 7, better-sqlite3, Vue, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-chat-context-compaction-design.md`

## Global Constraints

- Keep the complete `UIMessage` history in SQLite and in the visible chat; never store the synthetic summary as a user or assistant message.
- Preserve at least the last `K = 10` messages verbatim for model input and compact only across completed user/assistant/tool boundaries.
- Default to compaction enabled, `N = 20` unsummarized messages; reject `N < 12`. Trigger on `count >= N` OR estimated input reaching `70%` of the configured model window.
- With no model window, use the message trigger and the existing `120_000` character limit as the fallback compaction trigger. When disabled or the preserved tail still overflows, report an explicit error; remove silent middle truncation.
- Use the chosen chat model for the summary, without tools. Store successful summaries as versioned checkpoints and every attempted call with its available usage, including failed calls.
- Show estimated before/after size and measured summary usage separately; include summary cost in dialogue totals. Treat unavailable provider usage as unknown, never zero.
- Keep all compaction mechanics in `server/context-compaction/`; only request/UI/schema integration may live elsewhere.
- Use checkpoint `format_version = 1`, summary prompt version `1`, and the turn snapshot key `agent_config_json.contextCompaction`.

## Review Focus

1. A long tool result produced during an agent run can exceed the budget after initial compaction; Task 5 must stop before the next provider call with a clear error.
2. A summary call may fail after consuming tokens; Task 2 and Task 4 must retain its attempt and available usage without creating a checkpoint.
3. The chosen model or window can change between checkpoints; Task 4 must reuse the existing textual summary while recalculating the current budget.
4. A huge old PDF/file result can overflow the summarizer itself; Task 4 must bound its input and record what was omitted without changing the stored history.
5. A threshold of 12 after an odd message boundary can invite repeated compaction or split a user/assistant/tool exchange; Task 3 and Task 4 must retain the complete exchange and advance the checkpoint only over a completed prefix.

---

## File map

- `shared/chat.ts`: request settings, public attempt types, and dialogue cost calculation.
- `server/context-compaction/types.ts`: internal message, checkpoint, decision, and prepared-context contracts.
- `server/context-compaction/estimate.ts`: conservative input-size estimate.
- `server/context-compaction/policy.ts`: trigger and safe boundary selection.
- `server/context-compaction/repository.ts`: checkpoint/attempt reads and atomic writes.
- `server/context-compaction/summarizer.ts`: bounded prompt and tool-free model call.
- `server/context-compaction/index.ts`: single public `prepareSessionContext` entry point.
- `server/context-compaction/step-guard.ts`: model-call budget check inside agent loops.
- `server/persistence/migrations.ts`: schema version and two compaction tables.
- `server/api/chat.post.ts`, `server/agent/chat-agent.ts`: thin server integration.
- `components/ModelSettings.vue`, `components/ChatSessionList.vue`, `pages/chat/[id].vue`, `components/ChatWorkspace.vue`, `components/ChatRequestMetrics.vue`: controls and visible evidence.
- `server/persistence/session-repository.ts`: expose attempts with the session and associate them with the initiating user message.

### Task 1: Request settings contract

**Files:** Modify `shared/chat.ts`, `server/utils/chat-request.ts`; test `tests/chat-request.test.ts`, `tests/server-chat-request.test.ts`.

**Interfaces:** Produce `ChatCompactionSettings = { enabled: boolean; messageThreshold: number; contextWindowTokens?: number }`, `DEFAULT_COMPACTION_SETTINGS` (`true`, `20`), and `validateCompactionSettings(input: unknown): ChatCompactionSettings`. Add optional `compaction` to both `ChatRequestBody` variants; omitted settings resolve to defaults at the server boundary. Keep existing no-settings requests valid.

- [ ] **Step 1: Write failing tests** named `accepts compaction settings on message and continuation`, `defaults absent settings`, and `rejects invalid compaction settings`. Core assertions:
  ```ts
  expect(validateCompactionSettings(undefined)).toEqual({ enabled: true, messageThreshold: 20 })
  expect(validateCompactionSettings({ enabled: true, messageThreshold: 12, contextWindowTokens: 128000 }).messageThreshold).toBe(12)
  expect(() => validateCompactionSettings({ enabled: true, messageThreshold: 11 })).toThrow()
  expect(() => validateCompactionSettings({ enabled: true, messageThreshold: 20, contextWindowTokens: 1.5 })).toThrow()
  ```
  Run both request kinds through `parseChatPayload`; the parsed snapshot must match. Retain the existing client-history rejection assertion.
- [ ] **Step 2: Run** `npx vitest run tests/chat-request.test.ts tests/server-chat-request.test.ts`; expect the new settings tests to fail.
- [ ] **Step 3: Implement** `validateCompactionSettings` and request parsing in the two named files. Accept only positive safe integer windows and safe integer `N >= 12`; bound `N` to `10_000` so malformed requests cannot disable the test trigger accidentally.
- [ ] **Step 4: Run** the same targeted tests; expect PASS.
- [ ] **Step 5: Commit** only Task 1 files: `git commit -m "feat: validate chat compaction settings"`.

### Task 2: Durable checkpoints and attempts

**Files:** Create `server/context-compaction/types.ts`, `server/context-compaction/repository.ts`; modify `server/persistence/migrations.ts`; test `tests/chat-db.test.ts`, create `tests/context-compaction-repository.test.ts`.

**Interfaces:** `createCompactionRepository(db)` exposes `loadMessages(sessionId): Promise<StoredContextMessage[]>`, `latestCheckpoint(sessionId): ContextCheckpoint | null`, `beginAttempt(input): string`, `finishAttempt(input): ContextCheckpoint | null`, `listAttempts(sessionId): CompactionAttempt[]`. A `StoredContextMessage` carries SQLite `position`, `status`, and validated `UIMessage`. An attempt carries `turnId`, trigger, status, model ID, range, estimates, nullable provider usage, and nullable cost. `finishAttempt` commits a valid checkpoint and the successful attempt together; failed attempts never create checkpoints.

- [ ] **Step 1: Write failing DB tests** named `migrates v4 to v5`, `keeps billed failed attempts without checkpoint`, `commits a checkpoint with its attempt`, and `deletes compaction records with a session`. Core assertions:
  ```ts
  expect(db.pragma('user_version', { simple: true })).toBe(5)
  expect(repository.latestCheckpoint(sessionId)).toBeNull()
  expect(repository.listAttempts(sessionId)[0]?.usage?.inputTokens).toBe(120)
  expect(repository.latestCheckpoint(sessionId)?.throughPosition).toBe(9)
  ```
  Reopen the DB between write/read, validate loaded message positions/statuses, and assert both tables are empty after session deletion.
- [ ] **Step 2: Run** `npx vitest run tests/chat-db.test.ts tests/context-compaction-repository.test.ts`; expect failures for missing tables/repository.
- [ ] **Step 3: Implement** schema version 5 and repository methods. Give checkpoints unique `(session_id, through_message_position)` and attempts a `turn_id` foreign key; store structured usage as validated JSON. Reject a checkpoint position that does not advance the current latest position.
- [ ] **Step 4: Run** the targeted tests; expect PASS.
- [ ] **Step 5: Commit** only Task 2 files: `git commit -m "feat: persist context compaction checkpoints"`.

### Task 3: Pure budget and boundary policy

**Files:** Create `server/context-compaction/estimate.ts`, `server/context-compaction/policy.ts`; test `tests/context-compaction-policy.test.ts`.

**Interfaces:** `estimateInputTokens(messages: UIMessage[], promptOverheadTokens: number): number` and `decideCompaction(input: { messages: StoredContextMessage[]; checkpoint: ContextCheckpoint | null; settings: ChatCompactionSettings; promptOverheadTokens: number }): ContextDecision`. `ContextDecision` is `pass`, `compact` (trigger plus completed prefix and tail), or `overflow`. The hard input budget is `80%` of a configured window; the `70%` trigger leaves room to compact before that limit. Count estimated tokens as `ceil(UTF8_bytes(JSON.stringify(model-visible roles and parts)) / 2) + promptOverheadTokens`; this is a conservative estimate, not provider usage. Derive `promptOverheadTokens` from the agent instructions plus a fixed 2,000-token tool-schema reserve.

- [ ] **Step 1: Write failing tests** named `compacts at twenty unsummarized messages`, `compacts at seventy percent before count threshold`, `uses character fallback without a window`, `reports overflow when disabled`, and `keeps completed turns together at twelve`. Core assertions:
  ```ts
  expect(decideCompaction(twentyMessages).kind).toBe('compact')
  expect(decideCompaction(seventyPercentBeforeCount).kind).toBe('compact')
  expect(decideCompaction(disabledOverBudget).kind).toBe('overflow')
  const decision = decideCompaction(oddBoundary)
  expect(decision.kind).toBe('compact')
  if (decision.kind === 'compact') {
    expect(decision.tail[0]?.message.role).toBe('user')
    expect(decision.tail.length).toBeGreaterThanOrEqual(10)
  }
  ```
  Also assert a tail over the hard budget overflows and no partial/tool-pending message enters `toSummarize`.
- [ ] **Step 2: Run** `npx vitest run tests/context-compaction-policy.test.ts`; expect missing-module failures.
- [ ] **Step 3: Implement** estimate and decision functions. Count only messages beyond the latest checkpoint; preserve at least 10 complete recent messages, moving the boundary earlier when needed. Never summarize the current user message or an interrupted/partial assistant message.
- [ ] **Step 4: Run** the targeted tests; expect PASS.
- [ ] **Step 5: Commit** only Task 3 files: `git commit -m "feat: decide when chat context needs compaction"`.

### Task 4: Summary generation and server orchestration

**Files:** Create `server/context-compaction/summarizer.ts`, `server/context-compaction/index.ts`; modify `server/api/chat.post.ts`, `server/utils/session-context.ts`, `server/agent/chat-agent.ts`; test `tests/session-context.test.ts`, create `tests/context-compaction.test.ts`.

**Interfaces:** `prepareSessionContext(input: { db: Database.Database; sessionId: string; turnId: string; model: LanguageModel; modelId: string; settings: ChatCompactionSettings; pricing?: ChatPricing; promptOverheadTokens: number; abortSignal?: AbortSignal }): Promise<{ modelMessages: UIMessage[]; originalMessages: UIMessage[]; attempt?: CompactionAttempt }>`; `summarizeOldContext(input: { model: LanguageModel; previousSummary?: string; messages: StoredContextMessage[]; abortSignal?: AbortSignal }): Promise<{ text: string; usage?: ChatTokenUsage; durationMs: number }>`. `modelMessages` may include a synthetic `user` message explicitly marked as historical data; `originalMessages` never does. `streamChatAgent` accepts both arrays and passes them to AI SDK as `uiMessages` and `originalMessages`. Keep the existing session-not-found behavior and the continuation rule that omits an interrupted trailing assistant's partial text while retaining confirmed non-text parts.

- [ ] **Step 1: Write failing tests** named `creates then advances a rolling checkpoint`, `reuses summary after model change`, `bounds old tool output`, and `records failed paid summarization`. Key assertions:
  ```ts
  expect(secondSummaryPrompt).toContain(firstCheckpoint.summary)
  expect(secondSummaryPrompt).not.toContain(alreadySummarizedRawMessage)
  expect(prepared.modelMessages[0]?.role).toBe('user')
  expect(prepared.originalMessages).toEqual(fullSavedMessages)
  expect(repository.latestCheckpoint(sessionId)).toBeNull() // failed summary case
  expect(repository.listAttempts(sessionId)[0]?.usage?.inputTokens).toBe(120)
  ```
  Reopen the DB, switch model/window, assert a huge PDF result is bounded with an omission marker, and assert a successful checkpoint survives an agent setup failure. Verify `agent_config_json.contextCompaction` contains the settings snapshot used for that call. Test continuation after an interrupted assistant: partial text is absent from model input, confirmed tool parts remain.
- [ ] **Step 2: Run** `npx vitest run tests/session-context.test.ts tests/context-compaction.test.ts`; expect failures for absent orchestration and outdated silent-trimming expectations.
- [ ] **Step 3: Implement** tool-free `generateText` summarization with `maxOutputTokens: 2048`, explicit preservation prompt, output validation, versioned rolling checkpoint, and attempt lifecycle in the module. Replace the old trimming implementation with a thin loader or remove it after moving its tests; call `prepareSessionContext` after `beginUserTurn`/`beginContinuation` and before `streamChatAgent`. Snapshot settings in the turn's `agent_config_json`. Pass compacted context to AI SDK as `uiMessages` and full history as `originalMessages`; mark the turn failed on preparation error. Derive `promptOverheadTokens` from `getAgentConfig().instructions` and the Task 3 tool-schema reserve.
- [ ] **Step 4: Run** the targeted tests plus `npx vitest run tests/server-chat-request.test.ts tests/chat-continuation.test.ts`; expect PASS.
- [ ] **Step 5: Commit** only Task 4 files: `git commit -m "feat: compact old chat context before agent calls"`.

### Task 5: Guard each agent step

**Files:** Create `server/context-compaction/step-guard.ts`; modify `server/agent/chat-agent.ts`; test `tests/chat-agent.test.ts`, `tests/context-compaction-policy.test.ts`.

**Interfaces:** `assertStepWithinBudget(input: { messages: ModelMessage[]; contextWindowTokens?: number; promptOverheadTokens: number }): void`. Add the settings window to `createChatAgent` options and `streamChatAgent` input. The existing final-step `prepareStep` instruction remains; the guard runs before every model call and throws a classified context-limit error when estimated input exceeds `80%` of the window or the `120_000`-character fallback.

- [ ] **Step 1: Write failing tests** named `stops before sending an oversized second step` and `keeps final step instructions`. Core assertions:
  ```ts
  expect(providerCalls).toHaveLength(1)
  expect(turns.getLastTurn(sessionId)?.stopReason).toBe('context_limit')
  expect(savedToolExecution.status).toBe('completed')
  ```
  Keep the existing normal multi-step and final-step assertions passing.
- [ ] **Step 2: Run** `npx vitest run tests/chat-agent.test.ts tests/context-compaction-policy.test.ts`; expect the new overflow test to fail.
- [ ] **Step 3: Implement** the guard within `server/context-compaction/` and call it from `prepareStep` without replacing existing final-step logic. Map its error into the current stop-reason flow.
- [ ] **Step 4: Run** the targeted tests; expect PASS.
- [ ] **Step 5: Commit** only Task 5 files: `git commit -m "feat: guard agent steps against context overflow"`.

### Task 6: Controls, observability, and cost accounting

**Files:** Modify `components/ModelSettings.vue`, `components/ChatSessionList.vue`, `pages/chat/[id].vue`, `components/ChatWorkspace.vue`, `components/ChatRequestMetrics.vue`, `server/persistence/session-repository.ts`, `shared/chat.ts`, `README.md`, `docs/chat-session-persistence.md`, `docs/token-accounting.md`; test `tests/chat-cost-totals.test.ts`, `tests/session-repository.test.ts`, `tests/session-navigation.test.ts`.

**Interfaces:** Add `compactionAttempts: CompactionAttemptView[]` to `SessionDetail`, with `userMessageId` resolved from the attempt's turn. Extend `dialogueCostTotals(messages, compactionAttempts)` so the initiating user message contributes its attempt cost once and the assistant message contributes agent cost once. Keep `latestContextUsage` tied to the last agent model call. The UI passes a settings snapshot on new and continuation requests and refreshes session details after errors.

- [ ] **Step 1: Write failing tests** named `returns attempts after reload`, `counts summary and reply costs once`, and `shows a failed summary beside its user message`. Core assertions:
  ```ts
  expect(detail.compactionAttempts[0]?.userMessageId).toBe(userMessage.id)
  expect(dialogueCostTotals(messages, attempts).get(reply.id)).toBe(0.08)
  expect(dialogueCostTotals([userMessage], failedAttempts).get(userMessage.id)).toBe(0.03)
  ```
  Test missing provider usage as `undefined`, and assert both new-message and continuation transport bodies carry the configured window and threshold.
- [ ] **Step 2: Run** `npx vitest run tests/chat-cost-totals.test.ts tests/session-repository.test.ts tests/session-navigation.test.ts tests/chat-request.test.ts`; expect the new tests to fail.
- [ ] **Step 3: Implement** browser-persisted enable/threshold controls, server-request snapshots, per-message attempt details with expandable summary text, dialogue totals, and error-path refresh. Update the three documents with the new behavior and the fact that ruble costs remain estimates when cache tariffs differ.
- [ ] **Step 4: Run** targeted tests, `npm run typecheck`, and `npm test`; expect PASS. If a test provider is configured, manually send a short dialogue with `N = 12` and a deliberately small configured window; confirm summary visibility, actual provider usage, continuation, and control mode. If no provider is configured, record that the live check remains unverified.
- [ ] **Step 5: Commit** only Task 6 files: `git commit -m "feat: show and control chat context compaction"`.

## Final verification

- [ ] Run `npm run typecheck` and `npm test` on the completed branch; record the result.
- [ ] Review the diff against the spec, especially that checkpoint state never replaces full history and no old truncation path remains.
- [ ] Confirm only task files are committed; pre-existing untracked files stay untouched.
