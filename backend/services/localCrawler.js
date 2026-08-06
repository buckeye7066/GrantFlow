/**
 * Local Crawler - Matches local community foundation grants to profiles
 * 
 * Uses real local opportunities data from verified sources.
 */

import fs from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import { saveToProfilePipeline } from './opportunityMatcher.js'
import { discoveryAutoAddAllowedForProfile } from './discoveryAutoAddGate.js'
import {
  buildProfileSignals,
  summarizeProfileSignals,
} from './profileHelpers.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { scoreOpportunity } from './matchEngine.js'
import { filterOutPipelineMembers } from './pipelineExclusion.js'
import { DEFAULT_MIN_SCORE, RELAX_THRESHOLDS, SCORE_SCALE_ID } from '../config/matchThresholds.js'
import { RELEVANCE_FLOOR } from '../config/relevanceFloor.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('localCrawler')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    console.warn(`[localCrawler] Could not load ${filePath}:`, e.message)
    return []
  }
}

/**
 * Build the profile's outward-expansion geo scope (city → county → state →
 * national) from buildProfileSignals output. STRICTLY ADDITIVE: a single-address
 * profile that only resolved a state yields { states:[ST], counties:[], cities:[] }
 * — identical to the old state-only behavior. A multi-address profile contributes
 * the county/city of every address it could resolve.
 *
 * Canonical rule (docs/canonical_rules.md): "Matching expands outward:
 * city → county → state → national." The candidate-pool SQL must therefore admit
 * an opportunity when its STATE, COUNTY, or CITY matches ANY of the profile's
 * locations (or it is national), not state alone — otherwise a genuinely LOCAL
 * county/city award never enters the pool to be scored.
 *
 * @param {object} signals - buildProfileSignals(...) output
 * @param {string|null} [fallbackState] - last-resort flat profile state
 * @returns {{ states: string[], counties: string[], cities: string[] }}
 *   Normalized, deduped. States are 2-letter upper; counties are lower-cased
 *   with a trailing "county" stripped (matching normalizeCounty in matchEngine);
 *   cities are lower-cased trimmed.
 */
export function buildProfileGeoScope(signals, fallbackState = null) {
  const states = []
  const counties = []
  const cities = []

  const addState = (v) => {
    const s = String(v ?? '').trim().toUpperCase()
    if (s.length === 2 && /^[A-Z]{2}$/.test(s) && !states.includes(s)) states.push(s)
  }
  const addCounty = (v) => {
    // Mirror matchEngine.normalizeCounty so SQL candidate matching and scoring agree.
    const c = String(v ?? '')
      .trim()
      .toLowerCase()
      .replace(/\bcounty\b/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (c && !counties.includes(c)) counties.push(c)
  }
  const addCity = (v) => {
    const c = String(v ?? '').trim().toLowerCase()
    if (c && !cities.includes(c)) cities.push(c)
  }

  // Every resolved address (primary + secondary). buildProfileSignals fully
  // resolves county/city for the primary (and for secondary addresses where the
  // ZIP/state were present); we take whatever each address carries.
  const locs = Array.isArray(signals?.locations) && signals.locations.length
    ? signals.locations
    : (signals?.location ? [signals.location] : [])
  for (const loc of locs) {
    addState(loc?.state)
    addCounty(loc?.county)
    addCity(loc?.city)
  }

  // signals.location is the canonical primary even if locations[] was empty.
  if (signals?.location) {
    addState(signals.location.state)
    addCounty(signals.location.county)
    addCity(signals.location.city)
  }

  // All states across every address (primary-first, already deduped upstream).
  if (Array.isArray(signals?.states)) for (const st of signals.states) addState(st)

  // Last-resort flat state so a profile with only a bare state still works.
  addState(fallbackState)

  return { states, counties, cities }
}

function safeJsonArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  const trimmed = value.trim()
  if (!trimmed) return []

  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    if (typeof parsed === 'string' && parsed.trim()) return [parsed.trim()]
  } catch {
    // fall through to delimited parsing
  }

  // Common legacy formats: "a,b,c" or "a; b; c"
  return trimmed
    .split(/[,;\n]+/)
    .map((v) => v.trim())
    .filter(Boolean)
}

/**
 * Process local crawler job - matches local community grants to profile
 */
