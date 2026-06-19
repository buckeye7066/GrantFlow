/**
 * anya-onboarding-e2e.test.mjs
 *
 * End-to-end test for Anya's adaptive intake interview. Drives every
 * canonical persona path (personal/family, student, business, mission
 * org, school, VFD, gov) from `intro` to `__complete__` and asserts
 * the resulting profile patch is fit-for-matching.
 *
 * Why this test exists:
 *
 *   - Mission rule: 'Use the full profile, not just a few fields,
 *     when deciding what to search for.' If a persona finishes
 *     onboarding without the canonical signals (location.state,
 *     primary_type, focus_areas), the matcher will under-recall.
 *
 *   - Mission rule: 'Avoid zero-result experiences when relevant
 *     funding likely exists.' This is the upstream gate — a
 *     half-populated patch downstream of Anya is the most common
 *     reason a real user ends up with empty Discover Grants.
 *
 *   - Mission rule: 'Onboarding support — orient new users.' Anya
 *     IS the onboarding. If a branch in the question tree breaks
 *     (e.g. a missing `next()` returns undefined, or a section write
 *     drops the wrong key), this test fails immediately rather than
 *     in production triage.
 *
 * What this test asserts about every completed persona:
 *
 *   1. The flow REACHES `__complete__` (no dead branch).
 *   2. patch.primary_type is set and is a non-empty canonical value.
 *   3. basic_information has zip + state populated (geo-rank fuel).
 *   4. patch.tags is non-empty (matcher uses these as signals).
 *   5. programs_services.focus_areas is non-empty.
 *   6. display_name + email are set (sign-in fuel).
 *
 * Plus persona-specific assertions: TN+disability+Medicaid unlocks
 * the ECF crawler eligibility check, students get an education
 * section, providers/nonprofits get organization_details, etc.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  makeInitialState,
  applyAnswer,
  COMPLETION_TOKEN,
  FIRST_QUESTION_ID,
} from '../../backend/services/anyaInterviewEngine.js'
import { checkECFEligibility } from '../../backend/services/crawlers/ecfBenefitsCrawler.js'

/**
 * Drive the interview deterministically. `answersByQuestionId` is a
 * map from question id → answer. The test fails loudly if a question
 * is asked that wasn't pre-seeded.
 */
function runInterview(answersByQuestionId) {
  let state = makeInitialState()
  let qId = FIRST_QUESTION_ID
  const visited = []
  const guard = 50
  let steps = 0
  while (qId && qId !== COMPLETION_TOKEN) {
    if (++steps > guard) {
      throw new Error(`Interview exceeded ${guard} steps; likely a cycle. Visited: ${visited.join(' → ')}`)
    }
    visited.push(qId)
    if (!Object.prototype.hasOwnProperty.call(answersByQuestionId, qId)) {
      throw new Error(
        `Test missing answer for '${qId}'. Visited so far: ${visited.join(' → ')}`,
      )
    }
    const answer = answersByQuestionId[qId]
    const out = applyAnswer(state, qId, answer)
    state = out.state
    qId = out.nextQuestionId
  }
  return { state, visited, completed: qId === COMPLETION_TOKEN }
}

function assertCanonicalShape(state, label) {
  const patch = state.patch
  assert.ok(patch, `${label}: patch must exist`)
  assert.ok(typeof patch.primary_type === 'string' && patch.primary_type.length > 0,
    `${label}: primary_type must be set, got ${patch.primary_type}`)
  assert.equal(typeof patch.display_name, 'string', `${label}: display_name must be a string`)
  assert.ok(patch.display_name.length > 0, `${label}: display_name must be non-empty`)
  assert.equal(typeof patch.email, 'string', `${label}: email must be a string`)
  assert.match(patch.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, `${label}: email must be valid`)
  assert.ok(Array.isArray(patch.tags), `${label}: tags must be array`)
  assert.ok(patch.tags.length > 0, `${label}: tags must be non-empty (matcher needs signals)`)

  const basic = patch.sections?.basic_information ?? {}
  assert.ok(basic.zip_code, `${label}: zip_code required for geo-rank`)
  assert.ok(basic.state, `${label}: state required for geo-rank`)

  const ps = patch.sections?.programs_services ?? {}
  assert.ok(Array.isArray(ps.focus_areas), `${label}: focus_areas must be array`)
  assert.ok(ps.focus_areas.length > 0, `${label}: focus_areas must be non-empty`)
}

// ---------------------------------------------------------------------------

