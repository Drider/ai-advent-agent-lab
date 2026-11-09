import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHAT_MODEL,
  validateChatRequest,
  validateModelId,
} from '../shared/chat'

function userMessage(text: string): UIMessage {
  return {
    id: 'message-1',
    role: 'user',
    parts: [{ type: 'text', text }],
  }
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
  it('accepts a valid user message and ISO run ID', () => {
    const messages = [userMessage('Брось кубик')]

    expect(validateChatRequest({
      messages,
      model: ' deepseek/deepseek-v4.1-flash ',
      runId: '2026-11-09T12:00:00.000Z',
    })).toEqual({
      messages,
      model: 'deepseek/deepseek-v4.1-flash',
      runId: '2026-11-09T12:00:00.000Z',
    })
  })

  it('rejects an empty last user message', () => {
    expect(() => validateChatRequest({ messages: [userMessage('')] })).toThrow(
      'the last user message must contain text',
    )
  })

  it('rejects more than 100 messages', () => {
    const messages = Array.from({ length: 101 }, (_, index) => ({
      ...userMessage(`message ${index}`),
      id: `message-${index}`,
    }))

    expect(() => validateChatRequest({ messages })).toThrow(
      'messages must contain no more than 100 entries',
    )
  })

  it('rejects a last user message longer than 10000 characters', () => {
    expect(() => validateChatRequest({ messages: [userMessage('x'.repeat(10001))] })).toThrow(
      'the last user message must be no longer than 10000 characters',
    )
  })

  it('rejects a non-ISO run ID', () => {
    expect(() => validateChatRequest({
      messages: [userMessage('Hello')],
      runId: 'not-an-iso-date',
    })).toThrow('runId must be an ISO timestamp')
  })
})
