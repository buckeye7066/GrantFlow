import test from 'node:test'
import assert from 'node:assert/strict'
import { makeInitialState, applyAnswer } from '../../backend/services/anyaInterviewEngine.js'
import { resolveEffectiveProfileType } from '../../backend/services/profileHelpers.js'
import { computeProfileCompletionGate } from '../../backend/services/profileCompletionGate.js'

for (const [type, name] of [
  ['individual', 'Foundation Journey Tester'],
  ['individual', 'Jordan Church'],
  ['family', 'Church family'],
]) {
  test(`an explicit ${type} choice is not replaced by organization words in ${name}`, () => {
    let state = makeInitialState()
    for (const [question, answer] of [
      ['personal_subtype', type],
      ['location', { zip: '37312', state: 'TN', city: 'Cleveland', county: 'Bradley' }],
      ['needs_personal', ['utilities']],
      ['name', name],
    ]) {
      state = applyAnswer(state, question, answer).state
    }
    assert.equal(state.patch.sections.basic_information.profile_type, type)
    assert.equal(resolveEffectiveProfileType(state.patch, state.patch.sections), type)
    assert.deepEqual(state.patch.sections.financial_information.assistance_needs, ['utilities'])
    const gate = computeProfileCompletionGate(state.patch, state.patch.sections)
    assert.equal(gate.type_class.isOrg, false)
    assert.deepEqual(gate.missing.map((question) => question.id), ['financial_need'])
    state.patch.sections.financial_information.financial_need_level = 'high'
    assert.equal(computeProfileCompletionGate(state.patch, state.patch.sections).complete, true)
  })
}

test('legacy unclassified organization profiles still use their existing name inference', () => {
  assert.equal(resolveEffectiveProfileType({ primary_type: 'individual', display_name: 'Community Foundation' }, {}), 'nonprofit')
})

test('specific structured organization evidence still wins over a generic personal default', () => {
  assert.equal(resolveEffectiveProfileType(
    { primary_type: 'individual', display_name: 'Example applicant' },
    { basic_information: { profile_type: 'individual' }, organization_details: { organization_type: 'church' } },
  ), 'church')
})
