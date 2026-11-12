import { describe, expect, it } from 'vitest'
import * as chat from '../shared/chat'

describe('dialogueCostTotals', () => {
  it('accumulates only priced assistant replies in message order', () => {
    expect(chat).toHaveProperty('dialogueCostTotals')
    const messages = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Вопрос' }] },
      { id: 'reply-1', role: 'assistant', parts: [], metadata: {
        durationMs: 10,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        costRub: { input: 0.01, output: 0.02, total: 0.03 },
      } },
      { id: 'reply-without-price', role: 'assistant', parts: [] },
      { id: 'reply-2', role: 'assistant', parts: [], metadata: {
        durationMs: 10,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        costRub: { input: 0.02, output: 0.03, total: 0.05 },
      } },
    ] as chat.ChatUIMessage[]

    expect([...chat.dialogueCostTotals(messages)]).toEqual([
      ['reply-1', 0.03],
      ['reply-2', 0.08],
    ])
  })
})
