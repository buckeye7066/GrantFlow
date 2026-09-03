// crawlerOsCompatibility.js — compatibility entrypoints for older HTTP routes
// after the Crawler OS cutover. The old bulk grant-crawl engine is retired:
// profile-facing discovery routes delegate to runProfileDiscoveryLive, and
// non-profile bulk crawl endpoints return an explicit retired/OS response.
import {
  opportunityLifecycleVisibilitySql,
  qualifiesForDisplay,
  SURFACED_MATCHER_VERSIONS_SQL,
} from '../config/matchSurfacing.js'
import { allSources, getSource } from '../crawler-os/sourceRegistry.js'
import { resolveCrawlerActivation } from '../config/crawlerActivationPolicy.js'

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
export function getStrategy(sourceId) { return getSource(String(sourceId || '').trim()) }
export function listStrategies() { return allSources() }
export const KNOWN_ITEM_SOURCES = Object.freeze(['profile_catalog', 'live_web'])
export function parseItemRequest(value) {
  const raw = typeof value === 'object' && value ? value.item_request ?? value.items : value
  const items = (Array.isArray(raw) ? raw : String(raw || '').split(/[\n,;]+/))
    .map((item) => String(item || '').trim())
    .filter(Boolean)
  return { items }
}
export async function searchWebForItem(db, profileId, item, options = {}) {
  const { searchItemNeed } = await import('./itemNeedSearch.js')
  return searchItemNeed(db, { profileId, item, ...options })
}
export async function runAllDomainEngines(db, profileId, options = {}) {
  return runCrawler(db, profileId, { ...options, crawlerType: 'crawler-os' })
}
export async function crawlStateWaiverBenefits(db, profileId, options = {}) {
  return runCrawler(db, profileId, { ...options, crawlerType: 'state_waiver_benefits' })
}
export function evaluateStateWaiverEligibility(profile) {
  const state = String(profile?.state || profile?.location?.state || '').trim()
  return { eligible: Boolean(state), reason: state ? 'profile_state_present' : 'profile_state_required' }
}
export async function stampLastDiscoveryAt() { /* Crawler OS persistence owns this timestamp. */ }

function safeJsonParse(value, fallback) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return value
  if (!value || typeof value !== 'string') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

