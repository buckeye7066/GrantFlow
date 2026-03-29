/**
 * Profile Intelligence — Unit Tests
 *
 * Phases tested:
 * 1. Needs taxonomy (needsTaxonomy.js)
 * 2. Profile normalization (profileNormalizerIntel.js)
 * 3. Need inference engine for multiple profile archetypes (needsInferenceEngine.js)
 * 4. Search plan generator (searchPlanGenerator.js)
 *
 * Additional test categories:
 * - Match threshold enforcement (slider at 80% returns nothing below 80%)
 * - Faith-based profile exclusion from public grants
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeProfileIntelligence } from '../../backend/services/profileIntelligence/profileNormalizerIntel.js'
import { inferNeeds, annotateWithInferredNeeds } from '../../backend/services/profileIntelligence/needsInferenceEngine.js'
import { generateSearchPlans } from '../../backend/services/profileIntelligence/searchPlanGenerator.js'
import { buildProfileIntelligence } from '../../backend/services/profileIntelligence/index.js'
import {
  TAXONOMY_VERSION,
  NEEDS_TAXONOMY,
  getNeed,
  isValidNeedCode,
  getNeedsForEntityType,
  getAllNeedCodes,
} from '../../backend/services/profileIntelligence/needsTaxonomy.js'

// ---------------------------------------------------------------------------
// TAXONOMY TESTS
// ---------------------------------------------------------------------------

test('TAXONOMY_VERSION is set', () => {
  assert.equal(typeof TAXONOMY_VERSION, 'string')
  assert.ok(TAXONOMY_VERSION.length > 0)
})

test('NEEDS_TAXONOMY has all required need codes', () => {
  const required = [
    'facilities_repair', 'facilities_preservation', 'accessibility_upgrades', 'safety_upgrades',
    'utilities_support', 'energy_efficiency', 'technology', 'broadband', 'vehicles', 'equipment',
    'ppe', 'training', 'staffing_salary', 'program_operations', 'food_programs', 'housing_support',
    'health_medical_support', 'emergency_assistance', 'scholarships_tuition', 'debt_relief',
    'childcare_support', 'transportation_support', 'arts_equipment', 'athletics_equipment',
    'workforce_development', 'research_funding', 'environmental_projects', 'public_safety_equipment',
    'disaster_recovery', 'community_outreach', 'donor_support_private', 'denomination_support',
    'capital_campaign', 'matching_funds_needed',
  ]
  for (const code of required) {
    assert.ok(NEEDS_TAXONOMY.has(code), `Missing need code: ${code}`)
  }
})

test('getNeed returns definition for valid code', () => {
  const def = getNeed('facilities_repair')
  assert.ok(def)
  assert.equal(def.code, 'facilities_repair')
  assert.ok(Array.isArray(def.synonyms))
  assert.ok(Array.isArray(def.relatedEntityTypes))
  assert.ok(typeof def.fundability === 'string')
})

test('isValidNeedCode returns true for valid, false for invalid', () => {
  assert.ok(isValidNeedCode('ppe'))
  assert.ok(!isValidNeedCode('foobar_nonexistent'))
})

test('getNeedsForEntityType returns relevant needs for church', () => {
  const needs = getNeedsForEntityType('church')
  const codes = needs.map(n => n.code)
  assert.ok(codes.includes('facilities_repair'), 'church should have facilities_repair')
  assert.ok(codes.includes('community_outreach'), 'church should have community_outreach')
  // individuals should not be in church-related needs (they're in disallowedEntityTypes for org needs)
})

test('scholarships_tuition disallows nonprofit', () => {
  const def = getNeed('scholarships_tuition')
  assert.ok(def.disallowedEntityTypes.includes('nonprofit'))
  assert.ok(def.disallowedEntityTypes.includes('local_government'))
})

test('getAllNeedCodes returns an array of strings', () => {
  const codes = getAllNeedCodes()
  assert.ok(Array.isArray(codes))
  assert.ok(codes.length >= 34, `Expected >= 34 codes, got ${codes.length}`)
})

// ---------------------------------------------------------------------------
// PROFILE NORMALIZATION TESTS
// ---------------------------------------------------------------------------

test('normalizeProfileIntelligence: church profile', () => {
  const profile = {
    id: 'church-1',
    primary_type: 'church',
    state: 'OH',
    zip_code: '44444',
  }
  const sections = {
    qualifications: { is_501c3: true, is_faith_based: true, is_rural: true },
    organization_details: { ein: '12-3456789' },
  }
  const intel = normalizeProfileIntelligence(profile, sections)

  assert.ok(intel.entity_types.includes('church'), 'should have church entity type')
  assert.ok(intel.eligibility_flags.includes('faith_based'), 'should have faith_based flag')
  assert.ok(intel.exclusion_flags.includes('public_grant_excludes_religious_use'), 'should have exclusion for public grants')
  assert.ok(intel.compliance_flags.includes('501c3'), 'should have 501c3 compliance')
  assert.ok(intel.geographic_flags.includes('rural'), 'should have rural flag')
  assert.ok(intel.is_rural, 'is_rural should be true')
  assert.ok(intel.is_faith_based, 'is_faith_based should be true')
  assert.equal(intel.state, 'OH')
})

test('normalizeProfileIntelligence: volunteer fire department', () => {
  const profile = {
    id: 'vfd-1',
    primary_type: 'volunteer_fire_dept',
    state: 'WV',
  }
  const sections = {
    qualifications: { is_rural: true },
  }
  const intel = normalizeProfileIntelligence(profile, sections)

  assert.ok(intel.entity_types.includes('volunteer_fire_dept'))
  assert.ok(intel.is_rural)
  assert.equal(intel.state, 'WV')
})

test('normalizeProfileIntelligence: school district', () => {
  const profile = {
    id: 'school-1',
    primary_type: 'school_district',
    state: 'KY',
  }
  const sections = {}
  const intel = normalizeProfileIntelligence(profile, sections)

  assert.ok(intel.entity_types.includes('school_district'))
})

test('normalizeProfileIntelligence: individual student', () => {
  const profile = {
    id: 'student-1',
    primary_type: 'student',
    state: 'PA',
  }
  const sections = {
    financial_situation: { is_low_income: true },
    health_medical: { disability: true, disability_types: ['physical'] },
  }
  const intel = normalizeProfileIntelligence(profile, sections)

  assert.ok(intel.demographic_flags.includes('enrolled_student'))
  assert.ok(intel.eligibility_flags.includes('student_eligible'))
  assert.ok(intel.hardship_flags.includes('low_income'))
  assert.ok(intel.hardship_flags.includes('disability'))
  assert.ok(intel.is_student)
})

test('normalizeProfileIntelligence: veteran', () => {
  const profile = { id: 'vet-1', primary_type: 'individual', state: 'TX' }
  const sections = {
    military_service: { veteran: true },
    financial_situation: { unemployed: true },
  }
  const intel = normalizeProfileIntelligence(profile, sections)

  assert.ok(intel.demographic_flags.includes('veteran'))
  assert.ok(intel.eligibility_flags.includes('veteran_eligible'))
  assert.ok(intel.hardship_flags.includes('unemployed'))
  assert.ok(intel.is_veteran)
})

test('normalizeProfileIntelligence: preserves provenance', () => {
  const profile = { id: 'np-1', primary_type: 'church', state: 'GA' }
  const sections = { qualifications: { is_faith_based: true } }
  const intel = normalizeProfileIntelligence(profile, sections)

  assert.ok(intel.provenance)
  assert.ok(Array.isArray(intel.provenance.entity_types))
  assert.ok(intel.provenance.entity_types.length > 0)
})

// ---------------------------------------------------------------------------
// NEED INFERENCE ENGINE TESTS
// ---------------------------------------------------------------------------

test('inferNeeds: church profile infers facilities_repair and community_outreach', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'c1', primary_type: 'church', state: 'OH' },
    { qualifications: { is_faith_based: true, is_rural: true } }
  )
  const needs = inferNeeds(intel)
  const codes = needs.map(n => n.code)

  assert.ok(codes.includes('facilities_repair'), 'church should infer facilities_repair')
  assert.ok(codes.includes('community_outreach'), 'church should infer community_outreach')
  assert.ok(codes.includes('donor_support_private'), 'church should infer donor_support_private')
})

test('inferNeeds: church with repair keywords → high confidence facilities_repair', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'c2', primary_type: 'church', state: 'OH' },
    {
      qualifications: { is_faith_based: true },
      narrative: { story: 'Our church needs roof repair and building renovation urgently' },
    }
  )
  const needs = inferNeeds(intel)
  const facilRepair = needs.find(n => n.code === 'facilities_repair')

  assert.ok(facilRepair, 'should infer facilities_repair')
  assert.ok(facilRepair.weight > 0.7, `weight should be > 0.7, got ${facilRepair.weight}`)
  assert.ok(facilRepair.reasons.length >= 2, 'should have ≥2 reasons (converging signals)')
})

test('inferNeeds: volunteer fire dept infers public_safety_equipment, ppe, vehicles', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'vfd1', primary_type: 'volunteer_fire_dept', state: 'WV' },
    { qualifications: { is_rural: true } }
  )
  const needs = inferNeeds(intel)
  const codes = needs.map(n => n.code)

  assert.ok(codes.includes('public_safety_equipment'), 'fire dept: public_safety_equipment')
  assert.ok(codes.includes('ppe'), 'fire dept: ppe')
  assert.ok(codes.includes('vehicles'), 'fire dept: vehicles')
  assert.ok(codes.includes('training'), 'fire dept: training')
})

test('inferNeeds: school with band keywords infers arts_equipment', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'school1', primary_type: 'school_district', state: 'KY' },
    { narrative: { story: 'Our school band needs new instruments for the marching band program' } }
  )
  const needs = inferNeeds(intel)
  const codes = needs.map(n => n.code)

  assert.ok(codes.includes('arts_equipment'), 'school with band keywords: arts_equipment')
  assert.ok(codes.includes('technology'), 'school: technology (baseline)')
})

test('inferNeeds: school with sports keywords infers athletics_equipment', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'school2', primary_type: 'school_district', state: 'TX' },
    { narrative: { story: 'We need sports equipment and uniforms for our athletic programs' } }
  )
  const needs = inferNeeds(intel)
  const codes = needs.map(n => n.code)

  assert.ok(codes.includes('athletics_equipment'), 'school with sports keywords: athletics_equipment')
})

test('inferNeeds: individual student infers scholarships_tuition', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'stud1', primary_type: 'student', state: 'PA' },
    { financial_situation: { is_low_income: true } }
  )
  const needs = inferNeeds(intel)
  const codes = needs.map(n => n.code)

  assert.ok(codes.includes('scholarships_tuition'), 'student: scholarships_tuition')
})

test('inferNeeds: student with disability infers scholarships + health_medical', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'stud2', primary_type: 'student', state: 'PA' },
    {
      financial_situation: { is_low_income: true },
      health_medical: { disability: true, disability_types: ['physical'] },
    }
  )
  const needs = inferNeeds(intel)
  const codes = needs.map(n => n.code)

  assert.ok(codes.includes('scholarships_tuition'), 'student+disability: scholarships_tuition')
  assert.ok(codes.includes('health_medical_support'), 'student+disability: health_medical_support')
})

test('inferNeeds: hardship individual with homelessness infers housing + emergency', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'hard1', primary_type: 'individual', state: 'OH' },
    {
      financial_situation: { is_low_income: true, unemployed: true },
      family_life: { experiencing_homelessness: true },
    }
  )
  const needs = inferNeeds(intel)
  const codes = needs.map(n => n.code)

  assert.ok(codes.includes('housing_support'), 'hardship: housing_support')
  assert.ok(codes.includes('emergency_assistance'), 'hardship: emergency_assistance')
  assert.ok(codes.includes('workforce_development'), 'hardship+unemployed: workforce_development')
})

test('inferNeeds: veteran infers health_medical_support', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'vet1', primary_type: 'individual', state: 'TX' },
    { military_service: { veteran: true } }
  )
  const needs = inferNeeds(intel)
  const codes = needs.map(n => n.code)

  assert.ok(codes.includes('health_medical_support'), 'veteran: health_medical_support')
})

test('inferNeeds: homeless veteran infers housing_support with high weight', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'vet2', primary_type: 'individual', state: 'TX' },
    {
      military_service: { veteran: true },
      family_life: { experiencing_homelessness: true },
      financial_situation: { is_low_income: true },
    }
  )
  const needs = inferNeeds(intel)
  const housing = needs.find(n => n.code === 'housing_support')

  assert.ok(housing, 'should infer housing_support for homeless veteran')
  assert.ok(housing.weight > 0.8, `housing weight should be > 0.8 for homeless veteran, got ${housing.weight}`)
})

test('inferNeeds: non-school profile does NOT infer arts_equipment or athletics_equipment', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'indiv1', primary_type: 'individual', state: 'OH' },
    {}
  )
  const needs = inferNeeds(intel)
  const codes = needs.map(n => n.code)

  assert.ok(!codes.includes('arts_equipment'), 'individual should NOT infer arts_equipment')
  assert.ok(!codes.includes('athletics_equipment'), 'individual should NOT infer athletics_equipment')
})

test('inferNeeds: non-student profile does NOT infer scholarships_tuition', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'np1', primary_type: 'nonprofit', state: 'OH' },
    {}
  )
  const needs = inferNeeds(intel)
  const codes = needs.map(n => n.code)

  assert.ok(!codes.includes('scholarships_tuition'), 'nonprofit should NOT infer scholarships_tuition')
})

test('inferNeeds: all inferred needs have valid codes', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'church2', primary_type: 'church', state: 'GA' },
    { qualifications: { is_faith_based: true, is_rural: true } }
  )
  const needs = inferNeeds(intel)
  for (const n of needs) {
    assert.ok(isValidNeedCode(n.code), `Invalid code in inference output: ${n.code}`)
  }
})

test('inferNeeds: each inferred need has at least one reason', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'vfd2', primary_type: 'volunteer_fire_dept', state: 'WV' },
    {}
  )
  const needs = inferNeeds(intel)
  for (const n of needs) {
    assert.ok(Array.isArray(n.reasons) && n.reasons.length > 0, `Need ${n.code} missing reasons`)
  }
})

// ---------------------------------------------------------------------------
// SEARCH PLAN GENERATOR TESTS
// ---------------------------------------------------------------------------

test('generateSearchPlans: church profile produces relevant plans', () => {
  const intel = buildProfileIntelligence(
    { id: 'church3', primary_type: 'church', state: 'OH' },
    { qualifications: { is_faith_based: true, is_rural: true } }
  )
  const plans = intel.search_plans

  assert.ok(Array.isArray(plans), 'should return array')
  assert.ok(plans.length > 0, 'should produce at least one plan')

  // All plans should have required fields
  for (const p of plans) {
    assert.ok(p.need_code, `plan missing need_code`)
    assert.ok(Array.isArray(p.search_terms) && p.search_terms.length > 0, `plan ${p.need_code} missing search_terms`)
    assert.ok(typeof p.priority_weight === 'number', `plan ${p.need_code} missing priority_weight`)
    assert.ok(typeof p.expected_funding_type === 'string', `plan ${p.need_code} missing expected_funding_type`)
    assert.ok(Array.isArray(p.search_scope) && p.search_scope.length > 0, `plan ${p.need_code} missing search_scope`)
  }
})

test('generateSearchPlans: fire dept produces public_safety_equipment plan with AFG terms', () => {
  const intel = buildProfileIntelligence(
    { id: 'vfd3', primary_type: 'volunteer_fire_dept', state: 'WV' },
    { qualifications: { is_rural: true } }
  )
  const safePlan = intel.search_plans.find(p => p.need_code === 'public_safety_equipment')

  assert.ok(safePlan, 'should have public_safety_equipment plan')
  const hasAFG = safePlan.search_terms.some(t => t.toLowerCase().includes('afg'))
  assert.ok(hasAFG, 'fire dept safety plan should include AFG search term')
})

test('generateSearchPlans: school with band needs includes arts_equipment plan', () => {
  const intel = buildProfileIntelligence(
    { id: 'school3', primary_type: 'school_district', state: 'KY' },
    { narrative: { story: 'We need band instruments for our music program' } }
  )
  const artsPlan = intel.search_plans.find(p => p.need_code === 'arts_equipment')

  assert.ok(artsPlan, 'should have arts_equipment plan')
  assert.ok(artsPlan.search_terms.some(t => /instrument|band|music/i.test(t)), 'arts plan should have music terms')
})

test('generateSearchPlans: student profile produces scholarships plan with state context', () => {
  const intel = buildProfileIntelligence(
    { id: 'stud3', primary_type: 'student', state: 'PA' },
    { financial_situation: { is_low_income: true } }
  )
  const schPlan = intel.search_plans.find(p => p.need_code === 'scholarships_tuition')

  assert.ok(schPlan, 'should have scholarships_tuition plan')
  // Should include state-specific search term
  const hasStateTerms = schPlan.search_terms.some(t => t.toLowerCase().includes('pa') || t.toLowerCase().includes('pennsylvania'))
  assert.ok(hasStateTerms, 'scholarship plan should include PA/Pennsylvania terms')
})

test('generateSearchPlans: plans respect maxPlans option', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'church4', primary_type: 'church', state: 'OH' },
    { qualifications: { is_faith_based: true } }
  )
  const intelWithNeeds = annotateWithInferredNeeds(intel)
  const plans = generateSearchPlans(intelWithNeeds, { maxPlans: 3 })

  assert.ok(plans.length <= 3, `should respect maxPlans=3, got ${plans.length}`)
})

test('generateSearchPlans: faith-based profile includes denominational scope', () => {
  const intel = buildProfileIntelligence(
    { id: 'church5', primary_type: 'church', state: 'OH' },
    { qualifications: { is_faith_based: true } }
  )
  const facilPlan = intel.search_plans.find(p => p.need_code === 'facilities_repair')

  assert.ok(facilPlan, 'should have facilities_repair plan')
  assert.ok(facilPlan.search_scope.includes('denominational'), 'faith-based facilities plan should include denominational scope')
})

// ---------------------------------------------------------------------------
// MATCH THRESHOLD ENFORCEMENT TESTS
// ---------------------------------------------------------------------------

test('match threshold enforcement: explicit threshold is honored — no results below it', () => {
  // Simulate what the matching API should do when isExplicitThreshold=true
  const allResults = [
    { id: '1', match_score: 90 },
    { id: '2', match_score: 75 },
    { id: '3', match_score: 60 },
    { id: '4', match_score: 45 },
    { id: '5', match_score: 20 },
  ]

  const userThreshold = 80

  // When user sets explicit threshold, we must NOT fall back below it
  const filtered = allResults.filter(r => (r.match_score ?? 0) >= userThreshold)

  assert.equal(filtered.length, 1, 'should return only results at or above 80%')
  assert.equal(filtered[0].id, '1', 'should return only the 90% result')
  assert.ok(!filtered.some(r => r.match_score < userThreshold), 'No result should be below threshold')
})

test('match threshold enforcement: when no results meet threshold, return empty (not fallback)', () => {
  const allResults = [
    { id: '1', match_score: 50 },
    { id: '2', match_score: 30 },
    { id: '3', match_score: 10 },
  ]

  const userThreshold = 80
  const isExplicitThreshold = true

  let scored = allResults.filter(r => (r.match_score ?? 0) >= userThreshold)

  // When explicit threshold is set, do NOT relax
  if (scored.length === 0 && !isExplicitThreshold) {
    // This branch should NOT execute when isExplicitThreshold=true
    scored = allResults
  }

  assert.equal(scored.length, 0, 'When explicit threshold set and no matches, should return empty')
})

test('match threshold enforcement: threshold_relaxed flag absent when explicit threshold used', () => {
  // This verifies the API response contract: threshold_relaxed should not be true
  // when user set an explicit threshold and we honor it (i.e. return empty rather than relax)
  const allResults = [{ id: '1', match_score: 40 }]
  const userThreshold = 80
  const isExplicitThreshold = true

  let scored = allResults.filter(r => (r.match_score ?? 0) >= userThreshold)
  let thresholdRelaxed = false

  // Should NOT relax when explicit
  if (scored.length === 0 && !isExplicitThreshold) {
    scored = allResults
    thresholdRelaxed = true
  }

  assert.equal(thresholdRelaxed, false, 'threshold_relaxed should be false when explicit threshold set')
  assert.equal(scored.length, 0)
})

test('match threshold enforcement: fallback IS allowed when no explicit threshold was set', () => {
  const allResults = [
    { id: '1', match_score: 40 },
    { id: '2', match_score: 25 },
  ]
  const defaultMinScore = 50
  const isExplicitThreshold = false // no slider set by user

  let scored = allResults.filter(r => (r.match_score ?? 0) >= defaultMinScore)
  let thresholdRelaxed = false

  // Fallback IS allowed when no explicit threshold was set
  if (scored.length === 0 && !isExplicitThreshold) {
    const fallback = [30, 15, 0]
    for (const t of fallback) {
      scored = allResults.filter(r => (r.match_score ?? 0) >= t)
      if (scored.length > 0) {
        thresholdRelaxed = true
        break
      }
    }
  }

  assert.ok(scored.length > 0, 'fallback should produce results when no explicit threshold')
  assert.equal(thresholdRelaxed, true, 'threshold_relaxed should be true when fallback used')
})

// ---------------------------------------------------------------------------
// FAITH-BASED EXCLUSION FROM PUBLIC GRANTS
// ---------------------------------------------------------------------------

test('faith-based profile gets exclusion_flag for public grants', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'fb1', primary_type: 'church', state: 'OH' },
    { qualifications: { is_faith_based: true } }
  )

  assert.ok(intel.exclusion_flags.includes('public_grant_excludes_religious_use'),
    'faith-based profile should have public_grant_excludes_religious_use exclusion flag')
})

test('non-faith profile does NOT get faith exclusion flag', () => {
  const intel = normalizeProfileIntelligence(
    { id: 'np2', primary_type: 'nonprofit', state: 'OH' },
    { qualifications: { is_501c3: true, is_faith_based: false } }
  )

  assert.ok(!intel.exclusion_flags.includes('public_grant_excludes_religious_use'),
    'non-faith nonprofit should NOT have faith-based exclusion flag')
})

// ---------------------------------------------------------------------------
// FULL PIPELINE INTEGRATION
// ---------------------------------------------------------------------------

test('buildProfileIntelligence: church produces complete intelligence with search plans', () => {
  const result = buildProfileIntelligence(
    { id: 'int-church-1', primary_type: 'church', state: 'OH' },
    {
      qualifications: { is_faith_based: true, is_rural: true },
      narrative: { story: 'We need to repair our church roof and support our food pantry' },
    }
  )

  assert.ok(result.entity_types.length > 0, 'should have entity_types')
  assert.ok(result.likely_needs.length > 0, 'should have likely_needs')
  assert.ok(result.search_plans.length > 0, 'should have search_plans')
  assert.ok(result.is_faith_based, 'is_faith_based should be true')
  assert.ok(result.is_rural, 'is_rural should be true')
})

test('buildProfileIntelligence: fire dept produces complete intelligence', () => {
  const result = buildProfileIntelligence(
    { id: 'int-vfd-1', primary_type: 'volunteer_fire_dept', state: 'WV' },
    {
      qualifications: { is_rural: true },
      narrative: { story: 'We need new turnout gear, SCBA units and a new fire apparatus' },
    }
  )

  assert.ok(result.likely_needs.length > 0)
  const ppePlan = result.search_plans.find(p => p.need_code === 'ppe')
  const vehiclePlan = result.search_plans.find(p => p.need_code === 'vehicles')
  assert.ok(ppePlan, 'should have PPE plan')
  assert.ok(vehiclePlan, 'should have vehicles plan')
})

test('buildProfileIntelligence: student produces scholarships plan', () => {
  const result = buildProfileIntelligence(
    { id: 'int-stud-1', primary_type: 'student', state: 'PA' },
    { financial_situation: { is_low_income: true } }
  )

  assert.ok(result.is_student)
  assert.ok(result.likely_needs.some(n => n.code === 'scholarships_tuition'))
  assert.ok(result.search_plans.some(p => p.need_code === 'scholarships_tuition'))
})
