// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { amountTextFallback, AMOUNT_STATUS_LABEL } from './amountDisplay'

describe('amountTextFallback — honest amount display when no number renders', () => {
  it('prefers the stored excerpt over a status label', () => {
    expect(amountTextFallback({ amount_text: 'up to $10,000 in scholarship support', amount_status: 'range' }))
      .toBe('up to $10,000 in scholarship support')
  })

  it('falls back to the explicit status label', () => {
    expect(amountTextFallback({ amount_status: 'varies' })).toBe(AMOUNT_STATUS_LABEL.varies)
    expect(amountTextFallback({ amount_status: 'contact_required' })).toBe('Contact funder for amount')
    expect(amountTextFallback({ amount_status: 'not_listed' })).toBe('Amount not listed')
  })

  it('returns null when nothing is known (caller keeps its own default)', () => {
    expect(amountTextFallback({})).toBeNull()
    expect(amountTextFallback(null)).toBeNull()
    expect(amountTextFallback({ amount_status: 'known' })).toBeNull() // numeric statuses render numbers, not labels
  })
})

describe('none_published — the READ denial', () => {
  it('tells the user the funder states no amount, rather than "not listed"', () => {
    // "We did not find a figure" and "this funder publishes no figure" are
    // different facts (CLAUDE.md invariant). A benefit program or a food bank is
    // a real, valuable match that simply has no award size — rendering it as an
    // absence is how a full pipeline reads as "qualifies for nothing".
    expect(amountTextFallback({ amount_status: 'none_published' })).toBe('Funder states no set amount')
  })

  it('still prefers a real excerpt the page stated', () => {
    expect(amountTextFallback({ amount_status: 'none_published', amount_text: 'up to $500/mo' }))
      .toBe('up to $500/mo')
  })
})
