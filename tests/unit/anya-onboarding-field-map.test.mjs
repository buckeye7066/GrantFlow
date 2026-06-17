import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ANYA_ONBOARDING_FIELD_MAP,
  FIELD_MAP_BY_ID,
  questionsForBranch,
  intakeFieldsCoveredByBranch,
} from '../../backend/services/anya/anyaOnboardingFieldMap.js'
import {
  SUPPORTED_BRANCHES,
  UNIVERSAL_REQUIRED_FIELDS,
  requiredFieldsForBranch,
} from '../../backend/services/anya/anyaOnboardingIntakeContract.js'

test('field map is non-empty and frozen', () => {
  assert.ok(ANYA_ONBOARDING_FIELD_MAP.length > 30)
  assert.ok(Object.isFrozen(ANYA_ONBOARDING_FIELD_MAP))
})

test('every question id is unique', () => {
  const ids = ANYA_ONBOARDING_FIELD_MAP.map((q) => q.question_id)
  const set = new Set(ids)
  assert.equal(set.size, ids.length, 'duplicate question ids found')
})

test('FIELD_MAP_BY_ID indexes every entry', () => {
  for (const q of ANYA_ONBOARDING_FIELD_MAP) {
    assert.equal(FIELD_MAP_BY_ID[q.question_id], q)
  }
})

test('every entry has required shape', () => {
  for (const q of ANYA_ONBOARDING_FIELD_MAP) {
    assert.equal(typeof q.question_id, 'string')
    assert.ok(q.intake_field, `${q.question_id} missing intake_field`)
    assert.ok(q.prompt && q.prompt.length > 5, `${q.question_id} missing prompt`)
    assert.ok(['high', 'medium', 'low'].includes(q.matching_impact), `${q.question_id} bad matching_impact`)
    assert.ok(['high', 'medium', 'low'].includes(q.robert_search_impact), `${q.question_id} bad robert_search_impact`)
    assert.ok(typeof q.required === 'boolean')
    assert.ok(typeof q.sensitive === 'boolean')
    assert.ok(typeof q.readiness_category === 'string')
    assert.ok(Array.isArray(q.maps_to_profile_fields))
  }
})

test('universal required fields are all covered by universal questions', () => {
  const universalCovered = new Set(
    ANYA_ONBOARDING_FIELD_MAP.filter((q) => q.branch === null).map((q) => q.intake_field),
  )
  for (const f of UNIVERSAL_REQUIRED_FIELDS) {
    assert.ok(universalCovered.has(f), `Universal required field "${f}" is not covered by any universal question`)
  }
})

test('every branch covers all of its required fields', () => {
  for (const branch of SUPPORTED_BRANCHES) {
    const required = requiredFieldsForBranch(branch)
    const covered = intakeFieldsCoveredByBranch(branch)
    const missing = required.filter((f) => !covered.has(f))
    assert.deepEqual(missing, [], `Branch ${branch} missing required fields: ${missing.join(', ')}`)
  }
})

test('questionsForBranch returns universal + branch only', () => {
  for (const branch of SUPPORTED_BRANCHES) {
    const qs = questionsForBranch(branch)
    for (const q of qs) {
      assert.ok(q.branch === null || q.branch === branch, `${q.question_id} leaked into ${branch}`)
    }
  }
})

test('sensitive questions all carry rationale-style language', () => {
  const sensitive = ANYA_ONBOARDING_FIELD_MAP.filter((q) => q.sensitive)
  assert.ok(sensitive.length > 0)
  for (const q of sensitive) {
    const text = q.prompt.toLowerCase()
    const hasRationaleHint =
      text.includes('optional') ||
      text.includes('private') ||
      text.includes('only share') ||
      text.includes('skip') ||
      text.includes('helps us') ||
      text.includes('many ') ||
      text.includes('comfortable')
    assert.ok(hasRationaleHint, `Sensitive ${q.question_id} has no rationale hint: ${q.prompt}`)
  }
})

test('every non-universal entry references a known branch', () => {
  for (const q of ANYA_ONBOARDING_FIELD_MAP) {
    if (q.branch === null) continue
    assert.ok(SUPPORTED_BRANCHES.includes(q.branch), `Unknown branch ${q.branch} on ${q.question_id}`)
  }
})

test('high-impact universal questions write at least one profile field', () => {
  for (const q of ANYA_ONBOARDING_FIELD_MAP) {
    if (q.branch !== null) continue
    if (q.matching_impact !== 'high') continue
    assert.ok(q.maps_to_profile_fields.length > 0, `${q.question_id} (high impact) writes no profile field`)
  }
})
