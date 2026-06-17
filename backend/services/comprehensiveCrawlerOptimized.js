import fs from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import {
  buildProfileSignals,
  summarizeProfileSignals,
  safeParseArrayField,
} from './profileHelpers.js'
import { saveToProfilePipeline } from './opportunityMatcher.js'
import { runNationalZipCrawl } from './crawlers/nationalZipCrawler.js'
import { runDomainCorpusCrawl } from './crawlers/domainCorpusCrawler.js'
import { ingestFromConnectors } from './connectorIngestService.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('comprehensiveCrawlerOptimized')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    if (e && (e.code === 'ENOENT' || /ENOENT/i.test(String(e.message || '')))) {
      log.info(
        `[comprehensiveCrawler] Curated opportunities dataset not present at ${filePath}; continuing with empty curated dataset`,
      )
      return null
    }
    console.warn(`[comprehensiveCrawler] Could not load ${filePath}:`, e.message)
    return null
  }
}

/**
 * Load real funding opportunities from verified data files
 */
function loadRealOpportunities() {
  const defaultPath = join(__dirname, '../data/crawlers/real_funding_opportunities.json')
  const overrideDir = process.env.CRAWLER_DATA_DIR ? String(process.env.CRAWLER_DATA_DIR) : null
  const overridePath = overrideDir ? join(overrideDir, 'real_funding_opportunities.json') : null

  // Prefer the test/automation fixture dir when configured.
  const data = overridePath ? (loadJSON(overridePath) ?? loadJSON(defaultPath)) : loadJSON(defaultPath)
  
  if (!data) {
    console.warn('[comprehensiveCrawler] No real opportunities data found')
    return []
  }
  
  const allOpps = []
  const categories = [
    'federal_grants',
    'foundation_grants',
    'state_programs',
    'disability_assistance',
    'veteran_assistance',
    'nonprofit_grants',
    // Additional profile types: individuals, families, churches, fire departments, rural orgs
    'individual_grants',
    'family_assistance',
    'church_grants',
    'religious_organization_grants',
    'fire_department_grants',
    'rural_organization_grants',
    'tribal_grants',
    'small_business_grants',
  ]
  
  for (const cat of categories) {
    if (data[cat]) {
      allOpps.push(...data[cat])
    }
  }
  
  return allOpps
}

const STATE_MAPPING = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
}

function normalizeState(state) {
  if (!state) return ''
  const s = String(state).toLowerCase().trim()
  if (STATE_MAPPING[s]) return STATE_MAPPING[s].toUpperCase()
  const sanitized = s.replace(/[^a-z]/g, '')
  return sanitized.length === 2 ? sanitized.toUpperCase() : sanitized.toUpperCase()
}

/**
 * Calculate a prefilter match score between opportunity and profile signals.
 *
 * IMPORTANT — this is a CANDIDATE PREFILTER, NOT the match authority.
 * `computeMatchDecision()` in `backend/services/matchEngine.js` is the SOLE
 * scoring/decision authority. The score this function returns is used only
 * to rank/keep candidate opportunities before insertion; the pipeline saver
 * (`saveToProfilePipeline`) re-runs `computeMatchDecision` and overwrites
 * any score it sees here.
 */
