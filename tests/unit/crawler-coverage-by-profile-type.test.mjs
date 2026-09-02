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
import {
  buildFourTruthProof,
  isRecommendable,
  isResearchLead,
} from '../../backend/crawler-os/matchEngine.js'
import {
  buildCrawlerProfileRoute,
  listProfileTypes,
} from '../../backend/services/profileTypeRegistry.js'
import { profileContextToThesisInput } from '../../backend/services/crawlerOsPersistenceCore.js'

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

test('every canonical profile type has one explicit runtime applicant route', () => {
  for (const profileType of listProfileTypes()) {
    const route = buildCrawlerProfileRoute(profileType.id)
    assert.equal(route.canonical_profile_type, profileType.id)
    assert.equal(route.resolved, true)
    assert.ok(
      route.applicant_types.length > 0,
      `profile type "${profileType.id}" has no Crawler OS applicant route`,
    )
  }
})

test('the live profile-context bridge carries the canonical route into source decisions', () => {
  const input = profileContextToThesisInput({
    profile: { id: 'church-1', primary_type: 'church', display_name: 'Community Church' },
    sections: { organization_details: { mission: 'Food pantry and housing ministry' } },
    signals: {
      applicantTypes: new Set(['church']),
      needs: new Set(['food', 'housing']),
      needsDefaulted: false,
      location: { state: 'OH', city: 'Lorain' },
      states: ['OH'],
    },
    profileNorm: { needCategories: ['food', 'housing'] },
  })
  const thesis = buildThesis(input)
  const routePlan = plan(thesis)
  const grantsGov = routePlan.source_decisions.find((decision) => decision.source_id === 'grants_gov')

  assert.equal(input.profile_route.canonical_profile_type, 'church')
  assert.ok(input.applicant_types.includes('church'))
  assert.ok(input.applicant_types.includes('nonprofit'))
  assert.equal(grantsGov?.selected, true)
  assert.ok(grantsGov?.reasons.includes('profile_type_route:church'))
  assert.ok(grantsGov?.reasons.includes('profile_needs_source:profile_declared_or_faceted'))
})

test('the live bridge reads profileNorm, every section, documents, organization, and all states', () => {
  const input = profileContextToThesisInput({
    profile: { id: 'profile-all-facts', primary_type: 'disabled_adult', display_name: 'Applicant' },
    sections: {
      medical: { dme_needed: ['power wheelchair'] },
      transportation: { requested_vehicle: 'wheelchair-accessible van' },
    },
    signals: {
      applicantTypes: new Set(['individual', 'disabled']),
      needs: new Set(),
      needsDefaulted: false,
      location: { state: 'OH', county: 'Lorain', city: 'Elyria', zip: '44035' },
      states: ['OH', 'WV'],
    },
    profileNorm: { needCategories: new Set(['medical', 'transportation', 'equipment']) },
    organization: { name: 'Care Network', organization_type: 'nonprofit', mission: 'Mobility access' },
    documents: [{ title: 'DME prescription', extracted_text: 'Power wheelchair is medically necessary.' }],
  })

  assert.deepEqual(
    new Set(input.need_categories),
    new Set(['medical', 'transportation', 'equipment']),
  )
  assert.deepEqual(input.location.states, ['OH', 'WV'])
  assert.deepEqual(input.sections.map((section) => section.title).sort(), ['medical', 'transportation'])
  assert.equal(input.documents[0].name, 'DME prescription')
  assert.equal(input.organizations[0].mission, 'Mobility access')
  assert.equal(input.profile_route.profile_norm_considered, true)
  assert.equal(input.profile_route.document_count, 1)
})

test('type defaults are labeled as defaults and never masquerade as declared needs', () => {
  const input = profileContextToThesisInput({
    profile: { id: 'sparse-student', primary_type: 'college_student' },
    sections: {},
    signals: {
      applicantTypes: new Set(['student']),
      needs: new Set(['utilities', 'housing']),
      needCategories: new Set(['utilities', 'housing']),
      needsDefaulted: true,
      location: { state: 'TN' },
    },
  })
  const thesis = buildThesis(input)

  assert.equal(input.profile_route.needs_source, 'profile_type_default')
  assert.equal(thesis.needs_defaulted, true)
  assert.ok(input.need_categories.includes('scholarship'))
  assert.equal(input.need_categories.includes('utilities'), false)
})

test('direct funding requires positive proof for all four truths', () => {
  const opportunity = {
    id: 'opp-transport',
    kind: 'DIRECT_GRANT',
    reality_status: 'VERIFIED',
    apply_url: 'https://agency.gov/apply',
    evidence: {
      url: 'https://agency.gov/program',
      content_hash: 'sha256:verified-page',
      fetched_at: '2026-09-02T19:00:00.000Z',
    },
  }
  const canonical = {
    decision: 'ACCEPT',
    score: 91,
    eligible: 'yes',
    matchedNeeds: ['transportation'],
    missingEligibilityFields: [],
  }
  const proof = buildFourTruthProof(opportunity, { needs_defaulted: false }, canonical, {
    realityPassed: true,
  })

  assert.equal(proof.real.passed, true)
  assert.equal(proof.relatable.passed, true)
  assert.equal(proof.meets_profile_need.passed, true)
  assert.equal(proof.profile_qualifies.passed, true)
  assert.equal(proof.all_passed, true)
})

test('unknown qualification or type-defaulted needs cannot authorize direct funding', () => {
  const opportunity = {
    kind: 'DIRECT_GRANT',
    reality_status: 'VERIFIED',
    evidence: {
      url: 'https://agency.gov/program',
      content_hash: 'sha256:verified-page',
      fetched_at: '2026-09-02T19:00:00.000Z',
    },
  }
  const canonical = {
    decision: 'ACCEPT',
    score: 90,
    eligible: 'maybe',
    matchedNeeds: ['housing'],
    missingEligibilityFields: ['household_income'],
  }
  const proof = buildFourTruthProof(opportunity, { needs_defaulted: true }, canonical, {
    realityPassed: true,
  })

  assert.equal(proof.meets_profile_need.passed, false)
  assert.equal(proof.profile_qualifies.passed, false)
  assert.equal(proof.all_passed, false)
})

test('a safe but uncaptured link cannot satisfy the real truth', () => {
  const proof = buildFourTruthProof({
    kind: 'DIRECT_GRANT',
    reality_status: 'LINK_UNVERIFIED',
    apply_url: 'https://agency.gov/apply',
    evidence: { url: 'https://agency.gov/program' },
  }, { needs_defaulted: false }, {
    decision: 'ACCEPT',
    score: 90,
    eligible: 'yes',
    matchedNeeds: ['transportation'],
  }, { realityPassed: true })

  assert.equal(proof.real.passed, false)
  assert.equal(proof.all_passed, false)
})

test('directories are research leads, never direct funding recommendations', () => {
  const directory = { kind: 'DIRECTORY' }
  assert.equal(isRecommendable(directory, 'review'), false)
  assert.equal(isResearchLead(directory, 'review'), true)
  assert.equal(isResearchLead({ kind: 'DIRECT_GRANT' }, 'review'), false)
})
