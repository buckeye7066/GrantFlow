// backend/services/sourceRegistryParity.js
//
// THE registry-drift map between the two source registries.
//
// GrantFlow has two source catalogs and they are not the same set:
//
//   - backend/services/sourceRegistry.js  — the DISPLAY catalog (61 sources).
//     Drives the admin Crawl Coverage dashboard's freshness/stale list and the
//     trust tiers shown next to a run.
//   - backend/crawler-os/sourceRegistry.js — the ENGINE registry (178 sources).
//     The only registry the live pipeline consults, and the only ids that ever
//     appear in crawler_source_runs (its sole writer is
//     crawlerOsCoveragePersistence, fed by crawler-os run.sources).
//
// MEASURED 2026-08-07: 39 of the 61 display sources have NO crawler-os id.
// Those 39 can never produce a crawler_source_runs row, so the dashboard listed
// 31 of them as "never run" forever and the other 8 as permanently ~46.8 days
// stale — 46.8 days being the age of the LEGACY pre-cutover engine's last rows
// (2026-06-20/21), not a scheduler that stopped. Both symptoms are one fact:
// registry drift. Worse, the "Run now" button on those rows can only ever
// return 404 source_not_crawlable (adminCrawlCoverageActions.js resolves the id
// against the crawler-os registry).
//
// This module makes the drift ENUMERATED instead of silent, per the repo's
// MIGRATION PARITY rule (CLAUDE.md): a set whose members live in more than one
// place gets a REGISTRY plus a TOTALITY test so a new member cannot fall out of
// a consumer unnoticed. Guard test: backend/tests/sourceRegistryParity.test.js.
//
// It deliberately does NOT invent coverage: an alias is recorded only where the
// display row and the crawler-os row are the same real-world source (same
// organization AND same host/URL), verified by hand. Everything else is listed
// as display-only with a reason, so the dashboard can say "no crawler can run
// this" instead of "this never ran".

import { SOURCES as DISPLAY_SOURCES } from './sourceRegistry.js'
import { getSource as getCrawlerOsSource } from '../crawler-os/sourceRegistry.js'

/**
 * Display source id -> crawler-os source id, for rows that are the SAME source
 * under a different id (the 2026-06 cutover renamed them). Each pair was
 * verified by comparing organization + base host.
 */
export const CRAWLER_OS_SOURCE_ALIASES = Object.freeze({
  // cof.org community-foundation locator
  cof_foundation_locator: 'cof_locator',
  // rd.usda.gov programs & services
  usda_rural_dev: 'usda_rd',
  // studentaid.gov (FAFSA / federal student aid)
  ed_gov_fafsa: 'studentaid_gov',
  // sam.gov assistance listings (CFDA)
  sam_gov_assistance_listings: 'sam_gov',
  // donorschoose.org classroom funding
  donorschoose_or_equivalent: 'donorschoose',
  // samhsa.gov grants (the display label names SAMHSA explicitly)
  mental_health_nonprofit_grants: 'samhsa_grants',
  // grants.gov — the display row is a state/local FILTER over the same API the
  // crawler-os grants_gov lane queries; the reachable surface is identical.
  grants_gov_local_government: 'grants_gov',
})

/**
 * Display sources with no crawler-os lane at all. Listed with a reason so the
 * gap is a known, reviewable backlog rather than a dashboard row that pretends
 * a crawler exists. Wiring one means adding a crawler-os registry entry + an
 * adapter and REMOVING it from this map — the totality test enforces that.
 */
