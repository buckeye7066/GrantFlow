/**
 * Billing cadence schedule — weekly Friday 09:00 ET, semimonthly 1st/16th,
 * monthly 1st. Fixed UTC instants against Eastern (Jan = EST/UTC-5).
 */
import { describe, it, expect } from 'vitest'
import { billingMomentPassed, normalizeCadence } from '../services/billing/invoiceSchedule.js'

describe('normalizeCadence', () => {
  it('defaults unknown to weekly', () => {
    expect(normalizeCadence('bogus')).toBe('weekly')
    expect(normalizeCadence('MONTHLY')).toBe('monthly')
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

describe('monthly (1st 09:00 ET)', () => {
  it('mid-month bills for the current month', () => {
    const m = billingMomentPassed('monthly', new Date('2026-01-15T15:00:00Z'))
    expect(m.period_key).toBe('monthly:2026-01')
    expect(m.period_start).toBe('2026-01-01')
    expect(m.period_end).toBe('2026-01-31')
  })
  it('before the 1st 09:00 ET bills for the prior month', () => {
    const m = billingMomentPassed('monthly', new Date('2026-01-01T12:00:00Z')) // 07:00 EST on the 1st
    expect(m.period_key).toBe('monthly:2025-12')
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
