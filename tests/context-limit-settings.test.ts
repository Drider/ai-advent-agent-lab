import { describe, expect, it } from 'vitest'
import { normalizeStoredContextLimits } from '../shared/chat'

describe('stored model context limits', () => {
  it('restores numeric limits saved by the number input as strings', () => {
    expect(normalizeStoredContextLimits({
      'model-a': 128000,
      'model-b': '1000000',
      'model-c': 0,
    })).toEqual({
      'model-a': '128000',
      'model-b': '1000000',
    })
  })
})
