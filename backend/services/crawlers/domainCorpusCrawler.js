/**
 * Domain Corpus Crawler - National Funding Aggregator
 * Runs all domain crawlers from registry, persists to funding_opportunities with rich metadata.
 * Used by Admin Geo Crawl (nationwide) as the corpus-building phase.
 * - Every opportunity MUST have a URL. No fake results.
 * - Persists directory_resource and live_crawl entries.
 * - Lightweight URL verification (HEAD on first 20 new URLs).
 */

import { runDomainCrawler, looksLikeLoan, looksLikeMatchingFunds } from './domainCrawlerEngine.js'
import { DOMAIN_CRAWLER_REGISTRY, selectRelevantDomainIds } from './domainCrawlerRegistry.js'
import { runAllDomainEngines, DOMAIN_ENGINES } from './domainEngines/index.js'
import { bulkUpsertFundingOpportunities } from '../opportunityInserter.js'
import { headForVerification } from '../shared/httpClient.js'
import { createLogger } from '../../utils/logger.js'
const log = createLogger('domainCorpusCrawler')

const CRAWLER_VERSION = 'v3-domain-engine'
const DOMAIN_CRAWL_TIMEOUT_MS = Number(process.env.DOMAIN_CORPUS_CRAWL_TIMEOUT_MS ?? 8000)
const VERIFY_URL_LIMIT = 20

/** Minimal profile for corpus build - directory resources don't need signals. */
const MINIMAL_PROFILE = {
  signals: {
    keywordSet: new Set(),
    location: {},
  },
}

