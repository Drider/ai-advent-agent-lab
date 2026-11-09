# Agent Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Создать простой потоковый веб-чат с отдельным агентом, который по просьбе пользователя бросает d6 или указанный кубик `dN` и логирует обращения.

**Architecture:** Nuxt 4 обслуживает страницу и `/api/chat`. `ToolLoopAgent` на сервере владеет инструкциями, инструментом и циклом «модель → инструмент → модель → ответ»; маршрут только проверяет запрос и передаёт его агенту. Текущий диалог живёт в памяти вкладки, а диагностические записи сохраняются на локальном диске.

**Tech Stack:** Node.js 22.18+, npm, Nuxt 4, Vue 3, TypeScript, Nuxt UI 4, Lucide Icons, AI SDK 7 (`ai`, `@ai-sdk/vue`, `@ai-sdk/openai`), Comark, KaTeX, Zod, Vitest, Nuxt Typecheck.

**Spec:** [2026-11-09-agent-chat-design.md](../specs/2026-11-09-agent-chat-design.md)

## Global Constraints

- Один локальный процесс Node.js с постоянной папкой `data/`; серверное хранение истории и развёртывание без постоянного диска не входят в задачу.
- Из пользовательских настроек — только ID модели; `LLM_BASE_URL`, `LLM_API_KEY`, необязательный `LLM_MODEL_DEFAULT` и `LLM_LOG_LEVEL` читаются из `.env`. Ключ доступен только серверу.
- Модель по умолчанию: `deepseek/deepseek-v4.1-flash`; формат провайдера — OpenAI-совместимый Chat Completions.
- Один вызов инструмента даёт один независимый результат `1..sides`; `sides` по умолчанию `6`, допустимо `2..1000`. Запрос о броске всегда использует инструмент.
- Цикл завершается после итогового ответа без новых tool calls; предел — 10 шагов и общее время выполнения. Исчерпание предела показывается как ошибка.
- Логи: `off|basic|detailed|raw`, по умолчанию `basic`; один `data/runs/run-<runId>.json` на диалог, запись после каждого обращения.
- Ориентир по пакетам и интерфейсу — соседний `ai-app`; не переносить его бенчмарки, архив чатов и прочие настройки. Образец экрана находится рядом со спецификацией.
- Версии основы из `ai-app`: `nuxt@4.6.4`, `@nuxt/ui@4.12.0`, `ai@7.0.162`, `@ai-sdk/vue@4.0.162`, `@ai-sdk/openai@4.0.108`, `@comark/nuxt@0.8.1`, `@iconify-json/lucide@1.2.151`, `vitest@5.1.0`, `typescript@5.9.3`; добавить `zod@4.6.7`.

## File Map

| Файл | Ответственность |
| --- | --- |
| `package.json`, `package-lock.json`, `tsconfig.json`, `nuxt.config.ts`, `.env.example`, `.gitignore` | Зависимости, команды, конфигурация и исключение секретов/логов |
| `shared/chat.ts` | `ChatRequestBody`, `validateModelId`, `validateChatRequest`, константы ограничений |
| `server/tools/dice/dice-tool.ts` | Проверка числа граней, случайный бросок, AI SDK tool |
| `server/agent/chat-agent.ts` | Создание `ToolLoopAgent`, поток, шаги, предел, связь с логгером |
| `server/utils/run-logger.ts` | Уровни, проекция полей, атомарная запись JSON по `runId` |
| `server/utils/chat-request.ts` | Лимит HTTP-тела, проверка UI-сообщений и разрешение приватной конфигурации |
| `server/api/chat.post.ts` | HTTP-проверка и передача запроса агенту |
| `pages/index.vue`, `components/ModelSettings.vue`, `app.vue`, `app/assets/css/main.css` | Чат, выбор модели, новая сессия, адаптивный вид |
| `tests/chat-request.test.ts`, `tests/dice-tool.test.ts`, `tests/chat-agent.test.ts`, `tests/run-logger.test.ts`, `tests/server-chat-request.test.ts` | Проверки границ запроса, броска, агентного цикла, логов и HTTP-входа |
| `README.md` | Запуск, `.env`, сценарии проверки и ограничения |

## Review Focus

Эти входы и сбои имеют отдельные проверки в задачах ниже:

