import { describe, expect, it } from 'vitest'
import { nextOccurrence, previousOccurrence } from '../server/scheduler/schedule'

describe('scheduler cron calculations', () => {
  it('calculates five-field schedules in an IANA timezone', () => {
    expect(nextOccurrence('*/5 * * * *', 'Europe/Moscow', new Date('2026-11-26T10:02:30.000Z')).toISOString()).toBe('2026-11-26T10:05:00.000Z')
    expect(previousOccurrence('*/5 * * * *', 'Europe/Moscow', new Date('2026-11-26T10:02:30.000Z')).toISOString()).toBe('2026-11-26T10:00:00.000Z')
  })

  it('skips a nonexistent local hour at the DST spring transition', () => {
    expect(nextOccurrence('0 * * * *', 'Europe/Berlin', new Date('2026-03-29T00:50:00.000Z')).toISOString()).toBe('2026-03-29T01:00:00.000Z')
  })

  it('rejects an invalid timezone and a non-five-field expression', () => {
    expect(() => nextOccurrence('0 * * *', 'Europe/Moscow', new Date())).toThrow('five fields')
    expect(() => nextOccurrence('0 * * * *', 'Mars/Base', new Date())).toThrow()
  })
})
