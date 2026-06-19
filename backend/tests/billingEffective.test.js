/**
 * computeEffectiveBilling — the seat → invoice-amount wiring.
 * Uses a tiny fake db so we exercise the pure logic without a real schema.
 */
import { describe, it, expect } from 'vitest'
import { computeEffectiveBilling } from '../services/billingAccounts.js'
import { tierById } from '../../shared/tierCatalog.js'

const fakeDb = (emailRows) => ({
  prepare: () => ({ all: async () => emailRows }),
})

const orgAccount = (overrides = {}) => ({
  is_pro_bono: false,
  discount_percent: 0,
  custom_monthly_cents: null,
  tier: tierById('small_org'),
  ...overrides,
})

describe('computeEffectiveBilling (seats → amount)', () => {
  it('an org with 3 logins is billed the mid_size monthly', async () => {
    const rows = [{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }]
    const b = await computeEffectiveBilling(fakeDb(rows), 'p1', orgAccount())
    expect(b.basis).toBe('seats')
    expect(b.seat_count).toBe(3)
    expect(b.seat_tier_id).toBe('mid_size')
    expect(b.effective_monthly_cents).toBe(tierById('mid_size').monthly_cents)
  })

  it('1 login → small_org monthly', async () => {
    const b = await computeEffectiveBilling(fakeDb([{ email: 'solo@x.com' }]), 'p1', orgAccount())
    expect(b.seat_tier_id).toBe('small_org')
    expect(b.effective_monthly_cents).toBe(tierById('small_org').monthly_cents)
  })

  it('a custom monthly override wins over the seat amount', async () => {
    const b = await computeEffectiveBilling(fakeDb([{ email: 'a@x.com' }, { email: 'b@x.com' }]), 'p1',
      orgAccount({ custom_monthly_cents: 12345 }))
    expect(b.basis).toBe('custom_override')
    expect(b.effective_monthly_cents).toBe(12345)
  })

  it('pro bono zeroes the amount', async () => {
    const b = await computeEffectiveBilling(fakeDb([{ email: 'a@x.com' }]), 'p1', orgAccount({ is_pro_bono: true }))
    expect(b.basis).toBe('pro_bono')
    expect(b.net_monthly_cents).toBe(0)
  })

  it('a discount reduces the net amount', async () => {
    const rows = [{ email: 'a@x.com' }, { email: 'b@x.com' }] // mid_size
    const b = await computeEffectiveBilling(fakeDb(rows), 'p1', orgAccount({ discount_percent: 10 }))
    const expected = Math.round(tierById('mid_size').monthly_cents * 0.9)
    expect(b.net_monthly_cents).toBe(expected)
  })

  it('a non-org (service) tier is NOT seat-driven', async () => {
    const b = await computeEffectiveBilling(fakeDb([]), 'p1', orgAccount({ tier: tierById('foundation') }))
    expect(b.basis).toBe('assigned_tier')
    expect(b.effective_monthly_cents).toBe(tierById('foundation').monthly_cents)
  })
})
