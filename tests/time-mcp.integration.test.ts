import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { connectMcpServers } from '../server/mcp/client'
import { createChatAgent } from '../server/agent/chat-agent'

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
      const nextPrompt = JSON.stringify(model.doGenerateCalls[1]?.prompt)
      const schema = model.doGenerateCalls[0]?.tools?.find(tool => tool.name === 'mcp_time__get_current_time')
      const inputSchema = schema && 'inputSchema' in schema ? schema.inputSchema : undefined

      expect(result.text).toBe('Время получено от Time MCP Server.')
      expect(inputSchema).toMatchObject({
        type: 'object',
        properties: { timezone: expect.anything() },
      })
      expect(nextPrompt).toContain('Europe/Moscow')
      expect(nextPrompt).toMatch(/20\d{2}-\d{2}-\d{2}/)
      expect(nextPrompt).toMatch(/\d{2}:\d{2}/)
    } finally {
      await connection.close()
    }
  }, 90_000)

  it('passes an invalid timezone error to the next model step and closes the server', async () => {
    const connection = await connectMcpServers(timeServer, { timeoutMs: 60_000 })

    try {
      const model = new MockLanguageModelV3({
        doGenerate: [
          toolCallResult('invalid-time-call', 'mcp_time__get_current_time', { timezone: 'Mars/Olympus' }),
          textResult('Time MCP Server сообщил об ошибке часового пояса.'),
        ],
      })

      const result = await createChatAgent(model, undefined, { mcpTools: connection.tools }).generate({
        prompt: 'Проверь несуществующую временную зону.',
      })
      const nextPrompt = JSON.stringify(model.doGenerateCalls[1]?.prompt)

      expect(result.text).toBe('Time MCP Server сообщил об ошибке часового пояса.')
      expect(nextPrompt).toMatch(/isError|Invalid time zone|invalid timezone|error/i)
    } finally {
      await connection.close()
    }
  }, 90_000)
})
