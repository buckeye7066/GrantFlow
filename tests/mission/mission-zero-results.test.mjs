/**
 * Mission test suite — zero-result fallback ladder (Phase 6)
 *
 * Mission rule: zero results is a failure state. No blank page without
 * explanation; no irrelevant filler pretending to be a match. The
 * fallback ladder must:
 *   - never return an empty result without an explanation
 *   - mark relaxed results with threshold_relaxed=true + relaxed_reason
 *   - mark directory results with kind=directory
 *   - mark geo-expanded results with geo_expanded=true
 *   - prefer direct opportunities before falling back to directories
 *
 * The suite simulates 50 representative profile/result situations.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { assembleFundingResults, TIERS } from '../../backend/services/zeroResultLadder.js'
import { RELAX_THRESHOLDS, DEFAULT_MIN_SCORE } from '../../backend/config/matchThresholds.js'

function direct(score, extras = {}) {
  return {
    id: extras.id ?? `d-${Math.random().toString(16).slice(2, 8)}`,
    title: extras.title ?? `Direct grant ${score}`,
    kind: 'direct',
    match_score: score,
    match_decision: 'ACCEPT',
    application_url: 'https://example.org/apply',
    source: 'grants.gov',
    ...extras,
  }
}

function directory(extras = {}) {
  return {
    id: extras.id ?? `dir-${Math.random().toString(16).slice(2, 8)}`,
    title: extras.title ?? 'United Way 211',
    kind: 'directory',
    match_score: extras.match_score ?? 30,
    match_decision: 'REVIEW',
    application_url: 'https://www.211.org',
    source: 'united_way_211',
    ...extras,
  }
}

function rejected(extras = {}) {
  return direct(80, { match_decision: 'REJECT', ...extras })
}

const PROFILES = []
for (let i = 0; i < 50; i++) {
  PROFILES.push({ id: `profile-${i}` })
}

test('ladder: returns STRONG_DIRECT when at least one direct opp clears minScore', () => {
  const result = assembleFundingResults([direct(80), direct(45)], { minScore: 50 })
  assert.equal(result.tier, TIERS.STRONG_DIRECT)
  assert.equal(result.opportunities.length, 1)
  assert.equal(result.opportunities[0].match_score, 80)
  assert.equal(result.threshold_relaxed, false)
  assert.ok(result.explanation)
})

test('ladder: drops to RELAXED_DIRECT and marks rows when minScore unmet but lower-scoring direct exists', () => {
  const result = assembleFundingResults([direct(45), direct(35)], { minScore: 70 })
  assert.equal(result.tier, TIERS.RELAXED_DIRECT)
  assert.equal(result.threshold_relaxed, true)
  assert.ok(result.threshold_relaxed_reason)
  for (const opp of result.opportunities) {
    assert.equal(opp.threshold_relaxed, true)
    assert.ok(opp.relaxed_reason)
  }
})

test('ladder: relaxation is GRADUATED on the canonical data-point ladder — the best non-empty band wins, not one jump to zero', () => {
  // The bar is unmet; a top-band 7 and a below-every-band 3 exist. The
  // canonical RELAX_THRESHOLDS ([7, 4, 0]) must surface ONLY the 7 — the
  // retired hardcoded [40, 30, 20, 10, 0] tiers were all >= the bar and
  // degenerated into a single jump to 0 (returning the 3 too).
  //
  // The bar is derived from the ladder itself (top band + 1), NOT from
  // DEFAULT_MIN_SCORE. This fixture originally passed `DEFAULT_MIN_SCORE`
  // while its own comment asserted "Data-point bar (8) unmet" — true when the
  // discovery floor was 8, but #1135 deliberately lowered
  // DISCOVERY_MIN_SCORE_FLOOR to 7 to equal REVIEW_SCORE. From that commit on,
  // `direct(7)` CLEARED the bar, the ladder correctly returned STRONG_DIRECT,
  // and this test asserted RELAXED_DIRECT against a scenario it no longer
  // constructed — it was measuring the floor constant, not graduated
  // relaxation. Anchoring to RELAX_THRESHOLDS keeps the real invariant under
  // test and makes it immune to the next deliberate floor move.
  // (The floor default itself keeps its own dedicated test, immediately below.)
  const barAboveTopBand = RELAX_THRESHOLDS[0] + 1
  const result = assembleFundingResults([direct(7), direct(3)], { minScore: barAboveTopBand })
  assert.equal(result.tier, TIERS.RELAXED_DIRECT)
  assert.equal(result.opportunities.length, 1, 'only the best relax band surfaces')
  assert.equal(result.opportunities[0].match_score, 7)
  // and the graduated steps ARE the canonical ladder (no second relaxation authority)
  assert.ok(RELAX_THRESHOLDS.includes(7) && RELAX_THRESHOLDS.includes(0))
  // The ladder must have MORE than one step, or "graduated" is vacuous.
  assert.ok(RELAX_THRESHOLDS.length >= 2, 'a single-step ladder is one jump to zero')
})

test('ladder: the default minScore is the canonical discovery bar (data-point scale), not a retired-scale constant', () => {
  // A direct opportunity exactly at the canonical bar must be STRONG_DIRECT
  // with NO relaxation when the caller omits minScore. Under the old
  // hardcoded default (25, need-anchored scale) this honest at-bar match was
  // mislabeled threshold_relaxed.
  const result = assembleFundingResults([direct(DEFAULT_MIN_SCORE)], {})
  assert.equal(result.tier, TIERS.STRONG_DIRECT)
  assert.equal(result.threshold_relaxed, false)
})

test('ladder: falls to DIRECTORY when no direct opp exists; marks directory_only=true (mission rule: never blank)', () => {
  const result = assembleFundingResults([directory()], { minScore: 50 })
  assert.equal(result.tier, TIERS.DIRECTORY)
  assert.equal(result.directory_only, true)
  assert.ok(result.opportunities.length > 0)
  assert.ok(/director|referral/i.test(result.explanation))
})

test('ladder: respects directory survival even with strict minScore (mission rule: directories ALWAYS survive)', () => {
  const result = assembleFundingResults([directory({ match_score: 5 })], { minScore: 90 })
  assert.equal(result.tier, TIERS.DIRECTORY)
  assert.equal(result.opportunities.length, 1)
})

test('ladder: GEO_EXPAND when no in-state matches, with marker geo_expanded=true', () => {
  const out = direct(75, { id: 'oos-1' })
  const result = assembleFundingResults([], {
    minScore: 50,
    geoExpansionPool: [out],
  })
  assert.equal(result.tier, TIERS.GEO_EXPAND)
  assert.equal(result.geo_expanded, true)
  assert.equal(result.opportunities[0].geo_expanded, true)
})

test('ladder: PROFILE_GAPS when no results AND profile gaps exist; surfaces what to fix', () => {
  const result = assembleFundingResults([], {
    minScore: 50,
    profileGaps: ['state', 'organization_type'],
  })
  assert.equal(result.tier, TIERS.PROFILE_GAPS)
  assert.deepEqual(result.profile_gaps, ['state', 'organization_type'])
  assert.match(result.explanation, /state/i)
})

test('ladder: EXPLAIN_ZERO when nothing found and no gaps known; honest message, no blank page', () => {
  const result = assembleFundingResults([], { minScore: 50 })
  assert.equal(result.tier, TIERS.EXPLAIN_ZERO)
  assert.equal(result.opportunities.length, 0)
  assert.ok(result.explanation && result.explanation.length > 0, 'must include an honest explanation')
  assert.match(result.explanation, /couldn't find|search/i)
})

test('ladder: REJECT decisions never appear in any tier', () => {
  const result = assembleFundingResults([rejected({ id: 'r1' }), direct(60, { id: 'd1' })], { minScore: 50 })
  assert.equal(result.tier, TIERS.STRONG_DIRECT)
  for (const opp of result.opportunities) {
    assert.notEqual(opp.id, 'r1')
  }
})

test('ladder: prefers direct over directory when both exist (Phase 6 mission rule)', () => {
  const result = assembleFundingResults([directory(), direct(80)], { minScore: 50 })
  assert.equal(result.tier, TIERS.STRONG_DIRECT)
})

test('ladder: caps results to maxResults', () => {
  const many = Array.from({ length: 100 }, (_, i) => direct(70, { id: `m-${i}` }))
  const result = assembleFundingResults(many, { minScore: 50, maxResults: 10 })
  assert.equal(result.opportunities.length, 10)
})

test('ladder: tier_attempts records every step taken (debug/audit visibility)', () => {
  const result = assembleFundingResults([directory()], { minScore: 50 })
  assert.ok(Array.isArray(result.tier_attempts))
  // STRONG_DIRECT, RELAXED_DIRECT (both 0), then DIRECTORY hits.
  assert.ok(result.tier_attempts.length >= 3)
})

// 50-profile sweep — mission rule: no blank page, no placeholder filler.
for (let i = 0; i < PROFILES.length; i++) {
  test(`ladder: profile ${i} — never returns a blank page without explanation`, () => {
    // Randomized but deterministic-by-index fixture
    let scored = []
    let geoPool = []
    let gaps = []

    if (i % 5 === 0) scored = [direct(85)] // strong
    else if (i % 5 === 1) scored = [direct(45), direct(55)] // relaxed
    else if (i % 5 === 2) scored = [directory()] // directory only
    else if (i % 5 === 3) {
      scored = []
      geoPool = [direct(70)] // geo expand
    } else {
      scored = []
      gaps = ['state']
    }

    const result = assembleFundingResults(scored, {
      minScore: 50,
      geoExpansionPool: geoPool,
      profileGaps: gaps,
    })

    // mission rule: every response must have an explanation AND a tier
    assert.ok(result.explanation, `profile ${i}: missing explanation`)
    assert.ok(Object.values(TIERS).includes(result.tier), `profile ${i}: invalid tier ${result.tier}`)

    // mission rule: if zero opps shown, the tier must be PROFILE_GAPS or EXPLAIN_ZERO
    if (result.opportunities.length === 0) {
      assert.ok(
        result.tier === TIERS.PROFILE_GAPS || result.tier === TIERS.EXPLAIN_ZERO,
        `profile ${i}: empty opportunities but tier=${result.tier}; must be PROFILE_GAPS or EXPLAIN_ZERO`,
      )
    }

    // mission rule: relaxed results must be honestly labeled
    if (result.threshold_relaxed) {
      assert.ok(result.threshold_relaxed_reason, `profile ${i}: relaxed without reason`)
    }

    // mission rule: directory-only results must be labeled
    if (result.tier === TIERS.DIRECTORY) {
      assert.equal(result.directory_only, true, `profile ${i}: DIRECTORY tier must set directory_only`)
    }
  })
}
