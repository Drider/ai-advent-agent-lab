import type { StoredContextMessage } from './types'

export function selectSlidingWindow(messages: StoredContextMessage[], size: number): StoredContextMessage[] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('sliding window size must be a positive integer')
  return messages.slice(Math.max(0, messages.length - size))
}
