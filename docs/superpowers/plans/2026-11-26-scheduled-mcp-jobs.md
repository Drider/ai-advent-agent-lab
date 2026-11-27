# Scheduled MCP Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** По заданию из чата запускать MCP-сбор по расписанию, сохранять каждый результат в SQLite и автоматически публиковать сводку из всех результатов периода.

**Architecture:** Nitro plugin запускает фоновый цикл в постоянно работающем серверном процессе. Задания, сроки, попытки и отчёты хранятся в существующей SQLite; отдельный локальный MCP-сервер получает данные, сохраняет результат и постранично читает период. Чат только создаёт и управляет структурированными заданиями; выполнение не зависит от чата.

**Tech Stack:** Nuxt 4, TypeScript, AI SDK 7, `@ai-sdk/mcp`, MCP TypeScript SDK, `better-sqlite3`, Vitest; расчёт пятичастного cron реализуется локально через `Intl.DateTimeFormat`, чтобы не добавлять runtime-зависимость.

**Spec:** [Планировщик заданий с MCP и отчётами за период](../specs/2026-11-26-scheduled-mcp-jobs-design.md).

## Global Constraints

- Чат не принимает произвольный URL или команду источника: только `sourceId` из `SCHEDULER_SOURCES_JSON`.
- Внутренний MCP-сервер по умолчанию запускается из `scripts/scheduler-mcp-server.mjs` через текущий Node; отдельный `SCHEDULER_MCP_SERVER_JSON` переопределяет команду и не добавляется в `MCP_SERVERS_JSON` обычного чата.
- Поддерживается пятичастный cron; `SCHEDULER_DEFAULT_TIMEZONE=Europe/Moscow`; опоздание сбора до пяти минут выполняется, более старые сроки получают `missed`.
- Время в БД — ISO 8601 UTC; человекочитаемое время — в часовом поясе задания.
- `get_data`, `save_result`, `read_period` должны вызываться через MCP, а не прямым импортом функций сервера.
- Исходные результаты сохраняются между запусками и не удаляются при создании отчёта или паузе задания.
- Работа по расписанию требует постоянно запущенного процесса Nuxt; браузер может быть закрыт.

## Review Focus

- Смена летнего времени и несуществующее локальное время: следующий срок вычисляется без дубля или зацикливания; тест в Task 1.
- Перезапуск между `get_data` и `save_result`: зависшая запись получает `failed`, новый результат не выдумывается; тест в Task 3.
- Пустая страница или повторённый cursor `read_period`: отчёт останавливается с ошибкой вместо бесконечного цикла; тест в Task 4.
- Одновременный тик двух процессов: один `(job_id, scheduled_for)` исполняется один раз; тест в Task 3.
- Неработающий источник или модель: неуспех виден, а проверяемые счётчики отчёта остаются доступными; тесты в Tasks 3–4.

## File Structure

- `shared/scheduler.ts`: типы задания, запуска и отчёта; проверка пользовательского ввода.
- `server/scheduler/schedule.ts`: расчёт следующего срока и границ периода.
- `server/scheduler/config.ts`: проверка источников и настройки выделенного MCP-сервера.
- `server/scheduler/repository.ts`: задания, сроки, lease, запуски и отчёты в SQLite.
- `server/scheduler/mcp-runner.ts`: вызов только трёх разрешённых инструментов через `connectMcpServers`.
- `server/scheduler/worker.ts`: цикл сбора, восстановления и отчётов.
- `server/scheduler/report.ts`: чтение всех страниц, запись состава отчёта, счётчики и текстовая сводка по частям.
- `server/plugins/scheduler.ts`: запуск и остановка фонового цикла.
- `scripts/scheduler-mcp-server.mjs`: stdio MCP-сервер и его три инструмента.
- `server/tools/scheduler/`: инструменты чата для создания, просмотра и паузы заданий.
- `server/api/schedules/`, `pages/schedules.vue`: просмотр заданий, запусков и отчётов.

### Task 1: Схема данных и расчёт сроков

