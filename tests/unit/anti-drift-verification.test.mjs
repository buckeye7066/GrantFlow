/**
 * Anti-drift verification test.
 *
 * Validates that:
 * 1. All centralized config modules load and export expected constants
 * 2. matchDecisionEngine delegates to matchEngine (no duplicate logic)
 * 3. Scoring thresholds are consistent across all consumers
 * 4. URL validation rules are centralized
 * 5. A fresh profile with a fresh opportunity set returns results
 * 6. No zero-result state for any profile type with data present
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ── 1. Centralized configs load and export expected values ──────────────

test('matchThresholds exports all required constants', async () => {
  const thresholds = await import('../../backend/config/matchThresholds.js')

  assert.ok(typeof thresholds.SCORE_FLOOR === 'number', 'SCORE_FLOOR')
  assert.ok(typeof thresholds.W_NEED === 'number', 'W_NEED')
  assert.ok(typeof thresholds.W_ELIGIBILITY === 'number', 'W_ELIGIBILITY')
  assert.ok(typeof thresholds.W_GEO === 'number', 'W_GEO')
  assert.ok(typeof thresholds.W_CATEGORY === 'number', 'W_CATEGORY')

  const weightSum = thresholds.W_NEED + thresholds.W_ELIGIBILITY + thresholds.W_GEO + thresholds.W_CATEGORY
  assert.ok(Math.abs(weightSum - 1.0) < 0.001, `weights must sum to 1.0, got ${weightSum}`)

  assert.ok(typeof thresholds.DEFAULT_MIN_SCORE === 'number', 'DEFAULT_MIN_SCORE')
  assert.ok(Array.isArray(thresholds.RELAX_THRESHOLDS), 'RELAX_THRESHOLDS must be array')
  assert.ok(thresholds.RELAX_THRESHOLDS.length >= 2, 'must have at least 2 relaxation steps')
  assert.ok(typeof thresholds.FALLBACK_TOP_N === 'number', 'FALLBACK_TOP_N')
  assert.ok(typeof thresholds.ACCEPT_SCORE === 'number', 'ACCEPT_SCORE')
  assert.ok(typeof thresholds.REVIEW_SCORE === 'number', 'REVIEW_SCORE')
  assert.ok(typeof thresholds.ADMIN_SEED_MIN_SCORE === 'number', 'ADMIN_SEED_MIN_SCORE')

  assert.ok(thresholds.ACCEPT_SCORE > thresholds.REVIEW_SCORE, 'ACCEPT > REVIEW')
  assert.ok(thresholds.REVIEW_SCORE > thresholds.SCORE_FLOOR, 'REVIEW > FLOOR')
})

test('urlRules exports all required functions and sets', async () => {
  const rules = await import('../../backend/config/urlRules.js')

  assert.ok(rules.PLACEHOLDER_HOSTNAMES instanceof Set, 'PLACEHOLDER_HOSTNAMES')
  assert.ok(rules.NON_ACTIONABLE_DOMAINS instanceof Set, 'NON_ACTIONABLE_DOMAINS')
  assert.ok(Array.isArray(rules.INVALID_URL_PATTERNS), 'INVALID_URL_PATTERNS')
  assert.ok(Array.isArray(rules.PLACEHOLDER_TEXT_PATTERNS), 'PLACEHOLDER_TEXT_PATTERNS')
  assert.ok(typeof rules.isPlaceholderUrl === 'function', 'isPlaceholderUrl')
  assert.ok(typeof rules.isNonActionableUrl === 'function', 'isNonActionableUrl')
  assert.ok(typeof rules.isPlaceholderText === 'function', 'isPlaceholderText')
  assert.ok(typeof rules.pickRealUrl === 'function', 'pickRealUrl')
  assert.ok(typeof rules.extractHostname === 'function', 'extractHostname')
})

test('grantsGovEndpoints exports required URLs', async () => {
  const endpoints = await import('../../backend/config/grantsGovEndpoints.js')

  assert.ok(typeof endpoints.GRANTS_GOV_SEARCH2_URL === 'string', 'GRANTS_GOV_SEARCH2_URL')
  assert.ok(endpoints.GRANTS_GOV_SEARCH2_URL.includes('grants.gov'), 'must be grants.gov URL')
  assert.ok(typeof endpoints.SIMPLER_GRANTS_SEARCH_URL === 'string', 'SIMPLER_GRANTS_SEARCH_URL')
  assert.ok(endpoints.SIMPLER_GRANTS_SEARCH_URL.includes('simpler.grants.gov'), 'must be simpler grants URL')
})

// ── 2. matchDecisionEngine delegates to matchEngine (no duplicate logic) ──

test('matchDecisionEngine re-exports from matchEngine (no duplicate implementations)', async () => {
  const mde = await import('../../backend/services/matchDecisionEngine.js')
  const me = await import('../../backend/services/matchEngine.js')

  assert.strictEqual(mde.MATCHER_VERSION, me.MATCHER_VERSION, 'MATCHER_VERSION must match')
  assert.strictEqual(mde.calculateSourceTrust, me.calculateSourceTrust, 'calculateSourceTrust must be same function')
  assert.strictEqual(mde.evaluateEligibility, me.evaluateEligibility, 'evaluateEligibility must be same function')
  assert.strictEqual(mde.calculateNeedAlignment, me.calculateNeedAlignment, 'calculateNeedAlignment must be same function')
  assert.strictEqual(mde.computeMatchDecision, me.computeMatchDecision, 'computeMatchDecision must be same function')
  assert.strictEqual(mde.scoreOpportunity, me.scoreOpportunity, 'scoreOpportunity must be same function')
})

// ── 3. matchEngine uses centralized thresholds ──────────────────────────

test('matchEngine imports thresholds from config (not inline)', async () => {
  const me = await import('../../backend/services/matchEngine.js')
  const cfg = await import('../../backend/config/matchThresholds.js')

  assert.strictEqual(me.SCORE_FLOOR, cfg.SCORE_FLOOR, 'SCORE_FLOOR must come from config')
  assert.strictEqual(me.DEFAULT_MIN_SCORE, cfg.DEFAULT_MIN_SCORE, 'DEFAULT_MIN_SCORE must come from config')
  assert.deepStrictEqual(me.RELAX_THRESHOLDS, cfg.RELAX_THRESHOLDS, 'RELAX_THRESHOLDS must come from config')
})

// ── 4. URL validation rules are consistent ──────────────────────────────

test('urlRules correctly identifies placeholders', async () => {
  const { isPlaceholderUrl, isNonActionableUrl, isPlaceholderText } = await import('../../backend/config/urlRules.js')

  // Placeholders
  assert.ok(isPlaceholderUrl('https://example.com/grant'), 'example.com')
  assert.ok(isPlaceholderUrl('https://example.org/apply'), 'example.org')
  assert.ok(isPlaceholderUrl('https://placeholder.com/'), 'placeholder.com')
  assert.ok(isPlaceholderUrl('https://localhost:3000/'), 'localhost')
  assert.ok(isPlaceholderUrl('javascript:alert(1)'), 'javascript:')
  assert.ok(isPlaceholderUrl(null), 'null')
  assert.ok(isPlaceholderUrl(''), 'empty')
  assert.ok(isPlaceholderUrl('ftp://example.com'), 'ftp protocol')

  // Valid URLs
  assert.ok(!isPlaceholderUrl('https://grants.gov/apply'), 'grants.gov should be valid')
  assert.ok(!isPlaceholderUrl('https://www.hud.gov/program'), 'hud.gov should be valid')
  assert.ok(!isPlaceholderUrl('https://nonprofit.org/grants'), 'nonprofit.org should be valid')

  // Social media
  assert.ok(isNonActionableUrl('https://facebook.com/grants'), 'facebook')
  assert.ok(isNonActionableUrl('https://twitter.com/grants'), 'twitter')
  assert.ok(!isNonActionableUrl('https://grants.gov/search'), 'grants.gov is not social')

  // Placeholder text
  assert.ok(isPlaceholderText('Lorem ipsum dolor sit amet'), 'lorem ipsum')
  assert.ok(isPlaceholderText('TBD'), 'TBD')
  assert.ok(!isPlaceholderText('Ohio Emergency Housing Assistance'), 'real title')
})

test('pickRealUrl finds best URL from opportunity fields', async () => {
  const { pickRealUrl } = await import('../../backend/config/urlRules.js')

  assert.strictEqual(
    pickRealUrl({ application_url: 'https://grants.gov/apply', url: 'https://example.com' }),
    'https://grants.gov/apply',
    'should pick non-placeholder URL'
  )

  assert.strictEqual(
    pickRealUrl({ url: 'https://example.com', source_url: 'https://real.gov/program' }),
    'https://real.gov/program',
    'should skip placeholder url field and use source_url'
  )

  assert.strictEqual(
    pickRealUrl({ url: 'https://example.com', application_url: 'https://example.org' }),
    null,
    'should return null when all URLs are placeholders'
  )
})

// ── 5. Fresh profile + fresh opportunities → results ────────────────────

test('fresh profile scores > 0 against any valid opportunity', async () => {
  const { scoreOpportunity } = await import('../../backend/services/matchEngine.js')
  const { SCORE_FLOOR } = await import('../../backend/config/matchThresholds.js')

  const freshProfile = {
    profile: {
      id: 'fresh-1',
      display_name: 'New User',
      applicant_type: 'individual',
      state: 'OH',
      postal_code: '43215',
    },
    sections: {},
  }

  const opportunity = {
    id: 'opp-1',
    title: 'Ohio Emergency Housing Assistance',
    description: 'Housing help for Ohio residents',
    sponsor: 'Ohio Department of Development',
    state: 'OH',
    source_url: 'https://development.ohio.gov/housing',
    type: 'PROGRAM',
  }

  const result = scoreOpportunity(freshProfile, opportunity)
  assert.ok(result.score >= SCORE_FLOOR, `fresh profile score (${result.score}) must be >= SCORE_FLOOR (${SCORE_FLOOR})`)
  assert.ok(result.score > 0, 'score must never be zero')
  assert.ok(Array.isArray(result.reasons), 'must return reasons array')
})

test('all profile types score > 0 against generic national opportunity', async () => {
  const { scoreOpportunity } = await import('../../backend/services/matchEngine.js')

  const profileTypes = ['individual', 'student', 'nonprofit', 'business', 'veteran', 'church', 'school']

  const nationalOpp = {
    id: 'opp-national',
    title: 'National Resource Directory',
    description: 'Comprehensive resource directory for all Americans',
    sponsor: 'Federal Government',
    is_national: true,
    state: 'nationwide',
    source_url: 'https://nrd.gov/resources',
    type: 'DIRECTORY',
  }

  for (const type of profileTypes) {
    const profile = {
      profile: { id: `fresh-${type}`, applicant_type: type, state: 'OH' },
      sections: {},
    }
    const { score } = scoreOpportunity(profile, nationalOpp)
    assert.ok(score > 0, `${type} profile must score > 0, got ${score}`)
  }
})

// ── 6. matchOpportunities progressive relaxation works ──────────────────

test('matchOpportunities returns results even when minScore is high', async () => {
  const { matchOpportunities } = await import('../../backend/services/matchEngine.js')

  const profile = {
    profile: { id: 'test', applicant_type: 'individual', state: 'OH', postal_code: '43215' },
    sections: {},
  }

  const opps = [
    { id: 'o1', title: 'Generic Resource', description: 'A resource', state: 'OH', source_url: 'https://ohio.gov/resource', type: 'DIRECTORY' },
  ]

  const results = matchOpportunities(profile, opps, { minScore: 99 })
  assert.ok(results.length > 0, 'progressive relaxation must return at least one result')
})

// ── 7. No runtime-only dependencies ─────────────────────────────────────

test('matchEngine loads without any environment variables set', async () => {
  const me = await import('../../backend/services/matchEngine.js')
  assert.ok(typeof me.scoreOpportunity === 'function', 'scoreOpportunity exists')
  assert.ok(typeof me.matchOpportunities === 'function', 'matchOpportunities exists')
  assert.ok(typeof me.computeMatchDecision === 'function', 'computeMatchDecision exists')
  assert.ok(typeof me.MATCHER_VERSION === 'string', 'MATCHER_VERSION exists')
})

test('centralized configs load without database or filesystem', async () => {
  const t = await import('../../backend/config/matchThresholds.js')
  const u = await import('../../backend/config/urlRules.js')
  const g = await import('../../backend/config/grantsGovEndpoints.js')

  assert.ok(Number.isInteger(t.SCORE_FLOOR) && t.SCORE_FLOOR > 0, 'matchThresholds loads cleanly')
  assert.ok(u.PLACEHOLDER_HOSTNAMES.has('example.com'), 'urlRules loads cleanly')
  assert.ok(g.GRANTS_GOV_SEARCH2_URL.length > 0, 'grantsGovEndpoints loads cleanly')
})

// ── 8. Relaxation thresholds are monotonically decreasing ───────────────

test('RELAX_THRESHOLDS are monotonically decreasing', async () => {
  const { RELAX_THRESHOLDS } = await import('../../backend/config/matchThresholds.js')

  for (let i = 1; i < RELAX_THRESHOLDS.length; i++) {
    assert.ok(
      RELAX_THRESHOLDS[i] < RELAX_THRESHOLDS[i - 1],
      `RELAX_THRESHOLDS[${i}]=${RELAX_THRESHOLDS[i]} must be < RELAX_THRESHOLDS[${i - 1}]=${RELAX_THRESHOLDS[i - 1]}`,
    )
  }
})
