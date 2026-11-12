import { describe, expect, it } from 'vitest'
import * as chat from '../shared/chat'

describe('dialogueTokenTotal', () => {
  it('sums reported usage across assistant replies, including repeated history', () => {
    expect(chat).toHaveProperty('dialogueTokenTotal')
    const messages: chat.ChatUIMessage[] = [
      { id: 'user', role: 'user', parts: [], metadata: {
        durationMs: 0,
        usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 },
      } },
      { id: 'reply-1', role: 'assistant', parts: [], metadata: {
        durationMs: 10,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      } },
      { id: 'reply-2', role: 'assistant', parts: [], metadata: {
        durationMs: 10,
        usage: { inputTokens: 250, outputTokens: 75, totalTokens: 325 },
      } },
    ]

    expect(chat.dialogueTokenTotal(messages)).toBe(475)
    expect(chat.dialogueTokenTotal(messages.slice(0, 2))).toBe(150)
  })

  it('skips replies without token statistics and starts each dialogue at zero', () => {
    expect(chat).toHaveProperty('dialogueTokenTotal')
    const messages: chat.ChatUIMessage[] = [
      { id: 'partial', role: 'assistant', parts: [{ type: 'text', text: 'Ответ…' }] },
      { id: 'unknown-usage', role: 'assistant', parts: [], metadata: {
        durationMs: 10,
        usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
      } },
      { id: 'reply', role: 'assistant', parts: [], metadata: {
        durationMs: 10,
        usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
      } },
    ]

    expect(chat.dialogueTokenTotal(messages)).toBe(10)
    expect(chat.dialogueTokenTotal([])).toBe(0)
  })
})
