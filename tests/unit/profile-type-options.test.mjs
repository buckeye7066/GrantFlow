/**
 * profile-type-options.test.mjs
 *
 * Mission contract: every profile-type id surfaced to the UI MUST
 * resolve through the backend registry, and every UI alias MUST
 * resolve to a canonical id. This test is the only thing that
 * guarantees frontend selectors and backend planning agree on what a
 * profile type means.
 *
 * Mission goals: #4 (support every profile type), #5 (let the system
 * evolve), #9 (explainable, reliable).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROFILE_TYPE_OPTIONS,
  PROFILE_TYPE_UI_ALIASES,
  canonicalizeProfileTypeId,
  listCanonicalProfileTypeIds,
  getGroupedProfileTypeOptions,
} from '../../shared/profileTypeOptions.js'
import {
  PROFILE_TYPES,
  resolveProfileType,
  recommendStrategyFor,
  recommendedSourcesFor,
} from '../../backend/services/profileTypeRegistry.js'
import { SECTION_METADATA } from '../../src/config/sectionMetadata.js'

test('PROFILE_TYPE_OPTIONS: every id resolves to a canonical backend type (or is the catch-all "other")', () => {
  const failures = []
  for (const option of PROFILE_TYPE_OPTIONS) {
    // "other" is intentionally a UI-only catch-all that signals "we don't
    // know yet, run comprehensive". The backend planner treats unresolved
    // types as comprehensive too, so leaving "other" out of the registry
    // is the intended contract.
    if (option.id === 'other') continue
    const resolved = resolveProfileType(option.id)
    if (!resolved) failures.push(`${option.id} (${option.label}) does not resolve in profileTypeRegistry`)
    else if (resolved !== option.id) failures.push(`${option.id} resolved to ${resolved}, not itself`)
  }
  assert.deepEqual(failures, [], `Curated UI ids must be canonical backend ids:\n  ${failures.join('\n  ')}`)
})

test('PROFILE_TYPE_OPTIONS: every required user-facing type is present (per the brief)', () => {
  const required = [
    'individual', 'family', 'student', 'high_school_student', 'college_student', 'graduate_student',
    'nonprofit', 'church', 'ministry',
    'school_district', 'public_school', 'teacher', 'classroom_teacher',
    'volunteer_fire_department', 'business',
    'minority_owned_business', 'women_owned_business',
    'county_government', 'municipality', 'public_agency', 'tribal_government',
    'library', 'public_health_department',
    'food_pantry', 'homeless_shelter', 'animal_rescue',
    'medical_need',
    // Specialist personas surfaced so no supported user-type has to pick "Other"
    // (mission goal #4). These are fully supported in the registry (strategy +
    // >=3 sources) and must stay exposed.
    'senior', 'veteran', 'disabled_adult',
    'pta_pto', 'school_food_service', 'school_transportation', 'special_education_program',
    'museum', 'community_center', 'mental_health_nonprofit', 'substance_recovery_org', 'reentry_program',
    'parks_department', 'local_housing_authority', 'regional_planning_agency', 'economic_development_agency',
    'other',
  ]
  const have = new Set(listCanonicalProfileTypeIds())
  const missing = required.filter((id) => !have.has(id))
  assert.deepEqual(
    missing,
    [],
    `Curated UI list is missing required profile types:\n  ${missing.join('\n  ')}`,
  )
})

test('PROFILE_TYPE_UI_ALIASES: every alias canonicalizes to a recognised id', () => {
  const have = new Set(listCanonicalProfileTypeIds())
  const failures = []
  for (const [alias, canonical] of Object.entries(PROFILE_TYPE_UI_ALIASES)) {
    if (!have.has(canonical) && !PROFILE_TYPES[canonical]) {
      failures.push(`alias ${alias} → ${canonical} (target id not in curated list AND not in backend registry)`)
    }
    const resolved = canonicalizeProfileTypeId(alias)
    if (resolved !== canonical) {
      failures.push(`canonicalizeProfileTypeId(${alias}) returned ${resolved}, expected ${canonical}`)
    }
  }
  assert.deepEqual(failures, [], failures.join('\n  '))
})

test('canonicalizeProfileTypeId: legacy values used in real production data resolve cleanly', () => {
  // These are the literal strings stored in older profile rows / quick
  // add submissions. We must never silently lose them.
  assert.equal(canonicalizeProfileTypeId('individual_need'), 'individual')
  assert.equal(canonicalizeProfileTypeId('medical_assistance'), 'medical_need')
  assert.equal(canonicalizeProfileTypeId('volunteer_fire'), 'volunteer_fire_department')
  assert.equal(canonicalizeProfileTypeId('small_business'), 'business')
  assert.equal(canonicalizeProfileTypeId('organization'), 'nonprofit')
  assert.equal(canonicalizeProfileTypeId('school'), 'public_school')
  assert.equal(canonicalizeProfileTypeId('government'), 'public_agency')
  assert.equal(canonicalizeProfileTypeId('city'), 'municipality')
  assert.equal(canonicalizeProfileTypeId('minister'), 'ministry')
  assert.equal(canonicalizeProfileTypeId('clergy'), 'ministry')
  assert.equal(canonicalizeProfileTypeId(''), null)
  assert.equal(canonicalizeProfileTypeId(null), null)
  // Unknown strings round-trip verbatim so we never destroy data.
  assert.equal(canonicalizeProfileTypeId('exotic_new_persona_2099'), 'exotic_new_persona_2099')
})

test('SECTION_METADATA.basic_information.profile_type enum is a superset of curated ids', () => {
  const enumOptions = new Set(
    SECTION_METADATA.basic_information.fields.find((f) => f.name === 'profile_type')?.options ?? [],
  )
  const missing = listCanonicalProfileTypeIds().filter((id) => !enumOptions.has(id))
  assert.deepEqual(
    missing,
    [],
    `Curated profile-type ids must all appear in basic_information.profile_type enum:\n  ${missing.join('\n  ')}`,
  )
})

test('every curated profile type has a recommended strategy AND >=3 recommended sources', () => {
  const failures = []
  for (const option of PROFILE_TYPE_OPTIONS) {
    if (option.id === 'other') continue
    const strategy = recommendStrategyFor(option.id)
    const sources = recommendedSourcesFor(option.id)
    if (!strategy) failures.push(`${option.id}: no recommended strategy`)
    if (sources.length < 3) failures.push(`${option.id}: only ${sources.length} recommended sources (need >= 3)`)
  }
  assert.deepEqual(failures, [], failures.join('\n  '))
})

test('getGroupedProfileTypeOptions: every option appears in exactly one group', () => {
  const grouped = getGroupedProfileTypeOptions()
  const seen = new Map()
  for (const { group, options } of grouped) {
    for (const option of options) {
      if (seen.has(option.id)) {
        assert.fail(`${option.id} appears in both ${seen.get(option.id)} and ${group}`)
      }
      seen.set(option.id, group)
    }
  }
  assert.equal(seen.size, PROFILE_TYPE_OPTIONS.length)
})
