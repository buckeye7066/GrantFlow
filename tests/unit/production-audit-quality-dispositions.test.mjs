import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../../scripts/production-audit/db-audit.mjs', import.meta.url), 'utf8')

test('below-threshold audit measures only decisions that can surface', () => {
  const finding = source.slice(
    source.indexOf("id: 'below_threshold_surfaced'"),
    source.indexOf("id: 'reject_shown_as_review'"),
  )
  assert.match(finding, /match_decision[^\n]+IN \('accept', 'review'\)/)
})

test('profile discovery provenance is not mislabeled as catalog contamination', () => {
  assert.match(source, /id: 'catalog_profile_provenance'/)
  assert.match(source, /profile_id is discovery provenance rather than ownership/)
  assert.doesNotMatch(source, /id: 'catalog_contamination'/)
})

test('Amy audit preserves exact-cohort dispositions instead of only derived issue totals', () => {
  assert.match(source, /'amy_flywheel_cohort'/)
  assert.match(source, /finding_types: latest\.finding_types/)
  assert.match(source, /run_receipts: latest\.run_receipts/)
  assert.match(source, /issue_examples: latest\.issue_examples/)
})
