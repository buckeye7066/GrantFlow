import { describe, it, expect } from 'vitest'
import {
  classifyApplyability,
  applyabilityTierOf,
  isApplyableSource,
  applyabilityRank,
  tierIsApplyable,
  applyabilityTierSql,
  applyableSql,
  APPLYABILITY_TIERS,
  TIER_RANK,
} from '../config/sourceApplyability.js'

describe('classifyApplyability — the real prod junk', () => {
  // Each case is a verbatim shape the owner named as the problem the pipeline
  // fills with. Mutation-verify: neutering any tier rule reddens its case.

  it('ssa.gov/disability → account_portal, NOT applyable', () => {
    const r = classifyApplyability({ application_url: 'https://www.ssa.gov/disability', opportunity_kind: 'benefit' })
    expect(r.tier).toBe('account_portal')
    expect(r.isApplyable).toBe(false)
  })

  it('a grants.gov search-detail page → info_only, NOT applyable', () => {
    const r = classifyApplyability({ application_url: 'https://www.grants.gov/search-results-detail/362910', opportunity_kind: 'direct' })
    expect(r.tier).toBe('info_only')
    expect(r.isApplyable).toBe(false)
  })

  it('a sam.gov FAL listing → info_only', () => {
    const r = classifyApplyability({ application_url: 'https://sam.gov/fal/3d835e885525455bb6ee2e9dda488402/view', opportunity_kind: 'direct' })
    expect(r.tier).toBe('info_only')
  })

  it('a real scholarship form (academicworks) → online_form, applyable', () => {
    const r = classifyApplyability({ application_url: 'https://cpcc.academicworks.com/opportunities/12345', opportunity_kind: 'direct' })
    expect(r.tier).toBe('online_form')
    expect(r.isApplyable).toBe(true)
  })

  it('a mail-in grant → mail_or_pdf, applyable', () => {
    const r = classifyApplyability({ application_mode: 'mail', opportunity_kind: 'direct', title: 'Foundation Grant', mailing_address: '123 Main St, Nashville TN' })
    expect(r.tier).toBe('mail_or_pdf')
    expect(r.isApplyable).toBe(true)
  })

  it('a U.S. Bank web form → online_form, applyable', () => {
    const r = classifyApplyability({ application_url: 'https://onlinebanking.usbank.com/grants/apply', opportunity_kind: 'direct', application_mode: 'portal' })
    expect(r.tier).toBe('online_form')
    expect(r.isApplyable).toBe(true)
  })

  it('medicaid.gov → account_portal', () => {
    expect(applyabilityTierOf({ application_url: 'https://www.medicaid.gov', opportunity_kind: 'benefit' })).toBe('account_portal')
  })

  it('studentaid.gov work-study → account_portal', () => {
    expect(applyabilityTierOf({ application_url: 'https://studentaid.gov/understand-aid/types/work-study', opportunity_kind: 'benefit' })).toBe('account_portal')
  })

  it('a directory pointer → info_only', () => {
    expect(applyabilityTierOf({ application_url: 'https://www.scholarships.com/browse', opportunity_kind: 'directory' })).toBe('info_only')
  })

  it('a FAFSA-linkage auto_profile → account_portal (person must sign in)', () => {
    const r = classifyApplyability({
      application_mode: 'fafsa', opportunity_kind: 'direct',
      title: 'State aid — link your FAFSA',
      description: 'Link your FAFSA to apply. Federal student aid.',
    })
    expect(r.tier).toBe('account_portal')
  })

  it('a state benefit portal subdomain (.gov) → account_portal', () => {
    expect(applyabilityTierOf({ application_url: 'https://fabenefits.tn.gov/apply', opportunity_kind: 'benefit' })).toBe('account_portal')
  })

  it('an encyclopedia article about a funder → info_only', () => {
    expect(applyabilityTierOf({ application_url: 'https://en.wikipedia.org/wiki/NeighborWorks_America', opportunity_kind: 'direct' })).toBe('info_only')
  })

  it('a search-engine results URL → info_only', () => {
    expect(applyabilityTierOf({ application_url: 'https://www.google.com/search?q=grants', opportunity_kind: 'direct' })).toBe('info_only')
  })

  it('a benefit program with no other signal → account_portal', () => {
    expect(applyabilityTierOf({ opportunity_kind: 'benefit', title: 'LIHEAP', application_url: null })).toBe('account_portal')
  })
})

describe('applyability helpers', () => {
  it('tierIsApplyable is true only for the two apply tiers', () => {
    expect(tierIsApplyable('online_form')).toBe(true)
    expect(tierIsApplyable('mail_or_pdf')).toBe(true)
    expect(tierIsApplyable('account_portal')).toBe(false)
    expect(tierIsApplyable('info_only')).toBe(false)
  })

  it('isApplyableSource agrees with classifyApplyability', () => {
    const s = { application_url: 'https://cpcc.academicworks.com/opp/1' }
    expect(isApplyableSource(s)).toBe(classifyApplyability(s).isApplyable)
  })

  it('ranks an applyable source above an account/info source', () => {
    const form = { application_url: 'https://cpcc.academicworks.com/opp/1', opportunity_kind: 'direct' }
    const portal = { application_url: 'https://www.ssa.gov/disability', opportunity_kind: 'benefit' }
    const info = { application_url: 'https://www.grants.gov/search-results-detail/1', opportunity_kind: 'direct' }
    expect(applyabilityRank(form)).toBeLessThan(applyabilityRank(portal))
    expect(applyabilityRank(portal)).toBeLessThan(applyabilityRank(info))
  })

  it('every tier has a rank', () => {
    for (const t of Object.values(APPLYABILITY_TIERS)) {
      expect(TIER_RANK[t]).toBeTypeOf('number')
    }
  })

  it('a non-object source is info_only, never a crash', () => {
    expect(classifyApplyability(null).tier).toBe('info_only')
    expect(classifyApplyability(undefined).isApplyable).toBe(false)
  })
})

describe('the SQL derived read', () => {
  it('applyabilityTierSql emits a CASE naming every tier bucket', () => {
    const sql = applyabilityTierSql('fo.application_url', 'fo.opportunity_kind')
    expect(sql).toMatch(/CASE/)
    expect(sql).toMatch(/'account_portal'/)
    expect(sql).toMatch(/'info_only'/)
    expect(sql).toMatch(/'online_form'/)
    // dialect-agnostic: LIKE only, never a Postgres-only regex operator
    expect(sql).not.toMatch(/~\*/)
  })

  it('applyableSql restricts to the two applyable tiers', () => {
    const sql = applyableSql('u', 'k')
    expect(sql).toMatch(/'online_form'/)
    expect(sql).toMatch(/'mail_or_pdf'/)
    expect(sql).not.toMatch(/~\*/)
  })
})
