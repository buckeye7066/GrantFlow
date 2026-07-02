/**
 * Billing cadence schedule — weekly Friday 09:00 ET, biweekly alternating
 * Fridays (anchor-pinned parity), semimonthly 1st/16th, monthly FIRST FRIDAY.
 * Fixed UTC instants against Eastern (Jan = EST/UTC-5, Jul = EDT/UTC-4).
 */
import { describe, it, expect } from 'vitest'
import { billingMomentPassed, normalizeCadence, BILLING_CADENCES, BIWEEKLY_EPOCH } from '../services/billing/invoiceSchedule.js'

describe('normalizeCadence', () => {
  it('defaults unknown to weekly', () => {
    expect(normalizeCadence('bogus')).toBe('weekly')
    expect(normalizeCadence('MONTHLY')).toBe('monthly')
  })
  it('accepts biweekly', () => {
    expect(BILLING_CADENCES).toContain('biweekly')
    expect(normalizeCadence('BiWeekly')).toBe('biweekly')
  })
})

describe('weekly (Friday 09:00 ET)', () => {
  // 2026-01-16 is a Friday. 09:00 EST = 14:00Z.
  it('after Friday 09:00 ET bills for the week ending that Friday', () => {
    const m = billingMomentPassed('weekly', new Date('2026-01-16T15:00:00Z'))
    expect(m.period_key).toBe('weekly:2026-01-16')
    expect(m.period_end).toBe('2026-01-16')
    expect(m.period_start).toBe('2026-01-10')
  })
  it('Friday BEFORE 09:00 ET falls back to the prior Friday', () => {
    const m = billingMomentPassed('weekly', new Date('2026-01-16T13:00:00Z')) // 08:00 EST
    expect(m.period_key).toBe('weekly:2026-01-09')
  })
  it('mid-week bills for the most recent Friday', () => {
    const m = billingMomentPassed('weekly', new Date('2026-01-21T12:00:00Z')) // Wed
    expect(m.period_key).toBe('weekly:2026-01-16')
  })
})

describe('biweekly (every other Friday 09:00 ET, anchor-pinned parity)', () => {
  // Default epoch 2026-01-02 is a Friday → "on" Fridays: Jan 2, 16, 30; Feb 13, 27; Mar 13...
  it('an even-parity Friday after 09:00 ET bills a 14-day period ending that Friday', () => {
    const m = billingMomentPassed('biweekly', new Date('2026-01-16T15:00:00Z'))
    expect(m.period_key).toBe('biweekly:2026-01-16')
    expect(m.period_start).toBe('2026-01-03')
    expect(m.period_end).toBe('2026-01-16')
    expect(m.billed_at).toBe('2026-01-16T14:00:00.000Z') // 09:00 EST
  })
  it('an odd-parity ("off") Friday steps back to the previous on-Friday', () => {
    const m = billingMomentPassed('biweekly', new Date('2026-01-09T15:00:00Z'))
    expect(m.period_key).toBe('biweekly:2026-01-02')
  })
  it('parity is pinned to the account anchor, not "now" (redeploy-stable)', () => {
    // Anchor Friday 2026-01-09 flips the alternation: Jan 16 becomes "off".
    const anchored = billingMomentPassed('biweekly', new Date('2026-01-16T15:00:00Z'), { anchor: '2026-01-09T14:00:00Z' })
    expect(anchored.period_key).toBe('biweekly:2026-01-09')
    // A mid-week anchor snaps to ITS most recent Friday (same parity).
    const midWeekAnchor = billingMomentPassed('biweekly', new Date('2026-01-16T15:00:00Z'), { anchor: '2026-01-13T00:00:00Z' })
    expect(midWeekAnchor.period_key).toBe('biweekly:2026-01-09')
    // Same inputs → same output, always (pure function of now + anchor).
    const again = billingMomentPassed('biweekly', new Date('2026-01-16T15:00:00Z'), { anchor: '2026-01-09T14:00:00Z' })
    expect(again.period_key).toBe(anchored.period_key)
  })
  it('holds parity across the spring DST boundary (2026-03-08)', () => {
    // Weeks since epoch: Mar 6 = 9 (off), Mar 13 = 10 (on).
    const on = billingMomentPassed('biweekly', new Date('2026-03-13T13:30:00Z')) // 09:30 EDT
    expect(on.period_key).toBe('biweekly:2026-03-13')
    expect(on.billed_at).toBe('2026-03-13T13:00:00.000Z') // 09:00 EDT
    const off = billingMomentPassed('biweekly', new Date('2026-03-12T15:00:00Z')) // Thu after off-Friday Mar 6
    expect(off.period_key).toBe('biweekly:2026-02-27')
  })
  it('exports a fixed epoch Friday as the anchor fallback', () => {
    expect(BIWEEKLY_EPOCH).toBe('2026-01-02')
    expect(new Date('2026-01-02T12:00:00Z').getUTCDay()).toBe(5) // Friday
  })
})

describe('monthly (FIRST FRIDAY 09:00 ET)', () => {
  it('mid-month bills for the current month', () => {
    // Jan 2026: first Friday = Jan 2.
    const m = billingMomentPassed('monthly', new Date('2026-01-15T15:00:00Z'))
    expect(m.period_key).toBe('monthly:2026-01')
    expect(m.period_start).toBe('2026-01-01')
    expect(m.period_end).toBe('2026-01-31')
    expect(m.billed_at).toBe('2026-01-02T14:00:00.000Z') // Fri Jan 2, 09:00 EST
  })
  it('before the month’s first-Friday 09:00 ET bills for the prior month', () => {
    const m = billingMomentPassed('monthly', new Date('2026-01-01T12:00:00Z')) // Thu Jan 1
    expect(m.period_key).toBe('monthly:2025-12')
    expect(m.billed_at).toBe('2025-12-05T14:00:00.000Z') // Fri Dec 5, 09:00 EST
  })
  it('a month starting on Saturday waits for Friday the 7th', () => {
    // Aug 2026 starts on a Saturday → first Friday = Aug 7 (09:00 EDT = 13:00Z).
    const before = billingMomentPassed('monthly', new Date('2026-08-05T15:00:00Z'))
    expect(before.period_key).toBe('monthly:2026-07')
    const after = billingMomentPassed('monthly', new Date('2026-08-07T13:30:00Z'))
    expect(after.period_key).toBe('monthly:2026-08')
    expect(after.billed_at).toBe('2026-08-07T13:00:00.000Z')
  })
  it('uses the correct UTC offset after fall-back (Nov 2026)', () => {
    // DST ends Nov 1; first Friday Nov 6 09:00 EST = 14:00Z.
    const m = billingMomentPassed('monthly', new Date('2026-11-06T14:30:00Z'))
    expect(m.period_key).toBe('monthly:2026-11')
    expect(m.billed_at).toBe('2026-11-06T14:00:00.000Z')
  })
})

describe('semimonthly (1st & 16th 09:00 ET)', () => {
  it('between the 1st and 15th → H1', () => {
    const m = billingMomentPassed('semimonthly', new Date('2026-01-10T15:00:00Z'))
    expect(m.period_key).toBe('semimonthly:2026-01-H1')
    expect(m.period_end).toBe('2026-01-15')
  })
  it('on/after the 16th → H2', () => {
    const m = billingMomentPassed('semimonthly', new Date('2026-01-20T15:00:00Z'))
    expect(m.period_key).toBe('semimonthly:2026-01-H2')
    expect(m.period_start).toBe('2026-01-16')
  })
})
