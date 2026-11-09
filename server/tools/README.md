# Серверные инструменты

Все инструменты, которые доступны агенту, собраны в этой папке. Каждая
функциональная группа изолирована в собственном каталоге и имеет публичную
точку входа `index.ts`.

## Группы

- [`dice/`](./dice/README.md) — броски кубика и история бросков:
  `rollDie`, `listSavedRolls`.
- [`files/`](./files/README.md) — поиск, чтение, анализ и создание файлов:
  `find_files`, `read_file`, `search_text`, `text_stats`, `write_file`.
- [`sessions/`](./sessions/README.md) — поиск через `find_files`, чтение и агрегирование JSON-логов:
  `get_current_session`, `list_sessions`, `read_session_file`, `analyze_sessions`.

`server/agent/chat-agent.ts` подключает группы инструментов к `ToolLoopAgent`,
а внутренние реализации групп не используются напрямую за их пределами.
