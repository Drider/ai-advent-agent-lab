# Saved Model Configurations Implementation Plan

> **For agentic workers:** implement each task in order and review the resulting diff. Keep the existing application architecture.

**Goal:** Add named model profiles that users can select in chat settings and the agent can save, list, and delete through tools.

**Architecture:** A strict shared validator defines the profile contract. SQLite stores profiles in one repository used by HTTP endpoints and agent tools. The settings modal loads and manages profiles; applying one fills the draft and the existing Save action persists the model and context strategy for the active session.

**Tech Stack:** Nuxt 4, Vue 3, TypeScript, SQLite via `better-sqlite3`, AI SDK tools with Zod.

**Spec:** `docs/superpowers/specs/2026-11-18-saved-model-configurations-design.md`

## Global Constraints

- Store profiles in the same SQLite database used by the UI and agent tools.
- Require the exact profile structure: name, model ID, optional positive context-window token limit, context strategy, cost settings, and detailed-statistics flag.
- Use the existing session endpoints when applying model and context-strategy settings.
- Agent mutations require explicit user intent; deletion requires a listed saved profile.
- Do not add or run tests in this task.

## Review Focus

- Unknown or malformed fields at any profile nesting level must be rejected before saving.
- Duplicate names must update the existing profile and preserve its ID.
- Case variants of Cyrillic and compatibility-equivalent names must resolve to the same profile.
- A missing optional context limit must clear the currently drafted limit when a profile is selected.
- Continuation turns must retain read-only listing while disabling save and delete tools.
- Deleting the currently selected profile must not leave a stale selection in the modal.

---

### Task 1: Shared model-configuration contract and SQLite repository

**Files:**
- Create: `shared/model-config.ts`
- Create: `server/persistence/model-configuration-repository.ts`
- Modify: `server/persistence/migrations.ts`

**Interfaces:**
- `ModelConfigurationInput`: `{ name: string; modelId: string; contextWindowTokens?: number; contextStrategy: ChatContextStrategySettings; costSettings: ChatCostSettings; detailedStatistics: boolean }`
- `ModelConfiguration`: input fields plus `id`, `createdAt`, and `updatedAt`.
- `validateModelConfiguration(input: unknown): ModelConfigurationInput` rejects unknown keys, trims a 1–80 character name, validates model ID, validates an optional positive safe-integer context limit, and validates the exact nested strategy and cost-settings structures.
- Repository factory `createModelConfigurationRepository(db)` exposes `list(): ModelConfiguration[]`, `save(input): ModelConfiguration`, and `delete(id): boolean`.

- [x] Add migration version 10 with a `model_configurations` table, `configuration_json` JSON validity check, timestamps, and a case-insensitive unique index on name.
- [x] Add migration version 11 to backfill `name_key` for existing saved configurations and build the normalized unique index.
- [x] Implement the strict shared profile validator using existing model-ID and context-strategy validators.
- [x] Implement repository list/save/delete; saving a matching case-insensitive name updates that row and returns its stable ID.

### Task 2: HTTP API, agent tools, and model-configuration skill

**Files:**
- Create: `server/api/model-configurations/index.get.ts`
- Create: `server/api/model-configurations/index.post.ts`
- Create: `server/api/model-configurations/[id].delete.ts`
- Create: `server/tools/model-configurations/index.ts`
- Create: `server/tools/model-configurations/model-configuration-tools.ts`
- Create: `server/tools/model-configurations/SKILL.md`
- Modify: `server/agent/chat-agent.ts`
- Modify: `server/api/chat.post.ts`
- Modify: `server/tools/README.md`

**Interfaces:**
- HTTP GET lists profiles; POST accepts `{ name, configuration }`; DELETE removes by ID.
- Agent tools are `save_model_configuration`, `list_model_configurations`, and `delete_model_configuration`.
- The save tool uses a strict Zod object for both the outer input and nested configuration, then calls the shared validator/repository.

- [x] Implement no-store CRUD endpoints with 400 for invalid structures and 404 for unknown profile IDs.
- [x] Implement tool schemas and bind them to the same SQLite repository as the API.
- [x] Register the tools in the agent, record their executions with the existing durable-tool wrapper, and allow only listing in read-only continuation mode.
- [x] Add runtime policy and a skill: save only on explicit requests, list before deletion, and report exact saved/listed/deleted results.
- [x] Document the tool group in `server/tools/README.md`.

### Task 3: Manage and apply saved configurations in chat settings

**Files:**
- Modify: `components/ChatSettingsModal.vue`
- Modify: `components/ChatSessionList.vue`
- Modify: `pages/chat/[id].vue`

**Interfaces:**
- The page loads `ModelConfiguration[]`, creates/updates profiles through POST, and deletes them through DELETE.
- The modal receives the saved profiles and pending/error states; it emits save-profile and delete-profile events.
- Selecting a profile fills the draft model ID, context limit, strategy, cost settings, and detailed-statistics flag. The existing settings Save button applies the draft to the current session.

- [x] Add a configuration name field and save-current-profile action.
- [x] Render saved profile names and their model, context limit, strategy parameters, pricing, and statistics setting.
- [x] Add an apply action that populates all draft fields, including clearing an absent context limit.
- [x] Add deletion and clear the current profile selection after deletion.
- [x] Fetch and mutate profile data through the HTTP API, preserving existing modal save/cancel behavior.

### Task 4: Manual diff review

- [x] Review the changed files for schema consistency across validator, API, tools, and UI.
- [x] Confirm no unrelated user changes were modified.
- [x] Update existing database-version and table-inventory expectations for schema version 11; add no tests.
- [x] Do not run tests as specified by the task constraints.
