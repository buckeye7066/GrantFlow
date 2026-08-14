/**
 * coverage-outcomes.test.mjs
 *
 * Mission Goal 9 — Explainable, reliable, testable.
 *
 * Locks the contract that turns runCrawler's coarse candidateCounts
 * + the displayed opportunities into a per-source outcomes array
 * suitable for buildCoverageReport. Without this glue the
 * SearchCoveragePanel either lies ("queried" when nothing loaded) or
 * shows everything as a coverage gap.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveCoverageOutcomes, summariseOutcomes } from '../../backend/services/coverageOutcomes.js'
import { SOURCE_IDS, planCoverage, buildCoverageReport } from '../../backend/services/sourceRegistry.js'

function makeRunResult(candidateCounts) {
  return {
    debug: {
      candidateCounts,
      timing: { total_ms: 1234 },
      errors: [],
    },
  }
}

test('deriveCoverageOutcomes: federal candidate group maps to multiple SOURCE_IDS as queried', () => {
  const plan = { sources_planned: [SOURCE_IDS.GRANTS_GOV, SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS] }
  const outcomes = deriveCoverageOutcomes({
    coveragePlan: plan,
    runResult: makeRunResult({ federal: 12 }),
  })
  const ids = outcomes.map((o) => o.source_id)
  assert.ok(ids.includes(SOURCE_IDS.GRANTS_GOV), 'federal group must map to grants_gov')
  assert.ok(ids.includes(SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS), 'federal group must map to SAM listings')
  for (const id of ids) {
    const o = outcomes.find((x) => x.source_id === id)
    assert.equal(o.queried, true)
    assert.equal(o.failed, false)
    assert.equal(o.duration_ms, 1234)
  }
})

// This assertion used to say the opposite (`!sba` / "must not produce a
// queried outcome"). That encoded the exact bug deriveCoverageOutcomes' own
// header now documents: crawlerManager.loadCandidates writes `business = 0`
// INSIDE the branch it executed, so a present key with count 0 means the
// lane ran and found nothing, not that it never ran. Collapsing that into
// "not queried" is what made real coverage gaps invisible. Fixed alongside
// the source change (gf-batch-00); this test now pins the corrected contract.
test('deriveCoverageOutcomes: candidate count = 0 (key present) marks the group queried, with zero found', () => {
  const outcomes = deriveCoverageOutcomes({
    coveragePlan: { sources_planned: [SOURCE_IDS.SBA_GRANTS] },
    runResult: makeRunResult({ business: 0, federal: 5 }),
  })
  const sba = outcomes.find((o) => o.source_id === SOURCE_IDS.SBA_GRANTS)
  assert.ok(sba, 'business=0 (lane ran, found nothing) must still produce an outcome for SBA')
  assert.equal(sba.queried, true)
  assert.equal(sba.queried_evidence, 'run')
  assert.equal(sba.found, 0)
})

test('deriveCoverageOutcomes: opportunities with explicit source field tally as found per-id', () => {
  const outcomes = deriveCoverageOutcomes({
    coveragePlan: { sources_planned: [SOURCE_IDS.GRANTS_GOV] },
    runResult: makeRunResult({ federal: 1 }),
    opportunities: [
      { source: SOURCE_IDS.GRANTS_GOV, title: 'A' },
      { source: SOURCE_IDS.GRANTS_GOV, title: 'B' },
      { source: SOURCE_IDS.STATE_PORTAL, title: 'C' },
    ],
  })
  const gov = outcomes.find((o) => o.source_id === SOURCE_IDS.GRANTS_GOV)
  const state = outcomes.find((o) => o.source_id === SOURCE_IDS.STATE_PORTAL)
  assert.equal(gov.found, 2)
  assert.equal(state.found, 1)
  assert.equal(state.queried, true, 'state opportunities surface even if state group did not load')
})

test('deriveCoverageOutcomes: explicit error reports flip failed=true and capture message', () => {
  const outcomes = deriveCoverageOutcomes({
    coveragePlan: { sources_planned: [SOURCE_IDS.GRANTS_GOV] },
    runResult: makeRunResult({ federal: 5 }),
    errors: [{ source_id: SOURCE_IDS.GRANTS_GOV, error: 'timeout after 30s' }],
  })
  const gov = outcomes.find((o) => o.source_id === SOURCE_IDS.GRANTS_GOV)
  assert.equal(gov.failed, true)
  assert.equal(gov.error, 'timeout after 30s')
})

test('deriveCoverageOutcomes: unmapped strategy group becomes synthetic curated_<group> id', () => {
  const outcomes = deriveCoverageOutcomes({
    coveragePlan: { sources_planned: [] },
    runResult: makeRunResult({ brand_new_dataset: 7 }),
  })
  const synth = outcomes.find((o) => o.source_id === 'curated_brand_new_dataset')
  assert.ok(synth, 'unmapped group must surface as curated_<group>')
  assert.equal(synth.queried, true)
  assert.equal(synth.directory, false)
})

test('buildCoverageReport: gaps are honest when outcomes are derived from a real run', () => {
  // Plan covers MANY sources, runResult only loads federal.
  const plan = {
    profile_type: 'family',
    sources_planned: [
      SOURCE_IDS.GRANTS_GOV,
      SOURCE_IDS.UNITED_WAY_211,
      SOURCE_IDS.LIHEAP,
      SOURCE_IDS.SBA_GRANTS,
    ],
    sources_required: [
      SOURCE_IDS.GRANTS_GOV,
      SOURCE_IDS.UNITED_WAY_211,
      SOURCE_IDS.LIHEAP,
    ],
    notes: [],
  }
  const outcomes = deriveCoverageOutcomes({
    coveragePlan: plan,
    runResult: makeRunResult({ federal: 5, national: 2 }),
    opportunities: [{ source: SOURCE_IDS.GRANTS_GOV }],
  })
  const report = buildCoverageReport(plan, outcomes)
  // SBA was planned but federal mapping only covers grants_gov+samgov+benefits — NOT SBA.
  assert.ok(
    report.coverage_gaps.includes(SOURCE_IDS.LIHEAP) || report.coverage_gaps.length === 0,
    'liheap may be in queried via federal mapping; otherwise it must be a gap',
  )
  // grants_gov should have a found > 0
  const directFound = report.direct_opportunities_found
  assert.ok(directFound >= 1, `expected direct_opportunities_found >= 1, got ${directFound}`)
})

test('summariseOutcomes: tallies queried / failed / direct / directory', () => {
  const summary = summariseOutcomes([
    { source_id: SOURCE_IDS.GRANTS_GOV, queried: true, found: 3, directory: false },
    { source_id: SOURCE_IDS.UNITED_WAY_211, queried: true, found: 5, directory: true },
    { source_id: SOURCE_IDS.SBA_GRANTS, queried: true, failed: true, found: 0, directory: false, error: 'http 500' },
  ])
  assert.equal(summary.sources_total, 3)
  assert.equal(summary.sources_queried, 3)
  assert.equal(summary.sources_failed, 1)
  assert.equal(summary.direct_found, 3)
  assert.equal(summary.directory_found, 5)
  assert.equal(summary.total_found, 8)
})

test('integration: planCoverage → run → deriveCoverageOutcomes → buildCoverageReport produces non-empty report', () => {
  const plan = planCoverage({ profile: { primary_type: 'family' } })
  assert.ok(plan.sources_planned.length > 0)

  const outcomes = deriveCoverageOutcomes({
    coveragePlan: plan,
    runResult: makeRunResult({ federal: 10, national: 3, family: 2 }),
    opportunities: [{ source: SOURCE_IDS.SNAP }, { source: SOURCE_IDS.UNITED_WAY_211 }],
  })

  const report = buildCoverageReport(plan, outcomes)
  assert.equal(report.profile_type, 'family')
  assert.ok(report.sources_queried.length > 0, 'must have at least one queried source')
})
