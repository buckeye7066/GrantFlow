/**
 * Canonical matching-authority sweep.
 *
 * These tests enforce the repo rules:
 *   1. backend/services/matchEngine.js is the canonical implementation.
 *   2. backend/services/matchDecisionEngine.js is a thin re-export shim.
 *   3. backend/services/matchingEngine.js is a scoring-only compatibility
 *      shim (calculateMatchScore === scoreOpportunity); it is NOT an
 *      acceptance authority.
 *   4. computeMatchDecision(rawProfile, rawOpportunity, opts?) is the sole
 *      acceptance authority. The historical 4-arg shape
 *      (profile, opp, precomputedScore, precomputedReasons) does not exist
 *      as a contract.
 *   5. Deprecated fake-data seeders (backend/scripts/create-orgs-and-grants.mjs
 *      and scripts/prepopulate-grant-matches.mjs) hard-fail on load.
 *   6. itemCrawler's mapDecisionToPersistedFields() helper performs the
 *      camelCase -> snake_case mapping without silently dropping fields.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// 1. Canonical engine exports
// ---------------------------------------------------------------------------

test('matchEngine.js exports the canonical API', async () => {
  const m = await import('../../backend/services/matchEngine.js')
  assert.equal(typeof m.computeMatchDecision, 'function')
  assert.equal(typeof m.scoreOpportunity, 'function')
  assert.equal(typeof m.matchOpportunities, 'function')
  assert.equal(typeof m.makeDecision, 'function')
  assert.equal(typeof m.normalizeProfile, 'function')
  assert.equal(typeof m.normalizeOpportunity, 'function')
  assert.equal(typeof m.MATCHER_VERSION, 'string')
  assert.ok(/^[0-9]+\.[0-9]+\.[0-9]+$/.test(m.MATCHER_VERSION))
})

test('matchDecisionEngine.js is a pure re-export of matchEngine.js', async () => {
  const shim = await import('../../backend/services/matchDecisionEngine.js')
  const canonical = await import('../../backend/services/matchEngine.js')
  assert.strictEqual(shim.computeMatchDecision, canonical.computeMatchDecision)
  assert.strictEqual(shim.scoreOpportunity, canonical.scoreOpportunity)
  assert.strictEqual(shim.matchOpportunities, canonical.matchOpportunities)
  assert.strictEqual(shim.makeDecision, canonical.makeDecision)
  assert.strictEqual(shim.normalizeProfile, canonical.normalizeProfile)
  assert.strictEqual(shim.normalizeOpportunity, canonical.normalizeOpportunity)
  assert.strictEqual(shim.MATCHER_VERSION, canonical.MATCHER_VERSION)
})

test('matchingEngine.js is a scoring-only legacy shim over scoreOpportunity', async () => {
  const legacy = await import('../../backend/services/matchingEngine.js')
  const canonical = await import('../../backend/services/matchEngine.js')
  assert.equal(typeof legacy.calculateMatchScore, 'function')
  // Behaves identically to canonical scoreOpportunity for a concrete input.
  const profile = { state: 'OH', applicant_type: 'individual' }
  const opp = {
    title: 'Ohio Emergency Assistance',
    sponsor: 'State of Ohio',
    description: 'Emergency housing and utilities assistance for Ohio residents.',
    states: ['OH'],
    application_url: 'https://example.org/apply',
  }
  const a = legacy.calculateMatchScore(profile, opp)
  const b = canonical.scoreOpportunity(profile, opp)
  assert.equal(a.score, b.score)
  assert.deepEqual(a.reasons, b.reasons)
})

// ---------------------------------------------------------------------------
// 2. computeMatchDecision canonical signature and return shape
// ---------------------------------------------------------------------------

test('computeMatchDecision accepts (profile, opp, opts?) only; extra args are irrelevant', async () => {
  const { computeMatchDecision } = await import('../../backend/services/matchEngine.js')
  const profile = { state: 'OH', applicant_type: 'individual', tags: ['housing'] }
  const opp = {
    title: 'National Emergency Housing Assistance',
    sponsor: 'Example Foundation',
    description: 'Emergency housing support nationwide.',
    categories: ['housing'],
    keywords: ['housing', 'rental'],
    is_national: true,
    application_url: 'https://example.org/apply',
  }

  // With canonical 2-arg call.
  const twoArg = computeMatchDecision(profile, opp)

  // Passing (profile, opp, fakeScore, fakeReasons) must NOT change the decision.
  // If it did, a caller could spoof acceptance by feeding pre-computed scores.
  const fourArg = computeMatchDecision(profile, opp, 100, ['fake reason'])

  assert.equal(
    twoArg.decision,
    fourArg.decision,
    'extra positional args must not alter the canonical decision',
  )
  assert.equal(twoArg.score, fourArg.score, 'extra positional args must not alter score')
})

test('computeMatchDecision returns the canonical camelCase shape', async () => {
  const { computeMatchDecision, MATCHER_VERSION } = await import(
    '../../backend/services/matchEngine.js'
  )
  const profile = { state: 'OH', applicant_type: 'individual' }
  const opp = {
    title: 'Example Grant',
    sponsor: 'Example',
    description: 'Housing assistance in Ohio.',
    states: ['OH'],
    categories: ['housing'],
    application_url: 'https://example.org/apply',
  }
  const d = computeMatchDecision(profile, opp)
  const required = [
    'score', 'reasons', 'match_explain',
    'decision', 'explanation', 'eligible',
    'ineligibilityReasons', 'matchedNeeds', 'matchedProfileTraits',
    'missingEligibilityFields', 'needAlignment', 'confidence',
    'matcherVersion', 'evaluatedAt',
  ]
  for (const key of required) {
    assert.ok(key in d, `decision missing required field "${key}"`)
  }
  assert.equal(d.matcherVersion, MATCHER_VERSION)
  assert.ok(['ACCEPT', 'REVIEW', 'REJECT'].includes(d.decision))
})

// ---------------------------------------------------------------------------
// 3. itemCrawler persistence mapper: camelCase -> snake_case, no silent drops
// ---------------------------------------------------------------------------

test('mapDecisionToPersistedFields maps every canonical field', async () => {
  const { mapDecisionToPersistedFields } = await import(
    '../../backend/services/itemCrawler.js'
  )
  const decision = {
    decision: 'ACCEPT',
    explanation: 'Because housing.',
    matchedNeeds: ['housing'],
    eligible: true,
    ineligibilityReasons: [],
    confidence: 82,
    matcherVersion: '4.0.0',
    evaluatedAt: '2026-01-01T00:00:00.000Z',
  }
  const mapped = mapDecisionToPersistedFields(decision, {
    effectiveDecision: 'ACCEPT',
    fallbackScore: 55,
  })
  assert.deepEqual(mapped, {
    match_decision: 'ACCEPT',
    match_explanation: 'Because housing.',
    matched_needs: ['housing'],
    eligibility_status: true,
    ineligibility_reasons: [],
    match_confidence: 82,
    matcher_version: '4.0.0',
    evaluated_at: '2026-01-01T00:00:00.000Z',
  })
})

test('mapDecisionToPersistedFields never silently drops canonical fields (regression for stale itemCrawler reading snake_case)', async () => {
  const { mapDecisionToPersistedFields } = await import(
    '../../backend/services/itemCrawler.js'
  )
  // Simulate the exact shape the canonical engine returns today.
  const decision = {
    decision: 'REVIEW',
    explanation: 'Manual review',
    matchedNeeds: ['utilities', 'housing'],
    eligible: 'maybe',
    ineligibilityReasons: ['Missing state match'],
    confidence: 60,
    matcherVersion: '4.0.0',
    evaluatedAt: '2026-02-02T00:00:00.000Z',
  }
  const mapped = mapDecisionToPersistedFields(decision, { effectiveDecision: 'REVIEW' })
  // Regression: before the fix every one of these snake_case fields was
  // silently null/[] because itemCrawler was reading decision.matched_needs
  // etc. which didn't exist.
  assert.deepEqual(mapped.matched_needs, ['utilities', 'housing'])
  assert.equal(mapped.eligibility_status, 'maybe')
  assert.deepEqual(mapped.ineligibility_reasons, ['Missing state match'])
  assert.equal(mapped.matcher_version, '4.0.0')
  assert.equal(mapped.evaluated_at, '2026-02-02T00:00:00.000Z')
})

test('mapDecisionToPersistedFields falls back to snake_case input for defensive interop', async () => {
  const { mapDecisionToPersistedFields } = await import(
    '../../backend/services/itemCrawler.js'
  )
  const decision = {
    decision: 'ACCEPT',
    explanation: null,
    matched_needs: ['food'],
    eligibility_status: true,
    ineligibility_reasons: [],
    confidence: 70,
    matcher_version: '4.0.0',
    evaluated_at: '2026-03-03T00:00:00.000Z',
  }
  const mapped = mapDecisionToPersistedFields(decision, { effectiveDecision: 'ACCEPT' })
  assert.deepEqual(mapped.matched_needs, ['food'])
  assert.equal(mapped.eligibility_status, true)
  assert.equal(mapped.matcher_version, '4.0.0')
})

test('mapDecisionToPersistedFields never relabels a match score as confidence', async () => {
  const { mapDecisionToPersistedFields } = await import(
    '../../backend/services/itemCrawler.js'
  )
  const mapped = mapDecisionToPersistedFields(
    { decision: 'REVIEW', confidence: null },
    { fallbackScore: 99 },
  )
  assert.equal(mapped.match_confidence, null)
})

// ---------------------------------------------------------------------------
// 4. Deprecated fake-data seeders must hard-fail on load
// ---------------------------------------------------------------------------

function runNode(scriptPath) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: REPO_ROOT,
    timeout: 15000,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'development' },
  })
}

test('backend/scripts/create-orgs-and-grants.mjs is hard-disabled', () => {
  const result = runNode(
    path.join(REPO_ROOT, 'backend', 'scripts', 'create-orgs-and-grants.mjs'),
  )
  assert.notEqual(result.status, 0, 'deprecated script must exit non-zero')
  const combined = (result.stderr || '') + (result.stdout || '')
  assert.match(
    combined,
    /DEPRECATED.*computeMatchDecision/,
    'error message must explain why the script is disabled',
  )
})

test('scripts/prepopulate-grant-matches.mjs is hard-disabled', () => {
  const result = runNode(
    path.join(REPO_ROOT, 'scripts', 'prepopulate-grant-matches.mjs'),
  )
  assert.notEqual(result.status, 0, 'deprecated script must exit non-zero')
  const combined = (result.stderr || '') + (result.stdout || '')
  assert.match(
    combined,
    /DEPRECATED.*computeMatchDecision/,
    'error message must explain why the script is disabled',
  )
})

// ---------------------------------------------------------------------------
// 5. Active seeders do NOT import from the legacy matchingEngine.js
// ---------------------------------------------------------------------------

test('scripts/seed-profile-grants.mjs does not import from the legacy shim', async () => {
  const fs = await import('node:fs/promises')
  const src = await fs.readFile(
    path.join(REPO_ROOT, 'scripts', 'seed-profile-grants.mjs'),
    'utf8',
  )
  assert.doesNotMatch(
    src,
    /from\s+['"][^'"\n]*matchingEngine\.js['"]/,
    'seed-profile-grants.mjs must not import from matchingEngine.js legacy shim',
  )
  assert.match(
    src,
    /computeMatchDecision/,
    'seed-profile-grants.mjs must call computeMatchDecision',
  )
})

test('scripts/seed-matched-grants.mjs does not import from the legacy shim', async () => {
  const fs = await import('node:fs/promises')
  const src = await fs.readFile(
    path.join(REPO_ROOT, 'scripts', 'seed-matched-grants.mjs'),
    'utf8',
  )
  assert.doesNotMatch(
    src,
    /from\s+['"][^'"\n]*matchingEngine\.js['"]/,
    'seed-matched-grants.mjs must not import from matchingEngine.js legacy shim',
  )
  assert.match(src, /computeMatchDecision/)
})

test('scripts/prepopulate-profile-grants.mjs uses computeMatchDecision as sole acceptance authority', async () => {
  const fs = await import('node:fs/promises')
  const src = await fs.readFile(
    path.join(REPO_ROOT, 'scripts', 'prepopulate-profile-grants.mjs'),
    'utf8',
  )
  assert.doesNotMatch(
    src,
    /from\s+['"][^'"\n]*matchingEngine\.js['"]/,
    'prepopulate-profile-grants.mjs must not import from the legacy shim',
  )
  assert.match(src, /computeMatchDecision\(/)
})

// ---------------------------------------------------------------------------
// 6. Retired profile-intelligence scorers remain outside runtime authority
// ---------------------------------------------------------------------------

test('runtime code does not import the retired profile-intelligence decision engines', async () => {
  const fs = await import('node:fs/promises')
  const backendRoot = path.join(REPO_ROOT, 'backend')
  const retiredModules = new Set([
    path.join(backendRoot, 'services', 'profileIntelligence', 'eligibilityFilter.js'),
    path.join(backendRoot, 'services', 'profileIntelligence', 'relevanceScorer.js'),
  ])
  const offenders = []

  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'tests' || entry.name === 'node_modules') continue
        await walk(absolute)
        continue
      }
      if (!/\.(?:js|mjs)$/.test(entry.name) || retiredModules.has(absolute)) continue
      const source = await fs.readFile(absolute, 'utf8')
      if (
        /(?:from\s*|import\s*\(|require\s*\()\s*['"][^'"\n]*(?:profileIntelligence\/)?(?:relevanceScorer|eligibilityFilter)\.js['"]/.test(source)
      ) {
        offenders.push(path.relative(REPO_ROOT, absolute))
      }
    }
  }

  await walk(backendRoot)
  assert.deepEqual(
    offenders,
    [],
    'retired 0–100 scorers are test fixtures only; runtime decisions must use computeMatchDecision',
  )
})

// ---------------------------------------------------------------------------
// 7. Docs match code truth (MATCHER_VERSION)
// ---------------------------------------------------------------------------

test('docs/matching-architecture.md references the current MATCHER_VERSION', async () => {
  const fs = await import('node:fs/promises')
  const { MATCHER_VERSION } = await import('../../backend/services/matchEngine.js')
  const doc = await fs.readFile(
    path.join(REPO_ROOT, 'docs', 'matching-architecture.md'),
    'utf8',
  )
  assert.match(
    doc,
    // Escape every regex metacharacter (incl. backslash), not just `.`
    // (js/incomplete-sanitization).
    new RegExp(`MATCHER_VERSION[^\\n]{0,80}${MATCHER_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    `docs must reference the current MATCHER_VERSION (${MATCHER_VERSION}) near the top`,
  )
  assert.match(
    doc,
    /backend\/services\/matchEngine\.js/,
    'docs must name matchEngine.js as the canonical implementation',
  )
  assert.match(
    doc,
    /compatibility re-export/i,
    'docs must describe matchDecisionEngine.js as a compat re-export',
  )
})
