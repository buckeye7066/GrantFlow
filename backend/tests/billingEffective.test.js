/**
 * computeEffectiveBilling — the profile-type + budget → invoice-amount wiring.
 *
 * Per the owner's decision the BASE charged tier follows the profile TYPE +
 * (for orgs) annual budget, NOT the seat count. A custom override and the
 * pro-bono flag still win, and percentage discounts still apply on top. We use
 * a tiny fake db that answers the profile/organization lookups
 * deriveProfileClientCategory performs.
 */
import { describe, it, expect } from 'vitest'
import { computeEffectiveBilling, CLIENT_CATEGORY_TO_TIER_ID } from '../services/billingAccounts.js'
import { tierById } from '../../shared/tierCatalog.js'

/**
 * Build a fake db whose `profiles`/`organizations` lookups return the supplied
 * type + budget. computeEffectiveBilling no longer reads profile_emails (seats),
 * so we only need to answer the two SELECTs deriveProfileClientCategory issues.
 */
const fakeDb = ({ primaryType = null, annualBudget = null, orgSubtype = '' } = {}) => {
  const hasOrg = annualBudget !== null || Boolean(orgSubtype)
  return {
    prepare: (sql) => ({
      get: async () => {
        if (sql.includes('FROM profiles')) {
          return { primary_type: primaryType, organization_id: hasOrg ? 'org1' : null }
        }
        if (sql.includes('FROM organizations')) {
          return { annual_budget: annualBudget, nonprofit_type: orgSubtype, applicant_type: null }
        }
        return null
      },
      all: async () => [],
    }),
  }
}

const account = (overrides = {}) => ({
  is_pro_bono: false,
  discount_percent: 0,
  custom_monthly_cents: null,
  // The assigned tier is now informational only — the charged base tier is
  // derived from the profile type + budget, so we deliberately set a tier here
  // that does NOT match the type-derived one to prove type+budget wins.
  tier: tierById('foundation'),
  ...overrides,
})

describe('computeEffectiveBilling (profile type + budget → amount)', () => {
  it('an individual is billed the individual tier ($0), regardless of assigned tier', async () => {
    const b = await computeEffectiveBilling(fakeDb({ primaryType: 'individual' }), 'p1', account())
    expect(b.basis).toBe('profile_type')
    expect(b.client_category).toBe('individual')
    expect(b.tier_id).toBe('individual')
    expect(b.effective_monthly_cents).toBe(tierById('individual').monthly_cents)
  })

  it('a nonprofit (TOP-LEVEL type) with a small budget bills the small_org tier', async () => {
    const b = await computeEffectiveBilling(
      fakeDb({ primaryType: 'nonprofit', annualBudget: 120000 }), 'p1', account())
    expect(b.client_category).toBe('small')
    expect(b.tier_id).toBe('small_org')
    expect(b.effective_monthly_cents).toBe(tierById('small_org').monthly_cents)
  })

  it('a nonprofit with a mid-band budget bills the mid_size tier', async () => {
    const b = await computeEffectiveBilling(
      fakeDb({ primaryType: 'nonprofit', annualBudget: 900000 }), 'p1', account())
    expect(b.client_category).toBe('mid')
    expect(b.tier_id).toBe('mid_size')
    expect(b.effective_monthly_cents).toBe(tierById('mid_size').monthly_cents)
  })

  it('a nonprofit with a large budget bills the large_org tier', async () => {
    const b = await computeEffectiveBilling(
      fakeDb({ primaryType: 'nonprofit', annualBudget: 5000000 }), 'p1', account())
    expect(b.client_category).toBe('large')
    expect(b.tier_id).toBe('large_org')
    expect(b.effective_monthly_cents).toBe(tierById('large_org').monthly_cents)
  })

  it('a nonprofit with an UNKNOWN budget defaults to the small_org tier', async () => {
    const b = await computeEffectiveBilling(fakeDb({ primaryType: 'nonprofit' }), 'p1', account())
    expect(b.client_category).toBe('small')
    expect(b.tier_id).toBe('small_org')
  })

  it('a custom monthly override wins over the type-derived amount', async () => {
    const b = await computeEffectiveBilling(
      fakeDb({ primaryType: 'nonprofit', annualBudget: 900000 }), 'p1',
      account({ custom_monthly_cents: 12345 }))
    expect(b.basis).toBe('custom_override')
    expect(b.effective_monthly_cents).toBe(12345)
  })

  it('pro bono zeroes the amount (override untouched)', async () => {
    const b = await computeEffectiveBilling(
      fakeDb({ primaryType: 'nonprofit', annualBudget: 900000 }), 'p1',
      account({ is_pro_bono: true }))
    expect(b.basis).toBe('pro_bono')
    expect(b.net_monthly_cents).toBe(0)
  })

  it('a percentage discount reduces the net amount (discount logic untouched)', async () => {
    const b = await computeEffectiveBilling(
      fakeDb({ primaryType: 'nonprofit', annualBudget: 900000 }), 'p1',
      account({ discount_percent: 10 }))
    const expected = Math.round(tierById('mid_size').monthly_cents * 0.9)
    expect(b.net_monthly_cents).toBe(expected)
  })

  it('maps all four client categories to real catalog tiers', () => {
    for (const [category, tierId] of Object.entries(CLIENT_CATEGORY_TO_TIER_ID)) {
      expect(tierById(tierId), `${category} → ${tierId}`).toBeTruthy()
    }
  })
})
