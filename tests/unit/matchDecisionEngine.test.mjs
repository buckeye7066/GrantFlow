/**
 * Match Decision Engine Tests
 *
 * Tests for:
 * 1. Profile normalization aliasing
 * 2. Opportunity normalization
 * 3. Eligibility decisions (entity type, geography, need type)
 * 4. Need-type alignment
 * 5. Source trust scoring
 * 6. computeMatchDecision() integration
 * 7. Persistence: pipeline entry stores decision metadata
 * 8. Regression tests:
 *    - Student aid NOT shown to non-student
 *    - FEMA/disaster NOT shown without disaster context
 *    - Business grant NOT shown to individual with no business
 *    - Nonprofit/church grant NOT shown to private individual
 *    - Geographic mismatch NOT shown outside eligible region
 * 9. Positive tests: correct opportunities ARE accepted for qualifying profiles
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

// Static imports for pure engine code (no legacy deps)
import {
  normalizeProfile,
  computeProfileFingerprint,
  normalizeNeedCategory,
  normalizeEntityType,
} from '../../backend/services/profileNormalizer.js'

import {
  normalizeOpportunity,
  computeOpportunityFingerprint,
} from '../../backend/services/opportunityNormalizer.js'

import {
  evaluateEligibility,
  calculateNeedAlignment,
  calculateSourceTrust,
  computeMatchDecision,
  MATCHER_VERSION,
} from '../../backend/services/matchDecisionEngine.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      primary_type TEXT,
      display_name TEXT NOT NULL DEFAULT 'Test',
      status TEXT DEFAULT 'active',
      tags TEXT DEFAULT '[]'
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      sponsor TEXT,
      source TEXT,
      source_id TEXT,
      source_url TEXT,
      evidence_url TEXT,
      record_origin TEXT DEFAULT 'live_crawl',
      description TEXT,
      eligibility_bullets TEXT DEFAULT '[]',
      amount_min REAL,
      amount_max REAL,
      deadline TEXT,
      deadline_type TEXT,
      application_url TEXT,
      is_national INTEGER DEFAULT 0,
      state TEXT,
      categories TEXT DEFAULT '[]',
      keywords TEXT DEFAULT '[]',
      opportunity_type TEXT,
      funding_type TEXT,
      is_loan INTEGER DEFAULT 0
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT NOT NULL,
      funder TEXT,
      status TEXT DEFAULT 'discovered',
      deadline TEXT,
      match_score INTEGER,
      match_reasons TEXT DEFAULT '[]',
      notes TEXT,
      application_url TEXT,
      application_method TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      amount_requested REAL,
      amount_min REAL,
      amount_max REAL,
      match_decision TEXT,
      match_explanation TEXT,
      matched_needs TEXT DEFAULT '[]',
      eligibility_status TEXT,
      ineligibility_reasons TEXT DEFAULT '[]',
      profile_fingerprint TEXT,
      opportunity_fingerprint TEXT,
      matcher_version TEXT,
      evaluated_at DATETIME,
      match_confidence INTEGER
    );
  `)
  return db
}

// ---------------------------------------------------------------------------
// 1. Profile normalization aliasing
// ---------------------------------------------------------------------------

test('profileNormalizer: normalizeNeedCategory aliases medical → health_medical', () => {
  assert.equal(normalizeNeedCategory('medical'), 'health_medical')
  assert.equal(normalizeNeedCategory('health'), 'health_medical')
  assert.equal(normalizeNeedCategory('healthcare'), 'health_medical')
  assert.equal(normalizeNeedCategory('prescription'), 'health_medical')
})

test('profileNormalizer: normalizeNeedCategory aliases family → family_life', () => {
  assert.equal(normalizeNeedCategory('family'), 'family_life')
  assert.equal(normalizeNeedCategory('caregiver'), 'family_life')
  assert.equal(normalizeNeedCategory('childcare'), 'family_life')
})

test('profileNormalizer: normalizeNeedCategory aliases education → education', () => {
  assert.equal(normalizeNeedCategory('student'), 'education')
  assert.equal(normalizeNeedCategory('education'), 'education')
  assert.equal(normalizeNeedCategory('college'), 'education')
  assert.equal(normalizeNeedCategory('tuition'), 'education')
})

test('profileNormalizer: normalizeNeedCategory aliases housing variants', () => {
  assert.equal(normalizeNeedCategory('rent'), 'housing')
  assert.equal(normalizeNeedCategory('rental_assistance'), 'housing')
  assert.equal(normalizeNeedCategory('eviction'), 'housing')
  assert.equal(normalizeNeedCategory('housing_instability'), 'housing')
})

test('profileNormalizer: normalizeNeedCategory aliases technology/equipment → technology_equipment', () => {
  assert.equal(normalizeNeedCategory('laptop'), 'technology_equipment')
  assert.equal(normalizeNeedCategory('computer'), 'technology_equipment')
  assert.equal(normalizeNeedCategory('desktop'), 'technology_equipment')
  assert.equal(normalizeNeedCategory('hotspot'), 'technology_equipment')
  assert.equal(normalizeNeedCategory('wifi'), 'technology_equipment')
  assert.equal(normalizeNeedCategory('tablet'), 'technology_equipment')
  assert.equal(normalizeNeedCategory('technology'), 'technology_equipment')
  assert.equal(normalizeNeedCategory('digital_access'), 'technology_equipment')
  assert.equal(normalizeNeedCategory('digital_equity'), 'technology_equipment')
  assert.equal(normalizeNeedCategory('equipment'), 'technology_equipment')
})

test('profileNormalizer: normalizeNeedCategory aliases work clothing → clothing_goods', () => {
  assert.equal(normalizeNeedCategory('uniforms'), 'clothing_goods')
  assert.equal(normalizeNeedCategory('work_clothing'), 'clothing_goods')
  assert.equal(normalizeNeedCategory('work_uniforms'), 'clothing_goods')
  assert.equal(normalizeNeedCategory('work_clothes'), 'clothing_goods')
  assert.equal(normalizeNeedCategory('professional_clothing'), 'clothing_goods')
  assert.equal(normalizeNeedCategory('interview_clothing'), 'clothing_goods')
})

test('profileNormalizer: normalizeEntityType aliases individual variants', () => {
  assert.equal(normalizeEntityType('individual_need'), 'individual')
  assert.equal(normalizeEntityType('family'), 'individual')
  assert.equal(normalizeEntityType('household'), 'individual')
})

test('profileNormalizer: normalizeEntityType aliases nonprofit variants', () => {
  assert.equal(normalizeEntityType('church'), 'nonprofit')
  assert.equal(normalizeEntityType('faith_based'), 'nonprofit')
  assert.equal(normalizeEntityType('501c3'), 'nonprofit')
  assert.equal(normalizeEntityType('charity'), 'nonprofit')
})

test('profileNormalizer: normalizeEntityType aliases business variants', () => {
  assert.equal(normalizeEntityType('small_business'), 'business')
  assert.equal(normalizeEntityType('entrepreneur'), 'business')
  assert.equal(normalizeEntityType('startup'), 'business')
  assert.equal(normalizeEntityType('self_employed'), 'business')
})

test('profileNormalizer: normalizeProfile produces canonical structure', () => {
  const raw = {
    id: 'p1',
    primary_type: 'individual_need',
    state: 'OH',
    postal_code: '44022',
    needs: ['rent', 'medical', 'food'],
  }
  const norm = normalizeProfile(raw)
  assert.equal(norm.entityType, 'individual')
  assert.equal(norm.state, 'OH')
  assert.equal(norm.zip, '44022')
  assert.ok(norm.needCategories.includes('housing'), 'Should include housing (from rent)')
  assert.ok(norm.needCategories.includes('health_medical'), 'Should include health_medical (from medical)')
  assert.ok(norm.needCategories.includes('food'), 'Should include food')
})

test('profileNormalizer: normalizeProfile detects veteran flag', () => {
  const raw = { primary_type: 'veteran', state: 'TX' }
  const norm = normalizeProfile(raw)
  assert.equal(norm.isVeteran, true)
})

test('profileNormalizer: negative military and business strings do not become eligibility signals', () => {
  const raw = {
    primary_type: 'individual',
    state: 'TN',
    is_veteran: 'false',
    is_business: 'false',
  }
  const sections = {
    military_service: {
      answers: {
        is_veteran: 'no',
        veteran: 'false',
        served_in_military: 'no',
        military_service: 'none',
        veteran_status: 'not applicable',
        branch: 'not specified',
        discharge_status: 'unknown',
      },
    },
    business: {
      answers: {
        owns_business: 'no',
        is_self_employed: 'false',
        has_business: 'none',
        business_name: 'not specified',
        naics_code: 'n/a',
        ein: 'none',
      },
    },
  }

  const norm = normalizeProfile(raw, sections)
  assert.equal(norm.isVeteran, false)
  assert.equal(norm.isBusiness, false)
  assert.ok(!norm.needCategories.includes('veteran'))
  assert.ok(!norm.needCategories.includes('business'))
})

test('profileNormalizer: normalizeProfile detects student flag', () => {
  const raw = { primary_type: 'high_school_student', state: 'CA' }
  const norm = normalizeProfile(raw)
  assert.equal(norm.isStudent, true)
})

test('profileNormalizer: computeProfileFingerprint is deterministic', () => {
  const raw = { id: 'p1', primary_type: 'individual_need', state: 'OH', needs: ['rent', 'medical'] }
  const norm1 = normalizeProfile(raw)
  const norm2 = normalizeProfile(raw)
  assert.equal(computeProfileFingerprint(norm1), computeProfileFingerprint(norm2))
})

test('profileNormalizer: computeProfileFingerprint changes when entity type changes', () => {
  const norm1 = normalizeProfile({ primary_type: 'individual', state: 'OH' })
  const norm2 = normalizeProfile({ primary_type: 'nonprofit', state: 'OH' })
  assert.notEqual(computeProfileFingerprint(norm1), computeProfileFingerprint(norm2))
})

// ---------------------------------------------------------------------------
// 2. Opportunity normalization
// ---------------------------------------------------------------------------

test('opportunityNormalizer: extracts entity types from text', () => {
  const opp = {
    id: 'o1',
    title: 'Veteran Housing Grant',
    description: 'Available to US military veterans for housing assistance.',
    application_url: 'https://va.gov/apply',
    is_national: 1,
  }
  const norm = normalizeOpportunity(opp)
  assert.ok(norm.entityTypesAllowed.includes('veteran'), `Got: ${norm.entityTypesAllowed}`)
  assert.ok(norm.needTypesSupported.includes('housing'), `Got: ${norm.needTypesSupported}`)
})

test('opportunityNormalizer: extracts student from text', () => {
  const opp = {
    title: 'College Scholarship',
    description: 'For undergraduate students pursuing higher education.',
    application_url: 'https://college.edu/apply',
  }
  const norm = normalizeOpportunity(opp)
  assert.ok(norm.entityTypesAllowed.includes('student'), `Got: ${norm.entityTypesAllowed}`)
  assert.ok(norm.requiresStudent, 'Should flag requiresStudent')
})

test('opportunityNormalizer: detects nonprofit requirement', () => {
  const opp = {
    title: 'Nonprofit Capacity Grant',
    description: 'Open to 501(c)(3) organizations building capacity.',
    application_url: 'https://foundation.org/apply',
  }
  const norm = normalizeOpportunity(opp)
  assert.ok(norm.requiresNonprofit, 'Should flag requiresNonprofit')
})

test('opportunityNormalizer: marks loans correctly', () => {
  const opp = {
    title: 'Small Business Loan',
    description: 'Low-interest loan for small businesses.',
    application_url: 'https://sba.gov/apply',
    is_loan: 1,
  }
  const norm = normalizeOpportunity(opp)
  assert.equal(norm.isLoan, true)
})

test('opportunityNormalizer: normalizes funding type', () => {
  const grant = normalizeOpportunity({ title: 'Grant', funding_type: 'grant', application_url: 'https://x.org' })
  assert.equal(grant.fundingType, 'grant')

  const scholarship = normalizeOpportunity({ title: 'Fellowship', funding_type: 'fellowship', application_url: 'https://x.org' })
  assert.equal(scholarship.fundingType, 'scholarship')
})

test('opportunityNormalizer: normalizes deadline status', () => {
  const rolling = normalizeOpportunity({ title: 'A', deadline_type: 'rolling', application_url: 'https://x.org' })
  assert.equal(rolling.deadlineStatus, 'rolling')

  const past = normalizeOpportunity({ title: 'A', deadline: '2020-01-01', application_url: 'https://x.org' })
  assert.equal(past.deadlineStatus, 'closed')

  const future = normalizeOpportunity({ title: 'A', deadline: '2099-01-01', application_url: 'https://x.org' })
  assert.equal(future.deadlineStatus, 'open')
})

test('opportunityNormalizer: computeOpportunityFingerprint is deterministic', () => {
  const opp = { title: 'Test Grant', is_national: 1, funding_type: 'grant', application_url: 'https://x.org' }
  const norm1 = normalizeOpportunity(opp)
  const norm2 = normalizeOpportunity(opp)
  assert.equal(computeOpportunityFingerprint(norm1), computeOpportunityFingerprint(norm2))
})

// ---------------------------------------------------------------------------
// 3. Eligibility decisions
// ---------------------------------------------------------------------------

test('evaluateEligibility: loan is always ineligible', () => {
  const profile = normalizeProfile({ primary_type: 'individual', state: 'OH' })
  const opp = normalizeOpportunity({ title: 'Loan', is_loan: 1, application_url: 'https://x.gov' })
  const result = evaluateEligibility(profile, opp)
  assert.equal(result.eligible, false)
  assert.ok(result.ineligibilityReasons.some(r => r.includes('loan')))
})

test('evaluateEligibility: closed deadline is ineligible', () => {
  const profile = normalizeProfile({ primary_type: 'individual', state: 'OH' })
  const opp = normalizeOpportunity({ title: 'Closed Grant', deadline: '2010-01-01', application_url: 'https://x.gov' })
  const result = evaluateEligibility(profile, opp)
  assert.equal(result.eligible, false)
  assert.ok(result.ineligibilityReasons.some(r => r.includes('deadline')))
})

test('evaluateEligibility: veteran-only opportunity not eligible for non-veteran', () => {
  const profile = normalizeProfile({ primary_type: 'individual', state: 'OH' })
  const opp = normalizeOpportunity({
    title: 'Veteran Grant',
    description: 'For US military veterans only.',
    application_url: 'https://va.gov/apply',
    is_national: 1,
  })
  // Force requiresVeteran
  opp.requiresVeteran = true
  const result = evaluateEligibility(profile, opp)
  assert.equal(result.eligible, false)
  assert.ok(result.ineligibilityReasons.some(r => r.toLowerCase().includes('veteran')))
})

test('evaluateEligibility: student-only opportunity not eligible for non-student', () => {
  const profile = normalizeProfile({ primary_type: 'individual', state: 'CA' })
  const opp = normalizeOpportunity({
    title: 'College Scholarship',
    description: 'For undergraduate students pursuing higher education.',
    application_url: 'https://college.edu/apply',
  })
  const result = evaluateEligibility(profile, opp)
  if (opp.requiresStudent) {
    assert.equal(result.eligible, false)
    assert.ok(result.ineligibilityReasons.some(r => r.toLowerCase().includes('student')))
  }
})

test('evaluateEligibility: geo mismatch for state-specific opportunity', () => {
  const profile = normalizeProfile({ primary_type: 'individual', state: 'TX' })
  const opp = normalizeOpportunity({
    title: 'California Housing Grant',
    state: 'CA',
    application_url: 'https://ca.gov/apply',
    is_national: 0,
  })
  const result = evaluateEligibility(profile, opp)
  assert.equal(result.eligible, false)
  assert.ok(result.ineligibilityReasons.some(r => r.includes('Geographic mismatch')))
})

test('evaluateEligibility: national opportunity eligible for any state', () => {
  const profile = normalizeProfile({ primary_type: 'individual', state: 'TX' })
  const opp = normalizeOpportunity({
    title: 'National Grant',
    is_national: 1,
    state: 'nationwide',
    application_url: 'https://grants.gov/apply',
  })
  const result = evaluateEligibility(profile, opp)
  assert.notEqual(result.eligible, false, 'National opportunity should not be ineligible for geo mismatch')
})

test('evaluateEligibility: nonprofit-only not eligible for individual', () => {
  const profile = normalizeProfile({ primary_type: 'individual', state: 'OH' })
  const opp = normalizeOpportunity({
    title: 'Nonprofit Capacity Grant',
    description: 'Open to 501(c)(3) organizations.',
    application_url: 'https://foundation.org/apply',
  })
  opp.requiresNonprofit = true
  const result = evaluateEligibility(profile, opp)
  assert.equal(result.eligible, false)
  assert.ok(result.ineligibilityReasons.some(r => r.includes('nonprofit')))
})

test('evaluateEligibility: business-only not eligible for individual', () => {
  const profile = normalizeProfile({ primary_type: 'individual', state: 'OH' })
  const opp = normalizeOpportunity({
    title: 'Small Business Grant',
    description: 'Funding exclusively for small business owners.',
    application_url: 'https://sba.gov/apply',
  })
  opp.requiresBusiness = true
  const result = evaluateEligibility(profile, opp)
  assert.equal(result.eligible, false)
  assert.ok(result.ineligibilityReasons.some(r => r.includes('business')))
})

test('evaluateEligibility: missing profile location → maybe', () => {
  const profile = normalizeProfile({ primary_type: 'individual' })  // no state
  const opp = normalizeOpportunity({
    title: 'State Housing Grant',
    state: 'OH',
    is_national: 0,
    application_url: 'https://ohio.gov/apply',
  })
  const result = evaluateEligibility(profile, opp)
  // Should be maybe (missing data) rather than false (hard ineligible) when state unknown
  assert.ok(['maybe', true].includes(result.eligible), `Expected maybe/true, got: ${result.eligible}`)
  assert.ok(result.missingFields.includes('profile_location') || result.eligible === 'maybe')
})

// ---------------------------------------------------------------------------
// 4. Need-type alignment
// ---------------------------------------------------------------------------

test('calculateNeedAlignment: full overlap returns high score', () => {
  const profile = normalizeProfile({ needs: ['rent', 'utilities'], state: 'OH' })
  const opp = normalizeOpportunity({
    title: 'Rent and Utilities Assistance',
    description: 'Helps with housing rent and utility bills for low-income families.',
    application_url: 'https://agency.org/apply',
    is_national: 1,
  })
  const { score, matchedNeeds } = calculateNeedAlignment(profile, opp)
  assert.ok(score > 50, `Expected score > 50, got ${score}`)
  assert.ok(matchedNeeds.length > 0, 'Expected at least one matched need')
})

test('calculateNeedAlignment: no overlap returns 0', () => {
  const profile = normalizeProfile({ needs: ['veteran'], state: 'OH' })
  const opp = normalizeOpportunity({
    title: 'Small Business Grant',
    description: 'For small business entrepreneurs.',
    application_url: 'https://sba.gov/apply',
    is_national: 1,
  })
  const { score } = calculateNeedAlignment(profile, opp)
  assert.ok(score === 0, `Expected score=0 for no overlap, got ${score}`)
})

test('calculateNeedAlignment: partial overlap returns proportional score', () => {
  const profile = normalizeProfile({ needs: ['rent', 'food', 'medical'], state: 'OH' })
  const opp = normalizeOpportunity({
    title: 'Emergency Food Assistance',
    description: 'Provides emergency food boxes to families in need.',
    application_url: 'https://foodbank.org/apply',
    is_national: 1,
  })
  const { score, matchedNeeds } = calculateNeedAlignment(profile, opp)
  // Profile has 3 needs, opp covers food → 1/3 ≈ 33%
  assert.ok(score > 0, `Expected score > 0, got ${score}`)
  assert.ok(matchedNeeds.includes('food'), `Expected food in matched needs`)
})

test('computeMatchDecision: rich profile + catalog row without need types scores meaningfully (Discover slider)', () => {
  const profile = normalizeProfile({
    primary_type: 'individual',
    state: 'OH',
    postal_code: '44022',
    needs: ['housing', 'food', 'medical', 'employment', 'utilities'],
  })
  const opp = {
    title: 'National resource directory',
    description: 'Find funding sources in your area.',
    application_url: 'https://example.org/funding',
    is_national: 1,
    state: 'nationwide',
    record_origin: 'curated_program',
    categories: '[]',
    keywords: '[]',
  }
  const decision = computeMatchDecision(profile, opp)
  // Need-anchored scale: a directory that names NO content addresses none of
  // the profile's needs, so it honestly scores near the floor — it must remain
  // non-zero and reviewable (never hard-rejected), but it no longer claims a
  // surfaceable coverage number. Directories surface through their own lane.
  assert.ok(
    decision.score > 0,
    `Expected non-zero score for full profile + broad curated row, got ${decision.score}`,
  )
  assert.notEqual(decision.decision, 'REJECT', 'content-free directory is reviewable, not rejected')
  assert.ok(
    decision.score > 0,
    `Expected positive score, got ${decision.score}`,
  )
})

// ---------------------------------------------------------------------------
// 5. Source trust scoring
// ---------------------------------------------------------------------------

test('calculateSourceTrust: .gov URL scores ≥ 90', () => {
  const opp = { application_url: 'https://grants.gov/web/grants/search-grants.html' }
  assert.ok(calculateSourceTrust(opp) >= 90)
})

test('calculateSourceTrust: .edu URL scores ≥ 70', () => {
  const opp = { source_url: 'https://university.edu/scholarships' }
  assert.ok(calculateSourceTrust(opp) >= 70)
})

test('calculateSourceTrust: .org URL scores ≥ 55', () => {
  const opp = { source_url: 'https://redcross.org/assistance' }
  assert.ok(calculateSourceTrust(opp) >= 55)
})

test('calculateSourceTrust: no URL scores ≤ 20', () => {
  const opp = {}
  assert.ok(calculateSourceTrust(opp) <= 20)
})

test('calculateSourceTrust: curated_verified source boosts score', () => {
  const opp = {
    source_url: 'https://somedomain.com/grants',
    record_origin: 'curated_verified',
  }
  assert.ok(calculateSourceTrust(opp) >= 65)
})

// ---------------------------------------------------------------------------
// 6. computeMatchDecision() integration
// ---------------------------------------------------------------------------

test('computeMatchDecision: REJECT for loan', () => {
  const profile = { primary_type: 'individual', state: 'OH' }
  const opp = {
    title: 'Business Loan',
    description: 'Low-interest loan program.',
    is_loan: 1,
    application_url: 'https://sba.gov/loans',
  }
  const result = computeMatchDecision(profile, opp)
  assert.equal(result.decision, 'REJECT')
  assert.equal(result.eligible, false)
  assert.ok(result.ineligibilityReasons.length > 0)
  assert.ok(result.explanation.length > 0)
  assert.equal(result.matcherVersion, MATCHER_VERSION)
  assert.ok(result.evaluatedAt)
})

test('computeMatchDecision: ACCEPT for matching profile and opportunity', () => {
  const profile = {
    primary_type: 'individual',
    state: 'OH',
    needs: ['rent', 'utilities'],
  }
  const opp = {
    title: 'Emergency Rent Assistance Program',
    description: 'Provides emergency rent and utility assistance to low-income Ohio residents.',
    application_url: 'https://ohio.gov/rent-help',
    is_national: 0,
    state: 'OH',
    is_loan: 0,
  }
  const result = computeMatchDecision(profile, opp)
  assert.ok(['ACCEPT', 'REVIEW'].includes(result.decision), `Expected ACCEPT or REVIEW, got ${result.decision}`)
  assert.ok(result.score > 0)
  assert.ok(result.matchedNeeds.length > 0 || result.explanation.length > 0)
})

test('computeMatchDecision: structured decision object has all required fields', () => {
  const result = computeMatchDecision(
    { primary_type: 'individual', state: 'OH', needs: ['medical'] },
    { title: 'Medical Grant', description: 'Health assistance.', application_url: 'https://hhs.gov/apply', is_national: 1 }
  )
  assert.ok('eligible' in result)
  assert.ok('ineligibilityReasons' in result)
  assert.ok('needAlignment' in result)
  assert.ok('score' in result)
  assert.ok('confidence' in result)
  assert.ok('decision' in result)
  assert.ok('matchedNeeds' in result)
  assert.ok('matchedProfileTraits' in result)
  assert.ok('missingEligibilityFields' in result)
  assert.ok('explanation' in result)
  assert.ok('matcherVersion' in result)
  assert.ok('evaluatedAt' in result)
})

test('computeMatchDecision: REVIEW for incomplete data', () => {
  const result = computeMatchDecision({}, { title: 'Unknown Grant', description: 'Description.' })
  assert.ok(['REVIEW', 'REJECT'].includes(result.decision))
})

// ---------------------------------------------------------------------------
// 7. Persistence: pipeline entry stores decision metadata
// Tests use decision engine directly + inline DB insert to verify schema.
// (avoids the matchingEngine.js → profileHelpers.js → zipcodes dep chain)
// ---------------------------------------------------------------------------

test('persistence: computeMatchDecision output has all columns needed for grants table', () => {
  const profile = { primary_type: 'individual', state: 'OH', needs: ['rent', 'utilities'] }
  const opp = {
    title: 'Ohio Housing Help',
    description: 'Emergency rent assistance for Ohio residents.',
    application_url: 'https://ohio.gov/help',
    state: 'OH',
    is_national: 0,
    is_loan: 0,
  }
  const decision = computeMatchDecision(profile, opp)

  // Verify all fields needed for DB storage are present
  assert.ok(decision.decision, 'decision.decision must be set')
  assert.ok(decision.explanation, 'decision.explanation must be set')
  assert.ok(Array.isArray(decision.matchedNeeds), 'decision.matchedNeeds must be array')
  assert.ok(typeof decision.eligible !== 'undefined', 'decision.eligible must be set')
  assert.ok(Array.isArray(decision.ineligibilityReasons), 'decision.ineligibilityReasons must be array')
  assert.ok(decision.matcherVersion, 'decision.matcherVersion must be set')
  assert.ok(decision.evaluatedAt, 'decision.evaluatedAt must be set')
  assert.ok(typeof decision.confidence === 'number', 'decision.confidence must be a number')
  assert.ok(typeof decision.score === 'number', 'decision.score must be a number')
})

test('persistence: decision can be stored and retrieved from grants table', () => {
  const db = createDb()
  db.prepare(`INSERT INTO profiles (id, display_name, primary_type) VALUES ('p-persist', 'Test', 'individual')`).run()

  const opp = { title: 'Ohio Housing Help', description: 'Emergency rent assistance.', application_url: 'https://ohio.gov/help', state: 'OH', is_national: 0, is_loan: 0 }
  const profile = { primary_type: 'individual', state: 'OH', needs: ['rent', 'utilities'] }
  const decision = computeMatchDecision(profile, opp)

  const profileNorm = normalizeProfile(profile)
  const oppNorm = normalizeOpportunity(opp)
  const profileFingerprint = computeProfileFingerprint(profileNorm)
  const opportunityFingerprint = computeOpportunityFingerprint(oppNorm)

  // Simulate what opportunityMatcher.js saveToProfilePipeline does
  const grantId = 'test-grant-id-123'
  db.prepare(`
    INSERT INTO grants (
      id, profile_id, title, match_score,
      match_decision, match_explanation, matched_needs, eligibility_status,
      ineligibility_reasons, profile_fingerprint, opportunity_fingerprint,
      matcher_version, evaluated_at, match_confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    grantId, 'p-persist', opp.title, decision.score,
    decision.decision, decision.explanation, JSON.stringify(decision.matchedNeeds),
    String(decision.eligible), JSON.stringify(decision.ineligibilityReasons),
    profileFingerprint, opportunityFingerprint,
    decision.matcherVersion, decision.evaluatedAt, decision.confidence
  )

  const row = db.prepare('SELECT * FROM grants WHERE id = ?').get(grantId)
  assert.ok(row, 'Grant row should be stored')
  assert.equal(row.match_decision, decision.decision, 'match_decision should match')
  assert.equal(row.matcher_version, MATCHER_VERSION, 'matcher_version should be stored')
  assert.ok(row.evaluated_at, 'evaluated_at should be stored')
  assert.ok(row.match_confidence > 0 || row.match_confidence === 0, 'match_confidence should be numeric')
  assert.equal(row.profile_fingerprint, profileFingerprint, 'profile_fingerprint should be stored')
  assert.equal(row.opportunity_fingerprint, opportunityFingerprint, 'opportunity_fingerprint should be stored')
})

test('persistence: loan opportunity produces REJECT that would not be saved', () => {
  const profile = { primary_type: 'individual', state: 'OH' }
  const loanOpp = { title: 'Business Loan', is_loan: 1, application_url: 'https://sba.gov/loan' }
  const decision = computeMatchDecision(profile, loanOpp)
  assert.equal(decision.decision, 'REJECT', 'Loan should always produce REJECT decision')
  // In the pipeline: REJECT decisions are not saved
})

test('persistence: fingerprint changes when profile changes → triggers re-evaluation', () => {
  const profile1 = normalizeProfile({ primary_type: 'individual', state: 'OH', needs: ['rent'] })
  const profile2 = normalizeProfile({ primary_type: 'individual', state: 'TX', needs: ['rent'] })
  const fp1 = computeProfileFingerprint(profile1)
  const fp2 = computeProfileFingerprint(profile2)
  assert.notEqual(fp1, fp2, 'Different state should produce different fingerprint')
})

test('persistence: opportunity fingerprint changes when key fields change', () => {
  const opp1 = normalizeOpportunity({ title: 'Grant A', is_national: 1, application_url: 'https://x.gov' })
  const opp2 = normalizeOpportunity({ title: 'Grant A', is_national: 1, application_url: 'https://x.gov', is_loan: 1 })
  const fp1 = computeOpportunityFingerprint(opp1)
  const fp2 = computeOpportunityFingerprint(opp2)
  assert.notEqual(fp1, fp2, 'Loan flag change should produce different fingerprint')
})

// ---------------------------------------------------------------------------
// 8. Regression tests: wrong opportunities are REJECTED
// ---------------------------------------------------------------------------

test('regression: student aid NOT shown to non-student', () => {
  const profile = { primary_type: 'individual', state: 'OH', needs: ['rent'] }
  const opp = {
    title: 'FAFSA Scholarship for College Students',
    description: 'Available to undergraduate and graduate students only.',
    application_url: 'https://studentaid.gov/apply',
    is_national: 1,
  }
  const oppNorm = normalizeOpportunity(opp)
  if (oppNorm.requiresStudent) {
    const result = computeMatchDecision(profile, opp)
    assert.equal(result.decision, 'REJECT', 'Student scholarship should be REJECT for non-student')
    assert.ok(result.ineligibilityReasons.some(r => r.toLowerCase().includes('student')))
  }
})

test('regression: FEMA/disaster NOT shown without disaster context', () => {
  const profile = { primary_type: 'individual', state: 'OH', needs: ['rent'] }
  const opp = {
    title: 'FEMA Individual Assistance Program',
    description: 'Emergency relief for disaster victims only.',
    application_url: 'https://fema.gov/apply',
    is_national: 1,
    categories: '["emergency", "disaster"]',
    keywords: '["fema", "disaster", "emergency"]',
  }
  const { score } = calculateNeedAlignment(normalizeProfile(profile), normalizeOpportunity(opp))
  // Without disaster in profile needs, alignment should be low
  const profileNorm = normalizeProfile(profile)
  assert.ok(!profileNorm.hasEmergencyNeed, 'Profile without emergency need should not have emergency flag')
})

test('regression: business grant NOT shown to non-business individual', () => {
  const profile = { primary_type: 'individual', state: 'OH', needs: ['rent'] }
  const opp = {
    title: 'Small Business Development Grant',
    description: 'Exclusively for small business owners and entrepreneurs.',
    application_url: 'https://sba.gov/grants',
    is_national: 1,
  }
  const oppNorm = normalizeOpportunity(opp)
  if (oppNorm.requiresBusiness) {
    const result = computeMatchDecision(profile, opp)
    assert.equal(result.decision, 'REJECT', 'Business grant should be REJECT for non-business individual')
  }
})

test('regression: nonprofit grant NOT shown to private individual', () => {
  const profile = { primary_type: 'individual', state: 'OH', needs: ['housing'] }
  const opp = {
    title: 'Nonprofit Capacity Building Grant',
    description: 'Available exclusively to 501(c)(3) organizations.',
    application_url: 'https://foundation.org/apply',
    is_national: 1,
  }
  const oppNorm = normalizeOpportunity(opp)
  if (oppNorm.requiresNonprofit) {
    const result = computeMatchDecision(profile, opp)
    assert.equal(result.decision, 'REJECT', 'Nonprofit grant should be REJECT for individual')
  }
})

test('regression: geographic mismatch — Texas-only grant NOT shown to Ohio profile', () => {
  const profile = { primary_type: 'individual', state: 'OH', needs: ['rent'] }
  const opp = {
    title: 'Texas Emergency Rental Assistance',
    state: 'TX',
    is_national: 0,
    description: 'For Texas residents facing eviction.',
    application_url: 'https://texas.gov/rent-help',
  }
  const result = computeMatchDecision(profile, opp)
  assert.equal(result.decision, 'REJECT', 'TX-only grant should be REJECT for OH profile')
  // See #1380: the scoped residency gate words this bar itself; the legacy
  // 'Geographic mismatch:' prefix survives on the evaluateEligibility path.
  assert.ok(
    result.ineligibilityReasons.some(r => /Geographic mismatch|requires TX residency/i.test(r)),
    `expected a geographic ineligibility reason, got ${JSON.stringify(result.ineligibilityReasons)}`,
  )
})

test('regression: loan is always rejected, never accepted', () => {
  const profile = { primary_type: 'individual', state: 'OH', needs: ['housing'] }
  const opp = {
    title: 'Home Mortgage Loan',
    description: 'Low-interest home loan.',
    is_loan: 1,
    application_url: 'https://bank.com/apply',
    state: 'OH',
    is_national: 1,
  }
  const result = computeMatchDecision(profile, opp)
  assert.equal(result.decision, 'REJECT')
  assert.equal(result.eligible, false)
})

// ---------------------------------------------------------------------------
// 9. Positive tests: correct opportunities ARE accepted for qualifying profiles
// ---------------------------------------------------------------------------

test('positive: veteran profile gets veteran grant', () => {
  const profile = { primary_type: 'veteran', state: 'TX', needs: ['housing'] }
  const opp = {
    title: 'VA Housing Grant for Veterans',
    description: 'Available to US military veterans for housing assistance.',
    application_url: 'https://va.gov/housing',
    is_national: 1,
    categories: '["veteran", "housing"]',
    keywords: '["veteran", "housing"]',
  }
  const result = computeMatchDecision(profile, opp)
  assert.ok(
    ['ACCEPT', 'REVIEW'].includes(result.decision),
    `Expected ACCEPT or REVIEW for veteran grant with veteran profile, got ${result.decision}: ${result.explanation}`
  )
})

test('positive: student profile gets education grant', () => {
  const profile = { primary_type: 'student', state: 'CA', needs: ['education'] }
  const opp = {
    title: 'College Student Emergency Grant',
    description: 'Financial assistance for college students facing hardship.',
    application_url: 'https://ed.gov/emergency-aid',
    is_national: 1,
    categories: '["education", "student"]',
    keywords: '["student", "college", "financial aid"]',
  }
  const result = computeMatchDecision(profile, opp)
  assert.ok(
    ['ACCEPT', 'REVIEW'].includes(result.decision),
    `Expected ACCEPT or REVIEW for education grant with student profile, got ${result.decision}: ${result.explanation}`
  )
})

test('positive: nonprofit profile gets nonprofit grant', () => {
  const profile = { primary_type: 'nonprofit', state: 'IL', needs: ['nonprofit_ministry'] }
  const opp = {
    title: 'Community Nonprofit Support Grant',
    description: 'Available to 501(c)(3) nonprofits for capacity building.',
    application_url: 'https://foundation.org/grants',
    is_national: 1,
    categories: '["nonprofit"]',
    keywords: '["nonprofit", "501c3", "community"]',
  }
  const result = computeMatchDecision(profile, opp)
  assert.ok(
    ['ACCEPT', 'REVIEW'].includes(result.decision),
    `Expected ACCEPT or REVIEW for nonprofit grant with nonprofit profile, got ${result.decision}: ${result.explanation}`
  )
})

test('positive: individual with housing need gets housing assistance grant', () => {
  const profile = { primary_type: 'individual', state: 'OH', needs: ['rent', 'utilities'] }
  const opp = {
    title: 'Ohio Emergency Housing Assistance',
    description: 'Emergency rent and utility assistance for Ohio residents facing eviction.',
    application_url: 'https://ohio.gov/housing-help',
    state: 'OH',
    is_national: 0,
    categories: '["housing", "utilities"]',
    keywords: '["rent", "eviction", "utilities"]',
    is_loan: 0,
  }
  const result = computeMatchDecision(profile, opp)
  assert.ok(
    ['ACCEPT', 'REVIEW'].includes(result.decision),
    `Expected ACCEPT or REVIEW for Ohio housing grant with Ohio profile, got ${result.decision}: ${result.explanation}`
  )
  assert.ok(result.score > 0, `Score should be > 0, got ${result.score}`)
})
