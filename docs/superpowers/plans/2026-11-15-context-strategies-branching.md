# Context Strategies and Branching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Sliding Window and Sticky Facts beside Summary and Off, move settings into a modal, fork a dialogue after a completed answer, and produce a measured three-strategy comparison.

**Architecture:** Keep full UI history in SQLite and route each model request through a strategy-specific context preparation path. Persist facts snapshots and per-session strategy settings; fork by copying the visible prefix into a new session and carrying forward only strategy state valid at the fork point. Preserve actual model usage for both answer and maintenance calls.

**Tech Stack:** Nuxt 4, Vue 3, AI SDK 7, better-sqlite3, Vitest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-11-15-context-strategies-branching-design.md`

## Global Constraints

- Full saved messages remain unchanged when preparing a smaller model context.
- Defaults: Summary threshold 20; Sliding Window and Sticky Facts `N = 10`.
- Only completed assistant answers can be fork points.
- Strategy settings belong to the session; a new branch inherits them and then changes independently.
- Actual usage must include maintenance calls; unknown usage is not zero.
- The `data/` file workspace and global dice history stay shared.

## Review Focus

- Switching from Summary to Off or Sliding Window after a checkpoint must not leak the summary or drop covered messages (Task 2).
- Repeating a request after a successful facts update must not bill or update that message twice (Task 3).
- Returning to Sticky Facts after other modes must process skipped user messages in order (Task 3).
- Forking during an active turn or at an incomplete/user message must fail without a partial child (Task 4).
- Deleting a parent must leave children readable and writable (Task 4).

---

## File map

- `shared/chat.ts`: strategy/settings contracts and request validation.
- `server/persistence/migrations.ts`, `server/persistence/session-repository.ts`: session settings and branch origin.
- `server/context-compaction/prepare.ts`: shared entry point and strategy dispatch; existing Summary path stays intact.
- `server/context-compaction/sliding-window.ts`: exact last-N selection and budget check.
- `server/context-compaction/facts.ts`, `server/context-compaction/facts-repository.ts`: structured extraction, snapshots, usage, and Sticky Facts assembly.
- `server/persistence/branch-repository.ts`, `server/api/sessions/[id]/branches.post.ts`: transactional fork creation and branch links.
- `components/ChatSettingsModal.vue`, `components/ChatSessionList.vue`, `components/ChatWorkspace.vue`, `pages/chat/[id].vue`: modal, value summary, facts view, and fork navigation.
- `scripts/compare-context-strategies.mjs`, `docs/context-strategy-comparison.md`: reproducible scenario and measured report.

### Task 1: Settings contract and persistence

**Files:** Modify `shared/chat.ts`, `server/persistence/migrations.ts`, `server/persistence/session-repository.ts`, `server/api/chat.post.ts`; add a settings PATCH endpoint; test `tests/chat-request.test.ts`, `tests/session-repository.test.ts`.

**Interfaces:** Produce `ChatContextStrategy = 'off' | 'summary' | 'sliding_window' | 'sticky_facts'`, `ChatStrategySettings { strategy, windowSize, messageThreshold }`, `validateStrategySettings(input): ChatStrategySettings`, and session repository `getStrategySettings(id)` / `setStrategySettings(id, settings)`; preserve legacy `compaction` request parsing during migration.

- [x] Test validation of four modes, integer bounds, server-saved per-session settings, and independent settings in two sessions.
- [x] Run focused request/repository tests after the implementation.
- [x] Add schema migration and repository/API contract; adapt request handling to read saved session strategy and store the per-turn snapshot.
- [x] Run the focused tests and `npm run typecheck`.

### Task 2: Sliding Window and Summary isolation

**Files:** Create `server/context-compaction/sliding-window.ts`; modify `server/context-compaction/prepare.ts`, `server/api/chat.post.ts`; test `tests/context-compaction.test.ts`, `tests/context-compaction-policy.test.ts`.

**Interfaces:** Produce `selectSlidingWindow(messages: StoredContextMessage[], size: number): StoredContextMessage[]`; `prepareSessionContext` dispatches `off`, `summary`, and `sliding_window` while preserving `originalMessages`.

- [x] Test exact last-N messages, no summarizer call, full history in Off after a prior Summary checkpoint, and checkpoint isolation.
- [x] Run the context tests after the implementation.
- [x] Implement dispatch, budget check, and checkpoint isolation.
- [x] Run context tests and typecheck.

### Task 3: Sticky Facts

**Files:** Create `server/context-compaction/facts.ts`, `server/context-compaction/facts-repository.ts`; modify `server/persistence/migrations.ts`, `server/context-compaction/prepare.ts`, `server/persistence/session-repository.ts`, `components/ChatWorkspace.vue`; add `tests/sticky-facts.test.ts`.

**Interfaces:** Produce `updateFacts({ model, previousFacts, userMessage, abortSignal }): Promise<{ facts: Record<string,string>, usage?: ChatTokenUsage }>` and repository methods `latestFacts(sessionId, throughPosition)`, `saveFactsUpdate(...)`, `listFactsUpdates(sessionId)`.

- [x] Test facts extraction, validation, idempotent snapshots, empty provider output, and usage persistence.
- [x] Run the Sticky Facts tests after the implementation.
- [x] Add bounded structured extraction and versioned persistence; send facts plus last N messages and expose the facts/maintenance usage in session data.
- [x] Run tests and typecheck.

### Task 4: Dialogue branches

**Files:** Create `server/persistence/branch-repository.ts`, `server/api/sessions/[id]/branches.post.ts`; modify `server/persistence/migrations.ts`, `server/persistence/session-repository.ts`, `shared/chat.ts`, `components/ChatWorkspace.vue`, `components/ChatSessionList.vue`, `pages/chat/[id].vue`; add `tests/branch-repository.test.ts`.

**Interfaces:** Produce `createBranch({ parentSessionId, throughMessageId }): SessionSummary`, plus `parent` and `children` links in session detail. Copy message prefix with fresh IDs, valid Summary checkpoint and facts snapshot, not operational turns.

- [x] Test two children from one answer, independent prefixes, source point validation, and active-parent rejection.
- [x] Run the branch repository tests after the implementation.
- [x] Implement the transaction, API, fork icon, and parent/child navigation.
- [x] Run tests and typecheck.

### Task 5: Settings modal and migration

**Files:** Create `components/ChatSettingsModal.vue`; modify `components/ChatSessionList.vue`, `components/ModelSettings.vue`, `components/ChatCostSettings.vue`, `pages/chat/[id].vue`, `app/assets/css/main.css`; add or update `tests/model-settings.test.ts`.

**Interfaces:** Modal works on a draft, Save persists model and session strategy, Cancel discards it. Sidebar renders values only. Existing browser settings are imported once for legacy sessions.

- [x] Verify the modal draft flow, strategy-specific N/threshold field, and compact sidebar values through typecheck/build.
- [ ] Add a browser-level test for legacy localStorage import (the server session setting remains authoritative after load).
- [x] Implement modal and compact summary; remove inline strategy controls.
- [x] Run typecheck and production build.

### Task 6: Scenario, measurement, and final verification

**Files:** Create `scripts/compare-context-strategies.mjs`, `docs/context-strategy-comparison.md`; modify `README.md`, `docs/chat-context-compaction.md`, `docs/chat-compaction-manual-test.md`; test only new scoring logic if it has nontrivial branches.

**Interfaces:** Runner starts three fresh sessions, sends the same 15 prompts sequentially, stores five answers and provider usage, counts assistant and maintenance calls, and writes a reproducible result table. Complexity is counted as nonblank noncomment lines of strategy-specific source; shared code is separate.

- [x] Implement scenario runner and document its configuration, scoring, output, and a safe local mock-provider run.
- [x] Run unit tests, typecheck, and production build.
- [ ] Run the real scenario through the configured provider after explicit approval to send the project details; the result table currently contains a local mock-provider control run.
- [x] Commit documentation and runner, review the final diff, and report results and remaining limits.
