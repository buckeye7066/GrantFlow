/**
 * Canonical tier catalog consistency — the single source of truth must stay
 * internally coherent and match what the backend seeds + the public pricing.
 */
import { describe, it, expect } from 'vitest'
import {
  TIERS, TIER_IDS, DISCOUNTS, CAPABILITY_KEYS, ADDON_CATALOG,
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

  /* Pinned as a literal list on purpose. The capability vocabulary is a
     customer-facing contract - it decides what each tier is sold as - so adding
     or removing a flag should be a deliberate edit here, never a side effect of
     touching the catalog. Was three flags until 2026-09-15; three could not
     express a seven-rung ladder, so every tier ended up granting everything. */
  it('capability keys are exactly the ten the backend enforces', () => {
    expect([...CAP_FLAGS].sort()).toEqual([
      'enable_application_drafting',
      'enable_auto_submit',
      'enable_bulk_export',
      'enable_compliance_reporting',
      'enable_document_ai',
      'enable_funder_intelligence',
      'enable_item_funding',
      'enable_matching_intelligence',
      'enable_outreach',
      'enable_pipeline_automation',
    ])
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

  /* PACKAGING 2026-09-15. An earlier version of this test pinned pipeline
     automation ON for the $0 tiers, because with only three capability flags
     that was the only way a $0 profile was not locked out of everything
     automated (the prod incident recorded in billingUniversalEntitlement.test.js:
     a senior on the $0 'individual' tier locked out, unblocked by a hand-granted
     add-on).

     With ten flags that trade-off disappears. The free tiers keep everything
     that is cheap to serve - discovery, deadlines, reminders, AI document
     reading, item search - and unattended portal work, which is the most
     expensive capability to serve, starts at Growth. The original intent (a
     free user is not locked out of the product) is met by what free now
     includes, and the add-on path in ADDON_CATALOG still lets an admin grant
     any single capability to any account. */
  it('unattended automation is a paid capability, and free keeps what is cheap to serve', () => {
    for (const id of ['foundation', 'individual']) {
      const t = tierById(id)
      expect(t.monthly_cents).toBe(0)
      expect(t.capabilities[CAPABILITY_KEYS.PIPELINE_AUTOMATION]).toBe(false)
      expect(t.capabilities[CAPABILITY_KEYS.AUTO_SUBMIT]).toBe(false)
      // The hook: free must still do real work for the user.
      expect(t.capabilities[CAPABILITY_KEYS.DOCUMENT_AI]).toBe(true)
      expect(t.capabilities[CAPABILITY_KEYS.ITEM_FUNDING]).toBe(true)
    }
    expect(tierById('growth').capabilities[CAPABILITY_KEYS.PIPELINE_AUTOMATION]).toBe(true)
  })

  /* THE "never charge more for less" INVARIANT, and the reason it exists: the
     catalog had small_org at $149 excluding a capability that growth granted at
     $99. A price-ordered superset check makes that unshippable rather than
     something a human has to notice in a table. */
  it('a more expensive tier grants a superset of every cheaper tier', () => {
    const byPrice = [...TIERS].sort((a, b) => a.monthly_cents - b.monthly_cents)
    for (let i = 0; i < byPrice.length; i += 1) {
      for (let j = i + 1; j < byPrice.length; j += 1) {
        const cheap = byPrice[i]
        const dear = byPrice[j]
        const missing = CAP_FLAGS.filter((f) => cheap.capabilities[f] === true && dear.capabilities[f] !== true)
        expect(missing).toEqual([])
      }
    }
  })

  /* Capability DEPENDENCIES. These are not style preferences - each one is a
     package that would be incoherent or unsafe to sell on its own. */
  it('no tier sells a capability without the ones it depends on', () => {
    for (const t of TIERS) {
      const has = (k) => t.capabilities[k] === true
      // Submitting unattended presupposes working the pipeline unattended.
      if (has(CAPABILITY_KEYS.AUTO_SUBMIT)) {
        expect(has(CAPABILITY_KEYS.PIPELINE_AUTOMATION)).toBe(true)
      }
      // Hamilton cannot work a pipeline of applications he was never allowed
      // to write.
      if (has(CAPABILITY_KEYS.PIPELINE_AUTOMATION)) {
        expect(has(CAPABILITY_KEYS.APPLICATION_DRAFTING)).toBe(true)
      }
      // Drafting against a funder you were never allowed to score is how a
      // profile applies for things it does not qualify for.
      if (has(CAPABILITY_KEYS.APPLICATION_DRAFTING)) {
        expect(has(CAPABILITY_KEYS.MATCHING_INTELLIGENCE)).toBe(true)
      }
    }
  })

  /* Every flag must be reachable as a purchasable add-on, so a customer on a
     lower tier can buy the one capability they need instead of being told to
     jump a whole tier. */
  it('every capability is purchasable as an add-on', () => {
    const addonKeys = ADDON_CATALOG.map((a) => a.capability_key).sort()
    expect(addonKeys).toEqual([...CAP_FLAGS].sort())
    for (const a of ADDON_CATALOG) {
      expect(a.label).toBeTruthy()
      expect(a.plain).toBeTruthy()
    }
  })

  /* A tier that advertises a capability as excluded while granting it is a
     contradiction in the customer-facing copy.

     ACCURACY NOTE (I overclaimed this once and it is worth not repeating):
     `publicPricingTiers()` and `fullCatalog()` DO serve `includes`/`excludes`
     over /api/billing/catalog, but as of 2026-09-15 NO component renders them
     — `TierMatrix.jsx` renders the capability BOOLEANS only. So this guard is
     protecting the served contract ahead of its first consumer, not a live
     screen. That is still worth pinning: the copy is the part a human writes
     by hand, so it is the part that drifts from the flags. */
  it('no tier advertises a capability it actually grants as excluded', () => {
    for (const t of TIERS) {
      const excludesText = (t.excludes || []).join(' ').toLowerCase()
      if (t.capabilities[CAPABILITY_KEYS.PIPELINE_AUTOMATION] === true) {
        expect(excludesText).not.toMatch(/pipeline automation/)
      }
    }
  })
})
