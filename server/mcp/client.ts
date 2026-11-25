import { createMCPClient, type ListToolsResult, type MCPTransport } from '@ai-sdk/mcp'
import { StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio'
import type { ToolSet } from 'ai'

const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 60_000

export interface McpServerConfig {
  id: string
  command: string
  args: string[]
}

export interface McpClientLike {
  listTools(options?: {
    params?: { cursor?: string }
    options?: { signal?: AbortSignal; timeout?: number }
  }): Promise<ListToolsResult>
  toolsFromDefinitions(definitions: ListToolsResult): ToolSet
  close(): Promise<void>
}

export type McpClientFactory = (input: {
  server: McpServerConfig
  transport: MCPTransport
  signal?: AbortSignal
  timeoutMs?: number
}) => Promise<McpClientLike>

export interface McpConnectionOptions {
  createClient?: McpClientFactory
  createTransport?: (server: McpServerConfig) => MCPTransport
  signal?: AbortSignal
  timeoutMs?: number
}

function defaultCreateTransport(server: McpServerConfig): StdioMCPTransport {
  return Object.assign(new StdioMCPTransport({
    command: server.command,
    args: server.args,
    stderr: 'inherit',
  }), {
    // A cold uvx server can take longer than AI SDK's 1s discovery probe.
    // Let the overall MCP initialization timeout control this stdio handshake.
    waitsForProtocolVersionDiscovery: true,
  })
}

const defaultCreateClient: McpClientFactory = async ({ transport, signal, timeoutMs }) => {
  return await createMCPClient({
    transport,
    clientName: 'agent-chat-mcp-client',
    version: '1.0.0',
    initializationOptions: {
      signal,
      timeout: timeoutMs,
    },
  }) as unknown as McpClientLike
}

function validationError(message: string): Error {
  return new Error(`MCP_SERVERS_JSON ${message}`)
}

export function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  const input = raw?.trim() || '[]'
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    throw validationError('must be valid JSON')
  }

  if (!Array.isArray(parsed)) {
    throw validationError('must be an array')
  }

  const ids = new Set<string>()
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw validationError(`entry ${index} must be an object`)
    }
    const candidate = entry as Record<string, unknown>
    const id = candidate.id
    const command = candidate.command
    const args = candidate.args
    if (typeof id !== 'string' || !/^[a-z0-9_]+$/u.test(id)) {
      throw validationError(`entry ${index} id must contain only lowercase letters, digits, and underscores`)
    }
    if (ids.has(id)) {
      throw validationError(`contains duplicate server id: ${id}`)
    }
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw validationError(`entry ${index} command must be a non-empty string`)
    }
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
      throw validationError(`entry ${index} args must be an array of strings`)
    }
    ids.add(id)
    return { id, command, args: [...args] }
  })
}

async function listAllTools(client: McpClientLike, requestOptions: { signal?: AbortSignal; timeout?: number }): Promise<ListToolsResult> {
  const tools: ListToolsResult['tools'] = []
  let cursor: string | undefined
  const seenCursors = new Set<string>()
  do {
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) throw new Error(`MCP tool listing repeated cursor: ${cursor}`)
      seenCursors.add(cursor)
    }
    const page = await client.listTools({
      ...(cursor === undefined ? {} : { params: { cursor } }),
      options: requestOptions,
    })
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor !== undefined && cursor.length > 0)
  return { tools }
}

export async function connectMcpServers(
  servers: McpServerConfig[],
  options: McpConnectionOptions = {},
): Promise<{ tools: ToolSet; names: string[]; close(): Promise<void> }> {
  const createClient = options.createClient ?? defaultCreateClient
  const createTransport = options.createTransport ?? defaultCreateTransport
  const clients: McpClientLike[] = []
  const tools: ToolSet = {}
  const names: string[] = []
  let closed = false
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_MCP_STARTUP_TIMEOUT_MS)
  const startupController = new AbortController()
  const forwardAbort = () => startupController.abort(options.signal?.reason)
  if (options.signal?.aborted) forwardAbort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })

  const close = async () => {
    if (closed) return
    closed = true
    await Promise.allSettled(clients.map(client => client.close()))
  }

  const startup = (async () => {
    for (const server of servers) {
      const client = await createClient({
        server,
        transport: createTransport(server),
        signal: startupController.signal,
        timeoutMs,
      })
      clients.push(client)
      const definitions = await listAllTools(client, { signal: startupController.signal, timeout: timeoutMs })
      const serverTools = client.toolsFromDefinitions(definitions)
      for (const [toolName, serverTool] of Object.entries(serverTools)) {
        const namespacedName = `mcp_${server.id}__${toolName}`
        if (tools[namespacedName] !== undefined) {
          throw new Error(`MCP tool name collision: ${namespacedName}`)
        }
        tools[namespacedName] = serverTool
        names.push(namespacedName)
      }
    }
  })()

  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        startupController.abort(new Error(`MCP startup timed out after ${timeoutMs} ms`))
        reject(new Error(`MCP startup timed out after ${timeoutMs} ms`))
      }, timeoutMs)
    })
    try {
      await Promise.race([startup, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  } catch (error) {
    await close()
    throw error
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort)
  }

  return { tools, names, close }
}
