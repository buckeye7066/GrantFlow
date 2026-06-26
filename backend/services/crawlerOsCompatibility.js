// crawlerOsCompatibility.js — compatibility entrypoints for older HTTP routes
// after the Crawler OS cutover. The old bulk grant-crawl engine is retired:
// profile-facing discovery routes delegate to runProfileDiscoveryLive, and
// non-profile bulk crawl endpoints return an explicit retired/OS response.
const SUPERSEDED = Object.freeze({
  retired: true,
  superseded: true,
  inserted: 0,
  evaluated: 0,
  total: 0,
  states: {},
  message: 'This older crawl endpoint is retired. Crawler OS is the only grant-discovery engine; use per-profile discovery or Robert automation.',
})

// Retired discovery-strategy / item / domain-engine / state-waiver helpers used
// by older route contracts. They intentionally do not crawl. Profile-facing
// routes below call Crawler OS instead.
export function getStrategy() { return null }
export function listStrategies() { return [] }
export async function searchWebForItem() { return [] }
export const KNOWN_ITEM_SOURCES = Object.freeze([])
export function parseItemRequest() { return {} }
export async function runAllDomainEngines() { return { ...SUPERSEDED, engines: [] } }
export async function crawlStateWaiverBenefits() { return [] }
export function evaluateStateWaiverEligibility() { return { eligible: false, superseded: true } }
export async function stampLastDiscoveryAt() { /* OS persistence stamps last_discovery_at */ }

function safeJsonParse(value, fallback) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return value
  if (!value || typeof value !== 'string') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

async function loadCrawlerOsProfileResults(db, profileId, limit = 200) {
  if (!db || !profileId) return []
  const activeClause = db?.dialect === 'postgres'
    ? 'AND (fo.is_active IS NULL OR fo.is_active = TRUE)'
    : 'AND (fo.is_active IS NULL OR fo.is_active = 1)'
  const rows = await db.prepare(`
    SELECT fo.id, fo.title, fo.sponsor, fo.description, fo.application_url, fo.apply_url,
           fo.source_url, fo.opportunity_kind, fo.deadline, fo.amount_min, fo.amount_max,
           fo.state, fo.categories, fo.funding_type,
           m.match_score, m.match_decision, m.match_explanation, m.match_reasons,
           m.match_explain_json, m.matcher_version
      FROM profile_opportunity_matches m
      JOIN funding_opportunities fo ON fo.id = m.opportunity_id
     WHERE m.profile_id = ?
       AND m.matcher_version IN ('crawler-os', 'crawler-os-xmatch')
       AND lower(COALESCE(m.match_decision, '')) IN ('accept', 'review')
       ${activeClause}
     ORDER BY m.match_score DESC
     LIMIT ?
  `).all(String(profileId), Number(limit) || 200)

  return (rows || []).map((row) => {
    const explain = safeJsonParse(row.match_explain_json, {})
    const categories = safeJsonParse(row.categories, [])
    return {
      id: row.id,
      name: row.title,
      title: row.title,
      description: row.description,
      url: row.application_url || row.apply_url || row.source_url || null,
      applicationUrl: row.application_url || row.apply_url || null,
      sourceUrl: row.source_url || null,
      matchScore: Number(row.match_score ?? 0),
      matchReasons: safeJsonParse(row.match_reasons, explain?.matched_needs || []),
      matchedCategories: categories,
      categories,
      type: String(row.opportunity_kind || '').toUpperCase() === 'DIRECTORY' ? 'portal' : 'program',
      fundingType: row.funding_type || null,
      maxAmount: row.amount_max || null,
      minAmount: row.amount_min || null,
      deadline: row.deadline || null,
      stateRestriction: row.state || null,
      recurring: !row.deadline,
      match_explain: { ...explain, why: row.match_explanation || explain?.why, matcher_version: row.matcher_version },
    }
  })
}

