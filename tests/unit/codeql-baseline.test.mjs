import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  assertCurrentScanContext,
  assertFullScanBaselineMetadata,
  assertFullScanSarif,
  compareToBaseline,
  countQualifyingFindings,
} from '../../scripts/check-codeql-baseline.mjs'

function sarif({
  ruleId = 'js/example',
  severity = '8.2',
  precision = 'high',
  count = 1,
  incrementalMode = '',
  extensionNames = [],
  semanticVersion = '2.26.2',
  queries = ['security-extended'],
} = {}) {
  return {
    version: '2.1.0',
    runs: [{
      tool: {
        driver: { name: 'CodeQL', semanticVersion, rules: [] },
        extensions: [
          {
            name: 'codeql/javascript-queries',
            rules: [{
              id: ruleId,
              properties: {
                'security-severity': severity,
                precision,
              },
            }],
          },
          ...extensionNames.map((name) => ({ name, rules: [] })),
        ],
      },
      properties: {
        ...(incrementalMode ? { incrementalMode } : {}),
        codeqlConfigSummary: { queries },
      },
      results: Array.from({ length: count }, (_, index) => ({
        ruleId,
        message: { text: `finding ${index}` },
      })),
    }],
  }
}

const fullBaseline = {
  schema_version: 2,
  generated_from: {
    repository: 'buckeye7066/GrantFlow',
    commit: 'a'.repeat(40),
    event_name: 'push',
    scan_mode: 'full',
    workflow_run_id: 1,
    artifact_id: 2,
    artifact_digest: `sha256:${'b'.repeat(64)}`,
    generated_at: '2026-08-06T00:00:00Z',
  },
  policy: {
    minimum_security_severity: 7,
    allowed_precisions: ['high', 'very-high'],
  },
  counts_by_rule: { 'js/example': 1 },
  total: 1,
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

test('full SARIF and full baseline provenance pass scope validation', () => {
  assert.doesNotThrow(() => assertFullScanSarif([sarif()]))
  assert.doesNotThrow(() => assertFullScanBaselineMetadata(fullBaseline))
  assert.doesNotThrow(() => assertCurrentScanContext({ eventName: 'push', sha: 'c'.repeat(40) }))
})

test('diff-informed SARIF is rejected by mode or PR-diff extension', () => {
  assert.throws(
    () => assertFullScanSarif([sarif({ incrementalMode: 'diff-informed' })]),
    { code: 'diff_informed_sarif_not_allowed' },
  )
  assert.throws(
    () => assertFullScanSarif([sarif({ extensionNames: ['codeql-action/pr-diff-range'] })]),
    { code: 'diff_informed_sarif_not_allowed' },
  )
})

test('every run in every SARIF document must be a full scan', () => {
  const mixed = sarif()
  mixed.runs.push(sarif({ incrementalMode: 'diff-informed' }).runs[0])
  assert.throws(
    () => assertFullScanSarif([sarif(), mixed]),
    { code: 'diff_informed_sarif_not_allowed' },
  )
})

test('full-scan SARIF requires CodeQL version and query metadata', () => {
  assert.throws(
    () => assertFullScanSarif([sarif({ semanticVersion: '' })]),
    { code: 'full_scan_metadata_missing' },
  )
  assert.throws(
    () => assertFullScanSarif([sarif({ queries: [] })]),
    { code: 'full_scan_metadata_missing' },
  )
})

test('baseline provenance rejects schema 1 and pull-request sources', () => {
  assert.throws(
    () => assertFullScanBaselineMetadata({ ...fullBaseline, schema_version: 1 }),
    { code: 'baseline_full_scan_metadata_missing' },
  )
  assert.throws(
    () => assertFullScanBaselineMetadata({
      ...fullBaseline,
      generated_from: { ...fullBaseline.generated_from, event_name: 'pull_request' },
    }),
    { code: 'baseline_source_event_not_full_scan' },
  )
})

test('current scan context allows only full-scan events and exact SHAs', () => {
  for (const eventName of ['push', 'schedule', 'workflow_dispatch']) {
    assert.doesNotThrow(() => assertCurrentScanContext({ eventName, sha: 'd'.repeat(40) }))
  }
  assert.throws(
    () => assertCurrentScanContext({ eventName: 'pull_request', sha: 'd'.repeat(40) }),
    { code: 'current_scan_event_not_full_scan' },
  )
  assert.throws(
    () => assertCurrentScanContext({ eventName: 'push', sha: 'short' }),
    { code: 'current_scan_sha_invalid' },
  )
})

test('CodeQL runs a full-scan baseline gate on branch pushes before merge', () => {
  const workflow = fs.readFileSync(
    new URL('../../.github/workflows/codeql.yml', import.meta.url),
    'utf8',
  )
  assert.match(workflow, /\n\s+push:\s*\n/)
  assert.doesNotMatch(workflow, /push:\s*\n\s+branches:\s*\[main\]/)
  assert.match(workflow, /github\.event_name != 'pull_request'/)
  assert.match(workflow, /name: Require full-scan SARIF output/)
  assert.match(workflow, /if \[ -z "\$CODEQL_SARIF_OUTPUT" \]/)
  assert.match(
    workflow,
    /name: Enforce reviewed full-scan CodeQL baseline\s*\n\s*if: github\.event_name != 'pull_request'/,
  )
})
