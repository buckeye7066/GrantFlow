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
export async function triggerAutoDiscoveryCrawlers(db, profileId) {
  if (!db || !profileId) return { ...SUPERSEDED }
  const { runProfileDiscoveryLive } = await import('./crawlerOsService.js')
  try {
    const { run, persisted } = await runProfileDiscoveryLive({ db, profileId })
    return { engine: 'crawler-os', stored: run.stored, matches: persisted.matches, recommendations: run.recommendations.length }
  } catch (e) {
    return { engine: 'crawler-os', error: e?.message || String(e) }
  }
}

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