**Files:** Modify `server/persistence/migrations.ts`, `package.json`, `package-lock.json`; create `shared/scheduler.ts`, `server/scheduler/schedule.ts`, `server/scheduler/config.ts`, `server/scheduler/repository.ts`; test `tests/scheduler-repository.test.ts`, `tests/scheduler-schedule.test.ts`, update `tests/chat-db.test.ts`.

**Interfaces:** `validateScheduledJob(input: unknown): ScheduledJobInput`; `parseSchedulerSources(raw: string): SchedulerSourceConfig[]`, где `SchedulerSourceConfig = { id: string; kind: 'http_json'; url: string; allowedQueryKeys: string[] }`; `parseSchedulerMcpServer(raw?: string): McpServerConfig`, с локальным default; `nextOccurrence(cron: string, timezone: string, after: Date): Date`; `previousOccurrence(cron: string, timezone: string, before: Date): Date`; `createSchedulerRepository(db)` with `createJob`, `listJobs`, `pauseJob`, `resumeJob`, `claimRun`, `finishRun`, `markMissed`, `claimReport`, `finishReport`, `acquireLease`, `renewLease`, `releaseLease`. `claimRun` and `claimReport` take `(jobId, scheduledFor)` and return a row or `null` when already claimed.

- [ ] Добавить тесты: валидное и невалидное cron/timezone; переход летнего времени; ошибочный каталог источников и запрещённый query-ключ; два срока одной задачи уникальны; повторный `claimRun` возвращает `null`; записи сохраняются после закрытия и открытия БД; миграция с версии 19 добавляет таблицы без изменения существующих данных.
- [ ] Выполнить `npx vitest run tests/scheduler-schedule.test.ts tests/scheduler-repository.test.ts tests/chat-db.test.ts`; новые проверки должны упасть до реализации.
- [x] Добавлена миграция версии 20: `scheduled_jobs`, `scheduled_runs`, `scheduled_results`, `scheduled_reports`, `scheduled_report_results`, `scheduler_lease`; уникальные индексы `(job_id, scheduled_for)` для запусков и отчётов, `run_id` для результатов, `(report_id, run_id)` для состава отчёта. Исходный JSON хранится в `scheduled_results.payload_json`; `scheduled_runs` фиксирует `running`, `completed`, `failed`, `missed`. В задании хранится выбранный `modelId`, но не LLM API key.
- [ ] Реализовать валидацию, cron-расчёт и транзакционные методы репозитория. Периоды отчётов должны быть полуоткрытыми `[from, to)`.
- [ ] Повторить команду тестов и `npm run typecheck`; ожидание: PASS. Зафиксировать самостоятельный коммит схемы и репозитория.

### Task 2: MCP-сервер получения, записи и чтения

**Files:** Create `scripts/scheduler-mcp-server.mjs`, `server/scheduler/mcp-runner.ts`, `tests/scheduler-mcp.test.ts`; modify `nuxt.config.ts`, `.env.example`, `README.md`.

**Interfaces:** MCP `get_data({ sourceId: string, query?: Record<string, string> }) -> { observedAt: string, payload: unknown }`; `save_result({ runId: string, payload: unknown, observedAt: string }) -> { saved: boolean, runId: string }`; `read_period({ jobId: string, from: string, to: string, cursor?: string, limit?: number }) -> { items: Array<{ runId: string, scheduledFor: string, observedAt: string, payload: unknown }>, nextCursor?: string }`. `createSchedulerMcpRunner(config)` exposes typed `getData`, `saveResult`, `readPeriod`, `close`; `config` берётся из отдельного `SCHEDULER_MCP_SERVER_JSON`, всегда с ID `scheduler`.

