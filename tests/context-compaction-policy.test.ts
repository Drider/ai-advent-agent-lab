import { randomUUID } from 'node:crypto'
import type { ChatCompactionSettings, ChatUIMessage } from '../shared/chat'
import { describe, expect, it } from 'vitest'
import { decideCompaction } from '../server/context-compaction/policy'
import { estimateInputTokens } from '../server/context-compaction/estimate'
import type { ContextCheckpoint, StoredContextMessage } from '../server/context-compaction/types'

function message(role: ChatUIMessage['role'], text: string, position: number, status: StoredContextMessage['status'] = 'complete'): StoredContextMessage {
  return {
    position,
    status,
    message: { id: randomUUID(), role, parts: [{ type: 'text', text }] },
  }
}

function alternating(count: number, text = 'сообщение'): StoredContextMessage[] {
  return Array.from({ length: count }, (_, position) => message(position % 2 === 0 ? 'user' : 'assistant', `${text} ${position}`, position))
}

const enabled: ChatCompactionSettings = { enabled: true, messageThreshold: 20, contextWindowTokens: 100_000 }

describe('context compaction policy', () => {
  it('compacts at twenty unsummarized messages', () => {
    const decision = decideCompaction({ messages: alternating(20), checkpoint: null, settings: enabled, promptOverheadTokens: 0 })

    expect(decision.kind).toBe('compact')
    if (decision.kind !== 'compact') return
    expect(decision.trigger).toBe('message_count')
    expect(decision.toSummarize).toHaveLength(10)
    expect(decision.tail).toHaveLength(10)
    expect(decision.estimatedAfterTokens).toBeLessThan(decision.estimatedBeforeTokens)
  })

  it('compacts at seventy percent before the message threshold', () => {
    const messages = alternating(20, 'x'.repeat(180))
    const decision = decideCompaction({
      messages,
      checkpoint: null,
      settings: { enabled: true, messageThreshold: 100, contextWindowTokens: 3000 },
      promptOverheadTokens: 0,
    })

    expect(decision.kind).toBe('compact')
    if (decision.kind === 'compact') expect(decision.trigger).toBe('context_fraction')
  })

  it('uses the character fallback without a configured window', () => {
    const decision = decideCompaction({
      messages: alternating(20, 'x'.repeat(7_000)),
      checkpoint: null,
      settings: { enabled: true, messageThreshold: 100 },
      promptOverheadTokens: 0,
    })

    expect(decision.kind).toBe('compact')
    if (decision.kind === 'compact') expect(decision.trigger).toBe('fallback_limit')
  })

  it('reports overflow when compaction is disabled and the budget is exceeded', () => {
    const decision = decideCompaction({
      messages: alternating(20, 'x'.repeat(1_000)),
      checkpoint: null,
      settings: { enabled: false, messageThreshold: 20, contextWindowTokens: 1_000 },
      promptOverheadTokens: 0,
    })

    expect(decision.kind).toBe('overflow')
    if (decision.kind === 'overflow') expect(decision.reason).toBe('context_budget')
  })

  it('keeps completed turns together at twelve and never summarizes a partial message', () => {
    const messages = alternating(14)
    messages[3] = message('assistant', 'прервано', 3, 'interrupted')
    const decision = decideCompaction({
      messages,
      checkpoint: null,
      settings: { enabled: true, messageThreshold: 12, contextWindowTokens: 100_000 },
      promptOverheadTokens: 0,
    })

    expect(decision.kind).toBe('compact')
    if (decision.kind !== 'compact') return
    expect(decision.tail[0]?.message.role).toBe('user')
    expect(decision.tail.length).toBeGreaterThanOrEqual(10)
    expect(decision.toSummarize.every(item => item.status === 'complete')).toBe(true)
    expect(decision.toSummarize.some(item => item.position === 3)).toBe(false)
  })

  it('counts only messages after the latest checkpoint', () => {
    const checkpoint: ContextCheckpoint = {
      id: 'checkpoint-1', sessionId: 'session-1', fromMessagePosition: 0, throughMessagePosition: 9,
      summary: 'старое', formatVersion: 1, promptVersion: 1, modelId: 'mock', createdAt: '2026-01-01T00:00:00.000Z',
    }
    const decision = decideCompaction({
      messages: alternating(30), checkpoint,
      settings: { enabled: true, messageThreshold: 10, contextWindowTokens: 100_000 },
      promptOverheadTokens: 0,
    })

    expect(decision.kind).toBe('compact')
    if (decision.kind === 'compact') {
      expect(decision.toSummarize.every(item => item.position > 9)).toBe(true)
      expect(decision.tail.at(-1)?.position).toBe(29)
    }
  })

  it('uses the documented conservative estimate', () => {
    const messages: ChatUIMessage[] = [{ id: 'one', role: 'user', parts: [{ type: 'text', text: '1234' }] }]
    expect(estimateInputTokens(messages, 10)).toBe(Math.ceil(Buffer.byteLength(JSON.stringify({ role: 'user', parts: messages[0]!.parts }), 'utf8') / 2) + 10)
  })
})