// The legacy "trigger auto-discovery" entrypoint now drives the Crawler OS, so
// the user-facing "discover" actions still work — via the OS, not the old crawler.
//
// CONTRACT: must keep the historical jobs_enqueued / crawler_types fields the
// realCrawlers.js /discover-all route, the auth.js login fire-and-forget, and
// the DiscoverGrants UI ("show toast / poll" loop) all read from. Routes were
// reading summary?.jobs_enqueued ?? 0 against a shape that didn't carry that
// key, so the UI silently fell into "0 jobs enqueued" and skipped the toast +
// progress polling — making Discover feel broken even when the OS run actually
// produced rows. We now ALWAYS report the OS run as one synchronous "fleet"
// (jobs_enqueued = 1) plus the per-source counts, AND set synchronous:true so
// the client knows discovery is already complete by the time we return.
export async function triggerAutoDiscoveryCrawlers(db, profileId, _options = {}) {
  if (!db || !profileId) {
    return {
      ...SUPERSEDED,
      jobs_enqueued: 0,
      crawler_types: [],
      job_ids: [],
      engine: 'crawler-os',
      synchronous: true,
    }
  }
  const { runProfileDiscoveryLive } = await import('./crawlerOsService.js')
  try {
    const { run, persisted } = await runProfileDiscoveryLive({ db, profileId })
    const sourceTypes = Array.isArray(run?.sources)
      ? [...new Set(run.sources.map((s) => s?.source_id || s?.id).filter(Boolean))]
      : []
    return {
      // Historical UI / route contract (DiscoverGrants reads these):
      jobs_enqueued: 1,
      crawler_types: sourceTypes.length > 0 ? sourceTypes : ['crawler-os'],
      job_ids: [],
      // OS run details (used by tests + admin diagnostics):
      engine: 'crawler-os',
      synchronous: true,
      stored: run?.stored ?? 0,
      planned: run?.planned ?? 0,
      rejected: run?.rejected ?? 0,
      matches: persisted?.matches ?? 0,
      opportunities: persisted?.opportunities ?? 0,
      recommendations: Array.isArray(run?.recommendations) ? run.recommendations.length : 0,
      sources: run?.sources ?? [],
    }
  } catch (e) {
    return {
      jobs_enqueued: 0,
      crawler_types: [],
      job_ids: [],
      engine: 'crawler-os',
      synchronous: true,
      error: e?.message || String(e),
    }
  }
}

// Older route/admin surfaces that expect runCrawler now delegate to the Crawler
// OS and return the old result shape expected by those callers. Non-profile bulk
// crawler surfaces below remain explicit retired no-ops.
export async function runCrawler(db, profileId, options = {}) {
  if (!db || !profileId) return { ...SUPERSEDED, results: [] }
  const { runProfileDiscoveryLive } = await import('./crawlerOsService.js')
  const floor = Number.isFinite(Number(options?.minScore)) ? Number(options.minScore) : undefined
  const maxResults = Number(options?.maxResults) || 200
  const { run, persisted } = await runProfileDiscoveryLive({ db, profileId: String(profileId), floor })
  const results = await loadCrawlerOsProfileResults(db, profileId, maxResults)
  return {
    ...SUPERSEDED,
    superseded: false,
    engine: 'crawler-os',
    crawler_type: options?.crawlerType || 'crawler-os',
    inserted: persisted?.opportunities ?? run?.stored ?? results.length,
    evaluated: persisted?.matches ?? results.length,
    total: results.length,
    results,
    sources: run?.sources ?? [],
    rejected: run?.rejected ?? 0,
    pipelinePruned: persisted?.pipelinePruned ?? 0,
    hamiltonCleaned: persisted?.hamiltonCleaned ?? 0,
  }
}
export const SCHEMA = Object.freeze({})
export async function crawlItemFunding() { return { ...SUPERSEDED, items: [] } }
export const DOMAIN_CRAWLER_REGISTRY = Object.freeze({})

// countyFundingCrawler surface (admin county-crawl endpoints) — no-ops post-cutover.
export async function crawlAllCounties() { return { ...SUPERSEDED, counties: 0 } }
export async function crawlStateCounties() { return { ...SUPERSEDED, counties: 0 } }
export async function getCrawlerStatus() { return { ...SUPERSEDED, running: false } }
export function isCountyCrawlerEnabled() { return false }

export async function processComprehensiveCrawlerJob() { return { ...SUPERSEDED } }
export async function crawlGrantsGov() { return { ...SUPERSEDED } }
export async function crawlRealOpportunities() { return { ...SUPERSEDED } }
export async function crawlAllStates() { return { ...SUPERSEDED } }
export async function seedAllRealFunding() { return { ...SUPERSEDED } }
export function getOpportunityCountsByState() { return {} }

export default {
  processComprehensiveCrawlerJob,
  crawlGrantsGov,
  crawlRealOpportunities,
  crawlAllStates,
  seedAllRealFunding,
  getOpportunityCountsByState,
}