function calculateOpportunityMatch(opp, signals, profileState) {
  let score = 0
  const matchReasons = []
  
  const normalizedOppState = normalizeState(opp.state || '')
  const normalizedProfileState = normalizeState(profileState || '')
  
  const oppKeywords = new Set([
    ...(opp.keywords || []).map(k => k.toLowerCase()),
    ...(opp.categories || []).map(c => c.toLowerCase())
  ])
  
  const oppText = `${opp.title} ${opp.description}`.toLowerCase()
  
  // State match (15 points) — uses normalized values for TN/Tennessee, CA/California etc.
  const isNationwide = String(opp.state || '').toLowerCase().trim() === 'nationwide'
  if (isNationwide || (normalizedOppState && normalizedProfileState && normalizedOppState === normalizedProfileState)) {
    score += 15
    if (!isNationwide && normalizedOppState === normalizedProfileState) {
      matchReasons.push(`Location: ${profileState}`)
    }
  } else if (normalizedOppState && normalizedProfileState) {
    // Wrong state - significantly reduce score
    score -= 20
  }
  
  // Keyword matching (up to 25 points)
  let keywordMatches = 0
  const keywordIterable = signals?.keywords || signals?.keywordSet || signals?.keyword_set || null
  if (keywordIterable) {
    for (const keywordRaw of keywordIterable) {
      const keyword = String(keywordRaw ?? '').toLowerCase().trim()
      if (!keyword) continue
      if (oppKeywords.has(keyword) || oppText.includes(keyword)) {
        keywordMatches++
        if (keywordMatches <= 3) {
          matchReasons.push(`Keyword: ${keyword}`)
        }
      }
    }
  }
  score += Math.min(25, keywordMatches * 5)
  
  // Demographics matching (up to 15 points)
  if (signals.demographics) {
    let demoMatches = 0
    for (const demo of signals.demographics) {
      if (oppText.includes(demo)) {
        demoMatches++
        matchReasons.push(`Demographic: ${demo}`)
      }
    }
    score += Math.min(15, demoMatches * 5)
  }
  
  // Disability/health matching (up to 15 points)
  if (signals.health) {
    for (const health of signals.health) {
      if (oppText.includes(health) || oppKeywords.has(health)) {
        score += 5
        matchReasons.push(`Health: ${health}`)
      }
    }
  }
  
  // Veteran matching (up to 15 points)
  if (signals.military) {
    for (const mil of signals.military) {
      if (oppText.includes(mil) || oppKeywords.has('veteran')) {
        score += 10
        matchReasons.push(`Veteran status`)
        break
      }
    }
  }
  
  // Education matching
  if (signals.education && oppKeywords.has('education')) {
    score += 5
    matchReasons.push('Education focus')
  }
  
  // Ensure score is within bounds
  score = Math.max(0, Math.min(100, score))
  
  return { score, matchReasons }
}

/**
 * Run comprehensive search using real funding opportunities
 * Matches opportunities to profile based on signals
 */
