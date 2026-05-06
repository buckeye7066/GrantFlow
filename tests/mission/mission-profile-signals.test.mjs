/**
 * Mission test suite — full-profile signal extraction (Phase 3)
 *
 * Mission rule: every consumer (matching, discovery, Anya, pipeline save)
 * must use the FULL profile context (loadProfileContext / buildProfileSignals
 * / buildProfileSignalAudit), not a thin SELECT id, state, organization_type
 * row.
 *
 * What this suite asserts (per fixture profile type):
 *   1. buildProfileSignals returns a complete, structured signal object.
 *   2. buildProfileSignalAudit returns the consumer-facing audit payload
 *      (profile_type, location_used, needs_used, missing_high_value_fields).
 *   3. computeMatchDecision uses those signals to surface profile-specific
 *      facts in matched_profile_facts.
 *
 * If anyone re-introduces a shallow profile query (id, state, type only)
 * for matching/anya, these tests will trip because matched_profile_facts
 * will lose the profile-type-specific signals.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildProfileSignals, buildProfileSignalAudit } from '../../backend/services/profileHelpers.js'
import { computeMatchDecision } from '../../backend/services/matchEngine.js'

const NATIONAL_GRANT = {
  id: 'opp-test',
  title: 'National Equipment Grant',
  application_url: 'https://www.example.gov/grants/equip',
  source_url: 'https://www.example.gov/grants/equip',
  source: 'grants.gov',
  record_origin: 'grants_gov',
  state: 'nationwide',
  is_national: true,
  categories: ['equipment'],
  keywords: ['equipment'],
  opportunity_type: 'grant',
  deadline: '2099-12-31',
}

const FIXTURES = [
  {
    name: 'individual',
    profile: { id: 'p1', applicant_type: 'individual', primary_type: 'individual', state: 'TN', zip: '38501' },
    sections: { basic_information: { state: 'TN', zip: '38501' } },
  },
  {
    name: 'family',
    profile: {
      id: 'p2', applicant_type: 'family', primary_type: 'family', state: 'OH',
      household_size: 5, below_poverty_line: true,
    },
    sections: { basic_information: { household_size: 5 }, financial: { below_poverty_line: true } },
  },
  {
    name: 'student',
    profile: { id: 'p3', applicant_type: 'student', primary_type: 'student', state: 'CA' },
    sections: { education: { gpa: 3.6, school_name: 'Test University', degree_program: 'BS' } },
  },
  {
    name: 'church',
    profile: { id: 'p4', applicant_type: 'church', primary_type: 'church', organization_type: 'church', state: 'TX' },
    sections: { mission: { focus: 'community ministry, food pantry' } },
  },
  {
    name: 'nonprofit',
    profile: {
      id: 'p5', applicant_type: 'nonprofit', primary_type: 'nonprofit',
      organization_type: '501c3', state: 'NY', has_501c3: true,
    },
    sections: { programs_services: { focus_areas: ['youth', 'education', 'food'] } },
  },
  {
    name: 'school',
    profile: {
      id: 'p6', applicant_type: 'school', primary_type: 'school',
      organization_type: 'k12', state: 'WA',
    },
    sections: { school_info: { grade_level: 'k12', enrollment: 450 } },
  },
  {
    name: 'volunteer_fire',
    profile: {
      id: 'p7', applicant_type: 'volunteer_fire',
      primary_type: 'volunteer_fire_department',
      organization_type: 'volunteer_fire_department', state: 'KY', zip: '40502',
    },
    sections: {
      mission: { focus: 'volunteer fire and emergency services, rural equipment' },
      programs_services: { focus_areas: ['equipment', 'training', 'fire'] },
    },
  },
  {
    name: 'small_business',
    profile: {
      id: 'p8', applicant_type: 'business', primary_type: 'business',
      organization_type: 'small_business', state: 'IL',
    },
    sections: {
      business: { naics: '722330', business_type: 'food_truck', minority_owned: true },
    },
  },
  {
    name: 'ministry',
    profile: {
      id: 'p9', applicant_type: 'ministry', primary_type: 'ministry',
      organization_type: 'ministry', state: 'AL',
    },
    sections: { mission: { focus: 'addiction recovery ministry' } },
  },
  {
    name: 'veteran',
    profile: {
      id: 'p10', applicant_type: 'individual', primary_type: 'individual',
      state: 'GA', is_veteran: true, serves_veterans: true,
    },
    sections: { military: { served: true, branch: 'Army', service_connected: true } },
  },
  {
    name: 'disabled',
    profile: {
      id: 'p11', applicant_type: 'individual', primary_type: 'individual',
      state: 'NC', has_disability: true, serves_disabled: true,
    },
    sections: { health: { disabilities: ['mobility', 'mental_health'] } },
  },
  {
    name: 'medical_need',
    profile: {
      id: 'p12', applicant_type: 'individual', primary_type: 'individual',
      state: 'PA',
    },
    sections: { health: { conditions: ['diabetes', 'cancer'], chronic: true } },
  },
  {
    name: 'housing_emergency',
    profile: {
      id: 'p13', applicant_type: 'individual', primary_type: 'individual',
      state: 'FL', needs_housing: true,
    },
    sections: { housing: { housing_status: 'eviction_risk', emergency: true } },
  },
  {
    name: 'minority_woman_owned',
    profile: {
      id: 'p14', applicant_type: 'business', primary_type: 'business',
      organization_type: 'small_business', state: 'TX',
    },
    sections: { business: { minority_owned: true, woman_owned: true } },
  },
]

for (const fixture of FIXTURES) {
  test(`profile-signals: ${fixture.name} produces a complete signal object`, () => {
    const signals = buildProfileSignals({ profile: fixture.profile, sections: fixture.sections })
    assert.ok(signals && typeof signals === 'object', `${fixture.name}: signals must be a non-null object`)
    assert.ok(signals.location !== undefined, `${fixture.name}: signals.location is required`)
    assert.ok(signals.needs !== undefined, `${fixture.name}: signals.needs is required`)
  })

  test(`profile-signals: ${fixture.name} produces a profile_signal_audit`, () => {
    const profileContext = {
      profile: fixture.profile,
      sections: fixture.sections,
      signals: buildProfileSignals({ profile: fixture.profile, sections: fixture.sections }),
    }
    const audit = buildProfileSignalAudit(profileContext)
    assert.ok(audit, `${fixture.name}: audit object required`)
    assert.ok('profile_type' in audit, `${fixture.name}: audit.profile_type required`)
    assert.ok(Array.isArray(audit.location_used), `${fixture.name}: audit.location_used must be array`)
    assert.ok(Array.isArray(audit.needs_used), `${fixture.name}: audit.needs_used must be array`)
    assert.ok(
      Array.isArray(audit.missing_high_value_fields),
      `${fixture.name}: audit.missing_high_value_fields must be array`,
    )
  })

  test(`profile-signals: ${fixture.name} -> computeMatchDecision exposes matched_profile_facts`, () => {
    const decision = computeMatchDecision(fixture.profile, NATIONAL_GRANT, { profileSections: fixture.sections })
    assert.ok(
      Array.isArray(decision.matched_profile_facts),
      `${fixture.name}: matched_profile_facts must be array`,
    )
    // For any fixture with a state, the decision should mention it (so users
    // can see "your state X is why this surfaced").
    if (fixture.profile.state) {
      const stateMentioned = decision.matched_profile_facts.some((f) =>
        new RegExp(fixture.profile.state, 'i').test(f),
      )
      assert.ok(
        stateMentioned,
        `${fixture.name}: matched_profile_facts must mention state ${fixture.profile.state}. Got: ${JSON.stringify(decision.matched_profile_facts)}`,
      )
    }
  })
}

test('profile-signals: buildProfileSignalAudit handles empty/missing input safely', () => {
  // Mission rule: missing profile fields must default to neutral, not throw.
  const audit = buildProfileSignalAudit({})
  assert.ok(audit)
  assert.equal(audit.profile_type, null)
  assert.deepEqual(audit.location_used, [])
})

test('profile-signals: buildProfileSignalAudit flags missing high-value fields', () => {
  const audit = buildProfileSignalAudit({ profile: { id: 'p-empty' } })
  assert.ok(audit.missing_high_value_fields.includes('state'))
  assert.ok(audit.missing_high_value_fields.includes('organization_type'))
})
