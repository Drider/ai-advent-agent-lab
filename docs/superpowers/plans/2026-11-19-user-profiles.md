# User Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable instruction profiles, assigned per dialogue with a default for new dialogues, available from a profiles page and the chat agent.

**Architecture:** Persist profiles, default selection, and dialogue selection in SQLite. Read a versioned full profile snapshot when reserving each turn, add it to the agent instructions on every model step, and include it in all context budget estimates without adding it to compactable history. Expose the same repository through APIs, a profile management page, and recorded agent tools.

**Tech Stack:** Nuxt 4, Vue 3, TypeScript, SQLite (`better-sqlite3`), AI SDK, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-user-profiles-design.md`

## Global Constraints

- Profiles contain a name (1–80 trimmed characters) and full instructions (0–16,000 UTF-16 code units); reject malformed Unicode, NUL, invalid types, and unknown fields.
- Name uniqueness uses NFKC normalization, lowercase, and trimming; conflicts return an error and never overwrite another profile.
- Every session has a profile. The migration creates empty `Основной`, assigns it to existing sessions, and makes it the default.
- New sessions use the current default; branches inherit the parent session's profile.
- Profile edits and selection changes affect following turns. A turn uses the profile snapshot read while it is reserved.
- Inject the full standalone profile block on every agent step, never compact or silently truncate it, and include it in context budget estimates. Keep it out of generated history, checkpoints, Sticky Facts and summarizer input.
- Profile tools use the same repository and recorded execution path; continuation disables all profile mutation tools.
- Preserve the approved design's API, UI, concurrency, privacy, and error behavior in `docs/superpowers/specs/2026-11-19-user-profiles-design.md`.

## Review Focus

- Overlong profile plus near-full prompt: reject before the user message is persisted; pin in `tests/user-profile-context.test.ts`.
- Concurrent profile edit/selection during a generation: current turn retains its snapshot and next turn uses current revision; pin in `tests/user-profile-turn.test.ts`.
- Migration of populated databases: all sessions and the default point to the same initial profile; pin in `tests/user-profile-repository.test.ts`.
- Case/Unicode-equivalent names and stale revisions: reject without overwriting; pin in `tests/user-profile-repository.test.ts`.
- Tool-selected profile changes during its own active turn: only current session is changed and subsequent turns see it; pin in `tests/user-profile-tools.test.ts`.

---

### Task 1: Shared profile model, validation, migration, and repository

**Files:**
- Create: `shared/user-profile.ts`
- Create: `server/persistence/user-profile-repository.ts`
- Modify: `server/persistence/migrations.ts`
- Test: `tests/user-profile-repository.test.ts`
- Test: `tests/chat-db.test.ts`

**Interfaces:**
- Produce `UserProfile`, `UserProfileSummary`, `CreateUserProfileInput`, and `UpdateUserProfileInput` shared types.
- Produce `validateUserProfileCreate(input: unknown)`, `validateUserProfileUpdate(input: unknown)`, and `userProfileNameKey(name: string)`.
- Produce `createUserProfileRepository(db)` with `list()`, `get(id)`, `getDefault()`, `getForSession(sessionId)`, `create(input)`, `update(id, input)`, `setDefault(id)`, `selectForSession(sessionId, profileId, options?)`, and `getForTurn(sessionId, turnId?)`.

- [ ] Write tests for exact field validation, 16,000/16,001 character boundaries, NFKC/case-insensitive uniqueness, revision conflicts, no overwrite on conflict, default CRUD, session selection, populated-session migration, and empty-database migration.
- [ ] Run `npm test -- --run tests/user-profile-repository.test.ts tests/chat-db.test.ts`; confirm new profile tests fail before implementation.
- [ ] Implement shared validators and profile/settings tables; migration assigns `Основной` to existing sessions and adds a required `sessions.user_profile_id` reference.
- [ ] Implement repository operations with transactions. `getForTurn` reads the assigned profile and verifies the active turn when a turn ID is supplied. Selection increments session revision and rejects a running turn unless its own active turn ID is supplied.
- [ ] Extend session creation and branch creation in `session-repository.ts` and `branch-repository.ts` to atomically assign default and inherited profiles respectively.
- [ ] Run the focused command above and confirm all repository and migration tests pass.

### Task 2: Profile and session APIs

**Files:**
- Create: `server/api/user-profiles/index.get.ts`
- Create: `server/api/user-profiles/index.post.ts`
- Create: `server/api/user-profiles/[id].get.ts`
- Create: `server/api/user-profiles/[id].patch.ts`
- Create: `server/api/user-profiles/default.patch.ts`
- Create: `server/api/sessions/[id]/user-profile.patch.ts`
- Modify: `server/api/sessions/index.post.ts`
- Modify: `server/api/sessions/[id].get.ts`
- Modify: `shared/chat.ts`
- Test: `tests/user-profile-api.test.ts`

**Interfaces:**
- Consume the repository and validators from Task 1.
- Return public profile summaries from lists and complete instructions only from the individual-profile route and successful edits.
- Include selected profile ID and summary in session details.

- [ ] Write API tests for no-store headers, create/list/get/update/default/select, malformed and unknown fields, 404, duplicate name/revision 409, running-session 409, default assignment on session creation, and session-detail profile fields.
- [ ] Run `npm test -- --run tests/user-profile-api.test.ts`; confirm endpoint tests fail before implementation.
- [ ] Implement routes using repository methods; validate request shapes strictly and map validation/not-found/conflict errors to 400/404/409.
- [ ] Update session creation to accept its existing optional project ID while always resolving default profile server-side; expose profile summary and ID from session-detail responses.
- [ ] Run the focused command and confirm all API tests pass.

### Task 3: Turn snapshot, agent instructions, and context budgeting

**Files:**
- Modify: `server/api/chat.post.ts`
- Modify: `server/memory/start-turn.ts`
- Modify: `server/agent/chat-agent.ts`
- Modify: `server/context-compaction/step-guard.ts`
- Modify: `server/context-compaction/prepare.ts`
- Test: `tests/user-profile-turn.test.ts`
- Test: `tests/user-profile-context.test.ts`
- Test: `tests/chat-agent.test.ts`

**Interfaces:**
- Produce `UserProfileSnapshot` with `id`, `name`, `revision`, and `instructions`.
- Extend `getAgentConfig` with an optional snapshot and persist snapshot metadata plus effective instruction hash in the turn configuration.
- Extend `startMemoryAwareTurn` to return `{ turnId, snapshot, profileSnapshot }`; read/reserve profile and turn consistently, including continuation requests.
- Pass the same snapshot to `prepareSessionContext` and `streamChatAgent`.

- [ ] Write tests that prove full profile instructions are present at each agent step for all four context strategies and absent as a synthetic history/checkpoint/summarizer message.
- [ ] Write tests for snapshot stability, current profile on continuation, profile bytes in immediate and per-step budget estimation, and over-budget rejection before user-message persistence.
- [ ] Run focused turn/context/agent tests and confirm failure before implementation.
- [ ] Compose the profile as an explicit delimited system-instruction block appended to existing base instructions; keep the authoritative snapshot outside `UIMessage[]` and compaction storage.
- [ ] Ensure the AI SDK step budget guard receives profile-inclusive instruction overhead at setup and every prepare step. Return a clear 422 error without truncating the profile.
- [ ] Verify actual streaming uses the same hashed effective instructions saved in `agent_config_json` and remains stable if profile records change during a running turn.
- [ ] Run the focused command and confirm all profile turn, context and agent tests pass.

### Task 4: Recorded profile tools and agent skill

**Files:**
- Create: `server/tools/user-profiles/index.ts`
- Create: `server/tools/user-profiles/user-profile-tools.ts`
- Create: `server/tools/user-profiles/README.md`
- Create: `server/tools/user-profiles/SKILL.md`
- Modify: `server/tools/README.md`
- Modify: `server/agent/chat-agent.ts`
- Modify: `server/api/chat.post.ts`
- Test: `tests/user-profile-tools.test.ts`

**Interfaces:**
- Produce `createUserProfileTools({ db, sessionId, turnId })` returning `list_user_profiles`, `get_user_profile`, `create_user_profile`, `update_user_profile`, and `select_user_profile`.
- Bind session and active turn IDs on the server; do not accept them in model arguments.
- Wrap profile tools with `recordToolExecution`; on safe continuation enable only list/get profile tools.

- [ ] Write tests for list/get/create/update/select, preserving unmodified fields, revision conflicts, explicit session binding, active-turn-only selection, stopped-turn rejection, and continuation tool allowlist.
- [ ] Run the focused tool tests and confirm they fail before implementation.
- [ ] Implement strict Zod schemas and tool descriptions; return exact saved profile and next-turn effect.
- [ ] Connect tools to chat agent and ensure disabled-mutation active tool set excludes create/update/select.
- [ ] Write the Russian profile-management skill with explicit-intent, full-read-before-edit, collision-clarification, and no memory-inference rules.
- [ ] Run focused tool and agent tests and confirm they pass.

### Task 5: Profile management page and chat selector

**Files:**
- Create: `pages/profiles.vue`
- Create: `components/UserProfileSelector.vue`
- Create: `components/UserProfileEditor.vue`
- Modify: `components/ChatWorkspace.vue`
- Modify: `pages/chat/[id].vue`
- Modify: `shared/chat.ts`
- Test: `tests/user-profile-ui.test.ts` (only if the repository's current Vue test setup can mount Nuxt UI components without added dependencies)

**Interfaces:**
- Consume profile API routes and session-detail fields from Task 2.
- Emit `select(profileId)` from the chat selector; editor emits create/update/default actions and tracks server revision.

- [ ] Implement `/profiles` with profile list, create form, name/instructions fields, revision-aware edit/save, unsaved-change guard, default assignment, and explanatory next-turn text.
- [ ] Add profile selector and `/profiles` link to the chat header; disable direct UI selection while generating and refresh current session/list after a tool result or page return.
- [ ] Preserve return route/session ID when entering the profiles page. Report loading, validation, stale revision and save errors beside the corresponding controls.
- [ ] Manually exercise profile create/edit/default and independent selection in two dialogues using the running app; verify a newly created dialogue uses the current default.

### Task 6: Documentation, full verification, and review

**Files:**
- Modify: `README.md`
- Modify: `server/tools/README.md`
- Modify: `docs/agent-memory.md` only if needed to clarify that user profiles are independent of memory.

- [ ] Document profile management, per-dialogue assignment, default behavior for new dialogues, and agent tools/skill in the README.
- [ ] Run `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Review migration behavior against existing database fixtures and verify the working tree contains only profile implementation changes.
- [ ] Check the final diff against every requirement in `docs/superpowers/specs/2026-11-19-user-profiles-design.md`.