- [ ] Добавить сквозной тест с настоящим stdio MCP-клиентом и временной SQLite: конфигурация без override запускает локальный сервер; `get_data(clock)` возвращает JSON и время; тестовый локальный HTTP endpoint, внедрённый только в тестовый каталог источников, проверяет `http_json`; неизвестный `sourceId`, произвольный URL и redirect отклоняются; `save_result` идемпотентен; `read_period` отдаёт две страницы без результатов вне `[from, to)`.
- [ ] Выполнить `npx vitest run tests/scheduler-mcp.test.ts`; ожидание: новые проверки падают до реализации.
- [ ] Реализовать MCP-сервер. Для `http_json` читать только HTTPS URL из серверного каталога, разрешать только перечисленные в нём query-параметры, отклонять redirect, ограничивать запрос 15 секундами и ответ 256 КиБ, возвращать `isError` при HTTP/JSON ошибке. `save_result` проверяет существующий `runId` и вставляет запись в SQLite транзакцией. `read_period` использует устойчивый cursor `(scheduled_for, run_id)` и лимит страницы не больше 100.
- [ ] Реализовать адаптер вызовов через `connectMcpServers`; проверять `isError` и форму MCP-ответа, закрывать соединение при завершении и ошибке. Добавить конфигурационный пример для запуска локального сервера.
- [ ] Повторить тест и `npm run typecheck`; ожидание: PASS. Зафиксировать коммит MCP-сервера.

### Task 3: Фоновый сбор и восстановление

**Files:** Create `server/scheduler/worker.ts`, `server/plugins/scheduler.ts`, `tests/scheduler-worker.test.ts`; modify `server/scheduler/repository.ts` при необходимости.

**Interfaces:** `createSchedulerWorker({ repository, mcpRunnerFactory, clock, tickMs }): { start(): void; stop(): Promise<void>; tick(): Promise<void> }`. `tick` сначала восстанавливает истёкший lease и зависшие запуски, затем обрабатывает сроки до текущего UTC времени. `get_data` → `save_result` → `finishRun(completed)` вызываются последовательно.

- [ ] Добавить тесты с управляемым временем: тик запускает сбор при наступлении срока без HTTP-запроса; второй тик и конкурентный worker не дублируют срок; ошибка `get_data`/`save_result` даёт `failed`; перезапуск после `get_data` без сохранения даёт `failed`, а после `save_result` даёт `completed`; срок старше пяти минут становится `missed`, а следующий срок остаётся будущим.
- [ ] Выполнить `npx vitest run tests/scheduler-worker.test.ts`; ожидание: FAIL до реализации.
- [ ] Реализовать lease с продлением, таймаут MCP-вызова, обработку исключений и остановку таймера при закрытии Nitro. Не запускать новый тик, пока предыдущий не закончился; не делать запросы к источнику за исторические сроки после простоя.
- [ ] Повторить тест и `npm run typecheck`; ожидание: PASS. Зафиксировать коммит фонового сбора.

### Task 4: Отчёт из всего периода

**Files:** Create `server/scheduler/report.ts`, `tests/scheduler-report.test.ts`; modify `server/scheduler/worker.ts`, `server/scheduler/repository.ts`.

**Interfaces:** `buildPeriodReport({ reportId, job, from, to, readPeriod, addMembers, summarizeChunk, combineSummaries }): Promise<PeriodReport>`; `PeriodReport` содержит границы, `runCount`, `successCount`, `failureCount`, `missedCount`, `resultCount`, текст и статус текста. `addMembers(reportId, runIds)` пишет состав каждой страницы в `scheduled_report_results`, не удерживая все payload в памяти. `summarizeChunk` и `combineSummaries` — внедряемые вызовы модели. Один срок отчёта соответствует одному уникальному `(jobId, scheduledFor)`.

- [ ] Добавить тест: в трёх страницах MCP лежат результаты трёх разных сроков; `scheduled_report_results` содержит все три `runId`, отчёт имеет правильные счётчики и не включает результат на `to`. Добавить проверки пустого периода, повторной генерации, ошибки модели, повторённого cursor и ошибки на одной из страниц; неполный отчёт после ошибки чтения не помечается готовым.
- [ ] Выполнить `npx vitest run tests/scheduler-report.test.ts`; ожидание: FAIL до реализации.
- [ ] Реализовать обход всех страниц без фиксированного ограничения числа результатов, постраничную запись состава отчёта, детерминированные счётчики по `scheduled_runs` и генерацию текста по частям. При ошибке чтения помечать отчёт `failed`; перед повтором удалять частичный состав этого же отчёта. Если не получилась только текстовая часть, сохранять счётчики, полный состав и статус ошибки текста. Worker должен сначала закончить сборы с `scheduled_for < to`, затем формировать отчёт.
- [ ] Повторить тест и `npm run typecheck`; ожидание: PASS. Зафиксировать коммит отчётов.

