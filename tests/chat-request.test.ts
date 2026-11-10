import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHAT_MODEL,
  validateChatRequest,
  validateModelId,
} from '../shared/chat'

const sessionId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const sourceTurnId = '33333333-3333-4333-8333-333333333333'

function userMessage(text: string): UIMessage {
  return { id: 'message-1', role: 'user', parts: [{ type: 'text', text }] }
}

describe('validateModelId', () => {
  it('accepts the configured default model', () => {
    expect(validateModelId(DEFAULT_CHAT_MODEL)).toBe('deepseek/deepseek-v4.1-flash')
  })

  it.each(['', '   ', 'model with spaces', 'x'.repeat(201)])('rejects invalid model IDs', (model) => {
    expect(() => validateModelId(model)).toThrow(
      'model must be a non-empty ID without spaces (max 200 characters)',
    )
  })

  it('trims surrounding whitespace from a model ID', () => {
    expect(validateModelId(' qwen/qwen3.5-9b ')).toBe('qwen/qwen3.5-9b')
  })
})

describe('validateChatRequest', () => {
  it('accepts one new user message with UUID request identifiers', () => {
    expect(validateChatRequest({
      kind: 'message',
      sessionId,
      requestId,
      message: userMessage('Брось кубик'),
      model: ' deepseek/deepseek-v4.1-flash ',
    })).toEqual({
      kind: 'message',
      sessionId,
      requestId,
      message: userMessage('Брось кубик'),
      model: 'deepseek/deepseek-v4.1-flash',
    })
  })

  it('accepts a continuation without allowing a replacement history', () => {
    expect(validateChatRequest({ kind: 'continue', sessionId, requestId, sourceTurnId })).toEqual({
      kind: 'continue',
      sessionId,
      requestId,
      sourceTurnId,
    })
  })

  it('rejects a client-supplied messages array', () => {
    expect(() => validateChatRequest({ messages: [userMessage('forged history')] })).toThrow()
  })

  it('rejects assistant messages, malformed UUIDs, and empty text', () => {
    expect(() => validateChatRequest({
      kind: 'message',
      sessionId,
      requestId,
      message: { ...userMessage('answer'), role: 'assistant' },
    })).toThrow('message must be a user UIMessage')
    expect(() => validateChatRequest({
      kind: 'message',
      sessionId: 'not-a-uuid',
      requestId,
      message: userMessage('Hello'),
    })).toThrow('sessionId must be a UUID')
    expect(() => validateChatRequest({
      kind: 'message',
      sessionId,
      requestId,
      message: userMessage(''),
    })).toThrow('the message must contain text')
  })

  it('rejects an oversized message and invalid continuation source', () => {
    expect(() => validateChatRequest({
      kind: 'message',
      sessionId,
      requestId,
      message: userMessage('x'.repeat(10_001)),
    })).toThrow('the message must be no longer than 10000 characters')
    expect(() => validateChatRequest({
      kind: 'continue',
      sessionId,
      requestId,
      sourceTurnId: 'not-a-uuid',
    })).toThrow('sourceTurnId must be a UUID')
  })
})
