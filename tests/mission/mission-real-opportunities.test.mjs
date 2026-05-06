/**
 * Mission test suite — real opportunities
 *
 * Mission goal #1: "Real funding only — no placeholders, no dead links, no
 * generic junk." This file is the acceptance test for that promise.
 *
 * Pass condition (per the user's reality-gate spec):
 *   0 bad direct opportunities pass the gate.
 *
 * The bad fixtures we exercise:
 *   1. expired direct grant
 *   2. placeholder URL (example.com)
 *   3. Facebook-only "grant"
 *   4. loan disguised as grant (is_loan=1)
 *   5. matching-funds-only program (requires_match=1)
 *   6. directory resource with no fixed deadline (allowed)
 *   7. legitimate live grant (sanity check — must be allowed)
 *   8. school portal (.edu without separate apply URL)
 *
 * The 404 / HEAD-blocking-but-GET-OK cases are exercised by
 * tests/unit/linkVerificationService.test.* via stubbed fetch — repeating them
 * here would duplicate plumbing we already have. The reality gate owns the
 * "before any network probe" rules; the verifier owns the network rules.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assessReality,
  classifyOpportunityKind,
  classifySourceTrustTier,
  OPPORTUNITY_KINDS,
  SOURCE_TRUST_TIERS,
} from '../../backend/services/opportunityRealityGate.js'

const yesterday = () => {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}
const nextYear = () => {
  const d = new Date()
  d.setFullYear(d.getFullYear() + 1)
  return d.toISOString().slice(0, 10)
}

test('mission/reality-gate: rejects expired direct grant', () => {
  const result = assessReality({
    title: 'Last Year Equipment Grant',
    application_url: 'https://www.grants.gov/some-program',
    record_origin: 'live_crawl',
    deadline: yesterday(),
    deadline_type: 'fixed',
  })
  assert.equal(result.allowed, false)
  assert.ok(
    result.reasons.includes('expired_deadline'),
    `expected expired_deadline, got ${result.reasons.join(',')}`,
  )
})

test('mission/reality-gate: rejects placeholder example.com URL', () => {
  const result = assessReality({
    title: 'Example Program',
    application_url: 'https://example.com/grant',
    record_origin: 'live_crawl',
    deadline: nextYear(),
  })
  assert.equal(result.allowed, false)
  assert.ok(
    result.reasons.includes('no_real_url') || result.reasons.includes('placeholder_content'),
    `expected placeholder rejection, got ${result.reasons.join(',')}`,
  )
})

test('mission/reality-gate: rejects Facebook-only "grant"', () => {
  const result = assessReality({
    title: 'Community Help Grant',
    application_url: 'https://www.facebook.com/CommunityHelp',
    source_url: 'https://www.facebook.com/CommunityHelp',
    record_origin: 'live_crawl',
    deadline: nextYear(),
  })
  assert.equal(result.allowed, false)
  assert.equal(
    result.kind,
    OPPORTUNITY_KINDS.DIRECT,
    'a "grant" must stay classified as DIRECT so the gate can reject it (mission rule: real funding only)',
  )
  assert.ok(
    result.reasons.includes('social_only_url_for_direct'),
    `expected social_only_url_for_direct, got ${result.reasons.join(',')}`,
  )
})

test('mission/reality-gate: explicit referral with social URL is allowed (downgraded)', () => {
  const result = assessReality({
    title: 'Local Mutual Aid Group',
    application_url: 'https://www.facebook.com/MutualAidLocal',
    source_url: 'https://www.facebook.com/MutualAidLocal',
    record_origin: 'live_crawl',
    opportunity_type: 'referral',
  })
  assert.equal(result.allowed, true, `expected allowed referral, got reasons=${result.reasons.join(',')}`)
  assert.equal(result.kind, OPPORTUNITY_KINDS.REFERRAL)
  assert.equal(result.downgrade, true)
})

test('mission/reality-gate: rejects loan disguised as grant', () => {
  const result = assessReality({
    title: 'SBA Loan Program',
    application_url: 'https://www.sba.gov/loans/x',
    record_origin: 'live_crawl',
    is_loan: 1,
    deadline: nextYear(),
  })
  assert.equal(result.allowed, false)
  assert.ok(
    result.reasons.includes('loan_like'),
    `expected loan_like, got ${result.reasons.join(',')}`,
  )
})

test('mission/reality-gate: rejects matching-funds-only program for direct', () => {
  const result = assessReality({
    title: 'Match Required Capital Grant',
    application_url: 'https://www.grants.gov/match-capital',
    record_origin: 'live_crawl',
    requires_match: 1,
    deadline: nextYear(),
  })
  assert.equal(result.allowed, false)
  assert.ok(
    result.reasons.includes('matching_funds_required'),
    `expected matching_funds_required, got ${result.reasons.join(',')}`,
  )
})

test('mission/reality-gate: matching-funds is OK when allowMatchingFunds=true', () => {
  const result = assessReality(
    {
      title: 'Match Required Capital Grant',
      application_url: 'https://www.grants.gov/match-capital',
      record_origin: 'live_crawl',
      requires_match: 1,
      deadline: nextYear(),
    },
    { allowMatchingFunds: true },
  )
  assert.equal(result.allowed, true)
})

test('mission/reality-gate: directory with no fixed deadline is allowed', () => {
  const result = assessReality({
    title: 'United Way 211 Local Resources',
    application_url: 'https://www.211.org/',
    record_origin: 'directory:health_resources',
    type: 'DIRECTORY',
    opportunity_type: 'directory',
    // intentionally no deadline
  })
  assert.equal(result.allowed, true, `expected allowed, got reasons=${result.reasons.join(',')}`)
  assert.equal(result.kind, OPPORTUNITY_KINDS.DIRECTORY)
  assert.equal(result.trustTier, SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY)
})

test('mission/reality-gate: legitimate live grant is allowed', () => {
  const result = assessReality({
    title: 'Rural Fire Equipment Grant',
    application_url: 'https://www.grants.gov/web/grants/view-opportunity.html?oppId=12345',
    source_url: 'https://www.grants.gov/web/grants/view-opportunity.html?oppId=12345',
    source: 'grants.gov',
    record_origin: 'grants_gov',
    deadline: nextYear(),
  })
  assert.equal(result.allowed, true, `expected allowed, got reasons=${result.reasons.join(',')}`)
  assert.equal(result.kind, OPPORTUNITY_KINDS.DIRECT)
  assert.equal(result.trustTier, SOURCE_TRUST_TIERS.OFFICIAL_API)
})

test('mission/reality-gate: school .edu page classifies as school_portal', () => {
  const kind = classifyOpportunityKind({
    title: 'XYZ University Financial Aid',
    source_url: 'https://www.xyzu.edu/financial-aid',
  })
  assert.equal(kind, OPPORTUNITY_KINDS.SCHOOL_PORTAL)
})

test('mission/reality-gate: hides direct opportunity when link_status=broken', () => {
  const result = assessReality({
    title: 'Equipment Grant',
    application_url: 'https://example-foundation.org/grant',
    record_origin: 'live_crawl',
    link_status: 'broken',
    deadline: nextYear(),
  })
  assert.equal(result.allowed, false)
  assert.ok(
    result.reasons.includes('link_marked_broken'),
    `expected link_marked_broken, got ${result.reasons.join(',')}`,
  )
})

test('mission/reality-gate: directory with broken link still allowed (downgraded)', () => {
  const result = assessReality({
    title: 'Local Food Pantry Directory',
    application_url: 'https://feedingamerica.org/find-food/',
    record_origin: 'directory:health_resources',
    type: 'DIRECTORY',
    link_status: 'broken',
  })
  assert.equal(result.allowed, true)
  assert.equal(result.downgrade, true)
  assert.ok(result.reasons.includes('link_marked_broken'))
})

test('mission/reality-gate: classifySourceTrustTier maps grants.gov to OFFICIAL_API', () => {
  const tier = classifySourceTrustTier({
    source: 'grants.gov',
    record_origin: 'grants_gov',
    application_url: 'https://www.grants.gov/x',
  })
  assert.equal(tier, SOURCE_TRUST_TIERS.OFFICIAL_API)
})

test('mission/reality-gate: classifySourceTrustTier maps .gov host to OFFICIAL_PORTAL', () => {
  const tier = classifySourceTrustTier({
    source: 'state_portal',
    record_origin: 'live_crawl',
    application_url: 'https://www.tn.gov/finance/programs/some-program',
  })
  assert.equal(tier, SOURCE_TRUST_TIERS.OFFICIAL_PORTAL)
})

test('mission/reality-gate: classifySourceTrustTier maps cof_foundation_locator to VERIFIED_DIRECTORY', () => {
  const tier = classifySourceTrustTier({
    source: 'cof',
    record_origin: 'cof_foundation_locator',
    application_url: 'https://cof.org/',
  })
  assert.equal(tier, SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY)
})

test('mission/reality-gate: missing/null fields default to NEUTRAL, not exclusionary', () => {
  // Mission rule: "null, undefined, or missing profile fields must NOT
  // disqualify a funding source by default." Same applies to optional
  // opportunity fields — no deadline, no description, no opportunity_type
  // should still pass for a real URL.
  const result = assessReality({
    title: 'Open Rolling Application',
    application_url: 'https://www.grants.gov/web/some-program',
    record_origin: 'grants_gov',
    // no deadline, no opportunity_type, no requires_match, etc.
  })
  assert.equal(result.allowed, true, `expected allowed, got reasons=${result.reasons.join(',')}`)
})
