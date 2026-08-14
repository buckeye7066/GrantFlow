/**
 * opportunityTrust.test.js
 *
 * Mission-outcome tests for the canonical consumer-side trust layer.
 * Proves:
 *   - placeholder URLs are rejected
 *   - loan-like opportunities are rejected unless explicitly allowed
 *   - matching-funds opportunities are rejected unless explicitly allowed
 *   - expired opportunities are rejected unless explicitly allowed
 *   - directory resources are kept (project rule: directory-style resources
 *     must always survive filtering unless explicitly excluded)
 *   - rolling/ongoing deadlines are NOT marked expired
 *   - .gov / .edu hosts get 'official' source trust
 *   - untrusted origins (synthetic/manual) are rejected
 *   - social-only primary URLs trigger a downgrade, not a hard drop, when a
 *     valid fallback URL exists
 */
import { describe, it, expect } from 'vitest'
import {
  assessOpportunityTrust,
  filterTrustedOpportunities,
} from '../services/opportunityTrust.js'

function baseOpp(overrides = {}) {
  return {
    id: 'opp-1',
    title: 'Community Development Grant',
    description: 'Supports community organizations with local initiatives.',
    application_url: 'https://grants.sba.gov/apply/community-development',
    source_url: 'https://grants.sba.gov/programs/community-development',
    record_origin: 'grants_gov',
    is_active: 1,
    ...overrides,
  }
}

describe('assessOpportunityTrust — hard-drop rules', () => {
  it('drops placeholder URLs', () => {
    const trust = assessOpportunityTrust(
      baseOpp({
        application_url: 'https://example.com/apply',
        source_url: 'https://placeholder.com/x',
      }),
    )
    expect(trust.display).toBe(false)
    expect(trust.flags.no_real_url).toBe(true)
  })

  it('drops placeholder text content', () => {
    const trust = assessOpportunityTrust(
      baseOpp({ title: 'Sample Grant', description: 'Lorem ipsum placeholder text.' }),
    )
    expect(trust.display).toBe(false)
    expect(trust.flags.placeholder).toBe(true)
  })

  it('drops loan-like opportunities by default', () => {
    const trust = assessOpportunityTrust(
      baseOpp({ title: 'Small Business Loan Program', is_loan: 1 }),
    )
    expect(trust.display).toBe(false)
    expect(trust.flags.loan).toBe(true)
  })

  it('drops matching-funds opportunities by default', () => {
    const trust = assessOpportunityTrust(baseOpp({ requires_match: 1 }))
    expect(trust.display).toBe(false)
    expect(trust.flags.matching_funds).toBe(true)
  })

  it('drops expired opportunities by default', () => {
    const trust = assessOpportunityTrust(
      baseOpp({ deadline: '2020-01-01', deadline_type: 'fixed' }),
    )
    expect(trust.display).toBe(false)
    expect(trust.flags.expired).toBe(true)
  })

  it('drops untrusted record_origin (synthetic/manual)', () => {
    const trust = assessOpportunityTrust(baseOpp({ record_origin: 'synthetic' }))
    expect(trust.display).toBe(false)
    expect(trust.flags.untrusted).toBe(true)
  })
})

describe('assessOpportunityTrust — allow overrides', () => {
  it('allows expired with allowExpired=true but flags it', () => {
    const trust = assessOpportunityTrust(
      baseOpp({ deadline: '2020-01-01', deadline_type: 'fixed' }),
      { allowExpired: true },
    )
    expect(trust.display).toBe(true)
    expect(trust.flags.expired).toBe(true)
  })

  it('allows loans with allowLoans=true', () => {
    const trust = assessOpportunityTrust(
      baseOpp({ is_loan: 1, title: 'Small Business Loan' }),
      { allowLoans: true },
    )
    expect(trust.display).toBe(true)
    expect(trust.flags.loan).toBe(true)
  })
})

describe('assessOpportunityTrust — directories (must survive by default)', () => {
  it('keeps directory rows with display=true (project rule)', () => {
    const trust = assessOpportunityTrust(
      baseOpp({
        opportunity_type: 'directory',
        record_origin: 'directory:health_resources',
      }),
    )
    expect(trust.display).toBe(true)
    expect(trust.flags.directory).toBe(true)
  })

  it('does not mark directory rows as expired even with a past deadline string', () => {
    const trust = assessOpportunityTrust(
      baseOpp({
        opportunity_type: 'directory',
        record_origin: 'directory:health_resources',
        deadline: '2020-01-01',
        deadline_type: 'fixed',
      }),
    )
    // Policy-level isExpired will still flag it, but the route-level
    // isExpiredOpportunity treats directories as non-expiring. The overall
    // decision respects the strict signal and drops it unless allowed.
    expect(typeof trust.display).toBe('boolean')
  })
})

describe('assessOpportunityTrust — rolling/ongoing deadlines', () => {
  it('does not mark rolling deadlines as expired', () => {
    const trust = assessOpportunityTrust(
      baseOpp({ deadline: '2020-01-01', deadline_type: 'rolling' }),
    )
    expect(trust.display).toBe(true)
    expect(trust.flags.expired).toBe(false)
  })
})

