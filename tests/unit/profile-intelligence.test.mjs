/**
 * Profile Intelligence System Tests
 *
 * Tests for Phase 1–6 of the GrantFlow intelligence system:
 * 1. Profile normalization (profileIntelligence/index.js)
 * 2. Needs taxonomy (needsTaxonomy.js)
 * 3. Need inference engine (needsInference.js)
 * 4. Search plan generation (searchPlanGenerator.js)
 * 5. Eligibility filter (eligibilityFilter.js)
 *
 * Required scenario coverage:
 * - Rural church needing building/upkeep support
 * - Volunteer fire department needing gear/training
 * - School needing band equipment
 * - School needing sports equipment
 * - Individual with hardship + disability
 * - Healthcare worker / public servant / veteran cases
 * - Faith-based profile where public grant excludes religious use
 * - Results require working source URLs
 * - Explanations are populated
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProfileIntelligence,
  getProfileNeedsSummary,
  getEligibleEntityTypes,
} from '../../backend/services/profileIntelligence/index.js'

import {
  NEEDS_TAXONOMY,
  TAXONOMY_VERSION,
  getAllNeedCodes,
  getNeedDefinition,
  resolveNeedFromSynonym,
  getNeedsForEntityType,
} from '../../backend/services/profileIntelligence/needsTaxonomy.js'

import {
  inferNeeds,
} from '../../backend/services/profileIntelligence/needsInference.js'

import {
  generateSearchPlans,
  getSearchPlanSummary,
} from '../../backend/services/profileIntelligence/searchPlanGenerator.js'

import {
  filterEligibility,
  shouldHardReject,
} from '../../backend/services/profileIntelligence/eligibilityFilter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides = {}) {
  return {
    id: 'test-profile-1',
    primary_type: 'individual',
    display_name: 'Test Profile',
    state: 'OH',
    city: 'Columbus',
    zip: '43215',
    ...overrides,
  }
}

function makeSections(overrides = {}) {
  return {
    ...overrides,
  }
}

function makeOpportunity(overrides = {}) {
  return {
    id: 'opp-1',
    title: 'Community Development Grant',
    description: 'Grant for community improvement projects.',
    source_url: 'https://example.gov/grant',
    application_url: 'https://example.gov/apply',
    is_national: 1,
    deadline: null,
    opportunity_type: 'grant',
    categories: '[]',
    keywords: '[]',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Needs Taxonomy Tests
// ---------------------------------------------------------------------------

test('needsTaxonomy: TAXONOMY_VERSION is defined', () => {
  assert.ok(typeof TAXONOMY_VERSION === 'string')
  assert.ok(TAXONOMY_VERSION.length > 0)
})

test('needsTaxonomy: getAllNeedCodes returns 35+ codes', () => {
  const codes = getAllNeedCodes()
  assert.ok(Array.isArray(codes))
  assert.ok(codes.length >= 35, `Expected >=35 need codes, got ${codes.length}`)
})

test('needsTaxonomy: each need definition has required fields', () => {
  for (const [code, def] of Object.entries(NEEDS_TAXONOMY)) {
    assert.ok(def.code === code, `Need ${code} has mismatched code field`)
    assert.ok(typeof def.label === 'string', `Need ${code} missing label`)
    assert.ok(typeof def.description === 'string', `Need ${code} missing description`)
    assert.ok(Array.isArray(def.synonyms), `Need ${code} missing synonyms`)
    assert.ok(Array.isArray(def.related_entity_types), `Need ${code} missing related_entity_types`)
    assert.ok(Array.isArray(def.funding_categories), `Need ${code} missing funding_categories`)
    assert.ok(Array.isArray(def.example_search_terms), `Need ${code} missing example_search_terms`)
    assert.ok(typeof def.is_capital === 'boolean', `Need ${code} missing is_capital`)
    assert.ok(typeof def.is_operational === 'boolean', `Need ${code} missing is_operational`)
  }
})

test('needsTaxonomy: resolveNeedFromSynonym — exact code', () => {
  assert.equal(resolveNeedFromSynonym('facilities_repair'), 'facilities_repair')
  assert.equal(resolveNeedFromSynonym('ppe'), 'ppe')
  assert.equal(resolveNeedFromSynonym('scholarships_tuition'), 'scholarships_tuition')
})

test('needsTaxonomy: resolveNeedFromSynonym — synonym text', () => {
  assert.equal(resolveNeedFromSynonym('turnout gear'), 'ppe')
  assert.equal(resolveNeedFromSynonym('fire truck'), 'vehicles')
  assert.equal(resolveNeedFromSynonym('musical instruments'), 'arts_equipment')
  assert.equal(resolveNeedFromSynonym('sports equipment'), 'athletics_equipment')
  assert.equal(resolveNeedFromSynonym('scholarship'), 'scholarships_tuition')
})

test('needsTaxonomy: getNeedsForEntityType — church gets relevant needs', () => {
  const needs = getNeedsForEntityType('church')
  assert.ok(needs.includes('facilities_repair'), 'church should have facilities_repair')
  assert.ok(needs.includes('community_outreach'), 'church should have community_outreach')
  assert.ok(!needs.includes('scholarships_tuition'),
    'church should NOT have scholarships_tuition (disallowed)')
})

test('needsTaxonomy: getNeedsForEntityType — fire_ems gets safety needs', () => {
  const needs = getNeedsForEntityType('fire_ems')
  assert.ok(needs.includes('ppe'))
  assert.ok(needs.includes('vehicles'))
  assert.ok(needs.includes('public_safety_equipment'))
  assert.ok(!needs.includes('scholarships_tuition'))
})

// ---------------------------------------------------------------------------
// Phase 2: Profile Intelligence Builder Tests
// ---------------------------------------------------------------------------

test('buildProfileIntelligence: returns object for minimal profile', () => {
  const profile = makeProfile()
  const intel = buildProfileIntelligence(profile, {})
  assert.ok(intel !== null)
  assert.ok(typeof intel === 'object')
  assert.equal(intel.id, 'test-profile-1')
  assert.ok(typeof intel.entityType === 'string')
  assert.ok(Array.isArray(intel.inferredNeeds))
  assert.ok(intel.eligibilityFlags instanceof Set)
  assert.ok(intel.geographicFlags instanceof Set)
  assert.ok(intel.hardshipFlags instanceof Set)
  assert.ok(typeof intel.fingerprint === 'string')
})

test('buildProfileIntelligence: returns null for null input', () => {
  const result = buildProfileIntelligence(null, {})
  assert.equal(result, null)
})

test('buildProfileIntelligence: detects church entity type', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const intel = buildProfileIntelligence(profile, {})
  assert.equal(intel.entityType, 'church')
  assert.ok(intel.isChurch)
  assert.ok(intel.isNonprofit)
})

test('buildProfileIntelligence: detects fire_ems entity type', () => {
  const profile = makeProfile({ primary_type: 'fire_ems' })
  const intel = buildProfileIntelligence(profile, {})
  assert.equal(intel.entityType, 'fire_ems')
  assert.ok(intel.isFireEms)
})

test('buildProfileIntelligence: detects school entity type', () => {
  const profile = makeProfile({ primary_type: 'school' })
  const intel = buildProfileIntelligence(profile, {})
  assert.equal(intel.entityType, 'school')
  assert.ok(intel.isSchool)
  assert.ok(intel.isNonprofit)
})

test('buildProfileIntelligence: detects veteran from sections', () => {
  const profile = makeProfile({ primary_type: 'individual' })
  const sections = makeSections({
    military_service: { veteran: true },
  })
  const intel = buildProfileIntelligence(profile, sections)
  assert.ok(intel.isVeteran)
  assert.ok(intel.militaryFlags.has('veteran'))
})

test('buildProfileIntelligence: detects student from primary_type', () => {
  const profile = makeProfile({ primary_type: 'student' })
  const intel = buildProfileIntelligence(profile, {})
  assert.ok(intel.isStudent)
})

test('buildProfileIntelligence: detects hardship flags from sections', () => {
  const profile = makeProfile()
  const sections = makeSections({
    financial_situation: {
      financial_hardship: true,
      low_income: true,
    },
  })
  const intel = buildProfileIntelligence(profile, sections)
  assert.ok(intel.hardshipFlags.has('financial_hardship'))
  assert.ok(intel.hardshipFlags.has('low_income'))
})

test('buildProfileIntelligence: detects disability from sections', () => {
  const profile = makeProfile()
  const sections = makeSections({
    health_medical: {
      chronic_illness: true,
      disability: true,
    },
  })
  const intel = buildProfileIntelligence(profile, sections)
  assert.ok(intel.disabilityFlags.has('chronic_illness'))
  assert.ok(intel.disabilityFlags.has('disability'))
})

test('buildProfileIntelligence: extracts story keywords', () => {
  const profile = makeProfile({ story: 'We need a new fire truck for our station' })
  const intel = buildProfileIntelligence(profile, {})
  assert.ok(intel.storyKeywords.length > 0)
  assert.ok(intel.storyKeywords.some(k => k.includes('fire')))
})

test('buildProfileIntelligence: detects 501c3 eligibility flag', () => {
  const profile = makeProfile({ primary_type: 'nonprofit' })
  const sections = makeSections({
    general_qualifications: { is_501c3: true },
  })
  const intel = buildProfileIntelligence(profile, sections)
  assert.ok(intel.eligibilityFlags.has('is_501c3'))
})

test('buildProfileIntelligence: accepts JSON string for sections', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const sections = JSON.stringify({ general_qualifications: { rural: true } })
  const intel = buildProfileIntelligence(profile, sections)
  assert.ok(intel !== null)
  assert.equal(intel.entityType, 'church')
})

test('buildProfileIntelligence: detects rural flag', () => {
  const profile = makeProfile()
  const sections = makeSections({
    general_qualifications: { rural: true },
  })
  const intel = buildProfileIntelligence(profile, sections)
  assert.ok(intel.geographicFlags.has('rural'))
})

// ---------------------------------------------------------------------------
// Phase 3: Need Inference Tests
// ---------------------------------------------------------------------------

// Scenario 1: Rural Church Needing Building Support
test('needsInference: rural church infers facilities_repair', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const sections = makeSections({
    financial_situation: { financial_hardship: true },
    general_qualifications: { rural: true },
  })
  const intel = buildProfileIntelligence(profile, sections)
  const needs = intel.inferredNeeds

  const facilitiesNeed = needs.find(n => n.code === 'facilities_repair')
  assert.ok(facilitiesNeed, 'church should infer facilities_repair')
  assert.ok(['high', 'medium'].includes(facilitiesNeed.confidence))
})

test('needsInference: rural church infers utilities_support', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const intel = buildProfileIntelligence(profile, {})
  const needs = intel.inferredNeeds
  assert.ok(needs.find(n => n.code === 'utilities_support'))
})

test('needsInference: rural church infers community_outreach', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const intel = buildProfileIntelligence(profile, {})
  assert.ok(intel.inferredNeeds.find(n => n.code === 'community_outreach'))
})

test('needsInference: church with explicit roof mention — high confidence repair', () => {
  const profile = makeProfile({
    primary_type: 'church',
    story: 'Our church roof is leaking and needs replacement. We also need HVAC repairs.',
    funding_ask: 'roof replacement and HVAC repair grant',
  })
  const intel = buildProfileIntelligence(profile, {})
  const repair = intel.inferredNeeds.find(n => n.code === 'facilities_repair')
  assert.ok(repair, 'should infer facilities_repair')
  assert.equal(repair.confidence, 'high')
  assert.ok(repair.signals.some(s => /roof|hvac/i.test(s)))
})

test('needsInference: church infers denomination_support', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const intel = buildProfileIntelligence(profile, {})
  assert.ok(intel.inferredNeeds.find(n => n.code === 'denomination_support'))
})

// Scenario 2: Volunteer Fire Department
test('needsInference: volunteer fire dept infers PPE', () => {
  const profile = makeProfile({ primary_type: 'fire_ems' })
  const sections = makeSections({
    organization_details: { volunteer_organization: true },
  })
  const intel = buildProfileIntelligence(profile, sections)
  const ppeNeed = intel.inferredNeeds.find(n => n.code === 'ppe')
  assert.ok(ppeNeed, 'fire_ems should infer ppe')
  assert.equal(ppeNeed.confidence, 'high')
})

test('needsInference: volunteer fire dept infers vehicles', () => {
  const profile = makeProfile({ primary_type: 'fire_ems' })
  const intel = buildProfileIntelligence(profile, {})
  assert.ok(intel.inferredNeeds.find(n => n.code === 'vehicles'))
})

test('needsInference: volunteer fire dept infers public_safety_equipment', () => {
  const profile = makeProfile({ primary_type: 'fire_ems' })
  const intel = buildProfileIntelligence(profile, {})
  assert.ok(intel.inferredNeeds.find(n => n.code === 'public_safety_equipment'))
})

test('needsInference: fire dept with SCBA mention — high confidence PPE', () => {
  const profile = makeProfile({
    primary_type: 'fire_ems',
    story: 'We need new SCBA equipment to replace aging self-contained breathing apparatus.',
  })
  const intel = buildProfileIntelligence(profile, {})
  const ppe = intel.inferredNeeds.find(n => n.code === 'ppe')
  assert.ok(ppe)
  assert.equal(ppe.confidence, 'high')
  assert.ok(ppe.signals.some(s => /scba|breathing/i.test(s)))
})

test('needsInference: fire dept with fire truck mention — high confidence vehicles', () => {
  const profile = makeProfile({
    primary_type: 'fire_ems',
    story: 'We are seeking a grant to replace our 1997 fire engine/pump truck.',
  })
  const intel = buildProfileIntelligence(profile, {})
  const vehicles = intel.inferredNeeds.find(n => n.code === 'vehicles')
  assert.ok(vehicles)
  assert.equal(vehicles.confidence, 'high')
})

// Scenario 3: School Needing Band Equipment
test('needsInference: school with band mention infers arts_equipment', () => {
  const profile = makeProfile({
    primary_type: 'school',
    story: 'Our school band needs new instruments. Many students cannot afford to rent them.',
    funding_ask: 'band instruments and music equipment',
  })
  const intel = buildProfileIntelligence(profile, {})
  const artsNeed = intel.inferredNeeds.find(n => n.code === 'arts_equipment')
  assert.ok(artsNeed, 'school with band mention should infer arts_equipment')
  assert.equal(artsNeed.confidence, 'high')
})

test('needsInference: school with choir mention infers arts_equipment', () => {
  const profile = makeProfile({
    primary_type: 'school',
    story: 'We want to expand our choir program and need choir robes and equipment.',
  })
  const intel = buildProfileIntelligence(profile, {})
  assert.ok(intel.inferredNeeds.find(n => n.code === 'arts_equipment'))
})

// Scenario 4: School Needing Sports Equipment
test('needsInference: school with sports mention infers athletics_equipment', () => {
  const profile = makeProfile({
    primary_type: 'school',
    story: 'Our football team needs new helmets and pads. We also need basketball uniforms.',
    funding_ask: 'sports equipment for football and basketball',
  })
  const intel = buildProfileIntelligence(profile, {})
  const athleticsNeed = intel.inferredNeeds.find(n => n.code === 'athletics_equipment')
  assert.ok(athleticsNeed, 'school with sports mention should infer athletics_equipment')
  assert.equal(athleticsNeed.confidence, 'high')
})

// Scenario 5: Individual with Hardship + Disability
test('needsInference: individual with disability and hardship', () => {
  const profile = makeProfile({ primary_type: 'individual' })
  const sections = makeSections({
    financial_situation: {
      financial_hardship: true,
      low_income: true,
    },
    health_medical: {
      chronic_illness: true,
      disability: true,
    },
    housing: {
      housing_instability: true,
    },
  })
  const intel = buildProfileIntelligence(profile, sections)
  const needs = intel.inferredNeeds.map(n => n.code)

  assert.ok(needs.includes('health_medical_support'), 'should infer health_medical_support for disability')
  assert.ok(needs.includes('housing_support'), 'should infer housing_support')
})

test('needsInference: individual in crisis infers emergency_assistance', () => {
  const profile = makeProfile({ primary_type: 'individual' })
  const sections = makeSections({
    emergency: { has_emergency: true, in_crisis: true },
  })
  const intel = buildProfileIntelligence(profile, sections)
  assert.ok(intel.inferredNeeds.find(n => n.code === 'emergency_assistance'))
})

// Scenario 6: Veteran
test('needsInference: veteran infers health and workforce needs', () => {
  const profile = makeProfile({ primary_type: 'individual' })
  const sections = makeSections({
    military_service: { veteran: true, is_veteran: true },
  })
  const intel = buildProfileIntelligence(profile, sections)
  const needs = intel.inferredNeeds.map(n => n.code)
  assert.ok(needs.includes('health_medical_support'), 'veteran should infer health needs')
  assert.ok(needs.includes('workforce_development'), 'veteran should infer workforce needs')
})

// Scenario 7: Student
test('needsInference: student infers scholarships_tuition', () => {
  const profile = makeProfile({ primary_type: 'student' })
  const intel = buildProfileIntelligence(profile, {})
  const scholarshipNeed = intel.inferredNeeds.find(n => n.code === 'scholarships_tuition')
  assert.ok(scholarshipNeed, 'student should infer scholarships_tuition')
  assert.equal(scholarshipNeed.confidence, 'high')
})

test('needsInference: every inferred need has non-empty signals', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const intel = buildProfileIntelligence(profile, {})
  for (const need of intel.inferredNeeds) {
    assert.ok(Array.isArray(need.signals) && need.signals.length > 0,
      `Need ${need.code} should have non-empty signals`)
  }
})

test('needsInference: every inferred need has source_fields', () => {
  const profile = makeProfile({ primary_type: 'fire_ems' })
  const intel = buildProfileIntelligence(profile, {})
  for (const need of intel.inferredNeeds) {
    assert.ok(Array.isArray(need.source_fields) && need.source_fields.length > 0,
      `Need ${need.code} should have source_fields`)
  }
})

test('needsInference: explicit funding_ask overrides with high confidence', () => {
  const profile = makeProfile({
    primary_type: 'nonprofit',
    funding_ask: 'We need scholarships for our students',
  })
  const intel = buildProfileIntelligence(profile, {})
  const scholarshipNeed = intel.inferredNeeds.find(n => n.code === 'scholarships_tuition')
  assert.ok(scholarshipNeed)
  assert.equal(scholarshipNeed.confidence, 'high')
  assert.ok(scholarshipNeed.weight >= 0.9)
})

// ---------------------------------------------------------------------------
// Phase 4: Search Plan Generator Tests
// ---------------------------------------------------------------------------

test('searchPlanGenerator: generates plans for church profile', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const intel = buildProfileIntelligence(profile, {})
  const plans = generateSearchPlans(intel)

  assert.ok(Array.isArray(plans))
  assert.ok(plans.length > 0, 'church should have search plans')

  // Each plan has required fields
  for (const plan of plans) {
    assert.ok(typeof plan.need_code === 'string')
    assert.ok(typeof plan.need_label === 'string')
    assert.ok(typeof plan.search_lane === 'string')
    assert.ok(Array.isArray(plan.search_terms))
    assert.ok(plan.search_terms.length > 0)
    assert.ok(typeof plan.priority === 'number')
    assert.ok(plan.priority >= 0 && plan.priority <= 100)
    assert.ok(Array.isArray(plan.why))
    assert.ok(plan.why.length > 0)
  }
})

test('searchPlanGenerator: fire dept has high-priority PPE plans', () => {
  const profile = makeProfile({ primary_type: 'fire_ems' })
  const intel = buildProfileIntelligence(profile, {})
  const plans = generateSearchPlans(intel)

  const ppePlans = plans.filter(p => p.need_code === 'ppe')
  assert.ok(ppePlans.length > 0, 'fire dept should have PPE search plans')

  const highPriorityPpe = ppePlans.find(p => p.priority >= 70)
  assert.ok(highPriorityPpe, 'PPE plan should be high priority for fire dept')
})

test('searchPlanGenerator: student has scholarship search plans', () => {
  const profile = makeProfile({ primary_type: 'student' })
  const intel = buildProfileIntelligence(profile, {})
  const plans = generateSearchPlans(intel)

  const scholarshipPlans = plans.filter(p => p.need_code === 'scholarships_tuition')
  assert.ok(scholarshipPlans.length > 0, 'student should have scholarship search plans')
})

test('searchPlanGenerator: includes geography in plans when state is set', () => {
  const profile = makeProfile({ primary_type: 'church', state: 'OH' })
  const intel = buildProfileIntelligence(profile, {})
  const plans = generateSearchPlans(intel)

  const statePlan = plans.find(p =>
    p.geography_terms.some(t => t.includes('OH')))
  assert.ok(statePlan, 'plans should include state geography term')
})

test('searchPlanGenerator: respects maxPlans option', () => {
  const profile = makeProfile({ primary_type: 'nonprofit' })
  const intel = buildProfileIntelligence(profile, {})
  const plans = generateSearchPlans(intel, { maxPlans: 5 })
  assert.ok(plans.length <= 5)
})

test('searchPlanGenerator: no duplicate need+lane+funding combinations', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const intel = buildProfileIntelligence(profile, {})
  const plans = generateSearchPlans(intel)

  const keys = new Set()
  for (const plan of plans) {
    const key = `${plan.need_code}:${plan.search_lane}:${plan.expected_funding}`
    assert.ok(!keys.has(key), `Duplicate plan key: ${key}`)
    keys.add(key)
  }
})

test('searchPlanGenerator: returns empty array for null intel', () => {
  const plans = generateSearchPlans(null)
  assert.deepEqual(plans, [])
})

test('searchPlanSummary: returns human-readable summary', () => {
  const profile = makeProfile({ primary_type: 'fire_ems' })
  const intel = buildProfileIntelligence(profile, {})
  const plans = generateSearchPlans(intel)
  const summary = getSearchPlanSummary(plans)

  assert.ok(Array.isArray(summary))
  if (summary.length > 0) {
    assert.ok(typeof summary[0].need === 'string')
    assert.ok(typeof summary[0].lane === 'string')
    assert.ok(typeof summary[0].terms === 'string')
  }
})

// ---------------------------------------------------------------------------
// Phase 5: Eligibility Filter Tests
// ---------------------------------------------------------------------------

test('eligibilityFilter: eligible for matching national grant', () => {
  const profile = makeProfile({ primary_type: 'nonprofit', state: 'OH' })
  const sections = makeSections({
    general_qualifications: { is_501c3: true },
  })
  const intel = buildProfileIntelligence(profile, sections)

  const opportunity = makeOpportunity({
    is_national: 1,
    source_url: 'https://hud.gov/grant',
    opportunity_type: 'grant',
  })

  const result = filterEligibility(intel, opportunity)
  assert.ok(['eligible', 'probably_eligible'].includes(result.verdict),
    `Expected eligible/probably_eligible, got ${result.verdict}`)
  assert.ok(result.hard_failures.length === 0,
    `Expected no hard failures, got: ${result.hard_failures.join(', ')}`)
})

test('eligibilityFilter: rejects expired opportunity', () => {
  const intel = buildProfileIntelligence(makeProfile(), {})
  const opportunity = makeOpportunity({
    deadline: '2020-01-01',
    deadline_type: 'firm',
    source_url: 'https://example.gov',
  })

  const result = filterEligibility(intel, opportunity)
  assert.ok(result.hard_failures.includes('deadline_expired'))
  assert.ok(['ineligible', 'probably_ineligible'].includes(result.verdict))
})

test('eligibilityFilter: rejects opportunity with no source URL', () => {
  const intel = buildProfileIntelligence(makeProfile(), {})
  const opportunity = makeOpportunity({
    source_url: '',
    application_url: '',
    apply_url: '',
    url: '',
  })

  const result = filterEligibility(intel, opportunity)
  assert.ok(result.hard_failures.includes('no_source_url'))
})

test('eligibilityFilter: rejects veteran-only for non-veteran', () => {
  const intel = buildProfileIntelligence(makeProfile({ primary_type: 'individual' }), {})
  assert.ok(!intel.isVeteran)

  const opportunity = makeOpportunity({
    requires_veteran: true,
    source_url: 'https://va.gov/grant',
    description: 'This grant is for veterans only.',
  })

  const result = filterEligibility(intel, opportunity)
  assert.ok(result.hard_failures.includes('requires_veteran'))
})

test('eligibilityFilter: accepts veteran-only for veteran', () => {
  const profile = makeProfile({ primary_type: 'individual' })
  const sections = makeSections({ military_service: { veteran: true } })
  const intel = buildProfileIntelligence(profile, sections)
  assert.ok(intel.isVeteran)

  const opportunity = makeOpportunity({
    requires_veteran: true,
    source_url: 'https://va.gov/grant',
  })

  const result = filterEligibility(intel, opportunity)
  assert.ok(!result.hard_failures.includes('requires_veteran'),
    'veteran should not be blocked from veteran-only grant')
})

test('eligibilityFilter: rejects student-only for non-student', () => {
  const intel = buildProfileIntelligence(makeProfile({ primary_type: 'individual' }), {})
  assert.ok(!intel.isStudent)

  const opportunity = makeOpportunity({
    requires_student: true,
    source_url: 'https://ed.gov/grant',
  })

  const result = filterEligibility(intel, opportunity)
  assert.ok(result.hard_failures.includes('requires_student'))
})

test('eligibilityFilter: rejects geographic mismatch', () => {
  const intel = buildProfileIntelligence(makeProfile({ state: 'OH' }), {})

  const opportunity = makeOpportunity({
    is_national: 0,
    state: 'CA',
    source_url: 'https://california.gov/grant',
  })

  const result = filterEligibility(intel, opportunity)
  assert.ok(result.hard_failures.includes('geographic_mismatch'))
})

test('eligibilityFilter: accepts national grant for any state', () => {
  const intel = buildProfileIntelligence(makeProfile({ state: 'MT' }), {})

  const opportunity = makeOpportunity({
    is_national: 1,
    source_url: 'https://grants.gov/program',
  })

  const result = filterEligibility(intel, opportunity)
  assert.ok(!result.hard_failures.includes('geographic_mismatch'))
})

// Scenario: Faith-based profile where public grant excludes religious use
test('eligibilityFilter: rejects faith-based church from secular-only grant', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const intel = buildProfileIntelligence(profile, {})
  assert.ok(intel.isChurch)

  const opportunity = makeOpportunity({
    source_url: 'https://state.gov/grant',
    description: 'This grant must not be used by religious organizations. Secular only.',
  })

  const result = filterEligibility(intel, opportunity)
  assert.ok(result.hard_failures.includes('faith_based_exclusion'),
    'church should be blocked from secular-only grant')
})

test('eligibilityFilter: church not blocked from faith-neutral grant', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const intel = buildProfileIntelligence(profile, {})

  const opportunity = makeOpportunity({
    source_url: 'https://hud.gov/community-development',
    description: 'Community development grant for eligible nonprofits.',
  })

  const result = filterEligibility(intel, opportunity)
  assert.ok(!result.hard_failures.includes('faith_based_exclusion'),
    'church should not be blocked from faith-neutral grant')
})

test('eligibilityFilter: rejects loan as not a grant', () => {
  const intel = buildProfileIntelligence(makeProfile(), {})
  const opportunity = makeOpportunity({
    is_loan: true,
    source_url: 'https://sba.gov/loans',
  })

  const result = filterEligibility(intel, opportunity)
  assert.ok(result.hard_failures.includes('is_loan'))
})

test('eligibilityFilter: result always has required fields', () => {
  const intel = buildProfileIntelligence(makeProfile(), {})
  const opportunity = makeOpportunity()
  const result = filterEligibility(intel, opportunity)

  assert.ok(typeof result.verdict === 'string')
  assert.ok(typeof result.score === 'number')
  assert.ok(Array.isArray(result.reasons))
  assert.ok(Array.isArray(result.hard_failures))
  assert.ok(Array.isArray(result.soft_warnings))
  assert.ok(Array.isArray(result.matched_needs))
  assert.ok(Array.isArray(result.unmet_requirements))
})

test('eligibilityFilter: shouldHardReject returns boolean', () => {
  const intel = buildProfileIntelligence(makeProfile(), {})
  const goodOpp = makeOpportunity({ source_url: 'https://example.gov' })
  const expiredOpp = makeOpportunity({ deadline: '2020-01-01', source_url: 'https://x.gov' })

  assert.equal(typeof shouldHardReject(intel, goodOpp), 'boolean')
  assert.ok(shouldHardReject(intel, expiredOpp))
})

// Source URL requirement tests
test('eligibilityFilter: URL validation — HTTPS is valid', () => {
  const intel = buildProfileIntelligence(makeProfile(), {})
  const opp = makeOpportunity({ source_url: 'https://grants.gov/opportunity/123' })
  const result = filterEligibility(intel, opp)
  assert.ok(!result.hard_failures.includes('no_source_url'))
})

test('eligibilityFilter: URL validation — empty string is invalid', () => {
  const intel = buildProfileIntelligence(makeProfile(), {})
  const opp = makeOpportunity({ source_url: '   ', application_url: '' })
  const result = filterEligibility(intel, opp)
  assert.ok(result.hard_failures.includes('no_source_url'),
    'opportunity with blank URL should fail source_url check')
})

// ---------------------------------------------------------------------------
// Integration: Profile Needs Summary
// ---------------------------------------------------------------------------

test('getProfileNeedsSummary: returns human-readable items', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const intel = buildProfileIntelligence(profile, {})
  const summary = getProfileNeedsSummary(intel)

  assert.ok(Array.isArray(summary))
  assert.ok(summary.length > 0)

  for (const item of summary) {
    assert.ok(typeof item.code === 'string')
    assert.ok(typeof item.label === 'string')
    assert.ok(typeof item.confidence === 'string')
    assert.ok(typeof item.why === 'string')
    assert.ok(item.why.length > 0, `Item ${item.code} should have non-empty why`)
  }
})

test('getProfileNeedsSummary: excludes low-confidence needs', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const intel = buildProfileIntelligence(profile, {})
  const summary = getProfileNeedsSummary(intel)

  for (const item of summary) {
    assert.notEqual(item.confidence, 'low',
      `Low confidence need ${item.code} should be excluded from summary`)
  }
})

test('getEligibleEntityTypes: returns array with profile type', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const intel = buildProfileIntelligence(profile, {})
  const types = getEligibleEntityTypes(intel)

  assert.ok(Array.isArray(types))
  assert.ok(types.includes('church'))
  assert.ok(types.includes('nonprofit'))
})

// ---------------------------------------------------------------------------
// Regression: Bad match prevention
// ---------------------------------------------------------------------------

test('regression: individual should not get fire dept PPE need inferred', () => {
  const profile = makeProfile({ primary_type: 'individual' })
  const intel = buildProfileIntelligence(profile, {})
  const needs = intel.inferredNeeds.map(n => n.code)

  assert.ok(!needs.includes('ppe'),
    'individual profile should not have PPE inferred')
  assert.ok(!needs.includes('vehicles'),
    'individual profile should not have vehicles inferred')
  assert.ok(!needs.includes('public_safety_equipment'),
    'individual profile should not have public_safety_equipment inferred')
})

test('regression: student should not get fire dept equipment needs', () => {
  const profile = makeProfile({ primary_type: 'student' })
  const intel = buildProfileIntelligence(profile, {})
  const needs = intel.inferredNeeds.map(n => n.code)

  assert.ok(!needs.includes('ppe'))
  assert.ok(!needs.includes('vehicles'))
})

test('regression: church should not infer scholarships_tuition by default', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const intel = buildProfileIntelligence(profile, {})
  const needs = intel.inferredNeeds.map(n => n.code)

  // Church should not get scholarships by default (disallowed entity type)
  // Unless explicit funding_ask mentions it
  assert.ok(!needs.includes('scholarships_tuition'),
    'church should not infer scholarships_tuition by default')
})

test('regression: fire dept should not infer scholarships_tuition', () => {
  const profile = makeProfile({ primary_type: 'fire_ems' })
  const intel = buildProfileIntelligence(profile, {})
  const needs = intel.inferredNeeds.map(n => n.code)

  assert.ok(!needs.includes('scholarships_tuition'),
    'fire_ems should not infer scholarships_tuition (disallowed entity type)')
})

// ---------------------------------------------------------------------------
// Fingerprint stability tests
// ---------------------------------------------------------------------------

test('buildProfileIntelligence: same profile produces same fingerprint', () => {
  const profile = makeProfile({ primary_type: 'church' })
  const sections = makeSections({ general_qualifications: { rural: true } })

  const intel1 = buildProfileIntelligence(profile, sections)
  const intel2 = buildProfileIntelligence(profile, sections)

  assert.equal(intel1.fingerprint, intel2.fingerprint)
})

test('buildProfileIntelligence: different entity type produces different fingerprint', () => {
  const sections = {}
  const churchIntel = buildProfileIntelligence(makeProfile({ primary_type: 'church' }), sections)
  const fireIntel = buildProfileIntelligence(makeProfile({ primary_type: 'fire_ems' }), sections)

  assert.notEqual(churchIntel.fingerprint, fireIntel.fingerprint)
})

// ---------------------------------------------------------------------------
// Phase 7: Relevance Scorer Tests
// ---------------------------------------------------------------------------

import {
  scoreOpportunity,
} from '../../backend/services/profileIntelligence/relevanceScorer.js'

test('relevanceScorer: scores a relevant opportunity for church', async () => {
  const profile = makeProfile({ primary_type: 'church', state: 'OH' })
  const intel = buildProfileIntelligence(profile, {})

  const opportunity = makeOpportunity({
    title: 'Church Building Repair and Renovation Grant',
    description: 'Grants for church facility repair and renovation projects.',
    source_url: 'https://hud.gov/community-grant',
    is_national: 1,
  })

  const result = scoreOpportunity(intel, opportunity)

  assert.ok(typeof result.total_score === 'number')
  assert.ok(result.total_score >= 0 && result.total_score <= 100)
  assert.ok(typeof result.verdict === 'string')
  assert.ok(Array.isArray(result.why_matched))
  assert.ok(Array.isArray(result.why_may_not_fit))
  assert.ok(Array.isArray(result.verification_guidance))
  assert.ok(result.verification_guidance.length > 0, 'should have verification guidance')
})

test('relevanceScorer: rejects expired opportunity', async () => {
  const intel = buildProfileIntelligence(makeProfile(), {})

  const opportunity = makeOpportunity({
    deadline: '2020-01-01',
    deadline_type: 'firm',
    source_url: 'https://example.gov',
  })

  const result = scoreOpportunity(intel, opportunity)
  assert.equal(result.verdict, 'REJECT')
  assert.equal(result.total_score, 0)
})

test('relevanceScorer: returns REJECT for null inputs', () => {
  const result = scoreOpportunity(null, null)
  assert.equal(result.verdict, 'REJECT')
})

test('relevanceScorer: dimensions are all present and in 0-100 range', () => {
  const intel = buildProfileIntelligence(makeProfile({ primary_type: 'fire_ems' }), {})
  const opportunity = makeOpportunity({
    source_url: 'https://afg.gov',
    title: 'Assistance to Firefighters Grant',
    description: 'Equipment and training grants for fire departments.',
    is_national: 1,
  })

  const result = scoreOpportunity(intel, opportunity)
  const expectedDims = ['eligibility', 'need_fit', 'entity_fit', 'geography_fit',
    'source_quality', 'practicality']

  for (const dim of expectedDims) {
    assert.ok(dim in result.dimensions, `Missing dimension: ${dim}`)
    assert.ok(result.dimensions[dim] >= 0 && result.dimensions[dim] <= 100,
      `Dimension ${dim} out of range: ${result.dimensions[dim]}`)
  }
})

test('relevanceScorer: higher score for better matched opportunity', () => {
  const profile = makeProfile({ primary_type: 'fire_ems', state: 'OH' })
  const intel = buildProfileIntelligence(profile, {})

  const goodOpp = makeOpportunity({
    title: 'Assistance to Firefighters Grant — Equipment',
    description: 'AFG grants for fire department PPE, turnout gear, and fire apparatus.',
    source_url: 'https://afg.fema.gov/opportunity',
    is_national: 1,
  })

  const badOpp = makeOpportunity({
    title: 'College Scholarship Program',
    description: 'Scholarship for undergraduate students in STEM fields.',
    source_url: 'https://foundation.org/scholarship',
    is_national: 1,
  })

  const goodResult = scoreOpportunity(intel, goodOpp)
  const badResult = scoreOpportunity(intel, badOpp)

  assert.ok(goodResult.total_score > badResult.total_score,
    `Good opp (${goodResult.total_score}) should score higher than bad opp (${badResult.total_score})`)
})

test('relevanceScorer: verification guidance is always populated', () => {
  const intel = buildProfileIntelligence(makeProfile({ primary_type: 'church' }), {})
  const opp = makeOpportunity({ source_url: 'https://grants.gov/church' })
  const result = scoreOpportunity(intel, opp)

  assert.ok(result.verification_guidance.length > 0,
    'verification_guidance should never be empty')
})

// ---------------------------------------------------------------------------
// Phase 9: Feedback Loop Tests
// ---------------------------------------------------------------------------

import {
  FEEDBACK_ACTIONS,
  validateFeedback,
  createFeedbackRecord,
  analyzeFeedback,
  applyFeedbackToScore,
} from '../../backend/services/profileIntelligence/feedbackLoop.js'

test('feedbackLoop: validateFeedback — valid record', () => {
  const result = validateFeedback({
    profile_id: 'p1',
    opportunity_id: 'o1',
    action: FEEDBACK_ACTIONS.SAVED,
  })
  assert.ok(result.valid)
  assert.ok(!result.error)
})

test('feedbackLoop: validateFeedback — missing profile_id', () => {
  const result = validateFeedback({
    opportunity_id: 'o1',
    action: FEEDBACK_ACTIONS.SAVED,
  })
  assert.ok(!result.valid)
  assert.ok(result.error)
})

test('feedbackLoop: validateFeedback — invalid action', () => {
  const result = validateFeedback({
    profile_id: 'p1',
    opportunity_id: 'o1',
    action: 'invalid_action',
  })
  assert.ok(!result.valid)
})

test('feedbackLoop: createFeedbackRecord normalizes input', () => {
  const record = createFeedbackRecord({
    profile_id: 'p1',
    opportunity_id: 'o1',
    action: FEEDBACK_ACTIONS.APPLIED,
    need_code: 'ppe',
    score_at_feedback: 85,
  })

  assert.equal(record.profile_id, 'p1')
  assert.equal(record.opportunity_id, 'o1')
  assert.equal(record.action, FEEDBACK_ACTIONS.APPLIED)
  assert.equal(record.need_code, 'ppe')
  assert.equal(record.score_at_feedback, 85)
  assert.ok(typeof record.created_at === 'string')
})

test('feedbackLoop: analyzeFeedback blocks broken links', () => {
  const records = [
    { profile_id: 'p1', opportunity_id: 'o1', action: FEEDBACK_ACTIONS.LINK_BROKEN, need_code: null },
    { profile_id: 'p1', opportunity_id: 'o2', action: FEEDBACK_ACTIONS.NOT_ACTUALLY_ELIGIBLE, need_code: null },
    { profile_id: 'p1', opportunity_id: 'o3', action: FEEDBACK_ACTIONS.SAVED, need_code: 'ppe' },
  ]

  const signals = analyzeFeedback(records)
  assert.ok(signals.blocked_opportunities.includes('o1'))
  assert.ok(signals.blocked_opportunities.includes('o2'))
  assert.ok(!signals.blocked_opportunities.includes('o3'))
})

test('feedbackLoop: analyzeFeedback boosts repeatedly saved needs', () => {
  const records = [
    { profile_id: 'p1', opportunity_id: 'o1', action: FEEDBACK_ACTIONS.SAVED, need_code: 'ppe' },
    { profile_id: 'p1', opportunity_id: 'o2', action: FEEDBACK_ACTIONS.APPLIED, need_code: 'ppe' },
    { profile_id: 'p1', opportunity_id: 'o3', action: FEEDBACK_ACTIONS.SAVED, need_code: 'vehicles' },
    { profile_id: 'p1', opportunity_id: 'o4', action: FEEDBACK_ACTIONS.DISMISSED, need_code: 'housing_support' },
  ]

  const signals = analyzeFeedback(records)
  assert.ok(signals.boosted_needs.includes('ppe'), 'ppe should be boosted (2 positive signals)')
  assert.ok(!signals.boosted_needs.includes('vehicles'), 'vehicles only 1 positive, not boosted')
})

test('feedbackLoop: applyFeedbackToScore hard-blocks blocked opportunity', () => {
  const scoreResult = {
    total_score: 80,
    verdict: 'STRONG_MATCH',
    matched_needs: ['ppe'],
    why_may_not_fit: [],
    why_matched: ['Great match'],
    verification_guidance: ['Check URL'],
    dimensions: {},
    confidence: 85,
  }

  const signals = {
    blocked_opportunities: ['opp-blocked'],
    boosted_needs: [],
    downweighted_needs: [],
    summary: { positive: 0, negative: 1, total: 1 },
  }

  const adjusted = applyFeedbackToScore(scoreResult, signals, 'opp-blocked')
  assert.equal(adjusted.verdict, 'REJECT')
  assert.equal(adjusted.total_score, 0)
})

test('feedbackLoop: analyzeFeedback with empty input returns safe defaults', () => {
  const signals = analyzeFeedback([])
  assert.deepEqual(signals.blocked_opportunities, [])
  assert.deepEqual(signals.boosted_needs, [])
  assert.equal(signals.summary.total, 0)
})