1. Пустое сообщение, повреждённый `UIMessage` или слишком большой контекст отклоняются до обращения к платной модели — Task 1 и Task 5.
2. `d1`, `d1001`, дробное число граней и крайние допустимые значения не дают результата вне диапазона — Task 2.
3. Несколько последовательных вызовов инструмента используют настоящие результаты каждого броска — Task 3.
4. Зациклившаяся модель, отказ от tool calling и обрыв потока не превращаются в выдуманный успешный ответ — Task 3 и Task 5.
5. Параллельные записи одной сессии и разные уровни логирования не теряют записи и не раскрывают ключ — Task 4.

---

### Task 1: Основа Nuxt и контракт запроса

**Files:** Create `package.json`, `package-lock.json`, `tsconfig.json`, `nuxt.config.ts`, `.env.example`, `.gitignore`, `app.vue`, `shared/chat.ts`, `tests/chat-request.test.ts`.

**Interfaces:** Produce `ChatRequestBody { messages: UIMessage[]; model?: string; runId?: string }`, `DEFAULT_CHAT_MODEL`, `validateModelId(input: unknown): string`, `validateChatRequest(input: unknown): ChatRequestBody`.

- [ ] **Step 1: Создать минимальный Nuxt-проект.** Взять версии основных пакетов и npm scripts `dev`, `build`, `preview`, `typecheck`, `test` из соседнего `ai-app`; добавить прямую зависимость `zod`. Настроить приватные `llmBaseUrl`/`llmApiKey`, публичный `chatDefaultModel`, `llmLogLevel`; добавить `.env.example` и исключить `.env`, `.nuxt`, `.output`, `node_modules`, `data/runs` из Git. Сгенерировать lock-файл через `npm install`.
- [ ] **Step 2: Проверить каркас.** `npm run typecheck` и `npm run build` завершаются с кодом 0 без API-ключа.
- [ ] **Step 3: Написать падающие проверки `tests/chat-request.test.ts`.** `validateModelId` принимает `deepseek/deepseek-v4.1-flash` и отклоняет пустой ID, пробелы и длину 201; `validateChatRequest` отклоняет пустой текст последнего сообщения, более 100 сообщений, текст длиннее 10 000 символов и не-ISO `runId`.
- [ ] **Step 4: Запустить `npm test -- tests/chat-request.test.ts`.** Ожидается FAIL из-за отсутствия экспортируемых функций.
- [ ] **Step 5: Реализовать `shared/chat.ts`.** Нормализовать ID модели как в `ai-app` (trim, не более 200 символов, без пробелов), проверить форму сообщений и последний пользовательский текст; передать глубокую проверку `UIMessage` SDK на Task 5. Ограничения: 100 сообщений и 10 000 символов для последнего текста.
- [ ] **Step 6: Повторить тест и зафиксировать.** `npm test -- tests/chat-request.test.ts`, `npm run typecheck`; затем коммит `feat: scaffold chat app and request contract`.

### Task 2: Инструмент броска кубика

**Files:** Create `server/tools/dice/dice-tool.ts`, `tests/dice-tool.test.ts`.

**Interfaces:** Produce `DieRoll { sides: number; result: number }`, `rollDie(sides?: number, draw?: typeof randomInt): DieRoll`, `createDiceTool(draw?: typeof randomInt)` для `ToolLoopAgent`.

- [ ] **Step 1: Написать падающие проверки.** Для `rollDie()` зафиксировать аргументы генератора `[1, 7)` и результат d6; для d20 — `[1, 21)`; крайние результаты `1` и `sides` допустимы; `1`, `1001`, `2.5` отклоняются. Проверить, что два вызова обращаются к генератору дважды.
- [ ] **Step 2: Запустить `npm test -- tests/dice-tool.test.ts`.** Ожидается FAIL из-за отсутствия модуля.
- [ ] **Step 3: Реализовать инструмент.** `rollDie` использует `node:crypto.randomInt(1, sides + 1)`; `createDiceTool` описывает один бросок и применяет Zod-схему `sides: integer 2..1000` с default `6`. Ответ инструмента — только `{ sides, result }`.
- [ ] **Step 4: Повторить тест и зафиксировать.** `npm test -- tests/dice-tool.test.ts`, `npm run typecheck`; затем коммит `feat: add server dice tool`.

### Task 3: Отдельный агент и многошаговый цикл

**Files:** Create `server/agent/chat-agent.ts`, `tests/chat-agent.test.ts`.