export const DISPLAY_ONLY_SOURCES = Object.freeze({
  state_portal: 'no crawler-os lane: generic per-state portal, superseded by the per-state benefit lanes',
  foundation_locator: 'no crawler-os lane: generic foundation locator (cof_locator covers only cof.org)',
  overpass_local: 'no crawler-os lane: OpenStreetMap Overpass local-resource lookup was never ported',
  scholarship_directory: 'no crawler-os lane: generic scholarship directory',
  student_scholarship_portals: 'no crawler-os lane: generic scholarship search portals',
  faith_based_grants: 'no crawler-os lane',
  national_volunteer_fire_council: 'no crawler-os lane',
  rural_fire_grants: 'no crawler-os lane (fema_afg covers AFG only)',
  minority_business_dev: 'no crawler-os lane: MBDA was never ported',
  women_owned_business: 'no crawler-os lane',
  opioid_settlement_resources: 'no crawler-os lane',
  state_county_grant_portals: 'no crawler-os lane: generic state/county portal roll-up',
  state_emergency_management: 'no crawler-os lane',
  teacher_classroom_grants: 'no crawler-os lane',
  local_education_foundations: 'no crawler-os lane',
  nea_foundation: 'no crawler-os lane (nea_neh_arts is the National Endowment for the Arts — a DIFFERENT organization)',
  toshiba_america_foundation: 'no crawler-os lane',
  state_department_of_education_grants: 'no crawler-os lane',
  pto_pta_grants: 'no crawler-os lane',
  library_grants: 'no crawler-os lane (imls_library_museum covers IMLS only)',
  special_education_grants: 'no crawler-os lane',
  school_nutrition_grants: 'no crawler-os lane',
  school_transportation_grants: 'no crawler-os lane',
  tribal_government_grants: 'no crawler-os lane (bia_tribal_programs covers BIA only, not HUD ICDBG/IHBG)',
  parks_recreation_grants: 'no crawler-os lane (oregon_parks_rec_grants is Oregon-only, not LWCF/NPS)',
  public_health_department_grants: 'no crawler-os lane',
  animal_rescue_grants: 'no crawler-os lane',
  food_pantry_network: 'no crawler-os lane (feeding_america covers the food-bank locator only)',
  homeless_services_grants: 'no crawler-os lane (HUD CoC/ESG)',
  domestic_violence_shelter_grants: 'no crawler-os lane (ovw_grants covers OVW only)',
  reentry_program_grants: 'no crawler-os lane (bja_second_chance covers Second Chance Act only)',
  substance_recovery_nonprofit_grants: 'no crawler-os lane',
})

/**
 * Resolve a DISPLAY source id to the crawler-os id that actually runs it.
 * @param {string} displaySourceId
 * @returns {?string} crawler-os source id, or null when nothing can run it.
 */
export function resolveCrawlerOsSourceId(displaySourceId) {
  if (!displaySourceId) return null
  const aliased = CRAWLER_OS_SOURCE_ALIASES[displaySourceId] ?? displaySourceId
  return getCrawlerOsSource(aliased) ? aliased : null
}

/**
 * Runnability verdict for one display source.
 * @param {string} displaySourceId
 * @returns {{ runnable: boolean, crawler_os_source_id: ?string, reason: ?string }}
 */
export function classifyDisplaySource(displaySourceId) {
  const osId = resolveCrawlerOsSourceId(displaySourceId)
  if (osId) return { runnable: true, crawler_os_source_id: osId, reason: null }
  return {
    runnable: false,
    crawler_os_source_id: null,
    reason: DISPLAY_ONLY_SOURCES[displaySourceId] ?? 'no crawler-os lane (undeclared drift)',
  }
}

/**
 * Every display source that cannot be crawled, with its reason. Used by the
 * totality test and available to diagnostics.
 * @returns {Array<{ source_id: string, reason: string }>}
 */
export function listUnrunnableDisplaySources() {
  return Object.values(DISPLAY_SOURCES)
    .filter((s) => s?.id && !resolveCrawlerOsSourceId(s.id))
    .map((s) => ({ source_id: s.id, reason: classifyDisplaySource(s.id).reason }))
}

export default {
  CRAWLER_OS_SOURCE_ALIASES,
  DISPLAY_ONLY_SOURCES,
  resolveCrawlerOsSourceId,
  classifyDisplaySource,
  listUnrunnableDisplaySources,
}
