import crypto from 'crypto'

const FANOUT_LOW = 0.0005
const FANOUT_HIGH = 0.02
const MAX_ITEMS_LOW = 10000

export function computeChangeDigest(fields, ts) {
  const sorted = [...fields].sort((a, b) => a.field.localeCompare(b.field))
  return crypto.createHash('sha256').update(JSON.stringify(sorted) + ts).digest('hex')
}

export function classifyProfileChange(fields) {
  let entity = false, primaryNaics = false, naicsCount = 0
  let geo = false, revenue = false

  for (const f of fields) {
    if (f.field === 'entity_type') entity = true

    if (f.field.includes('naics')) {
      naicsCount++
      if (f.field.includes('primary')) primaryNaics = true
    }

    if (f.field.includes('geo') || f.field.includes('radius')) {
      if (Math.abs(Number(f.new)) > 10 || Math.abs(Number(f.old) - Number(f.new)) > 5) geo = true
    }

    if (f.field.includes('revenue')) revenue = true
  }

  if (entity) return 'entity_type_change'
  if (geo) return 'geo_shift'
  if (revenue) return 'revenue_band_cross'

  if (naicsCount > 0) {
    if (primaryNaics || naicsCount > 1) return 'naics_major'
    return 'naics_minor'
  }

  // Detect other meaningful profile sections before returning unknown
  const DEEP_PROFILE_FIELDS = [
    'military', 'veteran', 'disability', 'housing', 'emergency',
    'education', 'family', 'caregiver', 'health', 'business'
  ]
  const isDeepChange = fields.some(f =>
    DEEP_PROFILE_FIELDS.some(key => f.field.toLowerCase().includes(key))
  )
  if (isDeepChange) return 'deep_profile_change'

  return 'profile_field_change'
}

export function decideRevalAction({
  trigger, fanout_pct, affected_items, cost_units, daily_budget, manual_force
}) {
  let action = 'targeted_reval'

  if (manual_force) {
    action = 'full_recrawl'
  } else if (fanout_pct > FANOUT_HIGH) {
    action = 'full_recrawl'
  } else if (trigger === 'naics_minor') {
    action = 're-score'
  } else if (trigger === 'deep_profile_change' || trigger === 'profile_field_change') {
    // Deep profile changes (veteran, disability, housing, etc.) require at minimum
    // a targeted crawl so new-category opportunities are discovered â not just rescored.
    action = 'targeted_reval'
  } else {
    if (fanout_pct <= FANOUT_LOW && affected_items <= MAX_ITEMS_LOW) action = 're-score'
    else if (fanout_pct <= FANOUT_HIGH) action = 'targeted_reval'
    else action = 'full_recrawl'
  }

  if (action === 'full_recrawl' && cost_units > 10 * daily_budget) {
    // Cost guardrail: explicitly block unbounded recrawls.
    return { block: true, action, reason: 'cost_guardrail' }
  }

  return { block: false, action, reason: trigger }
}

/**
 * The ONLY enqueue-able crawler job that acts on a profile change today.
 *
 * `anya_match_scout` is in the `crawler_jobs.type` CHECK list
 * (backend/db/schema.sql), has a live dispatcher HANDLER
 * (crawlerDispatcher.HANDLERS.anya_match_scout), is NOT in
 * shared/supersededCrawlerTypes.js, and — the part that matters here — it
 * genuinely RE-SCORES the active catalog for one profile through the canonical
 * `computeMatchDecision` (anyaMatchScout.runMatchScoutForProfile).
 */
const REVAL_JOB_TYPE = 'anya_match_scout'

/**
 * What a reval job ACTUALLY covers, per action. Exported so no caller has to
 * infer it — the route's response says `type: <action>` and hands back an
 * `expected_complete_by`, and without this a caller would report a re-crawl
 * that never happened.
 *
 * `discovery: false` everywhere is not a defect in this module: since the
 * Crawler OS cutover there is NO enqueue-able discovery job type at all.
 * Profile-facing discovery runs SYNCHRONOUSLY through
 * `crawlerOsCompatibility.triggerAutoDiscoveryCrawlers -> runProfileDiscoveryLive`
 * (see shared/supersededCrawlerTypes.js header). Wiring the reval trigger to
 * that path is a change in backend/routes/crawlers.js, not here.
 */
export const REVAL_JOB_COVERAGE = Object.freeze({
  're-score': Object.freeze({ job_type: REVAL_JOB_TYPE, rescores: true, discovery: false }),
  targeted_reval: Object.freeze({ job_type: REVAL_JOB_TYPE, rescores: true, discovery: false }),
  full_recrawl: Object.freeze({ job_type: REVAL_JOB_TYPE, rescores: true, discovery: false }),
})

/**
 * Map a reval action to a crawler job type that can actually be created AND
 * dispatched.
 *
 * WHAT WAS BROKEN (this is the north-star trigger — a profile edit is exactly
 * "determine the need -> run the correct crawler"):
 *   - 'targeted_reval'  -> 'targeted_profile_crawl'  — that string appears
 *     NOWHERE else in the repo. It is not in the `crawler_jobs.type` CHECK list
 *     and has no HANDLER, so `createCrawlerJob` violated the constraint and the
 *     route returned a generic 500. `targeted_reval` is `decideRevalAction`'s
 *     DEFAULT and the forced action for `deep_profile_change` /
 *     `profile_field_change` — i.e. a veteran / disability / housing edit.
 *   - 'full_recrawl'    -> 'comprehensive' — a RETIRED type
 *     (shared/supersededCrawlerTypes.js); short-circuited at the dispatch choke
 *     point, so the job never ran.
 *   - 're-score'        -> 'profile_enrichment' — a live handler, but it does AI
 *     section-TEXT enrichment (backend/services/profileEnrichment.js) and never
 *     re-scores a single match, which is the one thing 're-score' names.
 *
 * All three now route to the one job that re-scores the profile for real. The
 * DISCOVERY half of `targeted_reval`/`full_recrawl` is still not enqueue-able —
 * `REVAL_JOB_COVERAGE` states that plainly rather than letting a caller imply a
 * re-crawl happened.
 */
export function mapActionToCrawlerJob(action) {
  return (REVAL_JOB_COVERAGE[action] ?? REVAL_JOB_COVERAGE.full_recrawl).job_type
}

export function estimateCompletion(action, startIso) {
  const base = new Date(startIso).getTime()
  if (action === 're-score') return new Date(base + 5 * 60 * 1000).toISOString()
  if (action === 'targeted_reval') return new Date(base + 60 * 60 * 1000).toISOString()
  return new Date(base + 24 * 60 * 60 * 1000).toISOString()
}
