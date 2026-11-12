import { describe, expect, it } from 'vitest'
import * as chat from '../shared/chat'

describe('pricingFromSettings', () => {
  it('accepts Polza prices with decimal commas', () => {
    expect(chat).toHaveProperty('pricingFromSettings')
    expect(chat.pricingFromSettings({
      enabled: true,
      inputPrice: '9,21',
      outputPrice: '36,85',
    })).toEqual({ inputPerMillionRub: 9.21, outputPerMillionRub: 36.85 })
  })

  it('omits pricing while disabled or missing a price', () => {
    expect(chat).toHaveProperty('pricingFromSettings')
    expect(chat.pricingFromSettings({
      enabled: false,
      inputPrice: '9,21',
      outputPrice: '36,85',
    })).toBeUndefined()
    expect(chat.pricingFromSettings({
      enabled: true,
      inputPrice: '9,21',
      outputPrice: '',
    })).toBeUndefined()
  })

  it('rejects negative and malformed prices', () => {
    expect(chat).toHaveProperty('pricingFromSettings')
    expect(chat.pricingFromSettings({ enabled: true, inputPrice: '-1', outputPrice: '2' })).toBeUndefined()
    expect(chat.pricingFromSettings({ enabled: true, inputPrice: 'abc', outputPrice: '2' })).toBeUndefined()
  })
})
