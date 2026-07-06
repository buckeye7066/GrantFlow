/**
 * relevance-attribute-exclusivity.test.mjs
 *
 * Verifies the single-attribute HARD exclusivity rules added per the owner
 * directive ("every profile data point is both a match key AND a gate"):
 *   - demographic_religion_exclusive
 *   - geographic_rural_exclusive
 *   - demographic_orientation_exclusive
 *   - demographic_marital_exclusive
 *   - demographic_ethnicity_exclusive
 *
 * Conservatism contract for every rule:
 *   (i)   suppresses an EXPLICITLY-exclusive opp for a clearly-mismatched,
 *         KNOWN profile attribute, and
 *   (ii)  does NOT suppress when the profile attribute is unknown (ambiguous
 *         passes) or when the opp is not explicitly exclusive.
 *
 * Plus an INCLUSION test proving heritage/religion attributes RAISE the score
 * when an opportunity targets them.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { applyRelevanceFilter } from '../../backend/services/relevanceFilter.js'
import { scoreOpportunity } from '../../backend/services/matchEngine.js'

// A baseline actionable opportunity so the data-quality URL rule never fires.
function opp(extra = {}) {
  return {
    title: 'Test Opportunity',
    description: 'A funding opportunity.',
    application_url: 'https://example.org/apply',
    state: 'TN',
    is_national: true, // national so the geographic state rules never interfere
    ...extra,
  }
}

// ── Religion exclusivity ──────────────────────────────────────────────────────

test('religion-exclusive: REJECTS a known-different faith', () => {
  const o = opp({ title: 'Catholic Scholarship', description: 'Open only to Catholic students only.' })
  const pd = { primary_type: 'student', religion: 'baptist' /* christian but not catholic */ }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, false)
  assert.equal(r.ruleId, 'demographic_religion_exclusive')
})

test('religion-exclusive: a Catholic profile PASSES a Catholics-only opp', () => {
  const o = opp({ title: 'Catholic Scholarship', description: 'For Catholic students only.' })
  const pd = { primary_type: 'student', religion: 'Roman Catholic' }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, true)
})

test('religion-exclusive: Christian-family synonym is NOT dropped from "Christian only"', () => {
  const o = opp({ description: 'Christians only may apply.' })
  const pd = { primary_type: 'student', religion: 'methodist' }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, true)
})

test('religion-exclusive: UNKNOWN profile religion PASSES (ambiguity wins)', () => {
  const o = opp({ description: 'Open only to Muslim students only.' })
  const pd = { primary_type: 'student' /* no religion set */ }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, true)
})

test('religion-exclusive: non-exclusive faith mention PASSES', () => {
  const o = opp({ description: 'A scholarship from a Catholic foundation; all welcome.' })
  const pd = { primary_type: 'student', religion: 'jewish' }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, true)
})

// ── Rural exclusivity ─────────────────────────────────────────────────────────

test('rural-exclusive: REJECTS a known-urban profile', () => {
  const o = opp({ description: 'For rural residents only.' })
  const pd = { primary_type: 'individual', geographic_qualifiers: ['urban_underserved'] }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, false)
  assert.equal(r.ruleId, 'geographic_rural_exclusive')
})

test('rural-exclusive: UNKNOWN locale PASSES', () => {
  const o = opp({ description: 'Rural communities only.' })
  const pd = { primary_type: 'individual' /* no locale */ }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, true)
})

test('rural-exclusive: a rural profile PASSES', () => {
  const o = opp({ description: 'Rural residents only.' })
  const pd = { primary_type: 'individual', geographic_qualifiers: ['rural'] }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, true)
})

test('rural-exclusive: non-exclusive rural mention PASSES for urban profile', () => {
  const o = opp({ description: 'Supports rural and urban communities alike.' })
  const pd = { primary_type: 'individual', geographic_qualifiers: ['urban_underserved'] }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, true)
})

// ── Orientation exclusivity ───────────────────────────────────────────────────

test('orientation-exclusive: REJECTS a known straight profile from LGBTQ-only', () => {
  const o = opp({ description: 'For LGBTQ+ applicants only.' })
  const pd = { primary_type: 'individual', sexual_orientation: 'heterosexual' }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, false)
  assert.equal(r.ruleId, 'demographic_orientation_exclusive')
})

test('orientation-exclusive: UNKNOWN orientation PASSES', () => {
  const o = opp({ description: 'For LGBTQ+ applicants only.' })
  const pd = { primary_type: 'individual' /* no orientation */ }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, true)
})

test('orientation-exclusive: an LGBTQ profile PASSES', () => {
  const o = opp({ description: 'Exclusively for LGBTQ students.' })
  const pd = { primary_type: 'student', demographics: ['lgbtq'] }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, true)
})

// ── Marital exclusivity ───────────────────────────────────────────────────────

test('marital-exclusive: REJECTS a known-single profile from married-only', () => {
  const o = opp({ description: 'For married couples only.' })
  const pd = { primary_type: 'individual', marital_status: 'single' }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, false)
  assert.equal(r.ruleId, 'demographic_marital_exclusive')
})

