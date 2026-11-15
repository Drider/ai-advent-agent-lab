import { describe, expect, it } from 'vitest'
import type { ChatUIMessage } from '../shared/chat'
import { selectSlidingWindow } from '../server/context-compaction/sliding-window'
import type { StoredContextMessage } from '../server/context-compaction/types'

function message(position: number): StoredContextMessage {
  const item: ChatUIMessage = { id: `message-${position}`, role: position % 2 === 0 ? 'user' : 'assistant', parts: [{ type: 'text', text: String(position) }] }
  return { position, status: 'complete', message: item }
}

describe('sliding window context strategy', () => {
  it('keeps exactly the latest N stored messages', () => {
    expect(selectSlidingWindow(Array.from({ length: 20 }, (_, index) => message(index)), 10).map(item => item.position))
      .toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  })

  it('rejects non-positive window sizes', () => {
    expect(() => selectSlidingWindow([message(0)], 0)).toThrow()
  })
})
