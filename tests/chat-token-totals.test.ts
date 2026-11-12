import { describe, expect, it } from 'vitest'
import * as chat from '../shared/chat'

describe('latestContextUsage', () => {
  it('compares input plus output of one model call with the window', () => {
    const messages: chat.ChatUIMessage[] = [
      { id: 'first', role: 'assistant', parts: [], metadata: { durationMs: 1, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, steps: [{ usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } }] } },
      { id: 'second', role: 'assistant', parts: [], metadata: { durationMs: 1, usage: { inputTokens: 450, outputTokens: 30, totalTokens: 480 }, steps: [
        { usage: { inputTokens: 200, outputTokens: 10, totalTokens: 210 } },
        { usage: { inputTokens: 250, outputTokens: 20, totalTokens: 270 } },
      ] } },
    ]
    expect(chat.latestContextUsage(messages, 1000)).toEqual({
      kind: 'limited',
      inputTokens: 250,
      outputTokens: 20,
      occupiedTokens: 270,
      limit: 1000,
      percent: 27,
      remaining: 730,
    })
  })

  it('shows unknown when the latest call has no usage or old metadata has no steps', () => {
    const old: chat.ChatUIMessage = { id: 'old', role: 'assistant', parts: [], metadata: { durationMs: 1, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } } }
    expect(chat.latestContextUsage([old], 1000)).toBeUndefined()
    const missing: chat.ChatUIMessage = { id: 'new', role: 'assistant', parts: [], metadata: { durationMs: 1, usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined }, steps: [{ usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined } }] } }
    expect(chat.latestContextUsage([old, missing], 1000)).toBeUndefined()
  })

  it('uses input plus output even when provider total differs, and clamps remaining at zero', () => {
    const message: chat.ChatUIMessage = { id: 'reply', role: 'assistant', parts: [], metadata: { durationMs: 1, usage: { inputTokens: 120, outputTokens: 5, totalTokens: 130 }, steps: [{ usage: { inputTokens: 120, outputTokens: 5, totalTokens: 130 } }] } }
    expect(chat.latestContextUsage([message])).toEqual({ kind: 'measured', inputTokens: 120, outputTokens: 5, occupiedTokens: 125 })
    expect(chat.latestContextUsage([message], 100)).toEqual({ kind: 'limited', inputTokens: 120, outputTokens: 5, occupiedTokens: 125, limit: 100, percent: 125, remaining: 0 })
    expect(chat.parseContextLimit('128000')).toBe(128000)
    expect(chat.parseContextLimit('0')).toBeUndefined()
    expect(chat.parseContextLimit('1.5')).toBeUndefined()
    expect(chat.parseContextLimit('abc')).toBeUndefined()
  })

  it('does not calculate a window percentage when output usage is unknown', () => {
    const message: chat.ChatUIMessage = { id: 'reply', role: 'assistant', parts: [], metadata: { durationMs: 1, usage: { inputTokens: 120, outputTokens: undefined, totalTokens: undefined }, steps: [{ usage: { inputTokens: 120, outputTokens: undefined, totalTokens: undefined } }] } }
    expect(chat.latestContextUsage([message], 1000)).toEqual({ kind: 'input-only', inputTokens: 120 })
  })
})
