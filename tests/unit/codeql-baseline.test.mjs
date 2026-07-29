import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compareToBaseline,
  countQualifyingFindings,
} from '../../scripts/check-codeql-baseline.mjs'

function sarif({ ruleId = 'js/example', severity = '8.2', precision = 'high', count = 1 } = {}) {
  return {
    version: '2.1.0',
    runs: [{
      tool: {
        driver: { name: 'CodeQL', rules: [] },
        extensions: [{
          name: 'codeql/javascript-queries',
          rules: [{
            id: ruleId,
            properties: {
              'security-severity': severity,
              precision,
            },
          }],
        }],
      },
      results: Array.from({ length: count }, (_, index) => ({
        ruleId,
        message: { text: `finding ${index}` },
      })),
    }],
  }
}

test('countQualifyingFindings includes only high-severity high-precision results', () => {
  const counts = countQualifyingFindings([
    sarif({ ruleId: 'js/high', severity: '8.1', precision: 'very-high', count: 2 }),
    sarif({ ruleId: 'js/low-severity', severity: '6.9', precision: 'very-high', count: 4 }),
    sarif({ ruleId: 'js/low-precision', severity: '9.0', precision: 'medium', count: 3 }),
  ], {
    minimum_security_severity: 7,
    allowed_precisions: ['high', 'very-high'],
  })

  assert.deepEqual(counts, { 'js/high': 2 })
})

test('compareToBaseline allows reductions', () => {
  const result = compareToBaseline(
    { 'js/existing': 2 },
    { counts_by_rule: { 'js/existing': 5 }, total: 5 },
  )
  assert.equal(result.ok, true)
  assert.equal(result.current_total, 2)
})

test('compareToBaseline blocks a new qualifying rule', () => {
  const result = compareToBaseline(
    { 'js/existing': 2, 'js/new': 1 },
    { counts_by_rule: { 'js/existing': 5 }, total: 5 },
  )
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.reason === 'new_high_confidence_rule'))
})

test('compareToBaseline blocks an increased rule count', () => {
  const result = compareToBaseline(
    { 'js/existing': 6 },
    { counts_by_rule: { 'js/existing': 5 }, total: 5 },
  )
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.reason === 'finding_count_increased'))
  assert.ok(result.failures.some((failure) => failure.reason === 'total_high_confidence_findings_increased'))
})
