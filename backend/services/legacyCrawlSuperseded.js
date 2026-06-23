// legacyCrawlSuperseded.js — the explicitly-named compatibility shim for the
// Crawler OS cutover. The legacy bulk grant-crawl entrypoints are superseded by
// the Crawler OS (automatic discovery via Robert + per-profile discovery via
// runProfileDiscoveryLive). These no-op shims preserve the (admin-only) legacy
// endpoint call sites WITHOUT importing or executing the removed legacy crawler
// engine, so the old crawler is unreachable at runtime. Each returns a clearly
// superseded result instead of running an old crawl.
const SUPERSEDED = Object.freeze({
  superseded: true,
  inserted: 0,
  evaluated: 0,
  total: 0,
  states: {},
  message: 'Legacy bulk crawl is superseded by the Crawler OS — discovery is automatic (Robert) and per-profile (runProfileDiscoveryLive).',
})

// Legacy discovery-strategy / item / domain-engine / state-waiver helpers used by
// the legacy crawl-trigger routes. No-ops now (the Crawler OS covers discovery).
export function getStrategy() { return null }
export function listStrategies() { return [] }
export async function searchWebForItem() { return [] }
export const KNOWN_ITEM_SOURCES = Object.freeze([])
export function parseItemRequest() { return {} }
export async function runAllDomainEngines() { return { ...SUPERSEDED, engines: [] } }
export async function crawlStateWaiverBenefits() { return [] }
export function evaluateStateWaiverEligibility() { return { eligible: false, superseded: true } }
export async function stampLastDiscoveryAt() { /* OS persistence stamps last_discovery_at */ }

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

// crawlerManager / itemFundingCrawler / domainCrawlerRegistry surfaces used by
// admin audit, crawlerFramework, and Sam diagnostics — no-ops post-cutover.
export async function runCrawler() { return { ...SUPERSEDED, results: [] } }
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