**Interfaces:** Produce `createChatAgent(model: LanguageModel, diceTool = createDiceTool()): ToolLoopAgent` и `streamChatAgent(input: { model: LanguageModel; modelId: string; messages: UIMessage[]; abortSignal?: AbortSignal }): Promise<Response>`. Task 4 расширит аргумент полями `runId` и `logLevel`; Task 5 вызовет окончательную сигнатуру.

- [ ] **Step 1: Написать падающие проверки на `MockLanguageModelV3` из `ai/test`.** Модель сначала возвращает tool call `rollDie`, затем итоговый текст с результатом; проверить порядок двух шагов, значение из инструмента и ответ в UI-потоке. Отдельная последовательность из двух tool calls должна использовать оба результата. Вопрос без броска проходит без вызова инструмента.
- [ ] **Step 2: Добавить сценарии отказа.** Модель, бесконечно запрашивающая инструмент, останавливается после 10 шагов с явной ошибкой; ошибка модели или отсутствие поддержки tool calling даёт ошибку клиенту, а не успешный ответ; обрыв по `AbortSignal` прекращает новые шаги.
- [ ] **Step 3: Запустить `npm test -- tests/chat-agent.test.ts`.** Ожидается FAIL до реализации агента.
- [ ] **Step 4: Реализовать `createChatAgent` и `streamChatAgent`.** `ToolLoopAgent` владеет инструкциями «для `dN` передай `sides=N`, без типа — `6`; для каждого броска вызови инструмент и не придумывай результат», `rollDie`, `stopWhen: isStepCount(10)` и общим таймаутом. `streamChatAgent` вызывает `createAgentUIStreamResponse`; при достижении предела не выдаёт промежуточный текст как завершённый ответ.
- [ ] **Step 5: Повторить тест и зафиксировать.** `npm test -- tests/chat-agent.test.ts`, `npm run typecheck`; затем коммит `feat: add tool-loop chat agent`.

### Task 4: Диагностическое логирование

**Files:** Create `server/utils/run-logger.ts`, `tests/run-logger.test.ts`; modify `server/agent/chat-agent.ts`, `tests/chat-agent.test.ts`.

**Interfaces:** Produce `RunLogLevel = 'off' | 'basic' | 'detailed' | 'raw'`, `RunLogEntry` с вопросом, ответом/ошибкой, временем, длительностью, суммарным usage и необязательными `request`, `response`, `steps`, `rawResponse`; `appendRunLogEntry(entry: RunLogEntry, directory?: string): Promise<void>`. Extend `streamChatAgent` input with `runId: string` and `logLevel: RunLogLevel`.

- [ ] **Step 1: Написать падающие проверки логгера.** `basic` сохраняет вопрос, ответ, длительность и суммарные токены без контекста; `detailed` добавляет модель, контекст, вызовы и результаты инструмента; `raw` добавляет raw chunks; `off` не создаёт файл. Два одновременных append с одним `runId` дают две записи без потерь; разные `runId` — разные файлы; ключ отсутствует во всех проекциях.
- [ ] **Step 2: Запустить `npm test -- tests/run-logger.test.ts`.** Ожидается FAIL из-за отсутствия модуля.
- [ ] **Step 3: Реализовать `appendRunLogEntry`.** Следовать формату `ai-app`: `data/runs/run-<ISO runId>.json`, очередь записей на файл, временный файл и atomic rename. Фильтровать поля по уровню, без сериализации секретов.
- [ ] **Step 4: Подключить логгер к агенту.** На завершении или ошибке потока писать одну запись на пользовательское сообщение; в `basic` агрегировать usage всех шагов; в `detailed` собрать шаги через `onStepEnd` и записать tool calls/results; в `raw` включить raw chunks через AI SDK 7, если они доступны. Ошибка записи только пишется в серверный console и не прерывает готовый ответ. Дополнить `tests/chat-agent.test.ts` проверкой вызова логгера.
- [ ] **Step 5: Повторить тесты и зафиксировать.** `npm test -- tests/run-logger.test.ts tests/chat-agent.test.ts`, `npm run typecheck`; затем коммит `feat: log agent conversations`.

### Task 5: Серверный маршрут и конфигурация модели

**Files:** Create `server/utils/chat-request.ts`, `server/api/chat.post.ts`, `tests/server-chat-request.test.ts`; modify `shared/chat.ts`, `server/agent/chat-agent.ts` при необходимости.