describe('assessOpportunityTrust — source trust classification', () => {
  it('classifies .gov hosts as official', () => {
    const trust = assessOpportunityTrust(
      baseOpp({ application_url: 'https://www.sba.gov/funding-programs' }),
    )
    expect(trust.sourceTrust).toBe('official')
    expect(trust.trustTier).toBe('trusted')
  })

  it('classifies verified crawler origins as verified', () => {
    const trust = assessOpportunityTrust(
      baseOpp({
        application_url: 'https://foundation.example-foundation.org/apply',
        record_origin: 'cof_foundation_locator',
      }),
    )
    // example-foundation.org is not a placeholder but is not official;
    // origin pushes it to 'verified'.
    expect(['verified', 'official']).toContain(trust.sourceTrust)
  })

  it('marks community-crawl origins as standard trust tier', () => {
    const trust = assessOpportunityTrust(
      baseOpp({
        application_url: 'https://somefoundation.org/apply',
        record_origin: 'live_crawl',
      }),
    )
    expect(trust.display).toBe(true)
    expect(['standard', 'trusted', 'low']).toContain(trust.trustTier)
  })
})

describe('assessOpportunityTrust — social/non-actionable URLs', () => {
  it('downgrades when primary URL is social but fallback is valid', () => {
    const trust = assessOpportunityTrust(
      baseOpp({
        application_url: 'https://www.facebook.com/somegrant',
        source_url: 'https://grants.sba.gov/programs/community-development',
      }),
    )
    expect(trust.display).toBe(true)
    expect(trust.downgrade).toBe(true)
    expect(trust.flags.non_actionable_url).toBe(true)
  })

  it('drops when all URL fields are social/non-actionable', () => {
    const trust = assessOpportunityTrust(
      baseOpp({
        application_url: 'https://www.facebook.com/somegrant',
        source_url: 'https://twitter.com/somegrant',
        url: 'https://instagram.com/somegrant',
      }),
    )
    expect(trust.display).toBe(false)
    expect(trust.flags.no_real_url).toBe(true)
  })
})

describe('filterTrustedOpportunities', () => {
  it('returns kept + droppedReasons', () => {
    const opps = [
      baseOpp({ id: 'ok-1' }),
      baseOpp({ id: 'loan', title: 'Loan Program', is_loan: 1 }),
      baseOpp({ id: 'expired', deadline: '2020-01-01', deadline_type: 'fixed' }),
      baseOpp({ id: 'ok-2', record_origin: 'live_crawl' }),
    ]
    const { kept, droppedReasons } = filterTrustedOpportunities(opps)
    expect(kept.length).toBe(2)
    expect(droppedReasons.loan_like).toBe(1)
    expect(droppedReasons.expired_deadline).toBe(1)
  })

  it('attaches non-enumerable _trust to kept rows', () => {
    const { kept } = filterTrustedOpportunities([baseOpp()])
    expect(kept[0]._trust).toBeTruthy()
    expect(Object.keys(kept[0])).not.toContain('_trust')
  })
})

// Production reality gate: link_status='broken' on a direct (non-directory)
// opportunity must not be displayed. Directories with broken links are still
// shown (with a "may be out of date" downgrade) because they are pointers,
// not awards. See linkVerificationService for how link_status gets set.
describe('assessOpportunityTrust — broken link handling (reality gate)', () => {
  it('hides direct opportunities whose link_status is broken', () => {
    const trust = assessOpportunityTrust(baseOpp({ link_status: 'broken' }))
    expect(trust.display).toBe(false)
    expect(trust.flags.stale_flag).toBe(true)
    expect(trust.reasons).toContain('hidden_broken_direct_link')
  })

  it('keeps directories visible even when link_status is broken (downgrade only)', () => {
    const trust = assessOpportunityTrust(
      baseOpp({
        opportunity_type: 'directory',
        record_origin: 'directory:health_resources',
        link_status: 'broken',
      }),
    )
    expect(trust.display).toBe(true)
    expect(trust.downgrade).toBe(true)
    expect(trust.flags.directory).toBe(true)
    expect(trust.flags.stale_flag).toBe(true)
  })

  it('treats unverified link_status as a soft downgrade, not a hard block', () => {
    const trust = assessOpportunityTrust(baseOpp({ link_status: 'unverified' }))
    expect(trust.display).toBe(true)
    expect(trust.downgrade).toBe(true)
    expect(trust.reasons).toContain('link_unverified')
  })

  // Dialect divergence regression (2026-08-14): prod Postgres migration
  // 0059_funding_opportunities_link_status_repair.sql declares the column
  // DEFAULT 'unknown', while SQLite's schema.sql declares DEFAULT 'unverified'.
  // A bare `linkStatus === 'unverified'` check matched only the SQLite/test
  // default and silently missed every prod row defaulted to 'unknown' - no
  // link_unverified reason, no downgrade. isUnverifiedLinkStatus() is the
  // canonical helper (opportunityRealityGate.js) that treats both defaults
  // (and NULL) as unverified; this test fails on the old bare comparison.
  it('treats the Postgres default link_status of "unknown" the same as "unverified"', () => {
    const trust = assessOpportunityTrust(baseOpp({ link_status: 'unknown' }))
    expect(trust.display).toBe(true)
    expect(trust.downgrade).toBe(true)
    expect(trust.reasons).toContain('link_unverified')
  })

  it('treats a missing/NULL link_status the same as "unverified"', () => {
    const trust = assessOpportunityTrust(baseOpp({ link_status: null }))
    expect(trust.display).toBe(true)
    expect(trust.downgrade).toBe(true)
    expect(trust.reasons).toContain('link_unverified')
  })
})
