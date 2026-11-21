# Инварианты ассистента

Инварианты — глобальные правила проекта, которые подключаются к системному prompt каждого хода. Их снимок сохраняется в `agent_config`, поэтому ход использует зафиксированную версию правил даже если правила изменятся позже. Типы, начальные правила и проверки полей определены в [`shared/invariant.ts`](../shared/invariant.ts).

## Модель

Инвариант содержит:

- `id` — стабильный идентификатор;
- `category` — `architecture`, `decision`, `stack` или `business`;
- `title` и `rule` — описание для интерфейса и модели;
- `forbidden` — regex-шаблоны для проверки сгенерированного текста и содержимого `write_file`;
- `updatedAt` — время последнего изменения.

Правила глобальны для всех диалогов. Хранилище — SQLite, таблицы `invariants` и `invariant_changes`. Чтение, мутации и журналирование реализованы в [`invariant-repository.ts`](../server/persistence/invariant-repository.ts), а схема и начальное заполнение — в [`migrations.ts`](../server/persistence/migrations.ts). Каждая мутация записывает `before` и `after` в одной транзакции.

## Команды

Команды разбирает [`shared/invariant.ts`](../shared/invariant.ts), перехватывает в браузере [`ChatWorkspace.vue`](../components/ChatWorkspace.vue), а страница диалога отправляет изменения через [`pages/chat/[id].vue`](../pages/chat/%5Bid%5D.vue). Команды не передаются модели:

```text
/invariant set <id> [категория] <текст правила>
/invariant forbid <id> <regex>; <regex>
/invariant remove <id>
```

`set` создаёт правило или обновляет существующее. Если категория не указана для нового правила, используется `decision`; у существующего сохраняется прежняя категория. `forbid` полностью заменяет список regex; команда без шаблонов оставляет только prompt-ограничение. Изменение обычной фразой в чате не считается командой и не меняет правило.

API чтения реализует [`index.get.ts`](../server/api/invariants/index.get.ts). Изменение и удаление доступны через [`[id].put.ts`](../server/api/invariants/%5Bid%5D.put.ts) и [`[id].delete.ts`](../server/api/invariants/%5Bid%5D.delete.ts); агенту эти инструменты не выдаются. Отображение текущих правил и журнала выполняет [`InvariantPanel.vue`](../components/InvariantPanel.vue).

## Проверка до ответа

`streamChatAgent` в [`chat-agent.ts`](../server/agent/chat-agent.ts) буферизует текстовый блок, проверяет его на все `forbidden`-шаблоны с флагами `iu`, и только затем отдаёт его клиенту. При совпадении исходный блок заменяется одним кодовым отказом с id правила, найденным фрагментом и подсказкой `/invariant set …`. В metadata сообщения записываются `invariantViolations`, поле которого описано в [`shared/chat.ts`](../shared/chat.ts).

`write_file` проверяется отдельно перед записью в том же [`chat-agent.ts`](../server/agent/chat-agent.ts). При совпадении файл не создаётся, а инструмент возвращает структурную ошибку `INVARIANT_VIOLATION`, объявленную в [`file-tool-contracts.ts`](../server/tools/files/file-tool-contracts.ts). Это закрывает обход через просьбу сохранить запрещённый код в файл.

При наличии правил текст ответа приходит блоком, поэтому клиент не видит непроверенные частичные дельты. При отсутствии правил сохраняется обычный потоковый режим.

## Ограничения regex

Для одного инварианта разрешено не более 20 шаблонов, длина каждого — не более 200 символов. Каждый шаблон компилируется до сохранения; невалидный regex отклоняется. Эти проверки реализованы в [`shared/invariant.ts`](../shared/invariant.ts). Ограничения уменьшают размер пользовательского ввода и риск случайного ReDoS, но не превращают произвольный regex в полностью безопасный sandbox.

Шаблоны следует направлять на признаки решения: импорты, вызовы API, команды установки и фрагменты кода. Голые слова дают ложные срабатывания на отказах и обычной прозе. Семантические синонимы и обфускация без запрещённого фрагмента намеренно остаются ограничением первой версии.

Начальные правила для проекта задаёт [`INITIAL_INVARIANTS`](../shared/invariant.ts):

- `stack-frontend`: Vue 3 / Nuxt вместо React;
- `storage-sqlite`: `better-sqlite3` без ORM;
- `server-llm`: вызовы LLM только на сервере;
- `money-rub`: стоимость только в рублях.

Подробный список попыток обхода находится в [отчёте эксперимента](invariants-bypass-report.md).

## Файлы реализации

| Область | Реализация |
| --- | --- |
| Типы, начальные правила, команды и regex-проверки | [`shared/invariant.ts`](../shared/invariant.ts) |
| SQLite-хранилище и журнал изменений | [`server/persistence/invariant-repository.ts`](../server/persistence/invariant-repository.ts), [`server/persistence/migrations.ts`](../server/persistence/migrations.ts) |
| Серверный prompt, проверка ответа и `write_file` | [`server/agent/chat-agent.ts`](../server/agent/chat-agent.ts), [`server/tools/files/file-tool-contracts.ts`](../server/tools/files/file-tool-contracts.ts) |
| Команды и HTTP API | [`components/ChatWorkspace.vue`](../components/ChatWorkspace.vue), [`pages/chat/[id].vue`](../pages/chat/%5Bid%5D.vue), [`server/api/invariants/`](../server/api/invariants/) |
| Панель и metadata ответа | [`components/InvariantPanel.vue`](../components/InvariantPanel.vue), [`shared/chat.ts`](../shared/chat.ts), [`components/ChatWorkspace.vue`](../components/ChatWorkspace.vue) |

## Дальнейшие улучшения

Следующие возможности пока остаются в backlog и не входят в текущую реализацию:

- добавить разбивку инвариантов по проектам;
- добавить LLM-судью для разбора формулировок и семантических обходов;
- добавить редактор инвариантов в UI.
