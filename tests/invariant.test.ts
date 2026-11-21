import { describe, expect, it } from 'vitest'
import {
  checkInvariants,
  formatInvariantRefusal,
  parseInvariantCommand,
  validateForbiddenPatterns,
  type Invariant,
} from '../shared/invariant'

const frontend: Invariant = {
  id: 'stack-frontend',
  category: 'stack',
  title: 'Фронтенд',
  rule: 'Фронтенд только Vue 3 / Nuxt.',
  forbidden: [String.raw`from\s+['"]react['"]`, String.raw`\bimport\s+React\b`],
  updatedAt: '2026-11-22T00:00:00.000Z',
}

describe('invariants', () => {
  it('detects forbidden code but not a prose refusal', () => {
    expect(checkInvariants("import React from 'react'", [frontend])).toEqual([
      { invariantId: 'stack-frontend', match: "from 'react'" },
      { invariantId: 'stack-frontend', match: 'import React' },
    ])
    expect(checkInvariants('React у нас не используется.', [frontend])).toEqual([])
  })

  it('formats a refusal with the rule and command hint', () => {
    const refusal = formatInvariantRefusal([{ invariantId: frontend.id, match: "from 'react'" }], [frontend])
    expect(refusal).toContain('stack-frontend')
    expect(refusal).toContain("from 'react'")
    expect(refusal).toContain('/invariant set stack-frontend')
  })

  it('validates regex count, size, and syntax', () => {
    expect(validateForbiddenPatterns([])).toEqual([])
    expect(() => validateForbiddenPatterns(['('])).toThrow(/invalid/u)
    expect(() => validateForbiddenPatterns(Array.from({ length: 21 }, () => 'x'))).toThrow(/at most 20/u)
    expect(() => validateForbiddenPatterns(['x'.repeat(201)])).toThrow(/200/u)
  })

  it('parses set, forbid, and remove commands', () => {
    expect(parseInvariantCommand('/invariant set stack-frontend stack React не используется')).toEqual({
      ok: true,
      action: 'set',
      id: 'stack-frontend',
      category: 'stack',
      rule: 'React не используется',
    })
    expect(parseInvariantCommand('/invariant forbid stack-frontend from\\s+react; import\\s+React')).toEqual({
      ok: true,
      action: 'forbid',
      id: 'stack-frontend',
      forbidden: ['from\\s+react', 'import\\s+React'],
    })
    expect(parseInvariantCommand('/invariant forbid stack-frontend')).toEqual({
      ok: true,
      action: 'forbid',
      id: 'stack-frontend',
      forbidden: [],
    })
    expect(parseInvariantCommand('/invariant remove stack-frontend')).toEqual({
      ok: true,
      action: 'remove',
      id: 'stack-frontend',
    })
  })
})
