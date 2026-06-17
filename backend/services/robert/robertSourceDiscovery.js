/**
 * robertSourceDiscovery.js
 *
 * Source-discovery layer with a PLUGGABLE fetcher. Robert never opens
 * the live web by default; all fetching goes through `searchProvider`
 * and `fetcher` callables that the caller injects. When env gates
 * `ROBERT_ALLOW_LIVE_WEB` and `ROBERT_ALLOW_SEARCH_ENGINE` are off
 * (the defaults), Robert simply skips and returns 0 candidates with
 * a `reason` of `'live_web_disabled'`.
 *
 * Output: an array of source candidates ready for upsertSourceCandidate().
 * The DECISION to persist them is left to the caller so this module is
 * trivially testable.
 */

import {
  classifySourceType,
  computeSourceTrustScore,
  ROBERT_SEED_SOURCES,
} from './robertSourceRegistry.js'
import {
  extractDomain,
  makeSourceCandidate,
  SOURCE_STATUS,
} from './robertTypes.js'
import {
  checkRateLimit,
  getRobertConfig,
  isPlaceholderUrl,
  isSearchEngineUrl,
  recordDomainHit,
} from './robertSafety.js'

/**
 * Seed Robert's source pool with the curated registry. Idempotent.
 */
export async function seedSourceRegistry({ db, upsert }) {
  if (!db || typeof upsert !== 'function') return { inserted: 0, updated: 0, skipped: 0 }
  let inserted = 0
  let updated = 0
  for (const seed of ROBERT_SEED_SOURCES) {
    const candidate = makeSourceCandidate({
      ...seed,
      source_domain: extractDomain(seed.source_url),
      trust_score: seed.trust_score ?? computeSourceTrustScore(seed.source_url),
      status: SOURCE_STATUS.APPROVED,                  // seeds are pre-approved
    })
    const result = await upsert(db, candidate)
    if (result?.inserted) inserted += 1
    else if (result?.updated) updated += 1
  }
  return { inserted, updated, skipped: 0 }
}

/**
 * Discover NEW source candidates given a list of search plans.
 *
 * @param {object} args
 * @param {Array}  args.plans               output of buildSearchPlans
 * @param {Function} [args.searchProvider]  async ({query, exclude}) => [{ url, title, snippet }]
 * @param {object}   [args.config]          override of getRobertConfig()
 * @returns {Promise<{ candidates, skipped, reason }>}
 */
export async function discoverSourceCandidates({
  plans = [],
  searchProvider = null,
  config = null,
} = {}) {
  const cfg = config || getRobertConfig()
  if (!cfg.enabled || !cfg.allowLiveWeb || !cfg.allowSourceDiscovery || typeof searchProvider !== 'function') {
    return { candidates: [], skipped: plans.length, reason: 'live_web_disabled' }
  }

  const seen = new Map()
  const candidates = []
  for (const plan of plans) {
    let results = []
    try {
      results = await searchProvider({
        query: plan.search_query,
        exclude: plan.exclude_terms || [],
        trustedDomains: plan.trusted_domains || [],
      }) || []
    } catch (err) {
      results = []
    }
    for (const result of results) {
      if (!result?.url) continue
      if (isPlaceholderUrl(result.url)) continue
      if (isSearchEngineUrl(result.url)) continue           // SE URLs are NEVER source candidates
      const domain = extractDomain(result.url)
      const dedupeKey = `${result.url}`.toLowerCase()
      if (seen.has(dedupeKey)) continue
      const trust = computeSourceTrustScore(result.url)
      if (trust < (cfg.minSourceTrust ?? 60)) continue
      const candidate = makeSourceCandidate({
        source_name: result.title || domain,
        source_url: result.url,
        source_domain: domain,
        source_type: classifySourceType(result.url),
        source_scope: plan.location_scope || 'national',
        applicant_types: plan.applicant_type ? [plan.applicant_type] : [],
        need_categories: plan.need_category ? [plan.need_category] : [],
        trust_score: trust,
        discovered_by: 'robert',
        status: SOURCE_STATUS.PENDING,
        evidence: { search_query: plan.search_query, snippet: result.snippet || '' },
      })
      seen.set(dedupeKey, candidate)
      candidates.push(candidate)
    }
  }
  return { candidates, skipped: 0, reason: null }
}

/**
 * Resolve a list of source candidates into URLs to fetch, respecting
 * domain rate limits. Returns the list of fetch tasks (NOT the
 * fetched contents — the caller is responsible for calling `fetcher`).
 */
export async function planSourceFetches({
  db,
  sources = [],
  config = null,
  now = new Date(),
} = {}) {
  const cfg = config || getRobertConfig()
  const out = []
  for (const src of sources) {
    if (!src?.source_url) continue
    const domain = extractDomain(src.source_url) || src.source_domain
    if (db && domain) {
      const rl = await checkRateLimit(db, domain, { perHour: cfg.rateLimitPerDomainPerHour, now })
      if (!rl.ok) continue
    }
    out.push({
      url: src.source_url,
      domain,
      timeoutMs: cfg.timeoutMs,
      userAgent: cfg.userAgent,
      respectRobots: cfg.respectRobots,
      source_candidate_id: src.id || src.source_candidate_id || null,
    })
  }
  return out
}

/**
 * Helper to consume a fetch result (intended to be called by the
 * agent) — records the domain hit so rate-limits stay accurate.
 */
export async function recordSourceFetch({ db, domain, error = null, now = new Date() } = {}) {
  if (!db || !domain) return
  await recordDomainHit(db, domain, { error, now })
}

export const __testing__ = { ROBERT_SEED_SOURCES }