function hasUrl(opp) {
  return !!(opp?.url || opp?.application_url || opp?.source_url)
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label || 'Domain crawl'} timed out after ${ms}ms`)), ms),
    ),
  ])
}

/**
 * Attach corpus metadata to each opportunity before persistence.
 */
function attachCorpusMetadata(opp, config) {
  const semanticOrigin = opp.record_origin ?? 'directory_resource'
  return {
    ...opp,
    funding_domain: config.category ?? null,
    funding_subdomain: config.id ?? null,
    source_category: semanticOrigin,
    compliance_required: config.requiredCompliance ?? [],
    certifications_required: config.requiredCertifications ?? [],
    geo_eligibility: config.geoScope ?? null,
    signal_tags: opp.matchedSignals ?? [],
    crawler_version: CRAWLER_VERSION,
    is_national: true,
    state: 'nationwide',
    record_origin: 'live_crawl',
    source: config.label ?? config.id ?? opp.source,
  }
}

/**
 * Run domain crawlers and persist to funding_opportunities.
 *
 * PROFILE-DRIVEN selection: when `options.profileContext` (or `options.signals`)
 * is supplied, only the domain corpora RELEVANT to that profile are crawled
 * (selectRelevantDomainIds) — a church profile pulls faith/community/nonprofit
 * domains, an EMS profile pulls first-responder domains, etc. With no profile
 * (admin nationwide sweep) ALL corpora are crawled exactly as before.
 *
 * @param {Object} db - Database instance
 * @param {Object} options - { skipVerification, geoRunId, profileContext, signals, domainIds, headForVerification }
 * @returns {Promise<Object>} Stats
 */
export async function runDomainCorpusCrawl(db, options = {}) {
  const verifyHead = options.headForVerification ?? headForVerification
  // Resolve the profile signals (dispatcher passes profileContext.signals).
  const signals = options.signals ?? options.profileContext?.signals ?? null
  // Domain engines (healthClinicalEngine, housingCommunityFinanceEngine,
  // utilitiesHardshipEngine, ...) read `profile.needs` / `profile.health.conditions` /
  // `profile.location` / `profile.states` directly off the profile object passed to
  // runAllDomainEngines below — NOT off `signals`. Handing them only `{ signals }`
  // left every engine seeing an empty needs/health/location profile, so the entire
  // profile-aware domain engine layer produced identical results regardless of what
  // a profile actually declared. `needs`/`health_conditions` are Sets on `signals`
  // (no .length/.some) so they must be converted to arrays here.
  const profileForCrawl = signals
    ? {
        signals,
        needs: Array.from(signals.needs ?? []),
        health: { conditions: Array.from(signals.health_conditions ?? []) },
        location: signals.location ?? {},
        states: Array.isArray(signals.states) ? signals.states : [],
      }
    : MINIMAL_PROFILE

  // Decide which corpora to run. Explicit options.domainIds wins; otherwise
  // derive from the profile; with no profile, run the whole registry.
  let activeRegistry = DOMAIN_CRAWLER_REGISTRY
  let selectedIds = null
  if (Array.isArray(options.domainIds) && options.domainIds.length > 0) {
    selectedIds = new Set(options.domainIds)
  } else if (signals) {
    selectedIds = new Set(selectRelevantDomainIds(signals))
  }
  if (selectedIds) {
    activeRegistry = DOMAIN_CRAWLER_REGISTRY.filter((c) => selectedIds.has(c.id))
    log.info(
      `[domainCorpusCrawler] Profile-driven selection: crawling ${activeRegistry.length}/${DOMAIN_CRAWLER_REGISTRY.length} ` +
      `domain corpora [${activeRegistry.map((c) => c.id).join(', ')}]`,
    )
  }

  const stats = {
    domains_selected: activeRegistry.length,
    domains_total: DOMAIN_CRAWLER_REGISTRY.length,
    profile_driven: Boolean(signals) && !options.domainIds,
    number_of_urls_missing: 0,
    number_filtered_loans: 0,
    number_filtered_matching: 0,
    number_directory_resources: 0,
    number_live_resources: 0,
    total_inserted: 0,
    total_verified: 0,
    crawlers_run: 0,
    crawlers_failed: 0,
  }

  const allOpportunities = []

  for (const config of activeRegistry) {
    try {
      const raw = await withTimeout(
        runDomainCrawler({
          profile: profileForCrawl,
          config,
          options: {},
        }),
        DOMAIN_CRAWL_TIMEOUT_MS,
        config.id,
      )

      let directoryCount = 0
      let liveCount = 0
      let filteredLoanCount = 0
      let filteredMatchingCount = 0

      for (const opp of raw) {
        if (!hasUrl(opp)) {
          stats.number_of_urls_missing++
          continue
        }

        const text = [opp.title, opp.description, ...(opp.eligibility_bullets || []), ...(opp.keywords || [])]
          .filter(Boolean)
          .join(' ')
        if (config.strict_no_loans && looksLikeLoan(text)) {
          filteredLoanCount++
          continue
        }
        if (config.strict_no_matching && looksLikeMatchingFunds(text)) {
          filteredMatchingCount++
          continue
        }

        if (opp.record_origin === 'live_crawl') liveCount++
        else directoryCount++

        const withMeta = {
  ...attachCorpusMetadata(opp, config),
  match_decision: 'PENDING',
  match_explanation: 'Awaiting profile match evaluation',
  matched_needs: JSON.stringify([]),
  eligibility_status: 'unreviewed',
  ineligibility_reasons: JSON.stringify([]),
  evaluated_at: null,
  match_confidence: null,
}
        allOpportunities.push(withMeta)
      }

      stats.number_filtered_loans += filteredLoanCount
      stats.number_filtered_matching += filteredMatchingCount
      stats.number_directory_resources += directoryCount
      stats.number_live_resources += liveCount
      stats.crawlers_run++
    } catch (err) {
      stats.crawlers_failed++
      log.error(`[domainCorpusCrawler] CRITICAL: ${config.id} failed:`, err?.message || String(err))
      // Do NOT re-throw timeout errors mid-loop; log and continue so remaining crawlers run.
      // The caller can inspect stats.crawlers_failed to decide whether to abort.
    }
  }

  // Append 8 domain engines (tax, utilities, health, education, housing, workforce, family/youth, geo)
  try {
    const engineOpps = await runAllDomainEngines(profileForCrawl, {})
    for (const o of engineOpps) {
      if (!hasUrl(o)) {
        stats.number_of_urls_missing++
        continue
      }
      const withMeta = {
        ...o,
        funding_domain: o.crawler_type ?? 'domain_engine',
        funding_subdomain: o.crawler_type ?? null,
        source_category: 'directory_resource',
        compliance_required: [],
        certifications_required: [],
        geo_eligibility: null,
        signal_tags: [],
        crawler_version: CRAWLER_VERSION,
        is_national: true,
        state: 'nationwide',
        record_origin: 'live_crawl',
        source: o.source ?? o.crawler_type,
        match_decision: 'PENDING',
        match_explanation: 'Awaiting profile match evaluation',
        matched_needs: JSON.stringify([]),
        eligibility_status: 'unreviewed',
        ineligibility_reasons: JSON.stringify([]),
        evaluated_at: null,
        match_confidence: null,
      }
      allOpportunities.push(withMeta)
      stats.number_directory_resources += 1
    }
    stats.crawlers_run += DOMAIN_ENGINES.length
  } catch (err) {
    log.error('[domainCorpusCrawler] CRITICAL: Domain engines phase failed:', err?.message || err)
    throw new Error('Domain engines failure - core funding categories unavailable')
  }

  // Dedupe by URL
  const seen = new Set()
  const deduped = allOpportunities.filter((o) => {
    const key = (o.url || o.application_url || o.source_url || '').toLowerCase()
    if (!key) return false
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  stats.number_deduped = allOpportunities.length - deduped.length
  stats.total_candidates = allOpportunities.length
  if (stats.number_deduped > 0) {
    log.info(
      `[domainCorpusCrawler] Deduplication removed ${stats.number_deduped} duplicate URLs from ${allOpportunities.length} candidates.`,
    )
  }

  let inserted
  try {
    inserted = await bulkUpsertFundingOpportunities(db, deduped)
    stats.total_inserted = inserted.length
  } catch (err) {
    log.error('[domainCorpusCrawler] CRITICAL: Database insert failed:', err?.message)
    throw new Error(`Failed to persist ${deduped.length} funding opportunities - data loss risk`)
  }

  // URL verification: HEAD on first N new URLs.
  //
  // We record honest verification metadata (link_status / link_status_code /
  // verification_method / verified_by / last_verified_at) — not just a
  // verified_url=1 boolean — so the recurring linkVerificationService and the
  // consumer-side trust gate have the data they need to hide broken direct
  // opportunities and re-check stale ones.
  if (!options.skipVerification && inserted.length > 0) {
    const idsToVerify = inserted.slice(0, VERIFY_URL_LIMIT)
    const placeholders = idsToVerify.map(() => '?').join(',')
    const rows = await db
      .prepare(
        `SELECT id, source_url, application_url, type, opportunity_type FROM funding_opportunities WHERE id IN (${placeholders})`,
      )
      .all(...idsToVerify)

    const verVal = db?.dialect === 'postgres' ? true : 1
    const falseVal = db?.dialect === 'postgres' ? false : 0
    const update = db.prepare(`
      UPDATE funding_opportunities
      SET verified_url = ?,
          last_verified_at = ?,
          link_status = ?,
          link_status_code = ?,
          verification_method = ?,
          verified_by = ?,
          verification_error = ?
      WHERE id = ?
    `)
    const deactivate = db.prepare(`
      UPDATE funding_opportunities SET is_active = ? WHERE id = ?
    `)
    for (const row of rows) {
      const url = row.application_url || row.source_url
      if (!url || !String(url).startsWith('http')) continue
      const now = new Date().toISOString()
      try {
        const probe = await verifyHead(url, { timeoutMs: 4000 })
        if (probe.ok) {
          await update.run(
            verVal,
            now,
            probe.status >= 300 && probe.status < 400 ? 'redirect' : 'ok',
            probe.status,
            'head',
            'crawler:domainCorpus',
            null,
            row.id,
          )
          stats.total_verified++
        } else {
          await update.run(
            falseVal,
            now,
            'broken',
            probe.status ?? null,
            'head',
            'crawler:domainCorpus',
            probe.error || `HTTP ${probe.status ?? 'no_response'}`,
            row.id,
          )
          // Direct (non-directory) broken rows should not be shown.
          const isDirectory =
            String(row.type || '').toUpperCase() === 'DIRECTORY' ||
            String(row.opportunity_type || '').toLowerCase().includes('directory')
          if (!isDirectory) {
            try { await deactivate.run(falseVal, row.id) } catch { /* best effort */ }
          }
        }
      } catch (httpErr) {
        log.debug(`[domainCorpusCrawler] URL verification failed for ${url}:`, httpErr?.message)
      }
    }
  }

  log.info('[domainCorpusCrawler] Complete:', stats)
  return stats
}
