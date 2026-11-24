# Git-тулы через MCP

Интеграция Git MCP состоит из трёх этапов: Git-сервер регистрирует инструменты, MCP-клиент получает их схемы и добавляет namespace, а агент объединяет их со своими локальными инструментами. После этого модель видит схемы Git-тулов и может выбрать нужный инструмент в обычном tool loop.

## 1. Регистрация тулов на Git MCP-сервере

Локальный сервер находится в [scripts/git-mcp-server.mjs](../scripts/git-mcp-server.mjs). Функция registerGitTools регистрирует три инструмента только для чтения:

~~~js [scripts/git-mcp-server.mjs]
function registerGitTools(server, repositoryRoot) {
  const runGit = createGitRunner(repositoryRoot)

  server.registerTool('git_status', {
    title: 'Git status',
    description: 'Show the current branch and changed or untracked files.',
    inputSchema: {},
  }, async () => {
    const output = (await runGit(['status', '--short', '--branch'])).trim()
    return { content: [{ type: 'text', text: output || 'clean' }] }
  })

  server.registerTool('git_log', {
    title: 'Git log',
    inputSchema: {
      limit: z.number().int().min(1).max(20).default(10),
    },
  }, async ({ limit = 10 }) => {
    const output = (await runGit([
      'log', '--oneline', '--decorate', '-' + limit,
    ])).trim()
    return { content: [{ type: 'text', text: output || 'no commits' }] }
  })

  server.registerTool('git_diff', {
    title: 'Git diff',
    inputSchema: {
      staged: z.boolean().default(false),
      path: z.string().optional(),
    },
  }, async ({ staged = false, path }) => {
    const args = ['diff']
    if (staged) args.push('--cached')
    args.push('--')
    if (path) args.push(path)
    const output = await runGit(args)
    return { content: [{ type: 'text', text: output || 'clean' }] }
  })
}
~~~

Имена инструментов на уровне MCP-сервера: git_status, git_log и git_diff. Каждый обработчик вызывает runGit, который запускает Git с массивом аргументов в настроенном репозитории.

Сервер фиксирует репозиторий при запуске и подключается через stdio:

~~~js [scripts/git-mcp-server.mjs]
const repositoryRoot = await findRepositoryRoot(process.argv[2] ?? process.cwd())
const server = new McpServer({ name: 'git-readonly-mcp', version: '1.0.0' })

registerGitTools(server, repositoryRoot)
await server.connect(new StdioServerTransport())
~~~

Сервер намеренно не регистрирует изменяющие операции add, commit, reset, checkout и push.

## 2. Запуск stdio-сервера

Приложение читает список MCP-серверов из MCP_SERVERS_JSON. Массив args передаёт путь к репозиторию Git-серверу:

~~~dotenv [.env]
MCP_SERVERS_JSON='[{"id":"git","command":"node","args":["/absolute/path/scripts/git-mcp-server.mjs","/absolute/path/repository"]}]'
~~~

nuxt.config.ts передаёт переменную окружения в runtimeConfig. API чата разбирает конфигурацию и передаёт список серверов агенту.

## 3. Получение и namespace MCP-тулов

MCP-клиент находится в [server/mcp/client.ts](../server/mcp/client.ts). Он создаёт stdio-транспорт, подключается к каждому серверу, получает полный список инструментов и преобразует MCP-описания в инструменты AI SDK:

~~~ts [server/mcp/client.ts]
const client = await createClient({
  server,
  transport: createTransport(server),
  signal: startupController.signal,
  timeoutMs,
})

const definitions = await listAllTools(client, {
  signal: startupController.signal,
  timeout: timeoutMs,
})

const serverTools = client.toolsFromDefinitions(definitions)
~~~

Клиент добавляет к каждому инструменту ID сервера. Для сервера с id "git" имена становятся такими:

~~~text [tool-name-mapping]
git_status → mcp_git__git_status
git_log    → mcp_git__git_log
git_diff   → mcp_git__git_diff
~~~

Namespace предотвращает конфликты между несколькими MCP-серверами:

~~~ts [server/mcp/client.ts]
for (const [toolName, serverTool] of Object.entries(serverTools)) {
  const namespacedName = 'mcp_' + server.id + '__' + toolName

  if (tools[namespacedName] !== undefined) {
    throw new Error('MCP tool name collision: ' + namespacedName)
  }

  tools[namespacedName] = serverTool
  names.push(namespacedName)
}
~~~

toolsFromDefinitions создаёт функцию execute, которая позже отправляет MCP-запрос tools/call. На этапе обнаружения клиент не запускает Git-команды: он только загружает схемы и подготавливает вызываемые адаптеры.

## 4. Добавление MCP-тулов в агент

Интеграция с агентом находится в [server/agent/chat-agent.ts](../server/agent/chat-agent.ts). Обработчик запроса подключает MCP до создания потокового ответа:

~~~ts [server/agent/chat-agent.ts]
if (shouldConnectMcp && (input.mcpServers?.length ?? 0) > 0) {
  const connect = input.mcpConnector ?? connectMcpServers
  mcpConnection = await connect(input.mcpServers!, {
    signal: input.abortSignal,
  })
}

const persistedMcpTools = mcpConnection
  ? recordTools(mcpConnection.tools as Record<string, Tool<unknown, unknown>>)
  : undefined
~~~

createChatAgent объединяет локальные и MCP-инструменты в один ToolSet:

~~~ts [server/agent/chat-agent.ts]
const localTools = {
  ...diceTools,
  ...fileTools,
  ...sessionTools,
  ...taskTools,
}

const dynamicTools = options.mcpTools ?? {}
const tools: ToolSet = {
  ...localTools,
  ...dynamicTools,
}

return new ToolLoopAgent({
  model,
  tools,
})
~~~

ToolLoopAgent получает MCP-схемы вместе со схемами локальных инструментов. Поэтому модель может выбрать mcp_git__git_status, передать аргументы и продолжить ответ после получения результата.

## 5. Полный путь запроса

~~~text
Запрос пользователя
    ↓
ToolLoopAgent получает локальные и MCP-схемы
    ↓
Модель выбирает mcp_git__git_status, mcp_git__git_log или mcp_git__git_diff
    ↓
AI SDK вызывает адаптер, созданный toolsFromDefinitions
    ↓
MCP-клиент отправляет tools/call через stdio
    ↓
Git MCP-сервер вызывает соответствующий обработчик registerTool
    ↓
runGit выполняет Git в настроенном репозитории
    ↓
Результат MCP возвращается модели для следующего шага агента
~~~

Приложение записывает MCP-вызовы через тот же recordTools, который используется для остальных инструментов. Соединения MCP закрываются после завершения ответа или при ошибке настройки. Запуск имеет ограниченный timeout, а сигнал отмены запроса передаётся в инициализацию MCP и получение списка тулов.

## 6. Ограничения доступности

MCP-тулы подключаются для обычных ходов чата. Агент исключает их во время продолжения прерванного хода и при открытой задаче, которая запрещает повторные или изменяющие действия. Это сохраняет единые правила жизненного цикла хода и безопасности задач.

