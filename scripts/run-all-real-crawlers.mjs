import fs from 'fs'
import { DEFAULT_MIN_SCORE, SCORE_SCALE_ID } from '../backend/config/matchThresholds.js'

// Node 22 has global fetch.
const BASE = process.env.BASE_URL || 'http://localhost:8080'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''

if (!ADMIN_TOKEN) {
  console.error(
    'Missing ADMIN_TOKEN. Set ADMIN_TOKEN to an authorized session token (do not use hard-coded defaults).',
  )
  process.exit(1)
}

const headers = {
  Authorization: `Bearer ${ADMIN_TOKEN}`,
  'Content-Type': 'application/json',
}

const CRAWLERS = [
  'local_funding',
  'government_funding',
  'student_grants',
  'ecf_benefits',
  'item_matching',
  'special_needs',
]

async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`Non-JSON response for GET ${path}: ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    throw new Error(json?.error || json?.message || `HTTP ${res.status}`)
  }
  return json
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`Non-JSON response for POST ${path}: ${text.slice(0, 200)}`)
  }
  // NOTE: /api/real-crawlers/run returns 200 even for failure, so check json.success
  return json
}

function summarizeProfileDebug(debug) {
  if (!debug || typeof debug !== 'object') return null
  return {
    keyword_count: debug.keyword_count ?? 0,
    demographics_count: debug.demographics_count ?? 0,
    has_zip: Boolean(debug.has_zip),
    profile_type: debug.profile_type ?? null,
    used_db_fallback: Boolean(debug.used_db_fallback),
    live_total_found: debug.live_total_found ?? 0,
    scored_total: debug.scored_total ?? 0,
    filtered_total: debug.filtered_total ?? 0,
  }
}

async function main() {
  const profiles = await apiGet('/api/profiles?limit=1000')
  const profileIds = Array.isArray(profiles) ? profiles.map((p) => p.id).filter(Boolean) : []

  console.log(`Found ${profileIds.length} profiles`)

  const report = {
    started_at: new Date().toISOString(),
    base: BASE,
    score_scale_id: SCORE_SCALE_ID,
    display_min_score: DEFAULT_MIN_SCORE,
    crawlers: CRAWLERS,
    profiles: [],
    totals: Object.fromEntries(CRAWLERS.map((c) => [c, { runs: 0, success: 0, matches: 0, used_db_fallback: 0 }])),
  }

  for (const profileId of profileIds) {
    const profileRow = { profileId, crawlers: {} }
    for (const crawler of CRAWLERS) {
      const result = await apiPost('/api/real-crawlers/run', {
        crawler_type: crawler,
        profile_id: profileId,
        min_match_score: DEFAULT_MIN_SCORE,
        score_scale_id: SCORE_SCALE_ID,
        allow_db_fallback: true,
      })

      report.totals[crawler].runs += 1
      if (result.success) report.totals[crawler].success += 1
      if (result.used_db_fallback) report.totals[crawler].used_db_fallback += 1
      report.totals[crawler].matches += Number(result.count || 0)

      profileRow.crawlers[crawler] = {
        success: Boolean(result.success),
        count: Number(result.count || 0),
        live_total_found: Number(result.live_total_found || result.total_found || 0),
        used_db_fallback: Boolean(result.used_db_fallback),
        message: result.message || result.error || null,
        debug: summarizeProfileDebug(result.debug),
      }
    }
    report.profiles.push(profileRow)
  }

  report.completed_at = new Date().toISOString()

  const outPath = 'test-results/run-all-real-crawlers-report.json'
  fs.mkdirSync('test-results', { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(`Wrote report: ${outPath}`)

  // Console summary
  console.log('\nTotals:')
  for (const crawler of CRAWLERS) {
    const t = report.totals[crawler]
    console.log(
      `${crawler}: runs=${t.runs} success=${t.success} matches=${t.matches} used_db_fallback=${t.used_db_fallback}`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
