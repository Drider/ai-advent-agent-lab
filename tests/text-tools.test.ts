import { describe, expect, it } from 'vitest'
import { searchText, textStats } from '../server/tools/files'

describe('searchText', () => {
  it('finds literal case-sensitive matches by line', () => {
    expect(searchText('TODO: a\nготово\nTODO: b', 'TODO')).toEqual({
      ok: true,
      data: {
        matches: [
          { lineNumber: 1, line: 'TODO: a' },
          { lineNumber: 3, line: 'TODO: b' },
        ],
        truncated: false,
      },
    })
  })

  it('handles line endings, literal patterns, and the match limit', () => {
    const lines = Array.from({ length: 101 }, (_, index) => `TODO ${index}`).join('\r\n')

    expect(searchText('a\r\nb\n', '.*')).toEqual({ ok: true, data: { matches: [], truncated: false } })
    expect(searchText('TODO\ntodo', 'TODO')).toEqual({
      ok: true,
      data: { matches: [{ lineNumber: 1, line: 'TODO' }], truncated: false },
    })
    expect(searchText(lines, 'TODO')).toMatchObject({
      ok: true,
      data: { truncated: true, matches: expect.any(Array) },
    })

    const result = searchText(lines, 'TODO')
    if (result.ok) {
      expect(result.data.matches).toHaveLength(100)
    }
  })

  it('rejects an empty or oversized query and oversized text', () => {
    expect(searchText('text', '')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(searchText('text', 'q'.repeat(257))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(searchText('я'.repeat(16 * 1024), 'я')).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } })
  })
})

describe('textStats', () => {
  it('counts lines, whitespace-delimited words, and Unicode code points', () => {
    expect(textStats('one two\nthree')).toEqual({
      ok: true,
      data: { lines: 2, words: 3, characters: 13 },
    })
    expect(textStats('Привет мир')).toEqual({
      ok: true,
      data: { lines: 1, words: 2, characters: 10 },
    })
    expect(textStats('😀')).toEqual({
      ok: true,
      data: { lines: 1, words: 1, characters: 1 },
    })
    expect(textStats('a\r\nb\n')).toEqual({
      ok: true,
      data: { lines: 2, words: 2, characters: 5 },
    })
    expect(textStats('')).toEqual({
      ok: true,
      data: { lines: 0, words: 0, characters: 0 },
    })
  })

  it('returns zero words for whitespace and rejects oversized text', () => {
    expect(textStats(' \t\r\n ')).toEqual({
      ok: true,
      data: { lines: 2, words: 0, characters: 5 },
    })
    expect(textStats('я'.repeat(16 * 1024))).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } })
  })
})
