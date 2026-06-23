/**
 * crawler-coverage-by-profile-type
 *
 * Mission guard (Part 1): every profile TYPE must have at least one relatable
 * funding source fire, and ORGANIZATION / GOVERNMENT types must reach the real
 * federal grant APIs — never be hard-excluded to "directories only" or zero.
 *
 * Regression for the 2026-06-23 audit finding: canonical org/government
 * primary_types whose stored string uses underscores
 * (volunteer_fire_department, food_pantry, homeless_shelter, local_housing_
 * authority, public_agency, museum, library, pta_pto, legacy 'organization',
 * etc.) silently fell through deriveApplicantTypes to the 'individual' default
 * and were then EXCLUDED from grants_gov/sam_gov at the planner — producing
 * ZERO real funding for fire departments, food pantries, shelters, libraries,
 * and government agencies. The PRIMARY_TYPE_TO_APPLICANT map fixes this.
 *
 * Mission rules enforced here:
 *   - "Avoid zero-result experiences when relevant funding likely exists."
 *   - "Hard boolean filters (AND logic) are forbidden unless the funding source
 *      is explicitly exclusive."
 *   - "Support all user types."
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildThesis } from '../../backend/crawler-os/profileIntelligence.js'
import { plan } from '../../backend/crawler-os/planner.js'
import { allSources } from '../../backend/crawler-os/sourceRegistry.js'

const DIRECTORY_IDS = new Set(allSources().filter((s) => s.directory).map((s) => s.source_id))

function selectedFor(primaryType) {
  const thesis = buildThesis({ profile_type: primaryType, type: primaryType })
  return { thesis, selected: plan(thesis).selected_source_ids }
}

// Person / household types: federal grant APIs (grants.gov/sam.gov) do NOT
// serve individuals, so directory-only (benefits.gov + foundation locator) +
// scholarship web discovery is the CORRECT, designed behavior. They must still
// be non-zero.
const PERSON_TYPES = [
  'individual', 'medical_need', 'senior', 'veteran', 'disabled_adult',
  'teacher', 'classroom_teacher',
]

// Organization / government / business types MUST reach the federal grant APIs
// (grants_gov + sam_gov) — anything less is a hard-exclude regression.
const FEDERAL_GRANT_TYPES = [
  'nonprofit', 'organization', 'church', 'ministry', 'food_pantry',
  'homeless_shelter', 'animal_rescue', 'mental_health_nonprofit',
  'community_center', 'museum', 'pta_pto',
  'school_district', 'public_school', 'special_education_program',
  'county_government', 'municipality', 'public_agency',
  'local_housing_authority', 'parks_department', 'tribal_government',
  'public_health_department',
  'business', 'small_business', 'minority_owned_business', 'women_owned_business',
  'volunteer_fire_department', // vfd reaches grants_gov even if sam_gov omits vfd
]

test('no profile type yields zero relatable funding sources', () => {
  const allTypes = [...PERSON_TYPES, ...FEDERAL_GRANT_TYPES,
    'family', 'student', 'high_school_student', 'college_student', 'graduate_student', 'library']
  for (const t of allTypes) {
    const { selected } = selectedFor(t)
    assert.ok(selected.length > 0, `type "${t}" selected ZERO sources (mission: never zero)`)
  }
})

test('person/household types are non-zero (directory + benefit finder)', () => {
  for (const t of PERSON_TYPES) {
    const { selected } = selectedFor(t)
    assert.ok(selected.length > 0, `person type "${t}" must have at least the benefit/foundation directories`)
    assert.ok(
      selected.includes('cof_locator') || selected.includes('benefits_gov'),
      `person type "${t}" should surface benefits.gov or the foundation locator; got [${selected.join(', ')}]`,
    )
  }
})

test('organization/government/business types reach the federal grant APIs', () => {
  for (const t of FEDERAL_GRANT_TYPES) {
    const { selected, thesis } = selectedFor(t)
    assert.ok(
      selected.includes('grants_gov'),
      `type "${t}" (apps=[${thesis.applicant_types.join(',')}]) was HARD-EXCLUDED from grants_gov; got [${selected.join(', ')}]`,
    )
  }
})

test('nonprofits + churches + ministries all reach grants_gov AND sam_gov', () => {
  for (const t of ['nonprofit', 'organization', 'church', 'ministry', 'food_pantry', 'homeless_shelter', 'museum']) {
    const { selected } = selectedFor(t)
    assert.ok(selected.includes('grants_gov'), `"${t}" missing grants_gov`)
    assert.ok(selected.includes('sam_gov'), `"${t}" missing sam_gov`)
  }
})

test('faith-based orgs keep their identity tag AND gain nonprofit eligibility', () => {
  for (const t of ['church', 'ministry']) {
    const { thesis } = selectedFor(t)
    assert.ok(thesis.applicant_types.includes(t), `"${t}" should keep its own identity tag`)
    assert.ok(thesis.applicant_types.includes('nonprofit'), `"${t}" should imply nonprofit eligibility`)
    assert.equal(thesis.is_org, true, `"${t}" must be classified as an organization`)
  }
})

test('volunteer fire department reaches the firefighter grant stack (fema_afg + grants_gov)', () => {
  const { selected, thesis } = selectedFor('volunteer_fire_department')
  assert.ok(thesis.applicant_types.includes('vfd'), 'VFD must map to the vfd bucket (not individual)')
  assert.ok(selected.includes('fema_afg'), `VFD must reach FEMA AFG; got [${selected.join(', ')}]`)
  assert.ok(selected.includes('grants_gov'), `VFD must reach grants_gov; got [${selected.join(', ')}]`)
})

test('students reach federal student aid + benefit directories', () => {
  for (const t of ['student', 'high_school_student', 'college_student', 'graduate_student']) {
    const { selected } = selectedFor(t)
    assert.ok(selected.includes('studentaid_gov'), `"${t}" missing studentaid_gov`)
    assert.ok(selected.includes('benefits_gov'), `"${t}" missing benefits_gov`)
  }
})
