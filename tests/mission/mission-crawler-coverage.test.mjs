/**
 * Mission test suite — crawler source coverage (Phase 4)
 *
 * Mission rule: every profile gets a crawler coverage report
 * (sources_planned, sources_queried, sources_failed,
 *  direct_opportunities_found, coverage_gaps). For every fixture profile
 * type:
 *   - At least 3 source categories must be queried.
 *   - Direct opportunities must be attempted before directory fallback.
 *   - Failures must be logged.
 *   - No silent zero-source run.
 *   - Grants.gov must NEVER be queried with an empty keyword.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  SOURCE_IDS,
  SOURCES,
  listSources,
  planCoverage,
  buildCoverageReport,
  buildGrantsGovQueryTerms,
} from '../../backend/services/sourceRegistry.js'

const FIXTURES = [
  { name: 'individual', profile: { id: 'p1', primary_type: 'individual', state: 'TN' }, expectMin: 3 },
  { name: 'family', profile: { id: 'p2', primary_type: 'family', state: 'OH' }, expectMin: 3 },
  { name: 'student', profile: { id: 'p3', primary_type: 'student', state: 'CA' }, expectMin: 3 },
  { name: 'church', profile: { id: 'p4', primary_type: 'church', state: 'TX' }, expectMin: 3 },
  { name: 'nonprofit', profile: { id: 'p5', primary_type: 'nonprofit', state: 'NY' }, expectMin: 3 },
  { name: 'school', profile: { id: 'p6', primary_type: 'school', state: 'WA' }, expectMin: 3 },
  { name: 'volunteer_fire', profile: { id: 'p7', primary_type: 'volunteer_fire', state: 'KY' }, expectMin: 3 },
  { name: 'business', profile: { id: 'p8', primary_type: 'business', state: 'IL' }, expectMin: 3 },
  { name: 'ministry', profile: { id: 'p9', primary_type: 'ministry', state: 'AL' }, expectMin: 3 },

  // Phase 4 expansion fixtures — each must hit the same ≥ 3 source-category
  // mission rule. Together they assert the gaps the user identified are
  // closed by the new sourceRegistry entries (county/local government,
  // teacher/classroom, library/parks, tribal, public-health, and
  // specialized nonprofits).
  { name: 'county_government', profile: { id: 'p10', primary_type: 'county_government', state: 'TN' }, expectMin: 3 },
  { name: 'municipality', profile: { id: 'p11', primary_type: 'municipality', state: 'OH' }, expectMin: 3 },
  { name: 'tribal_government', profile: { id: 'p12', primary_type: 'tribal_government', state: 'OK' }, expectMin: 3 },
  { name: 'public_school', profile: { id: 'p13', primary_type: 'public_school', state: 'TN' }, expectMin: 3 },
  { name: 'school_district', profile: { id: 'p14', primary_type: 'school_district', state: 'OH' }, expectMin: 3 },
  { name: 'teacher', profile: { id: 'p15', primary_type: 'teacher', state: 'TN' }, expectMin: 3 },
  { name: 'classroom_teacher', profile: { id: 'p16', primary_type: 'classroom_teacher', state: 'CA' }, expectMin: 3 },
  { name: 'library', profile: { id: 'p17', primary_type: 'library', state: 'TN' }, expectMin: 3 },
  { name: 'parks_department', profile: { id: 'p18', primary_type: 'parks_department', state: 'TN' }, expectMin: 3 },
  { name: 'public_health_department', profile: { id: 'p19', primary_type: 'public_health_department', state: 'TN' }, expectMin: 3 },
  { name: 'animal_rescue', profile: { id: 'p20', primary_type: 'animal_rescue', state: 'TN' }, expectMin: 3 },
  { name: 'food_pantry', profile: { id: 'p21', primary_type: 'food_pantry', state: 'TN' }, expectMin: 3 },
  { name: 'homeless_shelter', profile: { id: 'p22', primary_type: 'homeless_shelter', state: 'TN' }, expectMin: 3 },
]

test('source-registry: every entry declares the required contract fields', () => {
  for (const src of listSources()) {
    assert.ok(src.id, 'source must declare id')
    assert.ok(src.label, `source ${src.id} must declare label`)
    assert.ok(src.trust, `source ${src.id} must declare trust`)
    assert.ok(src.default_kind, `source ${src.id} must declare default_kind`)
    assert.ok(Array.isArray(src.profile_types), `source ${src.id} must declare profile_types[]`)
    assert.ok(Array.isArray(src.needs), `source ${src.id} must declare needs[]`)
    assert.ok(Number.isFinite(src.freshness_days), `source ${src.id} must declare freshness_days`)
    assert.equal(typeof src.verification_required, 'boolean', `source ${src.id} must declare verification_required:boolean`)
    assert.equal(typeof src.directory, 'boolean', `source ${src.id} must declare directory:boolean`)
  }
})

for (const fixture of FIXTURES) {
  test(`coverage-plan: ${fixture.name} plans ≥ ${fixture.expectMin} source categories`, () => {
    const plan = planCoverage({ profile: fixture.profile, signals: { needs: ['equipment', 'training', 'food'] } })
    assert.ok(
      plan.sources_planned.length >= fixture.expectMin,
      `${fixture.name}: planned ${plan.sources_planned.length} sources, expected ≥ ${fixture.expectMin}. plan=${JSON.stringify(plan)}`,
    )
    assert.ok(
      plan.sources_required.length >= 3,
      `${fixture.name}: required ${plan.sources_required.length} sources, expected ≥ 3 (mission rule)`,
    )
  })

  test(`coverage-plan: ${fixture.name} attempts at least one direct source (not directory-only)`, () => {
    const plan = planCoverage({ profile: fixture.profile, signals: { needs: ['community'] } })
    assert.ok(
      plan.direct_sources.length >= 1,
      `${fixture.name}: must attempt at least one DIRECT source before falling back to directories. plan=${JSON.stringify(plan)}`,
    )
  })
}

test('coverage-plan: empty profile produces a non-empty fallback plan (no silent zero-source run)', () => {
  const plan = planCoverage({})
  assert.ok(plan.sources_planned.length >= 1, `empty profile must still plan some sources, got: ${JSON.stringify(plan)}`)
  assert.ok(plan.sources_required.length >= 3, 'mission rule: ≥ 3 required sources for any profile')
})

test('coverage-report: outcomes flow through correctly', () => {
  const plan = planCoverage({ profile: { primary_type: 'volunteer_fire', state: 'KY' } })
  const outcomes = [
    { source_id: SOURCE_IDS.GRANTS_GOV, queried: true, failed: false, found: 5 },
    { source_id: SOURCE_IDS.FEMA_AFG, queried: true, failed: false, found: 2 },
    { source_id: SOURCE_IDS.STATE_PORTAL, queried: true, failed: true, found: 0, error: 'timeout' },
  ]
  const report = buildCoverageReport(plan, outcomes)

  assert.equal(report.profile_type, 'volunteer_fire')
  assert.ok(report.sources_queried.length >= 3, 'must record queried sources')
  assert.equal(report.sources_failed.length, 1)
  assert.equal(report.sources_failed[0].error, 'timeout')
  assert.ok(report.direct_opportunities_found >= 7, 'direct opportunities tracked')
})

test('coverage-report: gaps are surfaced when a required source was not queried', () => {
  const plan = planCoverage({ profile: { primary_type: 'volunteer_fire' } })
  const report = buildCoverageReport(plan, [
    { source_id: SOURCE_IDS.GRANTS_GOV, queried: true, failed: false, found: 1 },
  ])
  assert.ok(report.coverage_gaps.length > 0, 'gaps must be surfaced when sources_required > sources_queried')
})

test('grants.gov: query builder NEVER returns empty terms', () => {
  // Empty profile — mission rule forbids broad blank ZIP search.
  const empty = buildGrantsGovQueryTerms({})
  assert.ok(empty.length > 0, 'must always return at least one search term')
  for (const t of empty) {
    assert.ok(typeof t === 'string' && t.trim().length > 0, `query term must be non-blank string, got: ${JSON.stringify(t)}`)
  }

  // Profile with signals — should reflect them.
  const withProfile = buildGrantsGovQueryTerms({
    profile: { primary_type: 'volunteer_fire' },
    signals: { needs: ['equipment', 'training'] },
  })
  assert.ok(withProfile.some((t) => /volunteer|fire|equipment|training/.test(t)), `profile-derived terms must reflect profile, got: ${JSON.stringify(withProfile)}`)
})

test('grants.gov: nationalZipCrawler no longer calls searchGrants with empty string', () => {
  // Source-level guard. The fix is in nationalZipCrawler.js — assert the
  // legacy `searchGrants('')` pattern is gone so future regressions trip
  // this test.
  const filePath = path.resolve('backend/services/crawlers/nationalZipCrawler.js')
  const text = fs.readFileSync(filePath, 'utf8')
  assert.ok(
    !/searchGrants\(\s*['"]\s*['"]/i.test(text),
    "nationalZipCrawler.js must NOT call searchGrants('') — Phase 4 mission rule forbids broad blank ZIP search",
  )
})

test('source-registry: every source has at least one profile type or is universal', () => {
  for (const src of listSources()) {
    // Universal sources are allowed to declare empty profile_types[]. But if
    // they are profile-targeted, the array must list explicit types.
    if (src.profile_types.length === 0 && src.needs.length === 0) {
      assert.fail(`source ${src.id} has empty profile_types AND empty needs — what does it cover?`)
    }
  }
  // Spot-check: volunteer_fire profiles must have FEMA AFG + USDA Rural Dev.
  assert.ok(SOURCES[SOURCE_IDS.FEMA_AFG].profile_types.includes('volunteer_fire'))
  assert.ok(SOURCES[SOURCE_IDS.USDA_RURAL_DEV].profile_types.includes('volunteer_fire'))
})
