/**
 * Domain Corpus Crawler - National Funding Aggregator
 * Runs all domain crawlers from registry, persists to funding_opportunities with rich metadata.
 * Used by Admin Geo Crawl (nationwide) as the corpus-building phase.
 * - Every opportunity MUST have a URL. No fake results.
 * - Persists directory_resource and live_crawl entries.
 * - Lightweight URL verification (HEAD on first 20 new URLs).
 */

import { runDomainCrawler, looksLikeLoan, looksLikeMatchingFunds } from './domainCrawlerEngine.js'
import { DOMAIN_CRAWLER_REGISTRY } from './domainCrawlerRegistry.js'
import { runAllDomainEngines, DOMAIN_ENGINES } from './domainEngines/index.js'
import { bulkUpsertFundingOpportunities } from '../opportunityInserter.js'
import { headForVerification } from './httpClient.js'

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
 * Run all domain crawlers and persist to funding_opportunities.
 * @param {Object} db - Database instance
 * @param {Object} options - { skipVerification, geoRunId }
 * @returns {Promise<Object>} Stats
 */
export async function runDomainCorpusCrawl(db, options = {}) {
  const stats = {
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

  for (const config of DOMAIN_CRAWLER_REGISTRY) {
    try {
      const raw = await withTimeout(
        runDomainCrawler({
          profile: MINIMAL_PROFILE,
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

        const withMeta = attachCorpusMetadata(opp, config)
        allOpportunities.push(withMeta)
      }

      stats.number_filtered_loans += filteredLoanCount
      stats.number_filtered_matching += filteredMatchingCount
      stats.number_directory_resources += directoryCount
      stats.number_live_resources += liveCount
      stats.crawlers_run++
    } catch (err) {
      stats.crawlers_failed++
      console.error(`[domainCorpusCrawler] CRITICAL: ${config.id} failed:`, err?.message || String(err))
      // Do NOT re-throw timeout errors mid-loop; log and continue so remaining crawlers run.
      // The caller can inspect stats.crawlers_failed to decide whether to abort.
    }
  }

  // Append 8 domain engines (tax, utilities, health, education, housing, workforce, family/youth, geo)
  try {
    const engineOpps = await runAllDomainEngines(MINIMAL_PROFILE, {})
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
      }
      allOpportunities.push(withMeta)
      stats.number_directory_resources += 1
    }
    stats.crawlers_run += DOMAIN_ENGINES.length
  } catch (err) {
    console.error('[domainCorpusCrawler] CRITICAL: Domain engines phase failed:', err?.message || err)
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

  let inserted
  try {
    inserted = await bulkUpsertFundingOpportunities(db, deduped)
    stats.total_inserted = inserted.length
  } catch (err) {
    console.error('[domainCorpusCrawler] CRITICAL: Database insert failed:', err?.message)
    throw new Error(`Failed to persist ${deduped.length} funding opportunities - data loss risk`)
  }

  // URL verification: HEAD on first N new URLs
  if (!options.skipVerification && inserted.length > 0) {
    const idsToVerify = inserted.slice(0, VERIFY_URL_LIMIT)
    const placeholders = idsToVerify.map(() => '?').join(',')
    const rows = await db
      .prepare(
        `SELECT id, source_url, application_url FROM funding_opportunities WHERE id IN (${placeholders})`,
      )
      .all(...idsToVerify)

    const now = new Date().toISOString()
    const verVal = db?.dialect === 'postgres' ? true : 1
    for (const row of rows) {
      const url = row.source_url || row.application_url
      if (!url || !String(url).startsWith('http')) continue
      try {
        const { ok } = await headForVerification(url, { timeoutMs: 4000 })
        if (ok) {
          try {
            await db
              .prepare(
                `UPDATE funding_opportunities SET verified_url = ?, last_verified_at = ? WHERE id = ?`,
              )
              .run(verVal, now, row.id)
            stats.total_verified++
          } catch (dbErr) {
            console.warn(`[domainCorpusCrawler] Failed to update verification for ${row.id}:`, dbErr?.message)
          }
        }
      } catch (httpErr) {
        console.debug(`[domainCorpusCrawler] URL verification failed for ${url}:`, httpErr?.message)
      }
    }
  }

  console.log('[domainCorpusCrawler] Complete:', stats)
  return stats
}