### Task 5: Настройка задания из чата

**Files:** Create `server/tools/scheduler/index.ts`, `server/tools/scheduler/scheduler-tools.ts`, `tests/scheduler-tools.test.ts`; modify `server/agent/chat-agent.ts`, `server/api/chat.post.ts`, `server/tools/README.md`.

**Interfaces:** локальные инструменты `list_scheduled_sources`, `create_scheduled_job`, `list_scheduled_jobs`, `pause_scheduled_job`, `resume_scheduled_job`, `read_scheduled_reports`. Создание возвращает `jobId`, точные cron/timezone и `nextCollectAt`/`nextReportAt`; чтение отчётов возвращает сохранённую сводку и период.

- [ ] Добавить тесты: промпт с однозначным расписанием создаёт структурированное задание через tool call; несуществующий источник, запрещённый query-ключ, невалидный cron/timezone и отсутствующее обязательное поле не создают запись; список и пауза/возобновление отражают фактическую БД; продолжение прерванного хода не повторяет создание.
- [ ] Выполнить `npx vitest run tests/scheduler-tools.test.ts tests/chat-agent.test.ts`; ожидание: новые проверки падают до реализации.
- [ ] Подключить инструменты к агенту и его durable tool recording; добавить инструкцию агенту уточнять неоднозначное расписание и показывать человеку точное время следующего запуска. Не выводить секреты источника в ответ модели.
- [ ] Повторить тест и `npm run typecheck`; ожидание: PASS. Зафиксировать коммит чат-интеграции.

### Task 6: Просмотр результатов и сквозная проверка

**Files:** Create `server/api/schedules/index.get.ts`, `server/api/schedules/[id].get.ts`, `pages/schedules.vue`, `tests/scheduler-api.test.ts`, `tests/scheduler-flow.test.ts`; modify `pages/chat/[id].vue`, `README.md`.

**Interfaces:** `GET /api/schedules` возвращает задания с очередными сроками и последним статусом; `GET /api/schedules/:id` возвращает запуски и отчёты с пагинацией, а состав каждого отчёта — постранично. Страница `/schedules` показывает статус задания, последние запуски и каждый готовый отчёт, включая границы периода и число результатов.

- [ ] Добавить тест API и сквозной сценарий: создать задание из чата, выполнить два срока контролируемым clock, закрыть и открыть SQLite, построить отчёт, проверить в API/странице обе сохранённые записи и сводку с `resultCount = 2`.
- [ ] Выполнить `npx vitest run tests/scheduler-api.test.ts tests/scheduler-flow.test.ts`; ожидание: FAIL до реализации.
- [ ] Реализовать страницу и ссылку из чата; документировать переменные окружения, запуск постоянно работающего сервера, пример запроса в чат и способ проверить накопление за два срока.
- [ ] Выполнить `npm test`, `npm run typecheck`, `npm run build`; ожидание: PASS. Провести один живой запуск с настроенным MCP-сервером и убедиться, что повторный запуск приложения сохраняет историю. Если живой вызов модели без ключа невозможен, отметить это отдельно; автоматический тест с fake model остаётся обязательным.
- [ ] Зафиксировать коммит сквозного сценария и документации.

## Self-Review

Пункты запроса имеют явные задачи: конфигурация через чат — Task 5; запуск без вкладки — Task 3; все три MCP-вызова — Tasks 2–4; сохранение каждого запуска — Tasks 1–3; отчёт из всех результатов периода — Task 4; выдача отчёта в приложении — Task 6. План не требует существующего `tasks`-модуля: он обслуживает жизненный цикл интерактивной задачи чата и не является фоновым планировщиком.
