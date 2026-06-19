/**
 * Canonical tier catalog consistency — the single source of truth must stay
 * internally coherent and match what the backend seeds + the public pricing.
 */
import { describe, it, expect } from 'vitest'
import {
  TIERS, TIER_IDS, DISCOUNTS, CAPABILITY_KEYS,
  orgTierForSeats, tierById, publicPricingTiers, fullCatalog,
} from '../../shared/tierCatalog.js'

const CAP_FLAGS = Object.values(CAPABILITY_KEYS)

describe('tier catalog shape', () => {
  it('every tier has the required fields and exactly the 3 canonical capability flags', () => {
    for (const t of TIERS) {
      expect(typeof t.id).toBe('string')
      expect(typeof t.name).toBe('string')
      expect(typeof t.summary).toBe('string')
      expect(['service', 'organization']).toContain(t.family)
      expect(Object.keys(t.capabilities).sort()).toEqual([...CAP_FLAGS].sort())
      for (const f of CAP_FLAGS) expect(typeof t.capabilities[f]).toBe('boolean')
    }
  })

  it('capability keys are exactly the 3 the backend enforces', () => {
    expect([...CAP_FLAGS].sort()).toEqual(
      ['enable_document_ai', 'enable_item_funding', 'enable_pipeline_automation'].sort(),
    )
  })

  it('tier ids are unique', () => {
    expect(new Set(TIER_IDS).size).toBe(TIER_IDS.length)
  })
})

describe('organization seat tiers', () => {
  it('cover the seat ranges contiguously (1, 2-5, 6+)', () => {
    expect(orgTierForSeats(1).id).toBe('small_org')
    expect(orgTierForSeats(2).id).toBe('mid_size')
    expect(orgTierForSeats(5).id).toBe('mid_size')
    expect(orgTierForSeats(6).id).toBe('large_org')
    expect(orgTierForSeats(99).id).toBe('large_org')
    expect(orgTierForSeats(0).id).toBe('small_org') // 0 treated as 1
  })

  it('org tiers carry a non-zero monthly price (so seats drive the invoice)', () => {
    for (const id of ['small_org', 'mid_size', 'large_org']) {
      expect(tierById(id).monthly_cents).toBeGreaterThan(0)
    }
  })

  it('higher org tiers cost at least as much as lower ones', () => {
    const s = tierById('small_org').monthly_cents
    const m = tierById('mid_size').monthly_cents
    const l = tierById('large_org').monthly_cents
    expect(m).toBeGreaterThanOrEqual(s)
    expect(l).toBeGreaterThanOrEqual(m)
  })
})

describe('discounts (overrides, not tiers)', () => {
  it('student / minister / hardship / pro bono are discounts, not tiers', () => {
    const discountIds = DISCOUNTS.map((d) => d.id)
    for (const id of ['student', 'minister', 'hardship', 'pro_bono']) {
      expect(discountIds).toContain(id)
      expect(TIER_IDS).not.toContain(id) // never a tier
    }
    expect(DISCOUNTS.find((d) => d.id === 'pro_bono').percent).toBe(100)
  })
})

describe('public pricing matches backend tier definitions', () => {
  it('publicPricingTiers exposes exactly the catalog tiers with the same capabilities', () => {
    const pub = publicPricingTiers()
    expect(pub.map((t) => t.id)).toEqual(TIER_IDS)
    for (const p of pub) {
      const src = tierById(p.id)
      expect(p.capabilities).toEqual(src.capabilities)
      expect(p.monthly_usd).toBe(src.monthly_cents / 100)
    }
  })

  it('fullCatalog ships capability labels for every flag + the discounts', () => {
    const c = fullCatalog()
    for (const f of CAP_FLAGS) expect(c.capability_labels[f]?.label).toBeTruthy()
    expect(c.discounts.length).toBeGreaterThanOrEqual(4)
  })
})
