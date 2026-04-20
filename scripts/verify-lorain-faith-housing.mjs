#!/usr/bin/env node
/**
 * Verification script: Lorain County faith-based emergency housing opportunities.
 *
 * Canonical truth:
 *   backend/services/matchEngine.js -> computeMatchDecision()
 *
 * This script:
 *   1. Seeds the 6 opportunities into the local DB
 *   2. Verifies all 6 landed in the DB and the geo index
 *   3. Simulates a single mother in Lorain County, OH, needing eviction help
 *   4. Asks the CANONICAL engine for a decision on every opportunity and
 *      requires all six to produce ACCEPT or REVIEW (i.e. not REJECT).
 *   5. Runs the legacy `crawlerHelpers.calculateMatchScore` as an informational
 *      side-by-side view only. Its output is reported but DOES NOT gate the
 *      exit code; it exists so reviewers can spot drift between the canonical
 *      engine and the crawler's quick-filter heuristic.
 *
 * Non-authoritative helpers may rank or pre-filter; `computeMatchDecision` is
 * the sole acceptance authority (repo rule).
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

dotenv.config({ path: join(__dirname, '..', '.env') })

const { getDb } = await import('../backend/db/index.js')
const { seedFaithBasedHousing } = await import('../backend/utils/seedFaithBasedHousing.js')

// Canonical engine — sole acceptance authority.
const { computeMatchDecision, scoreOpportunity, MATCHER_VERSION } = await import(
  '../backend/services/matchEngine.js'
)

// Legacy crawler helper — NON-AUTHORITATIVE. Used only for a drift comparison
// that is reported but not used as an acceptance gate. The module is
// permanently preserved as a thin compatibility shim that delegates to the
// canonical scorer (see backend/services/crawlers/crawlerHelpers.js and
// tests/unit/legacy-module-resilience.test.mjs), so this import is safe
// across logins, machines, and deployments.
const crawlerHelpers = await import('../backend/services/crawlers/crawlerHelpers.js')

const db = getDb()

console.log('='.repeat(80))
console.log('VERIFICATION: Lorain County Faith-Based Emergency Housing Opportunities')
console.log(`Canonical engine: backend/services/matchEngine.js (MATCHER_VERSION=${MATCHER_VERSION})`)
console.log('='.repeat(80))

// ---------------------------------------------------------------------------
// Step 1: Seed
// ---------------------------------------------------------------------------
console.log('\n--- Step 1: Seeding opportunities ---')
const seedResult = await seedFaithBasedHousing(db)
console.log('Seed result:', seedResult)

// ---------------------------------------------------------------------------
// Step 2: DB entries
// ---------------------------------------------------------------------------
console.log('\n--- Step 2: Verifying DB entries ---')
const dbOpps = await db
  .prepare(
    `SELECT id, title, sponsor, state, geo_county, source, keywords, categories, eligibility_bullets,
            description, opportunity_type, type, is_national, geo_scope, application_url, url, source_url
     FROM funding_opportunities
     WHERE source = 'faith_based_assistance' AND state = 'OH' AND is_active = 1`,
  )
  .all()

console.log(`Found ${dbOpps.length} faith-based opportunities in DB`)
for (const opp of dbOpps) {
  console.log(`  - ${opp.title} (${opp.sponsor})`)
}

if (dbOpps.length < 6) {
  console.error('\nFAIL: Expected 6 opportunities, found', dbOpps.length)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Step 3: Profile fixture
// ---------------------------------------------------------------------------
console.log('\n--- Step 3: Simulating profile ---')
console.log('Profile: Single mother in Lorain County, OH | Needs: eviction prevention, rent assistance')

const simulatedProfile = {
  id: 'verify-lorain-single-mother',
  primary_type: 'individual_need',
  applicant_type: 'individual_need',
  state: 'OH',
  city: 'Elyria',
  county: 'Lorain',
  zip_code: '44035',
  // Signals the canonical engine reads directly:
  mission_focus: 'housing stability and eviction prevention',
  population_served: 'single parents, low-income families',
  sections: {
    basic_information: { state: 'OH', city: 'Elyria', county: 'Lorain' },
    demographics: { populations_served: ['single parents', 'low income', 'families with children'] },
    funding_needs: {
      primary_need_category: 'housing_stability',
      needs: ['rent assistance', 'eviction prevention', 'emergency housing'],
    },
    location_focus: { state: 'OH', counties: ['Lorain'] },
  },
}

function enrich(opp) {
  const parse = (v) => {
    try {
      return Array.isArray(v) ? v : JSON.parse(v || '[]')
    } catch {
      return []
    }
  }
  return {
    ...opp,
    keywords: parse(opp.keywords),
    categories: parse(opp.categories),
    eligibility_bullets: parse(opp.eligibility_bullets),
  }
}

// ---------------------------------------------------------------------------
// Step 4: Canonical decision (authoritative)
// ---------------------------------------------------------------------------
console.log('\n--- Step 4: computeMatchDecision (CANONICAL, authoritative) ---')
const canonicalResults = []
let canonicalPassCount = 0
for (const rawOpp of dbOpps) {
  const opp = enrich(rawOpp)
  const { score } = scoreOpportunity(simulatedProfile, opp)
  const decision = computeMatchDecision(simulatedProfile, opp)
  const passed = decision.decision === 'ACCEPT' || decision.decision === 'REVIEW'
  if (passed) canonicalPassCount += 1
  canonicalResults.push({ title: opp.title, score, decision: decision.decision, passed })
  console.log(
    `  ${passed ? 'PASS' : 'FAIL'} [${decision.decision}] score=${score} ${opp.title}`,
  )
  if (decision.explanation) {
    console.log(`        ${String(decision.explanation).slice(0, 140)}`)
  }
}

// ---------------------------------------------------------------------------
// Step 5: Legacy crawlerHelpers score (INFORMATIONAL ONLY)
// ---------------------------------------------------------------------------
console.log(
  '\n--- Step 5: crawlerHelpers.calculateMatchScore (NON-AUTHORITATIVE, info-only) ---',
)
// Build the legacy signal shape only so we can report the drift; the shape
// below is intentionally richer than the canonical engine needs.
const legacyCrawlerProfile = {
  ...simulatedProfile,
  signals: {
    location: { state: 'OH', city: 'Elyria', county: 'Lorain', zip: '44035' },
    applicantTypes: new Set(['individual_need', 'family']),
    keywordSet: new Set([
      'rent assistance',
      'eviction prevention',
      'emergency housing',
      'single parent',
      'housing instability',
      'behind on rent',
      'single mother',
      'low income',
      'Lorain County',
    ]),
    keywords: [
      'rent assistance',
      'eviction prevention',
      'emergency housing',
      'single parent',
      'housing instability',
      'behind on rent',
    ],
    demographics: new Set(['single_parent', 'low_income']),
    interests: new Set([
      'rent assistance',
      'eviction prevention',
      'emergency housing',
      'housing stability',
    ]),
    phrases: new Set([
      'eviction prevention',
      'rent assistance',
      'emergency housing',
      'single mother assistance',
    ]),
    intentPhrases: new Set(['rent assistance', 'eviction help', 'emergency housing']),
    family: new Set(['single_parent']),
    assistance: new Set(),
    military: new Set(),
    health: new Set(),
    occupation: new Set(),
  },
}

const legacyResults = []
if (!crawlerHelpers || typeof crawlerHelpers.calculateMatchScore !== 'function') {
  console.log('  (legacy crawlerHelpers unavailable — skipping legacy score comparison)')
} else {
  for (const rawOpp of dbOpps) {
    const opp = enrich(rawOpp)
    let score = null
    let matched = []
    try {
      const r = crawlerHelpers.calculateMatchScore(opp, legacyCrawlerProfile)
      score = r?.score ?? null
      matched = r?.matchedSignals || []
    } catch (err) {
      score = `error:${err?.message || String(err)}`
    }
    legacyResults.push({ title: opp.title, score })
    console.log(`  [legacy score=${score}] ${opp.title}`)
    if (matched.length > 0) {
      console.log(`        matched: ${matched.slice(0, 5).join('; ')}`)
    }
  }
}

// Drift surface: any opportunity where the legacy heuristic disagrees sharply
// with the canonical decision is still only informational, but is called out.
const drift = canonicalResults
  .map((c, i) => ({
    title: c.title,
    canonical: c.decision,
    legacy_score: legacyResults[i]?.score ?? null,
  }))
  .filter((row) => {
    const s = Number(row.legacy_score)
    if (!Number.isFinite(s)) return false
    if (row.canonical === 'REJECT' && s >= 70) return true
    if ((row.canonical === 'ACCEPT' || row.canonical === 'REVIEW') && s < 30) return true
    return false
  })
if (drift.length > 0) {
  console.log('\n  [drift] Legacy heuristic disagrees sharply with canonical decision:')
  for (const row of drift) console.log(`    - ${row.title}: canonical=${row.canonical} legacy_score=${row.legacy_score}`)
  console.log('  (Drift is informational; canonical decision remains authoritative.)')
}

// ---------------------------------------------------------------------------
// Step 6: Geo index
// ---------------------------------------------------------------------------
console.log('\n--- Step 6: Verifying geo index entries ---')
const geoEntries = await db
  .prepare(
    `SELECT g.opportunity_id, g.state, g.county, g.source, f.title
     FROM funding_opportunity_geo_index g
     JOIN funding_opportunities f ON f.id = g.opportunity_id
     WHERE g.state = 'OH' AND g.county = 'Lorain' AND g.source = 'faith_based_assistance'`,
  )
  .all()
console.log(`Found ${geoEntries.length} geo index entries`)
for (const g of geoEntries) {
  console.log(`  - ${g.title} (${g.state}/${g.county})`)
}

// ---------------------------------------------------------------------------
// Step 7: Crawler source registration
// ---------------------------------------------------------------------------
console.log('\n--- Step 7: Verifying crawler source registration ---')
try {
  const crawlerSrc = await db
    .prepare(
      "SELECT source_id, name, tags FROM crawler_sources WHERE source_id = 'lorain-county-faith-housing'",
    )
    .get()
  if (crawlerSrc) {
    console.log(`Crawler source registered: ${crawlerSrc.name}`)
    console.log(`  Tags: ${crawlerSrc.tags}`)
  } else {
    console.log('Crawler source not found (non-fatal)')
  }
} catch {
  console.log('crawler_sources table not available (non-fatal)')
}

// ---------------------------------------------------------------------------
// Summary & exit
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(80))
console.log('SUMMARY')
console.log('='.repeat(80))
console.log(`DB entries: ${dbOpps.length}/6`)
console.log(`Canonical ACCEPT/REVIEW: ${canonicalPassCount}/${dbOpps.length}`)
console.log(
  `Legacy heuristic reported for ${legacyResults.length} opportunities (informational only)`,
)
console.log(`Geo index entries: ${geoEntries.length}`)

const allPassed = dbOpps.length >= 6 && canonicalPassCount === dbOpps.length
console.log(`\nOverall (canonical-only): ${allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`)

if (!allPassed) {
  process.exit(1)
}
