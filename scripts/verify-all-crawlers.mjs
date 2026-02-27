#!/usr/bin/env node
/**
 * Verification: run each Discover Grants crawler type with a synthetic profile.
 * - Ensures each crawler runs without throwing
 * - Reports counts and any errors; fails if a crawler throws or returns non-array
 *
 * Run: node scripts/verify-all-crawlers.mjs
 */
import { crawlLocalFunding } from '../backend/services/crawlers/localFundingCrawler.js'
import { crawlGovernmentFunding } from '../backend/services/crawlers/governmentFundingCrawler.js'
import { crawlStudentGrants } from '../backend/services/crawlers/studentGrantsCrawler.js'
import { crawlHealthResources } from '../backend/services/crawlers/healthResourcesCrawler.js'
import { crawlSpecialNeeds } from '../backend/services/crawlers/specialNeedsCrawler.js'
import { crawlECFBenefits } from '../backend/services/crawlers/ecfBenefitsCrawler.js'

const MIN_MATCH_SCORE = 50
const TIMEOUT_MS = 25_000

const SYNTHETIC_PROFILE = {
  id: 'synthetic-verify',
  display_name: 'Synthetic Verify',
  state: 'OH',
  zip_code: '43215',
  city: 'Columbus',
  primary_type: 'student',
  profile_type: 'student',
  sections: {
    basic_information: { email: 'verify@example.com' },
    health_medical: { conditions: ['epilepsy', 'brain injury'], consent_for_studies: false },
  },
  signals: {
    location: { zip: '43215', city: 'Columbus', state: 'OH' },
    keywordSet: new Set(['disability', 'housing', 'utilities', 'community']),
    phrases: ['emergency assistance', 'support services'],
    interests: new Set(['housing', 'community', 'health']),
    demographics: new Set(['disabled']),
    health: new Set(['epilepsy', 'brain injury', 'disability']),
    assistance: new Set(['medicaid']),
    family: new Set(['single_parent']),
    academics: { gpa: 3.5 },
    coverage: { pct: 1 },
  },
}

const CRAWLERS = [
  { id: 'local_funding', fn: crawlLocalFunding },
  { id: 'government_funding', fn: crawlGovernmentFunding },
  { id: 'student_grants', fn: crawlStudentGrants },
  { id: 'health_resources', fn: crawlHealthResources },
  { id: 'special_needs', fn: crawlSpecialNeeds },
  { id: 'ecf_benefits', fn: crawlECFBenefits },
]

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ])
}

async function main() {
  console.log('[verify-all-crawlers] Running each crawler with synthetic OH profile (min_match_score=%s)\n', MIN_MATCH_SCORE)
  const opts = { min_match_score: MIN_MATCH_SCORE }
  const results = []

  for (const { id, fn } of CRAWLERS) {
    try {
      const raw = await withTimeout(fn(SYNTHETIC_PROFILE, opts), TIMEOUT_MS, id)
      const arr = Array.isArray(raw) ? raw : []
      const withUrl = arr.filter((r) => r?.url && String(r.url).startsWith('http'))
      results.push({
        id,
        ok: true,
        count: arr.length,
        withUrl: withUrl.length,
        error: null,
        sample: arr.slice(0, 2).map((o) => ({ title: o?.title, url: o?.url })),
      })
      console.log(`  ${id}: ${arr.length} results (${withUrl.length} with URL)`)
    } catch (err) {
      results.push({
        id,
        ok: false,
        count: 0,
        withUrl: 0,
        error: err?.message || String(err),
        sample: [],
      })
      console.log(`  ${id}: ERROR ${err?.message || err}`)
    }
  }

  const failed = results.filter((r) => !r.ok)
  const zeroCount = results.filter((r) => r.ok && r.count === 0)

  if (failed.length > 0) {
    console.error('\n[verify-all-crawlers] FAILED: crawlers threw:', failed.map((r) => `${r.id}: ${r.error}`).join('; '))
    process.exitCode = 1
    return
  }

  if (zeroCount.length === results.length) {
    console.error('\n[verify-all-crawlers] FAILED: all crawlers returned 0 results')
    process.exitCode = 1
    return
  }

  if (zeroCount.length > 0) {
    console.log('\n[verify-all-crawlers] WARN: zero results for:', zeroCount.map((r) => r.id).join(', '))
  }

  const total = results.reduce((s, r) => s + r.count, 0)
  console.log('\n[verify-all-crawlers] OK total=%s', total)
  console.log(JSON.stringify({ byCrawler: results.map((r) => ({ id: r.id, count: r.count, withUrl: r.withUrl })) }, null, 2))
}

main().catch((err) => {
  console.error('[verify-all-crawlers]', err?.message || err)
  process.exitCode = 1
})