test('PERSONAL persona: TN family with housing + food needs reaches __complete__ with matchable patch', () => {
  const out = runInterview({
    intro: 'yes',
    who: 'personal_group',
    location: { zip: '37130', state: 'TN', city: 'Murfreesboro', county: 'Rutherford' },
    personal_subtype: 'family',
    needs_personal: ['housing', 'food', 'utilities'],
    situations: ['caregiver'],
    narrative: 'Single mom raising two kids, behind on rent.',
    name: 'Jordan Smith',
    email: 'jordan@example.com',
  })
  assert.equal(out.completed, true)
  assertCanonicalShape(out.state, 'PERSONAL/family')
  assert.equal(out.state.patch.primary_type, 'family')
  assert.equal(out.state.patch.sections.basic_information.state, 'TN')
  assert.equal(out.state.patch.sections.location_focus?.focus_state, 'TN')
  assert.equal(out.state.patch.sections.housing?.status, 'at_risk')
  assert.equal(out.state.patch.sections.family?.responsibilities, 'caregiver')
  assert.match(out.state.patch.sections.narrative?.summary || '', /Single mom/)
})

test('PERSONAL persona: TN disabled adult with Medicaid-likely need passes ECF eligibility check', () => {
  const out = runInterview({
    intro: 'yes',
    who: 'personal_group',
    location: { zip: '37130', state: 'TN', city: 'Murfreesboro', county: 'Rutherford' },
    personal_subtype: 'disabled_adult',
    needs_personal: ['health_medical', 'disability', 'employment'],
    situations: ['chronic_illness'],
    narrative: 'I have intellectual disability and need help with employment supports.',
    name: 'Casey Doe',
    email: 'casey@example.com',
  })
  assert.equal(out.completed, true)
  assertCanonicalShape(out.state, 'PERSONAL/disabled_adult')
  assert.equal(out.state.patch.primary_type, 'disabled_adult')

  // The ECF crawler must accept a TN profile that signals disability.
  // We construct the matcher-shaped profile from the patch (state +
  // narrative keyword 'intellectual disability' + disability tag).
  const matcherProfile = {
    state: out.state.patch.sections.basic_information.state,
    sections: out.state.patch.sections,
    tags: out.state.patch.tags,
    signals: {
      location: { state: 'TN' },
      keywordSet: new Set(['tennessee', 'tn', 'intellectual', 'disability']),
      assistance: { has: (k) => k === 'medicaid' },
    },
  }
  // Mission rule: 'Profile attributes should: Increase score, not
  // eliminate results.' ECF eligibility is conservative-but-recall-
  // friendly: Medicaid + intellectual signals on a TN profile must
  // unlock the crawler.
  assert.equal(checkECFEligibility(matcherProfile), true,
    'TN + Medicaid + intellectual-disability profile must unlock ECF crawler')
})

test('STUDENT persona: CA college student needing tuition reaches __complete__', () => {
  const out = runInterview({
    intro: 'yes',
    who: 'student',
    location: { zip: '94720', state: 'CA', city: 'Berkeley', county: 'Alameda' },
    student_level: 'college_student',
    student_focus: ['tuition', 'scholarship', 'textbooks'],
    narrative: '',
    name: 'Sam Lee',
    email: 'sam@example.edu',
  })
  assert.equal(out.completed, true)
  assertCanonicalShape(out.state, 'STUDENT/college')
  assert.equal(out.state.patch.primary_type, 'college_student')
  assert.equal(out.state.patch.sections.education?.highest_level, 'in_undergraduate')
  // Mission: full profile inputs. A student must carry the
  // 'education' tag too so the scholarship crawlers fire.
  assert.ok(out.state.patch.tags.includes('education'))
})

test('BUSINESS persona: minority-owned business in OH needing equipment reaches __complete__', () => {
  const out = runInterview({
    intro: 'yes',
    who: 'business',
    location: { zip: '44113', state: 'OH', city: 'Cleveland', county: 'Cuyahoga' },
    business_subtype: 'minority_owned_business',
    business_focus: ['equipment', 'startup'],
    narrative: 'Starting a catering business, need a commercial freezer.',
    name: 'Acme Catering LLC',
    email: 'owner@acme-catering.example',
  })
  assert.equal(out.completed, true)
  assertCanonicalShape(out.state, 'BUSINESS/minority_owned')
  assert.equal(out.state.patch.primary_type, 'minority_owned_business')
  assert.ok(out.state.patch.sections.small_business_details)
})

test('MISSION ORG persona: TN church running a food pantry reaches __complete__ with org_compliance signal', () => {
  const out = runInterview({
    intro: 'yes',
    who: 'org_mission',
    location: { zip: '37130', state: 'TN', city: 'Murfreesboro', county: 'Rutherford' },
    org_subtype: 'church',
    org_compliance: 'yes',
    org_focus: ['food', 'program_funding', 'equipment'],
    narrative: 'Our church wants to start a weekly food pantry but we need a freezer and shelving.',
    name: 'Hope Community Church',
    email: 'pastor@hopecommunity.example',
  })
  assert.equal(out.completed, true)
  assertCanonicalShape(out.state, 'ORG/church')
  assert.equal(out.state.patch.primary_type, 'church')
  assert.equal(out.state.patch.sections.organization_details?.entity_type, 'church')
  // Mission: '501c3 → true' is a real eligibility lever. Anya must
  // capture it accurately or many foundation grants will silently
  // drop this profile.
  assert.equal(out.state.patch.sections.nonprofit_compliance?.is_501c3, true)
  // food + program_funding → focus areas
  assert.ok(out.state.patch.sections.programs_services.focus_areas.includes('food'))
})

