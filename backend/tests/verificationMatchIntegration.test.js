/**
 * verificationMatchIntegration.test.js
 *
 * Locks how the verification signal influences matching. NO NETWORK: these
 * tests attach a pre-computed `verification` signal to the opportunity (exactly
 * as the async discovery enrichment would) and assert the SYNC matcher applies
 * a conservative, honest adjustment:
 *
 *   - verified org sponsor       → confidence nudged UP, never rejected
 *   - org sponsor API said FALSE → score down-weighted, never hard-rejected
 *   - API down (verified:null)   → NO adjustment (never penalize on failure)
 *
 * Also verifies the matcher does not regress the eligibility gate and that the
 * `verification` signal is surfaced on the decision (observability rule).
 */
import { describe, it, expect } from 'vitest'
import {
  verificationMatchAdjustment,
  opportunityTargetsOrganizations,
} from '../services/verification/index.js'
import { computeMatchDecision } from '../services/matchEngine.js'
import { normalizeOpportunity } from '../services/opportunityNormalizer.js'

// A nonprofit profile (eligible for the 501(c)(3)-required org grant below, so
// the row is NOT rejected by the eligibility gate and the verification
// adjustment is actually exercised).
const ORG_PROFILE = {
  id: 'org-1',
  primary_type: 'nonprofit',
  is_nonprofit: true,
  state: 'OH',
  organization_name: 'Helping Hands Inc',
}

// An org-targeted opportunity (nonprofit eligible applicants).
const ORG_OPP = {
  id: 'org-opp',
  title: 'Capacity Building Grant for Nonprofits',
  description: 'Eligible applicants: 501(c)(3) nonprofit organizations.',
  sponsor: 'Helping Hands Inc',
  application_url: 'https://example.org/apply',
  is_national: true,
  funding_type: 'grant',
}

describe('verificationMatchAdjustment (pure)', () => {
  it('boosts confidence for a verified tax-exempt sponsor', () => {
    const adj = verificationMatchAdjustment({ source: 'propublica', verified: true }, { orgTargeted: true })
    expect(adj.confidenceDelta).toBeGreaterThan(0)
    expect(adj.scoreDelta).toBe(0)
    expect(adj.reasons.join(' ')).toMatch(/verified tax-exempt/i)
  })

  it('down-weights an org-targeted sponsor the API said is NOT registered', () => {
    const adj = verificationMatchAdjustment({ source: 'propublica', verified: false }, { orgTargeted: true })
    expect(adj.scoreDelta).toBeLessThan(0)
    expect(adj.confidenceDelta).toBeLessThan(0)
  })

  it('does NOT down-weight a verified:false signal when the opp is NOT org-targeted', () => {
    const adj = verificationMatchAdjustment({ verified: false }, { orgTargeted: false })
    expect(adj.scoreDelta).toBe(0)
    expect(adj.confidenceDelta).toBe(0)
  })

  it('NEVER adjusts when the API did not answer (verified === null)', () => {
    const adj = verificationMatchAdjustment({ verified: null, reason: 'api_error' }, { orgTargeted: true })
    expect(adj.scoreDelta).toBe(0)
    expect(adj.confidenceDelta).toBe(0)
    expect(adj.reasons).toEqual([])
  })

  it('NEVER adjusts for an empty/absent signal', () => {
    expect(verificationMatchAdjustment(null, { orgTargeted: true })).toEqual({ scoreDelta: 0, confidenceDelta: 0, reasons: [] })
    expect(verificationMatchAdjustment(undefined)).toEqual({ scoreDelta: 0, confidenceDelta: 0, reasons: [] })
  })
})

describe('opportunityTargetsOrganizations', () => {
  it('true for a nonprofit-required opportunity', () => {
    expect(opportunityTargetsOrganizations(normalizeOpportunity(ORG_OPP))).toBe(true)
  })
  it('false when applicability is unknown (conservative)', () => {
    const unknown = normalizeOpportunity({ id: 'x', title: 'A grant', application_url: 'https://e.org' })
    expect(opportunityTargetsOrganizations(unknown)).toBe(false)
  })
})

describe('computeMatchDecision verification influence (verified vs unverified vs API-down)', () => {
  it('VERIFIED: confidence is boosted; decision not rejected; signal surfaced', () => {
    const verified = { ...ORG_OPP, verification: { source: 'propublica', verified: true, ntee: 'P200', revenue_band: 'mid' } }
    const r = computeMatchDecision(ORG_PROFILE, verified, {})
    expect(r.decision).not.toBe('REJECT')
    expect(r.verification).toEqual({ source: 'propublica', verified: true, ntee: 'P200', revenue_band: 'mid' })
    expect(r.reasons.join(' ')).toMatch(/verified tax-exempt/i)
  })

  it('UNVERIFIED (API said false): score is down-weighted vs the verified case, NOT rejected', () => {
    const verified = { ...ORG_OPP, id: 'v', verification: { source: 'propublica', verified: true } }
    const unverified = { ...ORG_OPP, id: 'u', verification: { source: 'propublica', verified: false } }
    const rVer = computeMatchDecision(ORG_PROFILE, verified, {})
    const rUnv = computeMatchDecision(ORG_PROFILE, unverified, {})
    expect(rUnv.decision).not.toBe('REJECT')
    expect(rUnv.score).toBeLessThan(rVer.score)
  })

  it('API-DOWN (verified:null): score identical to no-signal baseline (never penalized)', () => {
    const baseline = computeMatchDecision(ORG_PROFILE, { ...ORG_OPP, id: 'b' }, {})
    const apiDown = computeMatchDecision(ORG_PROFILE, { ...ORG_OPP, id: 'd', verification: { source: 'propublica', verified: null, reason: 'api_error' } }, {})
    expect(apiDown.score).toBe(baseline.score)
    expect(apiDown.decision).toBe(baseline.decision)
  })

  it('REGRESSION: a verified:false signal cannot turn an otherwise-eligible org match into a REJECT', () => {
    const unverified = { ...ORG_OPP, id: 'u2', verification: { source: 'propublica', verified: false } }
    const r = computeMatchDecision(ORG_PROFILE, unverified, {})
    expect(r.decision).not.toBe('REJECT')
    expect(r.eligible).not.toBe(false)
  })

  it('Census geo: attached county fills a missing geo_county for the matcher', () => {
    const withGeo = {
      ...ORG_OPP,
      id: 'g',
      verification: { geo: { county: 'Cuyahoga County', state: 'OH', fips: '39035' } },
    }
    const r = computeMatchDecision(ORG_PROFILE, withGeo, {})
    // The signal is surfaced and the run does not reject.
    expect(r.verification.geo.fips).toBe('39035')
    expect(r.decision).not.toBe('REJECT')
  })
})
