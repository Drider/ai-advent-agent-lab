# Saved model configurations

## Intent

Let people reuse named model settings across chat sessions and let the agent save, inspect, and delete the same configurations. The configuration shape must be validated exactly before it enters persistent storage.

## Goals and constraints

- Store configurations in the existing SQLite database so the settings UI and server-side tools share one source of truth.
- Include a name, model ID, optional positive context-window token limit, context strategy with its parameters, cost settings, and detailed-statistics flag.
- Reject missing, invalid, or unknown fields at every configuration-object level.
- Let the settings UI list and inspect saved configurations, apply one to the active settings, and delete one.
- Give the agent separate save, list, and delete tools, plus an agent skill describing when and how to use them.
- Preserve the existing per-session model and context-strategy persistence; selecting a profile applies it through the existing settings flow.

## Approaches

- **SQLite shared by the UI and agent tools (selected):** supports both surfaces, survives browser changes, and fits the app's existing repository and migration patterns.
- **Browser local storage:** simpler for UI-only presets, but unavailable to server-side agent tools.
- **Per-session configuration rows:** reuses session ownership but makes profiles unavailable as a shared model library.

## Design

Add a versioned SQLite table and repository for named configurations. A shared validator defines the exact public structure and is used by the API, repository, and tool input schemas. Names use Unicode compatibility normalization and lowercase matching so Cyrillic names update consistently. The UI adds a name field for saving the current settings, a list with configuration details, an apply action, and deletion. Applying a configuration fills the current model and settings fields, then persists the model and context strategy with the existing session endpoints. Agent tools save, list, and delete from the same repository; the model-configuration skill and runtime instructions require explicit user intent for changes and listing before deletion.

## Out of scope

- Provider-specific generation parameters that the current settings screen does not expose.
- Automatically changing a configuration when a session setting changes.
- Import/export or profile sharing between different application databases.

## Builder decisions

- Treat the current context-strategy settings (including Summary threshold or window size) as the context-processing parameters in the profile. Summary's legacy compaction fields remain derived from that strategy.
- Store the context limit as a positive integer when present; expose it as text in the existing UI.
- Saving a configuration with an existing name replaces that configuration, with the result reported to the caller.