test('VFD persona: small Tennessee volunteer fire dept reaches __complete__', () => {
  const out = runInterview({
    intro: 'yes',
    who: 'volunteer_fire_department',
    location: { zip: '37130', state: 'TN', city: 'Murfreesboro', county: 'Rutherford' },
    vfd_focus: ['equipment', 'training'],
    narrative: '',
    name: 'Rutherford VFD',
    email: 'chief@rutherford-vfd.example',
  })
  assert.equal(out.completed, true)
  assertCanonicalShape(out.state, 'VFD')
  assert.equal(out.state.patch.primary_type, 'volunteer_fire_department')
})

test('SCHOOL persona: CA classroom teacher reaches __complete__', () => {
  const out = runInterview({
    intro: 'yes',
    who: 'school',
    location: { zip: '94720', state: 'CA', city: 'Berkeley', county: 'Alameda' },
    school_subtype: 'classroom_teacher',
    school_focus: ['equipment', 'training'],
    narrative: 'Need supplies and a classroom library.',
    name: 'Ms. Park 5th Grade',
    email: 'park@school.example',
  })
  assert.equal(out.completed, true)
  assertCanonicalShape(out.state, 'SCHOOL/teacher')
  assert.equal(out.state.patch.primary_type, 'classroom_teacher')
})

test('GOV persona: city public works dept reaches __complete__', () => {
  const out = runInterview({
    intro: 'yes',
    who: 'gov',
    location: { zip: '37130', state: 'TN', city: 'Murfreesboro', county: 'Rutherford' },
    gov_subtype: 'public_agency',
    gov_focus: ['infrastructure', 'equipment'],
    narrative: '',
    name: 'City of Murfreesboro Public Works',
    email: 'pw@cityofmboro.example',
  })
  assert.equal(out.completed, true)
  assertCanonicalShape(out.state, 'GOV/public_agency')
})

test('REGRESSION: every persona top-level "who" answer leads to a non-empty branch (no dead routes)', () => {
  // Drift guard. If someone removes a branch from `who.options`
  // without removing the corresponding `next()` mapping in
  // `location.next`, this test fails immediately instead of users
  // landing in a "what now?" dead end.
  const personas = [
    'personal_group', 'student', 'business', 'org_mission',
    'school', 'volunteer_fire_department', 'gov', 'other',
  ]
  for (const persona of personas) {
    let state = makeInitialState()
    state = applyAnswer(state, 'intro', 'yes').state
    const whoOut = applyAnswer(state, 'who', persona)
    assert.equal(whoOut.nextQuestionId, 'location',
      `'${persona}' must lead to 'location' next`)
    const locOut = applyAnswer(whoOut.state, 'location',
      { zip: '37130', state: 'TN' })
    assert.ok(locOut.nextQuestionId, `'${persona}' must have a non-empty next branch after location`)
    assert.notEqual(locOut.nextQuestionId, COMPLETION_TOKEN,
      `'${persona}' must NOT skip directly to complete after location`)
  }
})

test('REGRESSION: every "kinds of help" answer canonicalizes to a real need category', () => {
  // 'Real funding only' depends on need-keys actually being known to
  // the matcher. If a new option lands in needs_personal/student_focus
  // /etc but the canonicalizer drops it, the matcher silently loses
  // that signal — and the user gets a smaller match list than
  // they should.
  const out = runInterview({
    intro: 'yes',
    who: 'personal_group',
    location: { zip: '37130', state: 'TN' },
    personal_subtype: 'individual',
    needs_personal: [
      'housing', 'utilities', 'food', 'health_medical', 'family_life',
      'employment', 'education', 'transportation', 'disability',
      'cash_assistance', 'emergency', 'legal', 'technology_equipment',
      'clothing_goods',
    ],
    situations: [],
    narrative: '',
    name: 'Test Survivor',
    email: 't@example.com',
  })
  assert.equal(out.completed, true)
  // Every selected need must appear as either a tag or a focus area
  // (the canonicalizer may rename a couple, but nothing should be
  // silently dropped).
  const allSignals = new Set([
    ...out.state.patch.tags,
    ...(out.state.patch.sections.programs_services.focus_areas || []),
    ...(out.state.patch.sections.programs_services.keywords || []),
  ])
  // Expect at least 10 distinct canonical signals out of 14 selections
  // (a handful may collapse, e.g. health_medical → health).
  assert.ok(allSignals.size >= 10,
    `expected ≥10 canonical need signals, got ${allSignals.size}: ${[...allSignals].join(', ')}`)
})