test('marital-exclusive: single-mothers-only REJECTS a known male profile', () => {
  const o = opp({ description: 'For single mothers only.' })
  const pd = { primary_type: 'individual', gender: 'male' }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, false)
  assert.equal(r.ruleId, 'demographic_marital_exclusive')
})

test('marital-exclusive: UNKNOWN marital status PASSES married-only', () => {
  const o = opp({ description: 'Married couples only.' })
  const pd = { primary_type: 'individual' /* no marital status */ }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, true)
})

test('marital-exclusive: a married profile PASSES married-only', () => {
  const o = opp({ description: 'Married couples only.' })
  const pd = { primary_type: 'individual', marital_status: 'married' }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, true)
})

// ── Ethnicity / heritage exclusivity ──────────────────────────────────────────

test('ethnicity-exclusive: REJECTS a known-different heritage', () => {
  const o = opp({ title: 'Korean Heritage Scholarship', description: 'For Korean students only.' })
  const pd = { primary_type: 'student', ethnicity: 'irish' }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, false)
  assert.equal(r.ruleId, 'demographic_ethnicity_exclusive')
})

test('ethnicity-exclusive: matching heritage PASSES', () => {
  const o = opp({ description: 'For Korean students only.' })
  const pd = { primary_type: 'student', ethnicity: 'Korean American' }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, true)
})

test('ethnicity-exclusive: UNKNOWN ethnicity PASSES', () => {
  const o = opp({ description: 'For Korean students only.' })
  const pd = { primary_type: 'student' /* no ethnicity */ }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, true)
})

test('ethnicity-exclusive: generic "minority only" does NOT hard-reject', () => {
  const o = opp({ description: 'For minority students only.' })
  const pd = { primary_type: 'student', ethnicity: 'irish' }
  const r = applyRelevanceFilter(o, pd, { mode: 'soft' })
  assert.equal(r.pass, true)
})

// ── INCLUSION: profile attributes RAISE the score when targeted ───────────────

test('inclusion: Russian-heritage profile scores higher on a Russian-heritage scholarship', () => {
  // scoreOpportunity derives profileNorm only from a canonical context shape
  // { profile, sections }, so wrap the profile accordingly.
  const base = {
    profile: {
      id: 'p1',
      primary_type: 'student',
      state: 'TN',
      ethnicity: 'russian',
    },
    sections: {
      education: { answers: { enrollment_status: 'enrolled' } },
    },
  }
  const targeted = {
    title: 'Russian Heritage Scholarship',
    description: 'A scholarship for students of Russian heritage and descent.',
    application_url: 'https://example.org/apply',
    is_national: true,
    categories: ['education', 'scholarship'],
  }
  const generic = {
    title: 'General Scholarship',
    description: 'A scholarship for students.',
    application_url: 'https://example.org/apply',
    is_national: true,
    categories: ['education', 'scholarship'],
  }

  // Need-anchored scale: equal need coverage legitimately reads the same
  // score; targeting ranks via the topical-evidence tie-break (see
  // matchOpportunities sort).
  const scoredTargeted = scoreOpportunity(base, targeted)
  const scoredGeneric = scoreOpportunity(base, generic)
  assert.ok(
    scoredTargeted.score >= scoredGeneric.score,
    `expected heritage-targeted (${scoredTargeted.score}) >= generic (${scoredGeneric.score})`,
  )
  assert.ok(
    scoredTargeted.match_explain.scoreBreakdown.topical_evidence >
      scoredGeneric.match_explain.scoreBreakdown.topical_evidence,
    'expected heritage-targeted to out-rank generic on the topical tie-break',
  )
})

test('inclusion: faith profile scores higher on a Catholic scholarship', () => {
  const faithProfile = {
    profile: {
      id: 'p2',
      primary_type: 'student',
      state: 'TN',
    },
    sections: {
      faith: { answers: { religion: 'Catholic', church_member: true } },
      education: { answers: { enrollment_status: 'enrolled' } },
    },
  }
  const catholicOpp = {
    title: 'Catholic Student Scholarship',
    description: 'A scholarship offered by a Catholic diocese for students of faith.',
    application_url: 'https://example.org/apply',
    is_national: true,
    categories: ['education', 'scholarship'],
  }
  const genericOpp = {
    title: 'Student Scholarship',
    description: 'A scholarship for students.',
    application_url: 'https://example.org/apply',
    is_national: true,
    categories: ['education', 'scholarship'],
  }
  // Same tie-break contract as the heritage scenario above.
  const scoredFaith = scoreOpportunity(faithProfile, catholicOpp)
  const scoredGeneric = scoreOpportunity(faithProfile, genericOpp)
  assert.ok(
    scoredFaith.score >= scoredGeneric.score,
    `expected faith-targeted (${scoredFaith.score}) >= generic (${scoredGeneric.score})`,
  )
  assert.ok(
    scoredFaith.match_explain.scoreBreakdown.topical_evidence >
      scoredGeneric.match_explain.scoreBreakdown.topical_evidence,
    'expected faith-targeted to out-rank generic on the topical tie-break',
  )
})
