import { describe, expect, it } from 'vitest'
import { selectInitialSession } from '../shared/session-navigation'
import type { SessionSummary } from '../shared/chat'

function session(id: string, updatedAt: string): SessionSummary {
  return {
    id,
    runLogId: updatedAt,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    status: 'completed',
    revision: 1,
  }
}

describe('session navigation', () => {
  it('keeps a valid preferred session even when it is outside the first page', () => {
    expect(selectInitialSession({
      preferredSessionId: 'old-session',
      items: [session('new-session', '2026-11-10T12:00:00.000Z')],
    })).toBe('old-session')
  })

  it('uses the newest session when no preferred session exists', () => {
    expect(selectInitialSession({
      items: [
        session('older', '2026-11-10T11:00:00.000Z'),
        session('newer', '2026-11-10T12:00:00.000Z'),
      ],
    })).toBe('newer')
  })

  it('returns null for an empty list', () => {
    expect(selectInitialSession({ items: [] })).toBeNull()
  })

  it('uses a stable ID tie-breaker for equal timestamps', () => {
    expect(selectInitialSession({
      items: [
        session('a-session', '2026-11-10T12:00:00.000Z'),
        session('b-session', '2026-11-10T12:00:00.000Z'),
      ],
    })).toBe('b-session')
  })
})
