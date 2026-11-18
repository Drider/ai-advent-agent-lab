---
name: model-configurations
description: Save, inspect, or delete named model configurations when the user explicitly asks.
---

# Model configurations

Use this skill when the user asks to save, show, inspect, or delete saved model
configurations.

## Configuration shape

A saved profile has a name and a `configuration` object with exactly these
fields:

```json
{
  "name": "Profile name",
  "configuration": {
    "modelId": "provider/model-id",
    "contextWindowTokens": 128000,
    "contextStrategy": {
      "strategy": "summary",
      "windowSize": 10,
      "messageThreshold": 20
    },
    "costSettings": {
      "enabled": false,
      "inputPrice": "",
      "outputPrice": ""
    },
    "detailedStatistics": false
  }
}
```

`contextWindowTokens` is optional and must be a positive integer when present.
Valid strategies are `off`, `summary`, `sliding_window`, and `sticky_facts`.
`windowSize` must be from 1 to 10000; `messageThreshold` must be from 12 to
10000. Cost prices are strings so the saved profile preserves what the user
entered.

## Rules

- Save or delete only when the user explicitly requests that action.
- Do not invent model IDs, context limits, prices, or strategy settings. Ask for
  missing values or list saved profiles when the user intends to reuse one.
- Use `save_model_configuration` to save. A case-insensitive name match updates
  that profile; report whether it was replaced.
- Use `list_model_configurations` whenever the user asks to view or inspect the
  library. Use it before deletion and confirm the requested name matches the
  listed profile ID.
- Use `delete_model_configuration` only with an ID returned by the list tool in
  the current turn.
- Report the exact result from the tool. A saved profile is available in chat
  settings, where selecting it fills the draft settings and the user applies
  them with Save.
