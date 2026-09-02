import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NEED_COVERAGE_DETAIL,
  declaredNeedsFrom,
  evaluateDeclaredNeedCoverage,
} from '../../backend/services/pipelinePrecision.js'

test('empty common sections do not manufacture declared needs', () => {
  const sections = {
    housing: {},
    education: {},
    employment: {},
    health_medical: {},
    family_life: {},
  }
  assert.deepEqual(declaredNeedsFrom({}, sections), [])
})

test('unknown profile need evidence fails automated admission', () => {
  const result = evaluateDeclaredNeedCoverage(
    { need_types_supported: ['education'] },
    [],
  )
  assert.equal(result.pass, false)
  assert.equal(result.detail, NEED_COVERAGE_DETAIL.PROFILE_DECLARES_NO_NEEDS)
})

test('unknown opportunity need evidence fails automated admission', () => {
  const result = evaluateDeclaredNeedCoverage({}, ['education'])
  assert.equal(result.pass, false)
  assert.equal(result.detail, NEED_COVERAGE_DETAIL.OPPORTUNITY_STATES_NO_NEEDS)
})

test('one explicit canonical overlap passes', () => {
  const result = evaluateDeclaredNeedCoverage(
    { need_types_supported: ['education', 'housing'] },
    ['education'],
  )
  assert.equal(result.pass, true)
  assert.equal(result.detail, NEED_COVERAGE_DETAIL.MATCHED)
  assert.deepEqual(result.matched, ['education'])
})

test('explicit non-overlap fails', () => {
  const result = evaluateDeclaredNeedCoverage(
    { need_types_supported: ['housing'] },
    ['education'],
  )
  assert.equal(result.pass, false)
  assert.equal(result.detail, NEED_COVERAGE_DETAIL.UNCOVERED)
})
