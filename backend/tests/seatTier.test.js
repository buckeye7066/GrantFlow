/**
 * Seat-based billing tier (small=1, mid=2-5, large=6+).
 */
import { describe, it, expect } from 'vitest'
import {
  seatTierFor,
  describeSeatTier,
  evaluateSeatChange,
  countSeats,
  billableSeatEmails,
  SEAT_TIERS,
} from '../services/billing/seatTier.js'
import { orgTierForSeats } from '../../shared/tierCatalog.js'

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

describe('thresholds derive from the canonical catalog (SoT — no drift)', () => {
  it('SEAT_TIERS mins/maxes match shared/tierCatalog org seat ranges', () => {
    const byKey = Object.fromEntries(SEAT_TIERS.map((t) => [t.key, t]))
    expect(byKey.small).toMatchObject({ tier_id: 'small_org', min: 1, max: 1 })
    expect(byKey.mid).toMatchObject({ tier_id: 'mid_size', min: 2, max: 5 })
    expect(byKey.large).toMatchObject({ tier_id: 'large_org', min: 6, max: null })
  })

  it('seatTierFor agrees with catalog.orgTierForSeats for every count', () => {
    const KEY_BY_TIER_ID = { small_org: 'small', mid_size: 'mid', large_org: 'large' }
    for (const n of [0, 1, 2, 5, 6, 12, 100]) {
      expect(seatTierFor(n)).toBe(KEY_BY_TIER_ID[orgTierForSeats(n).id])
    }
  })
})

describe('billableSeatEmails — list == count (the off-by-one fix)', () => {
  const ADMIN = ['buckeye7066@gmail.com']

  it('the rendered list excludes the platform-admin login, so its length equals the seat count', () => {
    // Dr. John: 2 profile_emails rows, one of which is the platform operator.
    const rows = [
      { id: 'r1', email: 'john@axiombiolabs.org' },
      { id: 'r2', email: 'buckeye7066@gmail.com' }, // operator — not a paid seat
    ]
    const list = billableSeatEmails(rows, ADMIN)
    expect(list.map((r) => r.email)).toEqual(['john@axiombiolabs.org'])
    // The listed length and the seat count are now the SAME number.
    expect(list.length).toBe(countSeats(rows, ADMIN))
  })

  it('Dr. John (1 real org login) → 1 seat → Small, "1 more login → Mid-sized"', () => {
    const rows = [
      { id: 'r1', email: 'john@axiombiolabs.org' },
      { id: 'r2', email: 'buckeye7066@gmail.com' },
    ]
    const list = billableSeatEmails(rows, ADMIN)
    const seats = list.length
    expect(seats).toBe(1)
    const desc = describeSeatTier(seats)
    expect(desc).toMatchObject({
      tier: 'small',
      label: 'Small organization',
      seats: 1,
      next_tier: 'mid',
      next_tier_label: 'Mid-sized organization',
      seats_until_next_tier: 1, // adding 1 → 2 seats → mid, arithmetically consistent
    })
  })

  it('two REAL org logins → 2 seats → Mid-sized (already past the small/mid threshold)', () => {
    const rows = [
      { id: 'r1', email: 'john@axiombiolabs.org' },
      { id: 'r2', email: 'coworker@axiombiolabs.org' },
      { id: 'r3', email: 'buckeye7066@gmail.com' }, // operator excluded
    ]
    const list = billableSeatEmails(rows, ADMIN)
    expect(list.length).toBe(2)
    expect(describeSeatTier(list.length)).toMatchObject({
      tier: 'mid',
      label: 'Mid-sized organization',
      seats: 2,
      next_tier: 'large',
      seats_until_next_tier: 4, // 2 → 6 is 4 more, consistent
    })
  })

  it('Focus Forward (only the operator login) → empty list → 0 seats, consistent', () => {
    const rows = [{ id: 'r1', email: 'buckeye7066@gmail.com' }]
    const list = billableSeatEmails(rows, ADMIN)
    expect(list).toEqual([])
    expect(list.length).toBe(countSeats(rows, ADMIN))
    expect(list.length).toBe(0)
    // 0 billable logins still describes as the smallest org tier (never NaN/throws).
    expect(describeSeatTier(0)).toMatchObject({ tier: 'small', seats: 0 })
  })
})