export async function processLocalCrawlerJob({ db, job, dataDir, profileContext }) {
  log.info('[localCrawler] Starting local opportunity search...')

  // Validate required inputs
  if (!db) {
    throw new Error('Database connection is required for local crawler')
  }
  
  if (!profileContext?.profile) {
    // The job's profile was deleted (e.g. a cleaned-up smoke profile) or could
    // not be hydrated between enqueue and dispatch. There is nothing to crawl —
    // that's an honest no-op, not a failure. Returning a clean result keeps the
    // job out of the failed-job/error-log noise the owner sees in Diagnostics.
    log.warn(`[localCrawler] No profile data for job ${job?.id ?? '(unknown)'} — skipping (profile deleted or unhydrated)`)
    return {
      result_count: 0,
      result_meta: { skipped: true, noop_reason: 'profile has no usable data (deleted or unhydrated)' },
    }
  }

  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('Data directory path is required for local crawler')
  }
  
  const parameters = job.parameters ?? {}
  const matchThreshold = parameters.match_threshold ?? DEFAULT_MIN_SCORE
  const maxResults = parameters.max_results || 30
  
  // Build profile signals with error handling
  let signals
  try {
    signals = buildProfileSignals(profileContext)
  } catch (error) {
    console.error('[localCrawler] Error building profile signals:', error)
    throw new Error(`Failed to build profile signals: ${error.message}`)
  }
  
  // Extract state with multiple fallback options
  const profileState =
    profileContext?.profile?.state ||
    signals?.location?.state ||
    profileContext?.sections?.location_focus?.state ||
    parameters.state

  // Multi-address aware (STRICTLY ADDITIVE): crawl local opps for EVERY state the
  // profile is tied to (e.g. home OH + school TN), not just the primary. Reads
  // signals.states (primary-first) and falls back to the single primary state so a
  // single-address profile yields exactly one state → identical behavior. Bounded
  // to 2 as designed so the local crawl never explodes.
  const profileStateList = (() => {
    const out = []
    const add = (v) => {
      const s = String(v ?? '').trim().toUpperCase()
      if (s && s.length === 2 && !out.includes(s)) out.push(s)
    }
    add(profileState)
    if (Array.isArray(signals?.states)) for (const st of signals.states) add(st)
    // Bounded so the local crawl never explodes, but high enough to cover a
    // profile with several addresses (home + school + work + service areas).
    return out.slice(0, 5)
  })()

  if (profileStateList.length === 0) {
    console.warn('[localCrawler] No valid state specified - cannot find local opportunities')
    return {
      evaluated: 0,
      inserted: 0,
      opportunityLogs: [],
      error: 'No valid state information available in profile'
    }
  }

  // Outward-expansion geo scope (city → county → state → national). The DB
  // candidate-pool query below admits an opportunity on ANY of these, not just
  // state — so a genuinely LOCAL county/city award surfaces, while a profile
  // that only has a state still pulls exactly the same state-scoped pool.
  const geoScope = buildProfileGeoScope(signals, profileState)

  log.info('[localCrawler] Profile states:', profileStateList.join(', '))
  log.info(
    `[localCrawler] Geo scope — states:[${geoScope.states.join(',')}] ` +
      `counties:[${geoScope.counties.join(',')}] cities:[${geoScope.cities.join(',')}]`,
  )
  log.info('[localCrawler] Profile signals:', summarizeProfileSignals(signals))
  
  // Load local opportunities from data file
  let localOpps = []
  try {
    localOpps = loadJSON(join(dataDir, 'local_opportunities.json'))
    log.info(`[localCrawler] Loaded ${localOpps.length} local opportunities`)
  } catch (error) {
    console.warn('[localCrawler] Could not load local opportunities file:', error.message)
    // Continue with empty array - will try database next
  }
  
  // Also check database for local opportunities
  let dbOpps = []
  try {
    const isPg = db?.dialect === 'postgres'
    const activePredicate = isPg ? 'is_active = TRUE' : 'is_active = 1'
    const noMatchPredicate = isPg
      ? '(requires_match IS NULL OR requires_match = FALSE)'
      : '(requires_match = 0 OR requires_match IS NULL)'
    const nationalPredicate = isPg ? 'is_national = TRUE' : 'is_national = 1'

    // Outward-expansion candidate pool (city → county → state → national).
    // An opportunity is a candidate if its STATE matches any profile state, OR
    // its COUNTY (geo_county) matches any profile county, OR its CITY matches any
    // profile city (no city column exists — match against the description text,
    // the same signal the scorer uses), OR it is national. All values are
    // parameterized (no injection). When the profile resolved only states this
    // reduces to the previous state-IN behavior plus national.
    const geoClauses = []
    const geoParams = []

    if (geoScope.states.length > 0) {
      geoClauses.push(`UPPER(state) IN (${geoScope.states.map(() => '?').join(', ')})`)
      geoParams.push(...geoScope.states)
    }
    if (geoScope.counties.length > 0) {
      // Normalize stored geo_county the same way buildProfileGeoScope normalizes
      // the profile county (lower, strip trailing "county"), so "Putnam County"
      // and "putnam" match.
      const norm = "TRIM(REPLACE(LOWER(COALESCE(geo_county, '')), 'county', ''))"
      geoClauses.push(`${norm} IN (${geoScope.counties.map(() => '?').join(', ')})`)
      geoParams.push(...geoScope.counties)
    }
    for (const city of geoScope.cities) {
      // City-local: the catalog has no city column, so match the description text
      // (the exact signal scoreGeoComponent credits as a city-tier match).
      // ESCAPE '\' so LIKE wildcards inside a city name are treated literally.
      geoClauses.push("LOWER(COALESCE(description, '')) LIKE ? ESCAPE '\\'")
      geoParams.push(`%${city.replace(/[%_\\]/g, '\\$&')}%`)
    }
    geoClauses.push(nationalPredicate)
    const geoPredicate = `(${geoClauses.join(' OR ')})`

    dbOpps = await db
      .prepare(
        `
          SELECT * FROM funding_opportunities
          WHERE ${activePredicate}
          AND ${geoPredicate}
          AND ${noMatchPredicate}
          AND ${trustedOriginClause()}
          AND ${trustedSourceClause()}
          LIMIT 200
        `,
      )
      .all(...geoParams)

    log.info(`[localCrawler] Found ${dbOpps.length} local opportunities in database`)
  } catch (error) {
    console.error('[localCrawler] Error querying database for opportunities:', error.message)
    // Database failure is critical for local matching - return partial results with warning
    return {
      evaluated: localOpps.length,
      inserted: 0,
      opportunityLogs: [],
      error: `Database query failed: ${error.message}`,
      warning: 'Only file-based opportunities processed due to database error'
    }
  }
  
  // Combine and dedupe
  const seenTitles = new Set()
  const allOpps = []
  
  for (const opp of localOpps) {
    const title = opp?.title ? String(opp.title) : ''
    if (!title) continue
    if (!opp?.application_url || typeof opp.application_url !== 'string' || !opp.application_url.trim()) {
      console.warn(`[localCrawler] Skipping "${title}" â missing application_url (Goal 1)`)
      continue
    }
    if (!seenTitles.has(title)) {
      seenTitles.add(title)
      allOpps.push({
        ...opp,
        title,
        keywords: safeJsonArray(opp?.keywords),
        categories: safeJsonArray(opp?.categories),
        eligibility_bullets: safeJsonArray(opp?.eligibility_bullets),
      })
    }
  }

  for (const opp of dbOpps) {
    const title = opp?.title ? String(opp.title) : ''
    if (!title) continue
    if (!opp?.application_url || typeof opp.application_url !== 'string' || !opp.application_url.trim()) {
      console.warn(`[localCrawler] Skipping DB opp "${title}" â missing application_url (Goal 1)`)
      continue
    }
    if (!seenTitles.has(title)) {
      seenTitles.add(title)
      allOpps.push({
        ...opp,
        title,
        keywords: safeJsonArray(opp?.keywords),
        categories: safeJsonArray(opp?.categories),
        eligibility_bullets: safeJsonArray(opp?.eligibility_bullets),
      })
    }
  }
  
  // Score opportunities
  const scoredOpps = []
  
  let requiresMatchSkipped = 0
  for (const opp of allOpps) {
    if (opp.requires_match) {
      requiresMatchSkipped++
      continue
    }
    
    const { score, reasons: matchReasons } = scoreOpportunity(profileContext, opp)
    
    scoredOpps.push({
      ...opp,
      match_score: score,
      match_reasons: matchReasons
    })
  }
  
  // Sort and limit
  scoredOpps.sort((a, b) => b.match_score - a.match_score)
  const targetMin = Math.min(8, maxResults)
  const parsedThreshold = Number(matchThreshold)
  const requestedThreshold = Number.isFinite(parsedThreshold)
    ? Math.max(0, Math.min(100, parsedThreshold))
    : DEFAULT_MIN_SCORE
  const thresholdCandidates = Array.from(new Set([
    requestedThreshold,
    ...RELAX_THRESHOLDS.filter((threshold) => threshold < requestedThreshold),
  ]))

  let thresholdUsed = requestedThreshold
  let filteredOpps = scoredOpps.filter((opp) => (opp.match_score ?? 0) >= thresholdUsed)
  for (const threshold of thresholdCandidates) {
    const subset = scoredOpps.filter((opp) => (opp.match_score ?? 0) >= threshold)
    if (subset.length >= targetMin || (threshold === 0 && subset.length > 0)) {
      thresholdUsed = threshold
      filteredOpps = subset
      break
    }
  }

  let topOpps = filteredOpps.slice(0, maxResults)
  const thresholdFallbackApplied = thresholdUsed !== requestedThreshold
  const profileId = profileContext?.profile?.id

  // Dedup against this profile's existing pipeline + dismissals BEFORE returning
  // or saving, so we never re-surface a grant the user already saved or deleted
  // (canonical pipelineExclusion filter; profile-scoped). Recall-over-suppression:
  // any failure inside the filter degrades to the unfiltered list.
  let pipelineExcluded = 0
  if (profileId) {
    try {
      const filtered = await filterOutPipelineMembers(db, profileId, topOpps, { matchTitle: true })
      pipelineExcluded = filtered.excluded
      topOpps = filtered.results
    } catch (err) {
      console.warn(`[localCrawler] pipeline-exclusion filter failed (continuing unfiltered): ${err?.message || err}`)
    }
  }

  log.info(
    `[localCrawler] Found ${topOpps.length} matching local opportunities ` +
      `(requested: ${requestedThreshold}%, used: ${thresholdUsed}%, pipeline-excluded: ${pipelineExcluded})`,
  )

  // Insert into database
  let upsertedCount = 0
  let insertedCount = 0
  let updatedCount = 0
  let savedToPipeline = 0
  // Per-profile automation toggle: only auto-add to the pipeline when
  // discovery_auto_add is on. Off → opportunities are still cataloged and
  // surface in Discovery for manual add, but don't enter the pipeline
  // unattended. Checked once (not per-opportunity). Absent pref defaults ON.
  const autoAddOk = profileId ? await discoveryAutoAddAllowedForProfile(db, profileId) : false
  if (profileId && !autoAddOk) {
    log.info(`[localCrawler] discovery_auto_add OFF for profile ${profileId} — cataloging only, no pipeline auto-add`)
  }

  for (const opp of topOpps) {
    try {
      const result = await upsertFundingOpportunity(db, {
        title: opp.title,
        sponsor: opp.sponsor,
        description: opp.description,
        amount_min: opp.amount_min,
        amount_max: opp.amount_max,
        deadline: opp.deadline,
        application_url: opp.application_url,
        categories: opp.categories,
        keywords: opp.keywords,
        eligibility_bullets: opp.eligibility_bullets,
        requires_match: false,
        requires_501c3: opp.requires_501c3,
        state: opp.state,
        source: 'local_foundation',
        source_id: opp.id,
        record_origin: 'live_crawl',
        match_reasons: opp.match_reasons
      })
      
      if (result.id) {
        upsertedCount++
      }
      if (result.inserted) {
        insertedCount++
      }
      if (result.updated) {
        updatedCount++
      }
      
      // Save to profile pipeline using the relaxed threshold (topOpps already passed it)
      if (profileId && autoAddOk) {
        const oppWithId = { ...opp, id: result.id, source: 'local_foundation' }
        // Do NOT pass pre-computed score â let saveToProfilePipeline run
        // computeMatchDecision() as the single canonical authority (Goal 4).
        // relevanceFilter hard-rejection, audit metadata, and ACCEPT/REVIEW
        // decisions are all produced inside that call (Goals 3, 8).
        // Pass the crawler's already-chosen threshold (thresholdUsed) so
        // saveToProfilePipeline does not introduce a second caller default and
        // drop what the crawler legitimately surfaced. The saver
        // still re-runs computeMatchDecision and still treats the numeric
        // floor as authoritative (ACCEPT/REVIEW does NOT bypass it).
        //
        // BUT the relaxation loop above can drop thresholdUsed all the way to
        // 0 when results are scarce. Never ask the saver to persist below the
        // canonical pipeline relevance floor — that is the "this is junk for
        // this profile" line (docs/canonical_rules.md). Clamp here so a sparse
        // local crawl can't smuggle sub-floor rows into the pipeline; the
        // saver's own hard floor is the net behind this.
        const saveThreshold = Math.max(thresholdUsed, RELEVANCE_FLOOR)
        const pipelineResult = await saveToProfilePipeline(
          db,
          oppWithId,
          profileId,
          profileContext,
          null,
          saveThreshold,
        )
        if (pipelineResult.saved) {
          savedToPipeline++
        }
      }
    } catch (err) {
      console.error(`[localCrawler] Error inserting ${opp.title}:`, err.message)
    }
  }
  
  log.info(`[localCrawler] Saved ${savedToPipeline} opportunities to profile pipeline (canonical score threshold ${thresholdUsed})`)
  
  return {
    evaluated: allOpps.length,
    inserted: upsertedCount,
    inserted_new: insertedCount,
    updated_existing: updatedCount,
    matched: topOpps.length,
    savedToPipeline,
    result_meta: {
      total_scored: scoredOpps.length,
      score_scale: SCORE_SCALE_ID,
      skipped_requires_match: requiresMatchSkipped,
      match_threshold_requested: requestedThreshold,
      match_threshold_used: thresholdUsed,
      match_threshold_fallback_applied: thresholdFallbackApplied,
      pipeline_excluded: pipelineExcluded,
    },
    opportunityLogs: topOpps.map(o => ({
      title: o.title,
      sponsor: o.sponsor,
      score: o.match_score,
      reasons: o.match_reasons
    }))
  }
}

export default processLocalCrawlerJob
