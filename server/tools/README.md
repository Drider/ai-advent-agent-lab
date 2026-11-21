# Серверные инструменты

Все инструменты, которые доступны агенту, собраны в этой папке. Каждая
функциональная группа изолирована в собственном каталоге и имеет публичную
точку входа `index.ts`.

## Группы

- [`dice/`](./dice/README.md) — броски кубика и история бросков:
  `rollDie`, `listSavedRolls`.
- [`files/`](./files/README.md) — поиск, чтение, анализ и создание файлов:
  `find_files`, `read_file`, `read_pdf`, `search_text`, `text_stats`, `write_file`.
- [`memory/`](./memory/README.md) — явное сохранение записи в рабочую или долговременную память:
  `save_memory`.
- [`model-configurations/`](./model-configurations/README.md) — сохранение, просмотр и удаление именованных конфигураций моделей:
  `save_model_configuration`, `list_model_configurations`, `delete_model_configuration`.
- [`user-profiles/`](./user-profiles/README.md) — просмотр и явное управление дополнительными инструкциями:
  `list_user_profiles`, `get_user_profile`, `create_user_profile`, `update_user_profile`, `delete_user_profile`, `select_user_profile`.
- [`sessions/`](./sessions/README.md) — чтение и агрегирование JSON-логов:
  `get_current_session`, `list_sessions`, `read_session_file`, `analyze_sessions`.
- [`tasks/`](./tasks/README.md) — состояние задачи, ответы анкеты, шаг и предложения переходов:
  `get_task_state`, `record_task_answer`, `amend_task_answer`, `update_task_step`,
  `request_task_transition`, `cancel_task_transition`.

`server/agent/chat-agent.ts` подключает группы инструментов к `ToolLoopAgent`.
Описание поведения для модели находится в определениях инструментов; файлы
`SKILL.md` в отдельных группах служат документацией для разработчиков.
