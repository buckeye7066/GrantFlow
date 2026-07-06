import { describe, it, expect } from 'vitest'
import { containsTermWholeWord, containsAnyTermWholeWord, wholeWordTermRegex } from '../services/shared/textMatch.js'

describe('containsTermWholeWord', () => {
  it('rejects fragments hiding inside larger words (the phantom-need class)', () => {
    // 'rent' ⊂ parent/current — the phantom housing-need driver
    expect(containsTermWholeWord('single parent household', 'rent')).toBe(false)
    expect(containsTermWholeWord('our current programs', 'rent')).toBe(false)
    // 'bus' ⊂ business — the phantom transportation-need driver
    expect(containsTermWholeWord('growing a small business', 'bus')).toBe(false)
    // 'ets' ⊂ targets/assets — the phantom military-transition driver
    expect(containsTermWholeWord('we set targets and manage assets', 'ets')).toBe(false)
    // 'car' ⊂ care/career, 'aid' ⊂ paid/said — phantom coverage credit
    expect(containsTermWholeWord('a rewarding career in health care', 'car')).toBe(false)
    expect(containsTermWholeWord('stipends are paid monthly', 'aid')).toBe(false)
    // 'sud' ⊂ sudden, 'coa' ⊂ coach/coast
    expect(containsTermWholeWord('sudden hardship', 'sud')).toBe(false)
    expect(containsTermWholeWord('head coach of the team', 'coa')).toBe(false)
  })

  it('matches real whole-word occurrences', () => {
    expect(containsTermWholeWord('help with rent and utilities', 'rent')).toBe(true)
    expect(containsTermWholeWord('take the bus to work', 'bus')).toBe(true)
    expect(containsTermWholeWord('financial aid office', 'aid')).toBe(true)
    expect(containsTermWholeWord('a reliable car', 'car')).toBe(true)
  })

  it('tolerates common suffixes so keyword corpora keep their recall', () => {
    expect(containsTermWholeWord('rents are rising', 'rent')).toBe(true)
    expect(containsTermWholeWord('rented an apartment', 'rent')).toBe(true)
    expect(containsTermWholeWord('rental assistance program', 'rent')).toBe(true)
    expect(containsTermWholeWord('city buses', 'bus')).toBe(true)
    expect(containsTermWholeWord('scholarships for nurses', 'scholarship')).toBe(true)
    expect(containsTermWholeWord('self-employment income', 'self-employ')).toBe(true)
    expect(containsTermWholeWord('she is self-employed', 'self-employ')).toBe(true)
  })

  it('handles multi-word phrases and punctuation-bearing terms', () => {
    expect(containsTermWholeWord('the local food banks serve meals', 'food bank')).toBe(true)
    expect(containsTermWholeWord('foodbank drive', 'food bank')).toBe(false)
    expect(containsTermWholeWord('copay and co-pay costs', 'co-pay')).toBe(true)
    expect(containsTermWholeWord('a 501(c)(3) nonprofit', '501(c)(3)')).toBe(true)
  })

  it('is case-insensitive and safe on empty/absent input', () => {
    expect(containsTermWholeWord('RENT RELIEF', 'rent')).toBe(true)
    expect(containsTermWholeWord('', 'rent')).toBe(false)
    expect(containsTermWholeWord(null, 'rent')).toBe(false)
    expect(containsTermWholeWord('anything', '')).toBe(false)
    expect(containsTermWholeWord('anything', '  ')).toBe(false)
    expect(wholeWordTermRegex('!!!')).toBe(null)
  })

  it('containsAnyTermWholeWord scans a term list', () => {
    expect(containsAnyTermWholeWord('utility bill help', ['rent', 'utility'])).toBe(true)
    expect(containsAnyTermWholeWord('current parent', ['rent'])).toBe(false)
    expect(containsAnyTermWholeWord('anything', null)).toBe(false)
  })
})
