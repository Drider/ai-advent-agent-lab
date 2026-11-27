import type { Tool } from 'ai'
import { connectMcpServers, type McpServerConfig } from '../mcp/client'

export interface SchedulerData { sourceId: string; observedAt: string; payload: unknown }
export interface SchedulerPeriodItem { runId: string; scheduledFor: string; observedAt: string; payload: unknown }
export interface SchedulerPeriodPage { items: SchedulerPeriodItem[]; nextCursor?: string }

function decodeToolResult(value: unknown): unknown {
  if (value && typeof value === 'object' && 'isError' in value && (value as { isError?: boolean }).isError) throw new Error(extractText(value) || 'MCP tool returned an error')
  const text = extractText(value)
  if (text === undefined) return value
  try { return JSON.parse(text) as unknown } catch { return text }
}

function extractText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  return content.filter((part): part is { type: 'text'; text: string } => Boolean(part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')).map(part => part.text).join('\n') || undefined
}

async function invoke(tool: Tool<unknown, unknown>, input: unknown, toolCallId: string): Promise<unknown> {
  if (!tool.execute) throw new Error('scheduler MCP tool has no execute function')
  return decodeToolResult(await tool.execute(input, { toolCallId, messages: [] } as never))
}

export function createSchedulerMcpRunner(options: { server: McpServerConfig; connector?: typeof connectMcpServers; signal?: AbortSignal }) {
  let connection: Awaited<ReturnType<typeof connectMcpServers>> | undefined
  let ready: Promise<Awaited<ReturnType<typeof connectMcpServers>>> | undefined
  const ensureConnection = (): Promise<Awaited<ReturnType<typeof connectMcpServers>>> => {
    if (ready) return ready
    ready = (async () => {
      const connector = options.connector ?? connectMcpServers
      connection = await connector([options.server], { signal: options.signal })
      for (const name of ['mcp_scheduler__get_data', 'mcp_scheduler__save_result', 'mcp_scheduler__read_period']) {
        if (!connection.tools[name]) throw new Error(`scheduler MCP server does not provide ${name}`)
      }
      return connection
    })().catch(error => {
      ready = undefined
      throw error
    })
    return ready
  }

  return {
    async getData(input: { sourceId: string; query: Record<string, string> }): Promise<SchedulerData> {
      const connected = await ensureConnection()
      const result = await invoke(connected.tools.mcp_scheduler__get_data as Tool<unknown, unknown>, input, `scheduler-get-${Date.now()}`)
      if (!result || typeof result !== 'object' || typeof (result as { observedAt?: unknown }).observedAt !== 'string' || !('payload' in result)) throw new Error('invalid get_data result')
      return result as SchedulerData
    },
    async saveResult(input: { runId: string; payload: unknown; observedAt: string }): Promise<{ saved: boolean; runId: string }> {
      const connected = await ensureConnection()
      const result = await invoke(connected.tools.mcp_scheduler__save_result as Tool<unknown, unknown>, input, `scheduler-save-${input.runId}`)
      if (!result || typeof result !== 'object' || typeof (result as { runId?: unknown }).runId !== 'string') throw new Error('invalid save_result result')
      return result as { saved: boolean; runId: string }
    },
    async readPeriod(input: { jobId: string; from: string; to: string; cursor?: string; limit?: number }): Promise<SchedulerPeriodPage> {
      const connected = await ensureConnection()
      const result = await invoke(connected.tools.mcp_scheduler__read_period as Tool<unknown, unknown>, input, `scheduler-read-${Date.now()}`)
      if (!result || typeof result !== 'object' || !Array.isArray((result as { items?: unknown }).items)) throw new Error('invalid read_period result')
      return result as SchedulerPeriodPage
    },
    async close(): Promise<void> {
      await ready?.catch(() => undefined)
      await connection?.close()
    },
  }
}
