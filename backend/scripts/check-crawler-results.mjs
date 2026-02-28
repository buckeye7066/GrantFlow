/**
 * check-crawler-results.mjs
 *
 * Debug script that prints a summary of crawler-run results including:
 *   - Returned count
 *   - Policy rejection counts (why opportunities were dropped)
 *   - Top reasons for rejection
 *
 * Usage:
 *   node backend/scripts/check-crawler-results.mjs [crawler_type] [profile_id] [min_match_score]
 *
 * Examples:
 *   node backend/scripts/check-crawler-results.mjs government_funding
 *   node backend/scripts/check-crawler-results.mjs local_funding <profile-uuid> 50
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Config ───────────────────────────────────────────────────────────────────
const API_BASE = process.env.API_BASE || 'http://localhost:3000'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.AUTH_TOKEN || ''

const crawlerType = process.argv[2] || 'government_funding'
const profileId = process.argv[3] || null
const minMatchScore = Number(process.argv[4] || 0)

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function post(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${JSON.stringify(json)}`)
  }
  return json
}

function printSection(title) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log('─'.repeat(60))
}

function formatCount(label, count) {
  const bar = '█'.repeat(Math.min(count, 20))
  return `  ${String(count).padStart(4)}  ${bar}  ${label}`
}

// ─── Main ─────────────────────────────────────────────────────────────────────
if (!profileId) {
  console.error(
    '[check-crawler-results] ERROR: profile_id is required.\n' +
    '  Usage: node backend/scripts/check-crawler-results.mjs <crawler_type> <profile_id> [min_match_score]\n',
  )
  process.exit(1)
}

console.log(`\n[check-crawler-results] Running ${crawlerType} crawler`)
console.log(`  profile_id    : ${profileId}`)
console.log(`  min_match_score: ${minMatchScore}`)
console.log(`  api_base      : ${API_BASE}`)

const startedAt = Date.now()
let result
try {
  result = await post('/api/real-crawlers/run', {
    crawler_type: crawlerType,
    profile_id: profileId,
    min_match_score: minMatchScore,
    admin: 'true',
  })
} catch (err) {
  console.error(`\n[check-crawler-results] Request failed: ${err.message}`)
  process.exit(1)
}

const elapsed = Date.now() - startedAt

printSection('RESPONSE SUMMARY')
console.log(`  success         : ${result.success}`)
console.log(`  crawler_type    : ${result.crawler_type ?? crawlerType}`)
console.log(`  count_returned  : ${result.count ?? 0}`)
console.log(`  total_found     : ${result.total_found ?? 0}`)
console.log(`  min_match_score : ${result.min_match_score ?? minMatchScore}`)
console.log(`  used_live       : ${result.used_live ?? false}`)
console.log(`  used_db_fallback: ${result.used_db_fallback ?? false}`)
console.log(`  duration_ms     : ${result.duration ?? elapsed}`)

if (result.error) {
  console.log(`  error           : ${result.error}`)
}

// ─── Validation / policy rejection counts ────────────────────────────────────
const liveCounts = result.debug?.live?.validation_rejection_counts ?? {}
const dbCounts = result.debug?.db?.policy_rejection_counts ?? {}
const allCounts = {}
for (const [k, v] of Object.entries(liveCounts)) allCounts[k] = (allCounts[k] ?? 0) + Number(v)
for (const [k, v] of Object.entries(dbCounts)) allCounts[k] = (allCounts[k] ?? 0) + Number(v)

const totalRejected = Object.values(allCounts).reduce((a, b) => a + b, 0)

if (totalRejected > 0) {
  printSection(`POLICY REJECTIONS (total: ${totalRejected})`)
  const sorted = Object.entries(allCounts).sort((a, b) => b[1] - a[1])
  for (const [reason, count] of sorted) {
    console.log(formatCount(reason, count))
  }
  console.log()
  console.log('  Meanings:')
  console.log('    no_real_url        — opportunity has no valid http/https URL (or only placeholder domains)')
  console.log('    placeholder_text   — title/description contains stub text (lorem, TBD, coming soon, etc.)')
  console.log('    loan_like          — opportunity_type=loan or loan keywords in text')
  console.log('    matching_funds     — requires_match=true or match_percentage>0 or matching-fund keywords')
  console.log('    invalid_object     — null or non-object input')
  console.log('    query_plan_must_not— excluded by query plan mustNotTerms (intent disambiguation)')
  console.log('    missing_title      — no title field')
  console.log('    post_score_policy_*— filtered after scoring by enforceOpportunityPolicy')
} else {
  printSection('POLICY REJECTIONS')
  console.log('  (none — all opportunities passed policy checks)')
}

// ─── Top results ─────────────────────────────────────────────────────────────
const opps = Array.isArray(result.opportunities) ? result.opportunities : []
if (opps.length > 0) {
  printSection(`TOP RESULTS (${opps.length} returned)`)
  for (const opp of opps.slice(0, 10)) {
    const score = typeof opp.match_score === 'number' ? `${opp.match_score}%` : 'n/a'
    const url = opp.url ?? opp.application_url ?? opp.source_url ?? 'NO URL'
    console.log(`  [${score}] ${opp.title ?? '(no title)'}`)
    console.log(`         ${url}`)
    if (opp.match_reasons?.length) {
      console.log(`         Reasons: ${opp.match_reasons.slice(0, 3).join('; ')}`)
    }
  }
}

// ─── Score diagnostics if 0 results ──────────────────────────────────────────
if (opps.length === 0) {
  printSection('DEBUG: ZERO RESULTS DIAGNOSTICS')
  const diag = result.debug?.filter_diagnostics
  if (diag) {
    console.log(`  primary_reason: ${diag.primary_reason}`)
    console.log(`  min_match_score: ${diag.min_match_score}`)
    if (diag.score_stats) {
      const s = diag.score_stats
      console.log(`  score stats — min: ${s.min}, max: ${s.max}, avg: ${s.avg}`)
    }
    if (diag.top_5?.length) {
      console.log('  top 5 candidates before filter:')
      for (const c of diag.top_5) {
        console.log(`    score=${c.score}  ${c.title ?? '(no title)'} [${c.opportunity_type ?? 'unknown'}]`)
      }
    }
  } else {
    console.log('  No diagnostics available (no candidates found or live path used)')
    console.log('  debug.db:', JSON.stringify(result.debug?.db ?? {}, null, 2))
    console.log('  debug.live:', JSON.stringify(result.debug?.live ?? {}, null, 2))
  }
}

console.log()
