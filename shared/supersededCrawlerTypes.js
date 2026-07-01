/**
 * supersededCrawlerTypes.js — single source of truth for RETIRED crawler job types.
 *
 * GrantFlow's grant DISCOVERY was moved to the "Crawler OS" (agent codename
 * "Robert"). The old per-type discovery crawlers are retired: the dispatcher
 * short-circuits them at runtime and no code path should persist a new
 * crawler_jobs row for one of these types anymore. Profile-facing discovery
 * still works because it runs synchronously through the Crawler OS compat shim
 * (crawlerOsCompatibility.triggerAutoDiscoveryCrawlers → runProfileDiscoveryLive);
 * it just no longer enqueues legacy job rows.
 *
 * This list is imported by:
 *   - backend/services/crawlerDispatcher.js (runtime short-circuit)
 *   - backend/services/crawlerJobCreation.js (createCrawlerJob choke point)
 *   - backend/services/crawlerConcurrencyGuard.js (never resurrect a retired job)
 *   - backend enqueue paths (anyaLoginTrigger, adminGeoCrawlOnLogin, autoDiscoveryCrawlers)
 *   - backend/routes/crawlers.js (hide retired types from the Automation panel)
 *   - src/pages/Automation.jsx (hide retired tiles/cards/queue rows)
 *
 * Anything NOT in this set is a REAL automation that still runs:
 *   pipeline_automation, profile_enrichment, document_ingest, avatar_lookup,
 *   portal_check, anya_match_scout, national_zip_scan, …
 *
 * NOTE: 'comprehensive' (including the admin geo-crawl variant,
 * parameters.mode === 'geo') is retired — it has no dispatcher HANDLER and is
 * short-circuited as superseded. Do not exempt geo; Crawler OS owns catalog
 * population now.
 */

export const SUPERSEDED_CRAWLER_JOB_TYPES = Object.freeze([
  'live_search',
  'clinical_trials',
  'local',
  'scholarship',
  'curated_benefits',
  'health_resources',
  'comprehensive',
  'national',
  'item_search',
  'item_gift_search',
  'student_bridge_funding',
  'government_funding',
  'student_grants',
  'ecf_benefits',
  'ecf_hcbs',
  'special_needs',
  'local_funding',
  'item_matching',
  'foundation_990',
  'church',
  'faith_based',
  'ministry',
  'family',
  'school',
  'k12',
  'charter_school',
])

const SUPERSEDED_SET = new Set(SUPERSEDED_CRAWLER_JOB_TYPES)

/**
 * @param {string} type crawler job type
 * @returns {boolean} true when the type is a retired discovery crawler
 */
export function isSupersededCrawlerType(type) {
  if (!type) return false
  return SUPERSEDED_SET.has(String(type).toLowerCase())
}

/**
 * Filter a list of crawler job types down to the ones that still run.
 * @param {Iterable<string>} types
 * @returns {string[]}
 */
export function keepActiveCrawlerTypes(types) {
  return Array.from(types || []).filter((t) => !isSupersededCrawlerType(t))
}

export const SUPERSEDED_REASON =
  'superseded_by_crawler_os: legacy grant-discovery is handled by the Crawler OS (Robert)'
