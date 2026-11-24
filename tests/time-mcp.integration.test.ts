import type {
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { connectMcpServers } from '../server/mcp/client'
import { createChatAgent, streamChatAgent } from '../server/agent/chat-agent'
import type { UIMessage } from 'ai'

const integrationEnabled = process.env.RUN_TIME_MCP_INTEGRATION === '1'
const timeServer = [{ id: 'time', command: 'uvx', args: ['mcp-server-time'] }]

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

function toolCallResult(toolCallId: string, toolName: string, input: Record<string, unknown>): LanguageModelV3GenerateResult {
  return {
    content: [{
      type: 'tool-call',
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage,
    warnings: [],
  }
}

function textResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  }
}

function streamResult(chunks: LanguageModelV3StreamPart[]): LanguageModelV3StreamResult {
  return { stream: simulateReadableStream({ chunks }) }
}

function streamToolCallResult(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): LanguageModelV3StreamResult {
  return streamResult([
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ])
}

function streamTextResult(text: string): LanguageModelV3StreamResult {
  return streamResult([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ])
}

function userMessage(text: string): UIMessage {
  return {
    id: 'time-mcp-message',
    role: 'user',
    parts: [{ type: 'text', text }],
  }
}

function findToolResult(prompt: unknown, toolName: string, toolCallId: string): Record<string, unknown> | undefined {
  if (!Array.isArray(prompt)) return undefined

  for (const message of prompt) {
    if (typeof message !== 'object' || message === null || !('role' in message) || message.role !== 'tool') {
      continue
    }
    const content = 'content' in message ? message.content : undefined
    if (!Array.isArray(content)) continue
    const result = content.find((part) => {
      if (typeof part !== 'object' || part === null) return false
      return 'type' in part && part.type === 'tool-result'
        && 'toolName' in part && part.toolName === toolName
        && 'toolCallId' in part && part.toolCallId === toolCallId
    })
    if (typeof result === 'object' && result !== null) return result as Record<string, unknown>
  }

  return undefined
}

describe.skipIf(!integrationEnabled)('Time MCP server integration', () => {
  it('discovers namespaced tools and returns the real Moscow time to the next model step', async () => {
    const connection = await connectMcpServers(timeServer, { timeoutMs: 60_000 })

    try {
      expect(connection.names).toEqual(expect.arrayContaining([
        'mcp_time__get_current_time',
        'mcp_time__convert_time',
        'mcp_time__get_time_ago',
      ]))

      const model = new MockLanguageModelV3({
        doGenerate: [
          toolCallResult('time-call', 'mcp_time__get_current_time', { timezone: 'Europe/Moscow' }),
          textResult('Время получено от Time MCP Server.'),
        ],
      })

      const result = await createChatAgent(model, undefined, { mcpTools: connection.tools }).generate({
        prompt: 'Сколько сейчас времени в Москве?',
      })
      const schema = model.doGenerateCalls[0]?.tools?.find(tool => tool.name === 'mcp_time__get_current_time')
      const inputSchema = schema && 'inputSchema' in schema ? schema.inputSchema : undefined
      const toolResult = findToolResult(model.doGenerateCalls[1]?.prompt, 'mcp_time__get_current_time', 'time-call')
      const toolResultText = JSON.stringify(toolResult)

      expect(result.text).toBe('Время получено от Time MCP Server.')
      expect(inputSchema).toMatchObject({
        type: 'object',
        properties: { timezone: expect.anything() },
      })
      expect(toolResult).toMatchObject({
        type: 'tool-result',
        output: { type: 'content', value: expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: expect.stringContaining('Europe/Moscow') }),
        ]) },
      })
      expect(toolResultText).toMatch(/20\d{2}-\d{2}-\d{2}/)
      expect(toolResultText).toMatch(/\d{2}:\d{2}/)
    } finally {
      await connection.close()
    }
  }, 90_000)

  it('passes an invalid timezone error to the next model step and closes the server', async () => {
    let connection: Awaited<ReturnType<typeof connectMcpServers>> | undefined
    let closeMock: Mock<() => Promise<void>> | undefined
    const connect = async (...args: Parameters<typeof connectMcpServers>) => {
      const [servers, options] = args
      const actual = await connectMcpServers(servers, { ...options, timeoutMs: 60_000 })
      closeMock = vi.fn<() => Promise<void>>(async () => { await actual.close() })
      const wrapped = { ...actual, close: async (): Promise<void> => { await closeMock?.() } }
      connection = wrapped
      return wrapped
    }

    try {
      const model = new MockLanguageModelV3({
        doStream: [
          streamToolCallResult('invalid-time-call', 'mcp_time__get_current_time', { timezone: 'Mars/Olympus' }),
          streamTextResult('Time MCP Server сообщил об ошибке часового пояса.'),
        ],
      })

      const response = await streamChatAgent({
        model,
        modelId: 'mock-model',
        messages: [userMessage('Проверь несуществующую временную зону.')],
        runId: '2026-11-25T00:00:00.000Z',
        logLevel: 'off',
        mcpServers: timeServer,
        mcpConnector: connect,
      })
      const body = await response.text()
      const toolResult = findToolResult(model.doStreamCalls[1]?.prompt, 'mcp_time__get_current_time', 'invalid-time-call')

      expect(body).toContain('Time MCP Server сообщил об ошибке часового пояса.')
      expect(toolResult).toMatchObject({
        type: 'tool-result',
        output: { type: 'content', value: expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: expect.stringMatching(/Invalid timezone|No time zone found/) }),
        ]) },
      })
      expect(closeMock).toHaveBeenCalledOnce()
    } finally {
      await connection?.close()
    }
  }, 90_000)
})
