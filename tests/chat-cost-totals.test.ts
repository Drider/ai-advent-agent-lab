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

  it('counts a compaction attempt on its user message and carries it into the reply total once', () => {
    const userMessage = { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Вопрос' }] }
    const reply = {
      id: 'reply-1', role: 'assistant', parts: [], metadata: {
        durationMs: 10,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        costRub: { input: 0.02, output: 0.03, total: 0.05 },
      },
    }
    const attempts: chat.CompactionAttemptView[] = [{
      id: 'attempt-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      userMessageId: userMessage.id,
      trigger: 'message_count',
      status: 'completed',
      modelId: 'mock-model',
      fromMessagePosition: 0,
      throughMessagePosition: 9,
      estimatedBeforeTokens: 1000,
      estimatedAfterTokens: 300,
      costRub: { input: 0.03, output: 0, total: 0.03 },
      summary: 'Сводка',
      startedAt: '2026-11-13T00:00:00.000Z',
      finishedAt: '2026-11-13T00:00:01.000Z',
    }]

    const totals = chat.dialogueCostTotals([userMessage, reply] as chat.ChatUIMessage[], attempts)

    expect(totals.get(userMessage.id)).toBe(0.03)
    expect(totals.get(reply.id)).toBe(0.08)
  })

  it('does not add an attempt without provider usage', () => {
    const userMessage = { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Вопрос' }] }
    const attempts: chat.CompactionAttemptView[] = [{
      id: 'attempt-1', sessionId: 'session-1', turnId: 'turn-1', userMessageId: userMessage.id,
      trigger: 'message_count', status: 'failed', modelId: 'mock-model', fromMessagePosition: 0,
      throughMessagePosition: 9, estimatedBeforeTokens: 1000, estimatedAfterTokens: 300,
      startedAt: '2026-11-13T00:00:00.000Z', error: 'provider failed',
    }]

    expect(chat.dialogueCostTotals([userMessage] as chat.ChatUIMessage[], attempts).has(userMessage.id)).toBe(false)
  })
})
