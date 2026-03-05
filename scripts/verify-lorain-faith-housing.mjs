#!/usr/bin/env node
/**
 * Verification script for Lorain County faith-based emergency housing opportunities.
 *
 * Steps:
 *   1. Seeds the 6 opportunities into the local DB
 *   2. Simulates a profile search for a single mother in Lorain County needing eviction help
 *   3. Scores each opportunity using both matching engines
 *   4. Confirms all 6 appear with score >= 70
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

dotenv.config({ path: join(__dirname, '..', '.env') })

const { getDb } = await import('../backend/db/index.js')
const { seedFaithBasedHousing } = await import('../backend/utils/seedFaithBasedHousing.js')
const { calculateMatchScore } = await import('../backend/services/matchingEngine.js')
const crawlerHelpers = await import('../backend/services/crawlers/crawlerHelpers.js')

const db = getDb()

console.log('='.repeat(80))
console.log('VERIFICATION: Lorain County Faith-Based Emergency Housing Opportunities')
console.log('='.repeat(80))

// Step 1: Seed
console.log('\n--- Step 1: Seeding opportunities ---')
const seedResult = await seedFaithBasedHousing(db)
console.log('Seed result:', seedResult)

// Step 2: Verify DB entries
console.log('\n--- Step 2: Verifying DB entries ---')
const dbOpps = await db
  .prepare(
    `SELECT id, title, sponsor, state, geo_county, source, keywords, categories, eligibility_bullets, description, opportunity_type, type, is_national, geo_scope
     FROM funding_opportunities
     WHERE source = 'faith_based_assistance' AND state = 'OH' AND is_active = 1`
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

// Step 3: Simulate profile matching
console.log('\n--- Step 3: Simulating profile search ---')
console.log('Profile: Single mother in Lorain County, OH | Needs: eviction prevention, rent assistance')

const simulatedProfile = {
  primary_type: 'individual_need',
  applicant_type: 'individual_need',
  state: 'OH',
  city: 'Elyria',
  zip_code: '44035',
}

const simulatedSignals = {
  location: {
    state: 'OH',
    city: 'Elyria',
    county: 'Lorain',
    zip: '44035',
  },
  applicantTypes: new Set(['individual_need', 'family']),
  keywordSet: new Set([
    'rent assistance', 'eviction prevention', 'emergency housing',
    'single parent', 'housing instability', 'behind on rent',
    'single mother', 'low income', 'Lorain County',
  ]),
  keywords: [
    'rent assistance', 'eviction prevention', 'emergency housing',
    'single parent', 'housing instability', 'behind on rent',
  ],
  demographics: new Set(['single_parent', 'low_income']),
  interests: new Set(['rent assistance', 'eviction prevention', 'emergency housing', 'housing stability']),
  phrases: new Set(['eviction prevention', 'rent assistance', 'emergency housing', 'single mother assistance']),
  intentPhrases: new Set(['rent assistance', 'eviction help', 'emergency housing']),
  family: new Set(['single_parent']),
  assistance: new Set(),
  military: new Set(),
  health: new Set(),
  occupation: new Set(),
}

const simulatedFacets = {
  intent: {
    primary_need_category: 'housing_stability',
    keywords: ['rent assistance', 'eviction prevention', 'emergency housing', 'single mother'],
    negative_keywords: [],
  },
  profile: {
    primary_profile_type: 'individual_need',
    applicant_types: ['individual_need', 'family'],
  },
  financial: { low_income: true },
  assistance: { snap_recipient: false, tanf_recipient: false, section8_housing: false },
}

const profileContext = {
  profile: simulatedProfile,
  sections: {},
  signals: simulatedSignals,
  facets: simulatedFacets,
}

const crawlerProfile = {
  ...simulatedProfile,
  signals: simulatedSignals,
}

console.log('\n--- Step 4: Scoring with matchingEngine.calculateMatchScore ---')
let allAbove70_main = true
for (const opp of dbOpps) {
  let parsedKeywords = []
  let parsedCategories = []
  let parsedBullets = []
  try { parsedKeywords = JSON.parse(opp.keywords || '[]') } catch {}
  try { parsedCategories = JSON.parse(opp.categories || '[]') } catch {}
  try { parsedBullets = JSON.parse(opp.eligibility_bullets || '[]') } catch {}

  const enrichedOpp = {
    ...opp,
    keywords: parsedKeywords,
    categories: parsedCategories,
    eligibility_bullets: parsedBullets,
  }

  const result = calculateMatchScore(profileContext, enrichedOpp)
  const pass = result.score >= 70
  if (!pass) allAbove70_main = false
  console.log(`  ${pass ? 'PASS' : 'FAIL'} [${result.score}] ${opp.title}`)
  if (result.reasons.length > 0) {
    console.log(`        Reasons: ${result.reasons.slice(0, 5).join('; ')}`)
  }
}

console.log('\n--- Step 5: Scoring with crawlerHelpers.calculateMatchScore ---')
let allAbove70_crawler = true
for (const opp of dbOpps) {
  let parsedKeywords = []
  let parsedCategories = []
  let parsedBullets = []
  try { parsedKeywords = JSON.parse(opp.keywords || '[]') } catch {}
  try { parsedCategories = JSON.parse(opp.categories || '[]') } catch {}
  try { parsedBullets = JSON.parse(opp.eligibility_bullets || '[]') } catch {}

  const enrichedOpp = {
    ...opp,
    keywords: parsedKeywords,
    categories: parsedCategories,
    eligibility_bullets: parsedBullets,
  }

  const result = crawlerHelpers.calculateMatchScore(enrichedOpp, crawlerProfile)
  const pass = result.score >= 70
  if (!pass) allAbove70_crawler = false
  console.log(`  ${pass ? 'PASS' : 'FAIL'} [${result.score}] ${opp.title}`)
  if (result.matchedSignals?.length > 0) {
    console.log(`        Matched: ${result.matchedSignals.slice(0, 5).join('; ')}`)
  }
}

// Step 6: Check geo index
console.log('\n--- Step 6: Verifying geo index entries ---')
const geoEntries = await db
  .prepare(
    `SELECT g.opportunity_id, g.state, g.county, g.source, f.title
     FROM funding_opportunity_geo_index g
     JOIN funding_opportunities f ON f.id = g.opportunity_id
     WHERE g.state = 'OH' AND g.county = 'Lorain' AND g.source = 'faith_based_assistance'`
  )
  .all()
console.log(`Found ${geoEntries.length} geo index entries`)
for (const g of geoEntries) {
  console.log(`  - ${g.title} (${g.state}/${g.county})`)
}

// Step 7: Check crawler sources
console.log('\n--- Step 7: Verifying crawler source registration ---')
try {
  const crawlerSrc = await db
    .prepare("SELECT source_id, name, tags FROM crawler_sources WHERE source_id = 'lorain-county-faith-housing'")
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

// Summary
console.log('\n' + '='.repeat(80))
console.log('SUMMARY')
console.log('='.repeat(80))
console.log(`DB entries: ${dbOpps.length}/6`)
console.log(`Main engine >= 70: ${allAbove70_main ? 'ALL PASS' : 'SOME FAIL'}`)
console.log(`Crawler engine >= 70: ${allAbove70_crawler ? 'ALL PASS' : 'SOME FAIL'}`)
console.log(`Geo index entries: ${geoEntries.length}`)

const allPassed = dbOpps.length >= 6 && allAbove70_main && allAbove70_crawler
console.log(`\nOverall: ${allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`)

if (!allPassed) {
  process.exit(1)
}
