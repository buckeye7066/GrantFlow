/**
 * Seat-based billing tier (small=1, mid=2-5, large=6+).
 */
import { describe, it, expect } from 'vitest'
import {
  seatTierFor,
  describeSeatTier,
  evaluateSeatChange,
  countSeats,
} from '../services/billing/seatTier.js'

describe('seatTierFor', () => {
  it('maps seat counts to tiers per spec', () => {
    expect(seatTierFor(0)).toBe('small')
    expect(seatTierFor(1)).toBe('small')
    expect(seatTierFor(2)).toBe('mid')
    expect(seatTierFor(5)).toBe('mid')
    expect(seatTierFor(6)).toBe('large')
    expect(seatTierFor(50)).toBe('large')
  })
})

describe('countSeats', () => {
  it('counts distinct emails, case-insensitively, excluding admin emails', () => {
    const rows = [
      { email: 'Owner@org.com' }, { email: 'owner@org.com' }, // dup
      { email: 'staff@org.com' },
      { email: 'buckeye7066@gmail.com' }, // platform admin — excluded
    ]
    expect(countSeats(rows, ['buckeye7066@gmail.com'])).toBe(2)
  })
  it('accepts plain strings too', () => {
    expect(countSeats(['a@x.com', 'b@x.com'], [])).toBe(2)
  })
})

describe('describeSeatTier', () => {
  it('reports how many seats until the next tier', () => {
    expect(describeSeatTier(1)).toMatchObject({ tier: 'small', next_tier: 'mid', seats_until_next_tier: 1 })
    expect(describeSeatTier(5)).toMatchObject({ tier: 'mid', next_tier: 'large', seats_until_next_tier: 1 })
    expect(describeSeatTier(6)).toMatchObject({ tier: 'large', next_tier: null, seats_until_next_tier: null })
  })
})

describe('evaluateSeatChange', () => {
  it('flags small→mid when going from 1 to 2 seats', () => {
    const c = evaluateSeatChange(1, 1)
    expect(c).toMatchObject({ from_tier: 'small', to_tier: 'mid', crosses_up: true })
    expect(c.warning).toMatch(/higher billing tier/i)
  })
  it('flags mid→large when crossing 5→6', () => {
    expect(evaluateSeatChange(5, 1).crosses_up).toBe(true)
    expect(evaluateSeatChange(5, 1).to_tier).toBe('large')
  })
  it('does NOT flag a change within the same tier', () => {
    const c = evaluateSeatChange(2, 2) // 2 → 4, both mid
    expect(c.crosses_up).toBe(false)
    expect(c.warning).toBeNull()
  })
  it('does not flag adding zero new seats', () => {
    expect(evaluateSeatChange(1, 0).crosses_up).toBe(false)
  })
})