export async function runComprehensiveCrawler(contextOrDb, profileContextArg = {}, options = {}) {
  // Support both dispatcher context object and direct (db, profileContext, options) calls
  let db, profileContext, matchThreshold, maxResults, saveToDatabase
  
  if (contextOrDb && typeof contextOrDb === 'object' && contextOrDb.db) {
    // Called from dispatcher with context object
    db = contextOrDb.db
    profileContext = contextOrDb.profileContext || {}
    const params = contextOrDb.job?.parameters || {}

    // Geo crawl mode: run a small ZIP-scoped discovery crawl to populate the opportunity catalog.
    // This is used by the Geo Crawl admin UI. It is intentionally separate from profile matching.
    if (String(params.mode || '').toLowerCase() === 'geo') {
      const state = params.state ? String(params.state).toUpperCase() : null
      const runAllStates =
        params.run_all_states === true ||
        String(params.run_all_states || '').toLowerCase() === 'true' ||
        String(params.runAllStates || '').toLowerCase() === 'true'
      const maxZipsRaw = params.max_zips ?? params.maxZips ?? params.zip_limit ?? params.zipLimit ?? null
      const maxZipsNum = Number(maxZipsRaw)
      const maxZips = Number.isFinite(maxZipsNum) && maxZipsNum > 0 ? maxZipsNum : null
      const batchSize = Number(params.batch_size ?? Math.min(50, Math.max(1, maxZips ?? 50)))
      const minSources = Number(params.min_sources_per_zip ?? 3)
      const zipList =
        Array.isArray(params.zip_list) && params.zip_list.length > 0
          ? params.zip_list
          : Array.isArray(params.zips) && params.zips.length > 0
            ? params.zips
            : null
      const discoverLocal =
        params.discover_local_resources ?? params.discoverLocalResources ?? true
      const overpassRadiusKm = Number(params.overpass_radius_km ?? 12)
      const overpassMaxResults = Number(params.overpass_max_results ?? 60)

      // Default offline_only=false so geo crawl hits Grants.gov + Overpass and returns more than
      // the 6 directory-only sources per zip. Min is 3 per zip; there is no max cap.
      const offlineOnly = params.offline_only ?? params.offlineOnly ?? false
      // When offline_only=true, we skip upstream APIs and do not sleep per ZIP.
      // When offline_only=false, we apply a small default delay unless overridden.
      const rateLimitMs = Number(
        params.rate_limit_ms ??
          (offlineOnly ? 0 : 250),
      )
      const resume =
        params.resume === true ||
        String(params.resume || '').toLowerCase() === 'true'
      const counties = Array.isArray(params.counties) && params.counties.length > 0 ? params.counties : undefined
      const effectiveZipList = runAllStates ? undefined : zipList || undefined

      const jobId = contextOrDb?.job?.id ?? null
      const deadlineMs = contextOrDb?.deadlineMs ?? null
      const heartbeatFn = contextOrDb?.heartbeat ?? null
      const signal = contextOrDb?.signal ?? null

      const skipDomainCorpus =
        params.skip_domain_corpus === true ||
        String(params.skip_domain_corpus || '').toLowerCase() === 'true'

      // Phase 0: Domain corpus build - run all domain crawlers from registry, persist directory resources.
      // Skipped when skip_domain_corpus=true (e.g. Anya admin-login geo sweep) to reduce load.
      let domainCorpusStats = null
      if (!skipDomainCorpus) {
        try {
          domainCorpusStats = await runDomainCorpusCrawl(db, {
            skipVerification: params.skip_url_verification ?? false,
            geoRunId: params.geo_run_id ?? params.geoRunId ?? null,
          })
          log.info('[comprehensiveCrawler] Domain corpus phase complete:', domainCorpusStats)
        } catch (domainErr) {
          console.warn('[comprehensiveCrawler] Domain corpus phase failed (continuing with ZIP crawl):', domainErr?.message || domainErr)
        }
      } else {
        log.info('[comprehensiveCrawler] GEO mode: skipping domain corpus phase (skip_domain_corpus)')
      }

      const runOnce = async (stateArg) => {
        return await runNationalZipCrawl(db, {
          state: stateArg && /^[A-Z]{2}$/.test(stateArg) ? stateArg : undefined,
          zip_list: effectiveZipList,
          max_zips: maxZips,
          batch_size: Number.isFinite(batchSize) ? batchSize : 25,
          rate_limit_ms: Number.isFinite(rateLimitMs) ? rateLimitMs : (offlineOnly ? 0 : 250),
          min_sources_per_zip: Number.isFinite(minSources) ? minSources : 1,
          counties,
          offline_only: offlineOnly,
          discover_local_resources: Boolean(discoverLocal),
          overpass_radius_km: Number.isFinite(overpassRadiusKm) ? overpassRadiusKm : 12,
          overpass_max_results: Number.isFinite(overpassMaxResults) ? overpassMaxResults : 60,
          resume,
          job_id: jobId,
          geo_run_id: params.geo_run_id ?? params.geoRunId ?? null,
          fixtures_dir: process.env.GEO_CRAWL_FIXTURES_DIR || undefined,
          heartbeat: heartbeatFn,
          // Pass the dispatcher deadline + a 90s buffer so per-batch loops can exit
          // gracefully BEFORE withTimeout() kills the job as `failed`.
          deadline_ms: deadlineMs,
          deadline_buffer_ms: 90_000,
        })
      }

      if (runAllStates) {
        // When running all states without an explicit max_zips, apply a sane default
        // to prevent the crawl from attempting all ~43k US ZIPs.
        // 15 ZIPs/state × 51 = 765 total ZIPs — fits within 6h timeout with margin.
        const ALL_STATES_DEFAULT_MAX_ZIPS = 15
        if (!maxZips) {
          log.info(
            `[comprehensiveCrawler] GEO all-states: no max_zips specified, defaulting to ${ALL_STATES_DEFAULT_MAX_ZIPS} per state`,
          )
        }
        const effectiveMaxZips = maxZips || ALL_STATES_DEFAULT_MAX_ZIPS

        const stateList = Array.isArray(params.states) ? params.states : null
        const normalizedStates = (stateList || []).map((s) => String(s || '').toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s))
        const statesToRun = normalizedStates.length > 0
          ? normalizedStates
          : [
              'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
              'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
              'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
              'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
              'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
            ]

        const statePacingMs = Number(params.state_pacing_ms ?? params.statePacingMs ?? 0)
        const pacing =
          Number.isFinite(statePacingMs) && statePacingMs > 0 ? Math.min(statePacingMs, 120_000) : 0

        log.info('[comprehensiveCrawler] GEO mode starting: all states', {
          states: statesToRun.length,
          maxZips: effectiveMaxZips,
          batchSize,
          state_pacing_ms: pacing || 0,
        })

        // Override maxZips in runOnce so the per-state crawl respects the cap.
        const runOnceWithCap = async (stateArg) => {
          return await runNationalZipCrawl(db, {
            state: stateArg && /^[A-Z]{2}$/.test(stateArg) ? stateArg : undefined,
            zip_list: effectiveZipList,
            max_zips: effectiveMaxZips,
            batch_size: Number.isFinite(batchSize) ? batchSize : 25,
            rate_limit_ms: Number.isFinite(rateLimitMs) ? rateLimitMs : (offlineOnly ? 0 : 250),
            min_sources_per_zip: Number.isFinite(minSources) ? minSources : 1,
            counties,
            offline_only: offlineOnly,
            discover_local_resources: Boolean(discoverLocal),
            overpass_radius_km: Number.isFinite(overpassRadiusKm) ? overpassRadiusKm : 12,
            overpass_max_results: Number.isFinite(overpassMaxResults) ? overpassMaxResults : 60,
            resume,
            job_id: jobId,
            geo_run_id: params.geo_run_id ?? params.geoRunId ?? null,
            fixtures_dir: process.env.GEO_CRAWL_FIXTURES_DIR || undefined,
            heartbeat: heartbeatFn,
            // Pass the dispatcher deadline + a 90s buffer so per-batch loops can exit
            // gracefully BEFORE withTimeout() kills the job as `failed`.
            deadline_ms: deadlineMs,
            deadline_buffer_ms: 90_000,
          })
        }

        // Reserve 5 minutes for final DB writes and cleanup
        const DEADLINE_BUFFER_MS = 5 * 60 * 1000

        let totalProcessed = 0
        let totalSources = 0
        let totalFailed = 0
        let totalSkipped = 0
        /** @type {Array<any>} */
        const perState = []

        for (let i = 0; i < statesToRun.length; i++) {
          // Abort signal check: stop immediately if the dispatcher timed out or cancelled us.
          if (signal?.aborted) {
            console.warn(
              `[comprehensiveCrawler] Abort signal received after ${i}/${statesToRun.length} states — stopping`,
            )
            break
          }

          // Time-budget check: stop gracefully before the hard timeout kills us as a failure.
          if (deadlineMs && Date.now() + DEADLINE_BUFFER_MS >= deadlineMs) {
            console.warn(
              `[comprehensiveCrawler] Time budget exhausted after ${i}/${statesToRun.length} states — stopping gracefully`,
            )
            break
          }

          const st = statesToRun[i]
          if (pacing > 0 && i > 0) {
            await new Promise((resolve) => setTimeout(resolve, pacing))
          }

          // Pump heartbeat between states
          if (heartbeatFn) {
            try { await heartbeatFn() } catch { /* non-fatal */ }
          }

          const r = await runOnceWithCap(st)
          totalProcessed += Number(r?.processed ?? 0)
          totalSources += Number(r?.sources ?? 0)
          totalFailed += Number(r?.failed ?? 0)
          totalSkipped += Number(r?.skipped ?? 0)
          // Keep payload reasonably small
          perState.push({
            state: st,
            processed: Number(r?.processed ?? 0),
            sources: Number(r?.sources ?? 0),
            failed: Number(r?.failed ?? 0),
            skipped: Number(r?.skipped ?? 0),
            stopped_for_deadline: r?.stopped_for_deadline === true,
          })

          // If the per-state crawl exited because it hit the dispatcher
          // deadline buffer, stop the per-state loop immediately rather than
          // attempting another state we know we cannot finish. We're returning
          // success either way; the next run will pick up via the (now 7-day)
          // resume window.
          if (r?.stopped_for_deadline) {
            console.warn(
              `[comprehensiveCrawler] State ${st} stopped for deadline; exiting per-state loop`,
            )
            break
          }

          // Flush intermediate progress to crawler_jobs so timeouts still capture partial results.
          if (jobId) {
            try {
              const intermediateMeta = JSON.stringify({
                mode: 'geo',
                run_all_states: true,
                states_completed: i + 1,
                states_total: statesToRun.length,
                processed: totalProcessed,
                sources: totalSources,
                failed: totalFailed,
                skipped: totalSkipped,
              })
              await db.prepare(`
                UPDATE crawler_jobs
                SET result_count = ?,
                    result_meta = ?
                WHERE id = ?
                  AND status = 'running'
              `).run(totalSources, intermediateMeta, jobId)
            } catch (flushErr) {
              console.warn('[comprehensiveCrawler] Failed to flush intermediate progress:', flushErr?.message)
            }
          }
        }

        return {
          success: true,
          inserted: totalSources,
          evaluated: totalProcessed,
          result_meta: {
            mode: 'geo',
            run_all_states: true,
            processed: totalProcessed,
            sources: totalSources,
            failed: totalFailed,
            skipped: totalSkipped,
            states: perState,
          },
          message: `Geo crawl completed: processed ${totalProcessed} ZIPs across ${statesToRun.length} states`,
        }
      }

      log.info('[comprehensiveCrawler] GEO mode starting', { state, maxZips, batchSize })
      const result = await runOnce(state)

      return {
        success: true,
        inserted: Number(result?.sources ?? 0),
        evaluated: Number(result?.processed ?? 0),
        result_meta: {
          mode: 'geo',
          state: state ?? null,
          processed: result?.processed ?? 0,
          sources: result?.sources ?? 0,
          failed: result?.failed ?? 0,
          skipped: result?.skipped ?? 0,
          total_zips: result?.total_zips ?? null,
        },
        message: `Geo crawl completed: processed ${result?.processed ?? 0} ZIPs`,
      }
    }

    matchThreshold = params.match_threshold || 65
    maxResults = params.max_results || 50
    saveToDatabase = params.save_to_database !== false
  } else {
    // Called directly with (db, profileContext, options)
    db = contextOrDb
    profileContext = profileContextArg
    matchThreshold = options.matchThreshold || 80
    maxResults = options.maxResults || 50
    saveToDatabase = options.saveToDatabase !== false
  }
  
  log.info('[comprehensiveCrawler] Starting with real opportunities...')
  
  // Build profile signals
  const signals = buildProfileSignals(profileContext)
  const profileState = profileContext.profile?.state || profileContext.signals?.location?.state
  const profileId = profileContext.profile_id || profileContext.profile?.id
  
  log.info('[comprehensiveCrawler] Profile signals:', summarizeProfileSignals(signals))
  log.info('[comprehensiveCrawler] Profile state:', profileState)

  // Phase: profile-driven connector ingest. Pulls fresh, eligibility-matched rows
  // from Grants.gov / Simpler.Grants.gov / SAM Assistance Listings / NIH RePORTER /
  // ProPublica foundations into funding_opportunities BEFORE we query the DB below,
  // so this profile's matches draw from a pool sized to its actual eligibility
  // rather than a generic federal dump. Fully isolated: any failure is logged and
  // the established crawl continues unchanged. Opt out with INGEST_CONNECTORS=off.
  const hasFixtureCrawlerData = Boolean(String(process.env.CRAWLER_DATA_DIR || '').trim())
  const defaultConnectorIngestMode =
    process.env.NODE_ENV === 'test' || String(process.env.SMOKE_MODE || '').toLowerCase() === 'true' || hasFixtureCrawlerData
      ? 'off'
      : 'on'
  let connectorIngest = null
  if (db && String(process.env.INGEST_CONNECTORS || defaultConnectorIngestMode).toLowerCase() !== 'off') {
    try {
      connectorIngest = await ingestFromConnectors({ db, profileContext, signals })
      log.info('[comprehensiveCrawler] Connector ingest totals:', connectorIngest.totals)
    } catch (ingestErr) {
      console.warn('[comprehensiveCrawler] Connector ingest phase failed (continuing):', ingestErr?.message || ingestErr)
    }
  }

  // Load real opportunities
  const realOpps = loadRealOpportunities()
  log.info(`[comprehensiveCrawler] Loaded ${realOpps.length} real opportunities`)
  
  // Also load from database
  const isPg = db?.dialect === 'postgres'
  const dbOppsQuery = isPg
      ? `
          SELECT *
          FROM funding_opportunities
          WHERE is_active IS TRUE
            AND (requires_match IS FALSE OR requires_match IS NULL)
            AND ${trustedOriginClause()}
            AND ${trustedSourceClause()}
          ORDER BY created_at DESC
          LIMIT 200
        `
      : `
          SELECT *
          FROM funding_opportunities
          WHERE is_active = 1
            AND (requires_match = 0 OR requires_match IS NULL)
            AND ${trustedOriginClause()}
            AND ${trustedSourceClause()}
          ORDER BY created_at DESC
          LIMIT 200
        `

  let dbOpps = []
  try {
    dbOpps = await db.prepare(dbOppsQuery).all() || []
  } catch (err) {
    console.error('[comprehensiveCrawler] Error querying database for opportunities:', err.message)
  }
  
  log.info(`[comprehensiveCrawler] Found ${dbOpps.length} opportunities in database`)
  
  // Combine and dedupe
  const seenTitles = new Set()
  const allOpps = []
  
  for (const opp of realOpps) {
    if (!seenTitles.has(opp.title)) {
      seenTitles.add(opp.title)
      allOpps.push(opp)
    }
  }
  
  for (const opp of dbOpps) {
    if (!seenTitles.has(opp.title)) {
      seenTitles.add(opp.title)
      allOpps.push({
        ...opp,
        keywords: safeParseArrayField(opp.keywords, []),
        categories: safeParseArrayField(opp.categories, []),
        eligibility_bullets: safeParseArrayField(opp.eligibility_bullets, [])
      })
    }
  }
  
  // Score and filter opportunities
  const scoredOpps = []
  
  for (const opp of allOpps) {
    // Skip if requires matching funds
    if (opp.requires_match) continue
    
    const { score, matchReasons } = calculateOpportunityMatch(opp, signals, profileState)
    
    scoredOpps.push({
      ...opp,
      match_score: score,
      match_reasons: matchReasons
    })
  }
  
  // Sort by score and limit
  scoredOpps.sort((a, b) => b.match_score - a.match_score)
  const targetMin = Math.min(10, maxResults)
  const requestedThreshold = Number(matchThreshold) || 0
  const thresholdCandidates = Array.from(
    new Set([requestedThreshold, 80, 70, 60, 50, 0].filter((v) => Number.isFinite(v))),
  ).sort((a, b) => b - a)

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

  const topOpps = filteredOpps.slice(0, maxResults)
  const thresholdFallbackApplied = thresholdUsed !== requestedThreshold
  
  log.info(
    `[comprehensiveCrawler] Found ${topOpps.length} matching opportunities (requested: ${requestedThreshold}%, used: ${thresholdUsed}%)`,
  )
  
  // Save to database if requested
  let upsertedCount = 0
  let insertedCount = 0
  let updatedCount = 0
  if (saveToDatabase) {
    for (const opp of topOpps) {
      try {
        const result = await upsertFundingOpportunity(db, {
          title: opp.title,
          sponsor: opp.sponsor,
          description: opp.description,
          amount_min: opp.amount_min,
          amount_max: opp.amount_max,
          amount_description: opp.amount_description,
          deadline: opp.deadline,
          application_url: opp.application_url ?? null,
          source_url: opp.source_url ?? opp.application_url ?? null,
          categories: opp.categories,
          keywords: opp.keywords,
          eligibility_bullets: opp.eligibility_bullets,
          requires_match: false,
          requires_501c3: opp.requires_501c3,
          state: opp.state,
          source: 'verified_real',
          source_id: opp.id || opp.source_id,
          record_origin: 'curated_verified',
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
      } catch (err) {
        console.error(`[comprehensiveCrawler] Error inserting ${opp.title}:`, err.message)
      }
    }
  }
  
  // Save matches to profile pipeline if profileId provided.
  // Pass the crawler's chosen threshold (thresholdUsed) to
  // saveToProfilePipeline. ACCEPT/REVIEW no longer bypasses the saver's
  // numeric floor, so callers must explicitly supply the floor they already
  // filtered against. Otherwise the saver's 55% default silently rejects
  // opportunities this crawler legitimately surfaced.
  // instead of pre-filtering at 80% which blocked all individual-profile results.
  let savedToProfile = 0
  if (profileId) {
    for (const opp of topOpps) {
      try {
        // Find the inserted opportunity ID
        const insertedOpp = await db.prepare(`
          SELECT id FROM funding_opportunities
          WHERE source = 'verified_real' AND source_id = ?
          LIMIT 1
        `).get(opp.id || opp.source_id)

        if (insertedOpp) {
          const oppWithId = { ...opp, id: insertedOpp.id, source: opp.source || 'verified_real' }
          // Do NOT pass pre-computed score — let saveToProfilePipeline run
          // computeMatchDecision() as the single canonical authority (Goal 4).
          // Pass the crawler's chosen threshold so the saver respects this
          // caller's filtering choice instead of using its 55% default.
          const result = await saveToProfilePipeline(
            db,
            oppWithId,
            profileId,
            profileContext,
            null,
            thresholdUsed,
          )
          if (result.saved) {
            savedToProfile++
          }
        }
      } catch (err) {
        // Ignore duplicates
        console.warn(`[comprehensiveCrawler] Could not save to pipeline: ${err.message}`)
      }
    }
  }

  log.info(`[comprehensiveCrawler] Saved ${savedToProfile} opportunities to profile pipeline`)
  
  return {
    success: true,
    opportunities: topOpps.map(opp => ({
      id: opp.id,
      title: opp.title,
      sponsor: opp.sponsor,
      description: opp.description,
      amount_min: opp.amount_min,
      amount_max: opp.amount_max,
      amount_description: opp.amount_description,
      deadline: opp.deadline,
      application_url: opp.application_url,
      state: opp.state,
      match_score: opp.match_score,
      match_reasons: opp.match_reasons,
      requires_match: false,
      eligibility_bullets: opp.eligibility_bullets,
      categories: opp.categories
    })),
    total: topOpps.length,
    inserted: upsertedCount,
    inserted_new: insertedCount,
    updated_existing: updatedCount,
    savedToProfile,
    result_meta: {
      total_scored: scoredOpps.length,
      match_threshold_requested: requestedThreshold,
      match_threshold_used: thresholdUsed,
      match_threshold_fallback_applied: thresholdFallbackApplied,
    },
    message: `Found ${topOpps.length} real funding opportunities matching your profile.`
  }
}

// Export for backward compatibility
export default runComprehensiveCrawler
