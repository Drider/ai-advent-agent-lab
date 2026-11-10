import { describe, expect, it } from 'vitest'
import {
  parseChatPayload,
  resolveChatConfig,
  type ChatRuntimeConfig,
} from '../server/utils/chat-request'

const sessionId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const validMessage = {
  id: 'message-1',
  role: 'user' as const,
  parts: [{ type: 'text' as const, text: 'Брось кубик' }],
}

function createConfig(overrides: Partial<ChatRuntimeConfig> = {}): ChatRuntimeConfig {
  return {
    llmBaseUrl: 'https://provider.example/v1',
    llmApiKey: 'server-secret',
    llmLogLevel: 'detailed',
    public: { chatDefaultModel: 'deepseek/deepseek-v4.1-flash' },
    ...overrides,
  }
}

describe('parseChatPayload', () => {
  it('parses a valid new-message payload', async () => {
    await expect(parseChatPayload(JSON.stringify({
      kind: 'message',
      sessionId,
      requestId,
      message: validMessage,
    }))).resolves.toEqual({ kind: 'message', sessionId, requestId, message: validMessage })
  })

  it('parses a continuation payload without accepting messages', async () => {
    await expect(parseChatPayload(JSON.stringify({
      kind: 'continue',
      sessionId,
      requestId,
      sourceTurnId: '33333333-3333-4333-8333-333333333333',
    }))).resolves.toMatchObject({ kind: 'continue', sessionId, requestId })
  })

  it('rejects a request body larger than 256 KB', async () => {
    const raw = JSON.stringify({ kind: 'message', sessionId, requestId, message: validMessage, padding: 'x'.repeat(256 * 1024) })
    await expect(parseChatPayload(raw)).rejects.toThrow('request body must be no larger than 256 KB')
  })

  it('rejects malformed UI messages before calling the model', async () => {
    await expect(parseChatPayload(JSON.stringify({
      kind: 'message',
      sessionId,
      requestId,
      message: { ...validMessage, parts: [{ type: 'text' }] },
    }))).rejects.toThrow('messages must contain valid UIMessage entries')
  })

  it('rejects non-JSON input', async () => {
    await expect(parseChatPayload('{not-json')).rejects.toThrow('request body must be valid JSON')
  })
})

describe('resolveChatConfig', () => {
  it('rejects missing URL or API key without exposing secrets', () => {
    expect(() => resolveChatConfig(createConfig({ llmBaseUrl: '' }))).toThrow('LLM server configuration is incomplete')
    expect(() => resolveChatConfig(createConfig({ llmApiKey: '' }))).toThrow('LLM server configuration is incomplete')
  })

  it('prefers and normalizes an explicitly requested model', () => {
    expect(resolveChatConfig(createConfig(), ' qwen/qwen3.5-9b ')).toEqual({
      baseURL: 'https://provider.example/v1',
      apiKey: 'server-secret',
      modelId: 'qwen/qwen3.5-9b',
      logLevel: 'detailed',
    })
  })

  it('uses the public default model when no model is requested', () => {
    expect(resolveChatConfig(createConfig())).toMatchObject({ modelId: 'deepseek/deepseek-v4.1-flash' })
  })

  it.each(['off', 'basic', 'detailed', 'raw'] as const)('keeps supported log level %s', (logLevel) => {
    expect(resolveChatConfig(createConfig({ llmLogLevel: logLevel })).logLevel).toBe(logLevel)
  })

  it('normalizes unknown log levels to basic', () => {
    expect(resolveChatConfig(createConfig({ llmLogLevel: 'verbose' })).logLevel).toBe('basic')
  })
})