**Interfaces:** Produce `parseChatPayload(raw: string): Promise<ChatRequestBody>` and `resolveChatConfig(config: ChatRuntimeConfig, requestedModel?: string): { baseURL: string; apiKey: string; modelId: string; logLevel: RunLogLevel }`, where `ChatRuntimeConfig` contains private `llmBaseUrl`, `llmApiKey`, `llmLogLevel` and public `chatDefaultModel`. Consume `streamChatAgent`; expose `POST /api/chat` with AI SDK UI message stream.

- [ ] **Step 1: Написать падающие `tests/server-chat-request.test.ts`.** `parseChatPayload` отклоняет JSON больше 256 КБ, повреждённый `UIMessage` и не-JSON; `resolveChatConfig` отклоняет отсутствие URL/ключа безопасной ошибкой, выбирает явный `model` или default и нормализует уровень логирования.
- [ ] **Step 2: Запустить `npm test -- tests/server-chat-request.test.ts`.** Ожидается FAIL из-за отсутствия модуля.
- [ ] **Step 3: Реализовать HTTP-вход.** `parseChatPayload` проверяет размер, вызывает `validateChatRequest` и SDK `validateUIMessages`; `resolveChatConfig` читает только переданный приватный Nuxt config. Маршрут читает raw body, вызывает эти функции, создаёт `createOpenAI({ baseURL, apiKey }).chat(modelId)` и передаёт данные в `streamChatAgent` вместе с `AbortSignal` и `runId` (если не пришёл — новый ISO timestamp). Вернуть 400 для ошибки входа, безопасную 500 для отсутствующей конфигурации и безопасное сообщение в потоке для ошибки провайдера.
- [ ] **Step 4: Повторить проверки.** `npm test -- tests/server-chat-request.test.ts`, `npm run typecheck`, `npm run build`; вручную проверить 400 и 500 через `curl` без реального ключа. Затем коммит `feat: expose agent chat API`.

### Task 6: Страница чата и инструкция по запуску

**Files:** Create `pages/index.vue`, `components/ModelSettings.vue`, `app/assets/css/main.css`, `README.md`; modify `app.vue`.

**Interfaces:** Consume `POST /api/chat`, `useRuntimeConfig().public.chatDefaultModel`, `ChatRequestBody`; no new server interface.

- [ ] **Step 1: Сверстать страницу по скриншоту.** Левая область содержит только поле ID модели; справа — заголовок, сообщения, потоковый ответ, поле ввода, ошибку и «Новая сессия». Использовать Nuxt UI, Lucide, Comark и KaTeX; на малом экране настройки открываются компактно.
- [ ] **Step 2: Подключить `useChat` и запрос.** `DefaultChatTransport` передаёт `messages`, текущий `model`, ISO `runId`; пустой ввод и повторная отправка во время ответа блокируются. Enter отправляет, Shift+Enter добавляет строку. Новая сессия очищает сообщения и черновик, возвращает модель по умолчанию и создаёт новый `runId`; обновление страницы начинает пустой чат.
- [ ] **Step 3: Проверить состояния вручную и сборкой.** При локально заданном LLM API проверить обычный вопрос, d6, d10, d20, несколько бросков, смену модели, ошибку провайдера, новую сессию и перезагрузку. Без рабочего ключа проверить макет и состояния с моковым маршрутом; `npm run typecheck`, `npm test`, `npm run build` завершаются с кодом 0.
- [ ] **Step 4: Описать запуск и зафиксировать.** `README.md`: `npm ci`, `.env`, `npm run dev`, поддерживаемые `dN`, уровни логов, отсутствие восстановления истории и требования к tool calling. Проверить, что `.env` и `data/runs` не попали в Git. Коммит `feat: add chat UI and setup guide`.

## Final Verification

- [ ] `npm run typecheck`, `npm test`, `npm run build` проходят; `git status --short` чистый.
- [ ] С моковой моделью проверены прямой ответ, один и несколько бросков, предел шагов и ошибка провайдера. С реальным API при наличии ключа пройден ручной сценарий чата.
- [ ] В `data/runs` записи соответствуют выбранному уровню, и в браузере/логах нет `LLM_API_KEY`.
- [ ] Реализатор отмечает возможные различия поведения конкретного OpenAI-совместимого провайдера при tool calling.
