/**
 * Contract tests for the Anya conversational onboarding engine.
 *
 * Goals these tests guard:
 *   - Goal 5: every persona branch leads to a complete profile patch.
 *   - Goal 7: the question tree is finite, terminating, and adaptive
 *     (different branches for different personas).
 *   - Goal 9: every answer surfaces canonical signals the matching engine
 *     and crawlers actually consume — no off-vocabulary need ids.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyAnswer,
  COMPLETION_TOKEN,
  FIRST_QUESTION_ID,
  getFirstQuestion,
  getQuestion,
  makeInitialState,
  QUESTIONS,
  serializeQuestion,
} from '../../backend/services/anyaInterviewEngine.js'
import { NEED_ALIAS_MAP } from '../../backend/services/profileNormalizer.js'
import { canonicalizeProfileTypeId } from '../../shared/profileTypeOptions.js'

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------
function walk(answers) {
  let state = makeInitialState()
  let qid = FIRST_QUESTION_ID
  const visited = []
  const seen = new Set()
  while (qid !== COMPLETION_TOKEN) {
    if (seen.has(qid)) {
      throw new Error(`Loop detected: ${[...visited, qid].join(' → ')}`)
    }
    seen.add(qid)
    visited.push(qid)
    const q = QUESTIONS[qid]
    if (!q) throw new Error(`Missing question: ${qid}`)
    const a = answers[qid]
    const result = applyAnswer(state, qid, a === undefined ? defaultAnswerFor(q) : a)
    state = result.state
    qid = result.nextQuestionId
  }
  visited.push(COMPLETION_TOKEN)
  return { state, visited }
}

function defaultAnswerFor(q) {
  switch (q.kind) {
    case 'announce': return null
    case 'choice': return q.options?.[0]?.value ?? null
    case 'multi_choice': return q.options?.length ? [q.options[0].value] : []
    case 'location': return { zip: '37205', state: 'TN', city: 'Nashville', county: 'Davidson' }
    case 'long_text': return 'We need help running a small community garden.'
    case 'text': return 'Test Profile'
    case 'email': return 'test@example.com'
    default: return null
  }
}

// ---------------------------------------------------------------------------
// Tree contract
// ---------------------------------------------------------------------------
test('first question id is language', () => {
  assert.equal(FIRST_QUESTION_ID, 'language')
  assert.ok(getFirstQuestion())
  // The language step must lead into the welcome (intro) step.
  assert.equal(QUESTIONS.language.next(applyAnswer(makeInitialState(), 'language', 'en').state), 'intro')
})

test('every question id referenced by next() exists', () => {
  for (const [id, q] of Object.entries(QUESTIONS)) {
    // Try every plausible answer to flush all next() branches
    const samples = q.kind === 'multi_choice'
      ? (q.options?.map((opt) => [opt.value]) ?? [[]])
      : q.kind === 'choice'
        ? (q.options?.map((opt) => opt.value) ?? [null])
        : [defaultAnswerFor(q)]
    for (const a of samples) {
      let appliedState
      try {
        appliedState = q.apply(makeInitialState(), a)
      } catch {
        continue
      }
      const nextId = q.next(appliedState)
      if (nextId === COMPLETION_TOKEN) continue
      assert.ok(QUESTIONS[nextId], `question "${id}" → "${nextId}" does not exist`)
    }
  }
})

test('serializeQuestion drops fns and exposes prompt + options', () => {
  const wire = serializeQuestion(getQuestion('who'))
  assert.equal(wire.id, 'who')
  assert.equal(wire.kind, 'choice')
  assert.ok(Array.isArray(wire.options))
  assert.ok(wire.prompt.length > 0)
  assert.equal(typeof wire.apply, 'undefined')
  assert.equal(typeof wire.next, 'undefined')
})

// ---------------------------------------------------------------------------
// Adaptive branching
// ---------------------------------------------------------------------------
test('personal branch routes through personal_subtype + needs + situations', () => {
  const { visited, state } = walk({
    intro: null,
    who: 'personal_group',
    location: { zip: '37205', state: 'TN' },
    personal_subtype: 'family',
    needs_personal: ['housing', 'food', 'health_medical'],
    situations: ['caregiver'],
    narrative: 'We are raising three kids on one paycheck.',
    name: 'Smith Family',
    email: 'smith@example.com',
  })
  assert.deepEqual(visited.slice(0, 7), [
    'language', 'intro', 'who', 'location', 'personal_subtype', 'needs_personal', 'situations',
  ])
  assert.equal(state.patch.primary_type, 'family')
  assert.equal(state.patch.email, 'smith@example.com')
  assert.equal(state.patch.display_name, 'Smith Family')
  assert.equal(state.patch.sections.basic_information.zip_code, '37205')
  assert.equal(state.patch.sections.basic_information.state, 'TN')
  assert.equal(state.patch.sections.family.responsibilities, 'caregiver')
  assert.ok(state.patch.tags.includes('housing'))
  assert.ok(state.patch.tags.includes('food'))
})

test('student branch skips org_compliance and routes through education focus', () => {
  const { visited, state } = walk({
    intro: null,
    who: 'student',
    location: { zip: '90210', state: 'CA' },
    student_level: 'college_student',
    student_focus: ['tuition', 'textbooks', 'housing'],
    narrative: 'First-generation college student studying nursing.',
    name: 'Jordan Lee',
    email: 'jordan@example.edu',
  })
  assert.ok(!visited.includes('org_compliance'))
  assert.ok(!visited.includes('situations'))
  assert.ok(visited.includes('student_focus'))
  assert.equal(state.patch.primary_type, 'college_student')
  assert.equal(state.patch.sections.education.highest_level, 'in_undergraduate')
  assert.ok(state.patch.tags.includes('education'))
})

test('volunteer fire department branch skips subtype and goes straight to vfd_focus', () => {
  const { visited, state } = walk({
    intro: null,
    who: 'volunteer_fire_department',
    location: { zip: '24901', state: 'WV' },
    vfd_focus: ['ppe', 'training', 'apparatus'],
    narrative: 'Need replacement turnout gear.',
    name: 'Greenbrier VFD',
    email: 'chief@gvfd.example',
  })
  assert.ok(visited.includes('vfd_focus'))
  assert.ok(!visited.some((v) => v.includes('subtype')))
  assert.equal(state.patch.primary_type, 'volunteer_fire_department')
  assert.ok(state.patch.tags.includes('public_safety'))
})

test('mission org branch includes org_compliance', () => {
  const { visited, state } = walk({
    intro: null,
    who: 'org_mission',
    location: { zip: '37205', state: 'TN' },
    org_subtype: 'church',
    org_compliance: 'yes',
    org_focus: ['food', 'housing', 'community_facilities'],
    narrative: 'Weekly food pantry expansion.',
    name: 'Hope Community Church',
    email: 'pastor@hcc.example',
  })
  assert.ok(visited.includes('org_compliance'))
  assert.equal(state.patch.primary_type, 'church')
  assert.equal(state.patch.sections.nonprofit_compliance.is_501c3, true)
  assert.equal(state.patch.sections.organization_details.entity_type, 'church')
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
test('email question rejects malformed addresses', () => {
  const state = makeInitialState()
  assert.throws(() => applyAnswer(state, 'email', 'not-an-email'), /valid email/i)
  // empty
  assert.throws(() => applyAnswer(state, 'email', ''), /need an email/i)
})

test('location question rejects missing zip and state', () => {
  const state = makeInitialState()
  assert.throws(() => applyAnswer(state, 'location', { zip: '', state: '' }))
  assert.throws(() => applyAnswer(state, 'location', { zip: '37205', state: '' }))
  assert.throws(() => applyAnswer(state, 'location', { zip: 'abc', state: 'TN' }))
})

test('multi-choice questions reject empty selections unless optional', () => {
  const personalState = applyAnswer(makeInitialState(), 'intro', null).state
  const whoState = applyAnswer(personalState, 'who', 'personal_group').state
  const locState = applyAnswer(whoState, 'location', { zip: '37205', state: 'TN' }).state
  const subState = applyAnswer(locState, 'personal_subtype', 'individual').state
  assert.throws(() => applyAnswer(subState, 'needs_personal', []))
  // situations is optional and accepts empty
  const needsState = applyAnswer(subState, 'needs_personal', ['food']).state
  const result = applyAnswer(needsState, 'situations', [])
  assert.equal(result.nextQuestionId, 'narrative')
})

// ---------------------------------------------------------------------------
// Canonical-vocabulary guards (mission rule: keep the matching engine in sync)
// ---------------------------------------------------------------------------
test('every multi_choice option value resolves through NEED_ALIAS_MAP or is a known business/equipment keyword', () => {
  // Canonical bucket NAMES (the values in NEED_ALIAS_MAP, like
  // "technology_equipment", "health_medical", "family_life") are also fine
  // since `normalizeNeedCategory` returns them as-is.
  const CANONICAL_BUCKETS = new Set(Object.values(NEED_ALIAS_MAP))
  // These are non-need keywords used by org/vfd/gov/school branches that the
  // matching engine handles via tags. They MUST stay in this list — adding
  // more silently broadens the canonical needs vocabulary.
  const ALLOWED_NON_NEED_KEYS = new Set([
    'startup', 'equipment', 'inventory', 'building', 'training',
    'public_safety', 'apparatus', 'ppe', 'communications', 'wildland',
    'medical_supplies', 'recruitment', 'classroom_supplies',
    'special_education', 'stem_curriculum', 'safety',
    'parks_recreation', 'broadband', 'economic_development',
    'community_facilities', 'capacity_building', 'program_funding',
    // Public-sector / municipal infrastructure terms — these become tags
    // and focus_areas keywords that the matching engine surfaces directly.
    'infrastructure', 'water', 'fellowship',
  ])
  // The `situations` question intentionally uses life-event labels (e.g.
  // "recently_laid_off", "caregiver", "in_recovery") that are NOT canonical
  // need ids — they are written to dedicated section structures
  // (employment, family, health_medical, housing) instead. So we exclude
  // that question from the canonical-need vocabulary guard.
  const VOCAB_EXEMPT_QUESTIONS = new Set(['situations'])

  for (const [qid, q] of Object.entries(QUESTIONS)) {
    if (q.kind !== 'multi_choice') continue
    if (VOCAB_EXEMPT_QUESTIONS.has(qid)) continue
    for (const opt of q.options ?? []) {
      const v = String(opt.value ?? '')
      if (!v) continue
      if (NEED_ALIAS_MAP[v]) continue
      if (CANONICAL_BUCKETS.has(v)) continue
      if (ALLOWED_NON_NEED_KEYS.has(v)) continue
      assert.fail(
        `question "${qid}" option "${v}" is neither in NEED_ALIAS_MAP nor in the allowed non-need keyword list`,
      )
    }
  }
})

test('every choice option that becomes a primary_type canonicalizes to a real id', () => {
  const TYPE_QUESTIONS = ['personal_subtype', 'student_level', 'business_subtype', 'org_subtype', 'school_subtype', 'gov_subtype']
  for (const qid of TYPE_QUESTIONS) {
    const q = QUESTIONS[qid]
    for (const opt of q.options ?? []) {
      const canonical = canonicalizeProfileTypeId(opt.value)
      assert.equal(
        canonical,
        opt.value,
        `question "${qid}" option "${opt.value}" did not canonicalize cleanly (got "${canonical}")`,
      )
    }
  }
})

test('answer→profile-patch fidelity: needs_personal records canonical needs as tags + focus_areas', () => {
  const start = applyAnswer(makeInitialState(), 'intro', null).state
  const who = applyAnswer(start, 'who', 'personal_group').state
  const loc = applyAnswer(who, 'location', { zip: '37205', state: 'TN' }).state
  const sub = applyAnswer(loc, 'personal_subtype', 'individual').state
  const needs = applyAnswer(sub, 'needs_personal', ['housing', 'food', 'employment']).state
  assert.deepEqual(
    [...new Set(needs.patch.tags)].sort(),
    ['employment', 'food', 'housing'],
  )
  assert.deepEqual(
    [...new Set(needs.patch.sections.programs_services.focus_areas)].sort(),
    ['employment', 'food', 'housing'],
  )
  // Side-effects: housing intent → housing.status; employment intent → employment.current_status
  assert.equal(needs.patch.sections.housing.status, 'at_risk')
  assert.equal(needs.patch.sections.employment.current_status, 'unemployed_seeking')
})

test('answer→profile-patch fidelity: situations writes structured section signals', () => {
  const start = applyAnswer(makeInitialState(), 'intro', null).state
  const who = applyAnswer(start, 'who', 'personal_group').state
  const loc = applyAnswer(who, 'location', { zip: '37205', state: 'TN' }).state
  const sub = applyAnswer(loc, 'personal_subtype', 'individual').state
  const needs = applyAnswer(sub, 'needs_personal', ['food']).state
  const sit = applyAnswer(needs, 'situations', ['recently_laid_off', 'caregiver', 'in_recovery']).state
  assert.equal(sit.patch.sections.employment.current_status, 'unemployed_seeking')
  assert.equal(sit.patch.sections.family.responsibilities, 'caregiver')
  assert.equal(sit.patch.sections.health_medical.has_active_need, true)
  assert.ok(sit.patch.tags.includes('recently_laid_off'))
})