export async function loadCrawlerOsProfileResults(db, profileId, limit = 200) {
  if (!db || !profileId) return []
  const lifecycleClause = opportunityLifecycleVisibilitySql({
    tableAlias: 'fo',
    dialect: db?.dialect,
  })
  const rows = await db.prepare(`
    SELECT fo.id, fo.title, fo.sponsor, fo.description, fo.application_url, fo.apply_url,
           fo.source_url, fo.opportunity_kind, fo.deadline, fo.amount_min, fo.amount_max,
           fo.state, fo.categories, fo.funding_type, fo.is_hidden, fo.is_active,
           m.match_score, m.match_decision, m.match_explanation, m.match_reasons,
           m.match_explain_json, m.matcher_version
      FROM profile_opportunity_matches m
      JOIN funding_opportunities fo ON fo.id = m.opportunity_id
     WHERE m.profile_id = ?
       AND m.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
       AND lower(COALESCE(m.match_decision, '')) IN ('accept', 'review')
       AND ${lifecycleClause}
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
      match_score: Number(row.match_score ?? 0),
      match_decision: row.match_decision,
      opportunity_kind: row.opportunity_kind,
      four_truth_proof: explain?.four_truth_proof ?? null,
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
      is_hidden: row.is_hidden ?? null,
      is_active: row.is_active ?? null,
      match_explain: { ...explain, why: row.match_explanation || explain?.why, matcher_version: row.matcher_version },
    }
  }).filter((row) => qualifiesForDisplay(row, 0))
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
  const activation = resolveCrawlerActivation(options?.crawlerType || 'crawler-os')
  if (!activation.valid || activation.mode !== 'profile_planned') {
    return { ...SUPERSEDED, success: false, error: 'profile_planned_crawler_required', results: [] }
  }
  const { run, persisted } = await runProfileDiscoveryLive({ db, profileId: String(profileId), floor })
  const results = await loadCrawlerOsProfileResults(db, profileId, maxResults)
  return {
    ...SUPERSEDED,
    superseded: false,
    engine: 'crawler-os',
    crawler_type: options?.crawlerType || 'crawler-os',
    activation_authority: activation.activation_authority,
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
export const SCHEMA = Object.freeze({
  activation_authority: 'crawler-os/planner',
  source_authority: 'crawler-os/sourceRegistry',
  result_authority: 'config/fundingTruthPolicy',
})

export async function crawlItemFunding(profileInput, options = {}) {
  const db = options.db || profileInput?.db
  const profileId = profileInput?.id || profileInput?.profile_id || options.profileId || options.profile_id
  const { items } = parseItemRequest(options.item_request ?? options.items)
  if (!db || !profileId || items.length === 0) return []
  const { searchItemNeeds } = await import('./itemNeedSearch.js')
  const report = await searchItemNeeds(db, {
    profileId: String(profileId),
    items,
    profileContext: options.profileContext || null,
  })
  return (report?.items || []).flatMap((item) => item?.results || [])
}

export const DOMAIN_CRAWLER_REGISTRY = Object.freeze(
  Object.fromEntries(allSources().map((source) => [source.source_id, source])),
)

async function runProfileScopedOs(context = {}, { onlySourceIds = null, crawlerType = 'crawler-os' } = {}) {
  const db = context.db
  const profileId = context.profileId || context.profile_id ||
    context.job?.profile_id || context.job?.parameters?.profile_id ||
    context.profileContext?.profile_id || context.profileContext?.profile?.id
  if (!db || !profileId) {
    return {
      ...SUPERSEDED,
      success: false,
      retired: false,
      superseded: false,
      error: 'profile_id_required',
      message: 'Crawler OS requires a profile so source activation and all four funding truths can be evaluated.',
    }
  }
  const { runProfileDiscoveryLive } = await import('./crawlerOsService.js')
  const { run, persisted } = await runProfileDiscoveryLive({
    db,
    profileId: String(profileId),
    onlySourceIds,
    crawlerType,
  })
  return {
    success: true,
    retired: false,
    superseded: false,
    engine: 'crawler-os',
    activation_authority: 'crawler-os/planner',
    profile_id: String(profileId),
    inserted: Number(persisted?.opportunities ?? run?.stored ?? 0),
    updated: 0,
    evaluated: Number(persisted?.matches ?? 0),
    errors: 0,
    rejected: Number(run?.rejected ?? 0),
    sources: run?.sources ?? [],
    recommendations: run?.recommendations ?? [],
  }
}

export async function crawlAllCounties(db, options = {}) {
  return runProfileScopedOs({ db, ...options }, { crawlerType: 'local_funding' })
}
export async function crawlStateCounties(db, state, options = {}) {
  return runProfileScopedOs({ db, ...options, state }, { crawlerType: 'local_funding' })
}
export async function getCrawlerStatus() {
  return { engine: 'crawler-os', running: false, activation_authority: 'crawler-os/planner' }
}
export function isCountyCrawlerEnabled() { return true }

export async function processComprehensiveCrawlerJob(context = {}) {
  return runProfileScopedOs(context, { crawlerType: 'comprehensive' })
}
export async function crawlGrantsGov(db, options = {}) {
  return runProfileScopedOs({ db, ...options }, { onlySourceIds: ['grants_gov'], crawlerType: 'government_funding' })
}
export async function crawlRealOpportunities(db, options = {}) {
  return runProfileScopedOs({ db, ...options }, { crawlerType: 'comprehensive' })
}
export async function crawlAllStates(db, options = {}) {
  return runProfileScopedOs({ db, ...options }, { crawlerType: 'local_funding' })
}
export async function seedAllRealFunding(db, options = {}) {
  return runProfileScopedOs({ db, ...options }, { crawlerType: 'comprehensive' })
}
export async function getOpportunityCountsByState(db) {
  if (!db?.prepare) return {}
  const rows = await db.prepare(
    "SELECT COALESCE(NULLIF(TRIM(state), ''), 'national') AS state, COUNT(*) AS count FROM funding_opportunities WHERE COALESCE(is_active, 1) = 1 GROUP BY COALESCE(NULLIF(TRIM(state), ''), 'national')",
  ).all()
  return Object.fromEntries((rows || []).map((row) => [row.state, Number(row.count || 0)]))
}

export default {
  processComprehensiveCrawlerJob,
  crawlGrantsGov,
  crawlRealOpportunities,
  crawlAllStates,
  seedAllRealFunding,
  getOpportunityCountsByState,
}
