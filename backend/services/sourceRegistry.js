/**
 * sourceRegistry.js
 *
 * Phase 4 mission rule: every funding source must be classified by trust,
 * the profile types it serves, the needs it covers, the freshness window
 * before its data is considered stale, and whether the source requires URL
 * verification at ingest. Crawlers consult this registry to (a) build a
 * source coverage plan from a profile context and (b) emit a coverage
 * report after each run.
 *
 * Trust tiers reuse the canonical SOURCE_TRUST_TIERS enum from the Phase 1
 * opportunityRealityGate so display logic and ingest logic stay aligned.
 *
 * This file is intentionally pure / data-driven: no DB, no network, no I/O.
 * It is safe to import from anywhere.
 */

import { OPPORTUNITY_KINDS, SOURCE_TRUST_TIERS } from './opportunityRealityGate.js'

/**
 * Source identifiers — must align 1:1 with `funding_opportunities.source` and
 * `funding_opportunities.record_origin` so coverage reports can join cleanly
 * to actual rows.
 */
export const SOURCE_IDS = Object.freeze({
  GRANTS_GOV: 'grants_gov',
  COF_FOUNDATION_LOCATOR: 'cof_foundation_locator',
  STATE_PORTAL: 'state_portal',
  FOUNDATION_LOCATOR: 'foundation_locator',
  OVERPASS_LOCAL: 'overpass_local',
  USDA_RURAL_DEV: 'usda_rural_dev',
  FEMA_AFG: 'fema_afg',
  SBA_GRANTS: 'sba_grants',
  SCHOLARSHIP_DIRECTORY: 'scholarship_directory',
  STUDENT_SCHOLARSHIP_PORTALS: 'student_scholarship_portals',
  COMMUNITY_ACTION: 'community_action',
  UNITED_WAY_211: 'united_way_211',
  FEEDING_AMERICA: 'feeding_america',
  ED_GOV_FAFSA: 'ed_gov_fafsa',
  HRSA_HEALTH_CENTERS: 'hrsa_health_centers',
  FAITH_BASED_GRANTS: 'faith_based_grants',
  NATIONAL_VOLUNTEER_FIRE_COUNCIL: 'national_volunteer_fire_council',
  RURAL_FIRE_GRANTS: 'rural_fire_grants',
  MINORITY_BUSINESS_DEV: 'minority_business_dev',
  WOMEN_OWNED_BUSINESS: 'women_owned_business',
  LIHEAP: 'liheap',
  SNAP: 'snap',
  MEDICAID: 'medicaid',
  PELL_GRANT: 'pell_grant',
  USED_DEPT_OF_ED: 'us_dept_of_ed',
})

/**
 * Source classification. Each entry is the contract that lets the crawler
 * planner decide whether to query this source for a given profile.
 *
 *   trust              — SOURCE_TRUST_TIERS value (Phase 1)
 *   default_kind       — OPPORTUNITY_KINDS value emitted by this source
 *   profile_types      — applicant_type / primary_type / organization_type
 *                        values this source serves (best-effort recall)
 *   needs              — need categories this source covers
 *   freshness_days     — how stale the data may get before it must be
 *                        re-queried by the recurring scheduler
 *   verification_required — true means the URL must pass realityGate's URL
 *                        verification at ingest (Phase 1)
 *   directory          — true means rows from this source are directory
 *                        resources, not direct grants
 *   notes              — human-readable note for admin/Anya/dashboard
 */
export const SOURCES = Object.freeze({
  [SOURCE_IDS.GRANTS_GOV]: {
    id: SOURCE_IDS.GRANTS_GOV,
    label: 'Grants.gov',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_API,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['nonprofit', 'school', 'church', 'business', 'volunteer_fire', 'volunteer_fire_department', 'ministry', 'tribal', 'state_local_gov'],
    needs: ['equipment', 'training', 'research', 'education', 'health', 'community', 'food', 'housing', 'fire', 'public_safety', 'rural'],
    freshness_days: 1,
    verification_required: true,
    directory: false,
    notes: 'Federal grant opportunities. Use profile-derived keyword + agency filters; never blank query.',
  },
  [SOURCE_IDS.COF_FOUNDATION_LOCATOR]: {
    id: SOURCE_IDS.COF_FOUNDATION_LOCATOR,
    label: 'Council on Foundations Locator',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['nonprofit', 'church', 'school', 'ministry', 'individual', 'family'],
    needs: ['community', 'general'],
    freshness_days: 30,
    verification_required: true,
    directory: true,
    notes: 'Foundation directory by ZIP/state. Always survives filtering.',
  },
  [SOURCE_IDS.STATE_PORTAL]: {
    id: SOURCE_IDS.STATE_PORTAL,
    label: 'State Funding Portals',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['nonprofit', 'business', 'school', 'church', 'individual', 'family', 'volunteer_fire'],
    needs: ['housing', 'utilities', 'food', 'health', 'business', 'education', 'fire', 'public_safety'],
    freshness_days: 7,
    verification_required: true,
    directory: false,
    notes: 'State-run grant/benefits portals. Geographic match required.',
  },
  [SOURCE_IDS.FOUNDATION_LOCATOR]: {
    id: SOURCE_IDS.FOUNDATION_LOCATOR,
    label: 'Foundation Locators',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['nonprofit', 'church', 'school', 'ministry'],
    needs: ['community', 'general'],
    freshness_days: 30,
    verification_required: true,
    directory: true,
    notes: 'Directory of philanthropic foundations by region.',
  },
  [SOURCE_IDS.OVERPASS_LOCAL]: {
    id: SOURCE_IDS.OVERPASS_LOCAL,
    label: 'OpenStreetMap Local Resources',
    trust: SOURCE_TRUST_TIERS.OPEN_WEB,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['individual', 'family'],
    needs: ['food', 'housing', 'utilities', 'community'],
    freshness_days: 30,
    verification_required: false,
    directory: true,
    notes: 'Local food banks, shelters, community centers from OSM.',
  },
  [SOURCE_IDS.USDA_RURAL_DEV]: {
    id: SOURCE_IDS.USDA_RURAL_DEV,
    label: 'USDA Rural Development',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['volunteer_fire', 'volunteer_fire_department', 'nonprofit', 'business', 'individual', 'family'],
    needs: ['rural', 'housing', 'business', 'fire', 'public_safety', 'water'],
    freshness_days: 7,
    verification_required: true,
    directory: false,
    notes: 'USDA RD programs (water/community/business/housing).',
  },
  [SOURCE_IDS.FEMA_AFG]: {
    id: SOURCE_IDS.FEMA_AFG,
    label: 'FEMA Assistance to Firefighters Grants',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['volunteer_fire', 'volunteer_fire_department'],
    needs: ['equipment', 'training', 'fire', 'public_safety'],
    freshness_days: 7,
    verification_required: true,
    directory: false,
    notes: 'AFG / SAFER / FP&S firefighter grant programs.',
  },
  [SOURCE_IDS.SBA_GRANTS]: {
    id: SOURCE_IDS.SBA_GRANTS,
    label: 'Small Business Administration',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['business', 'minority_owned_business', 'women_owned_business'],
    needs: ['business', 'startup', 'rural'],
    freshness_days: 7,
    verification_required: true,
    directory: false,
    notes: 'SBA grants, not loans. Filter loan results out at ingest.',
  },
  [SOURCE_IDS.SCHOLARSHIP_DIRECTORY]: {
    id: SOURCE_IDS.SCHOLARSHIP_DIRECTORY,
    label: 'Scholarship Directories',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['student'],
    needs: ['scholarship', 'education'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'Scholarship-specific data sources for student profiles.',
  },
  [SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS]: {
    id: SOURCE_IDS.STUDENT_SCHOLARSHIP_PORTALS,
    label: 'Student Scholarship Search Portals',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['student'],
    needs: ['scholarship', 'education'],
    freshness_days: 14,
    verification_required: false,
    directory: true,
    notes: 'Profile-matching scholarship search portals (Fastweb, CollegeScholarships.org, CollegeXpress, CollegeWhale, Peterson\'s, Unigo/Scholarship Experts, Scholly, StudentScholarships.org). Always survives filtering for student profiles.',
  },
  [SOURCE_IDS.COMMUNITY_ACTION]: {
    id: SOURCE_IDS.COMMUNITY_ACTION,
    label: 'Community Action Agencies',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['individual', 'family'],
    needs: ['utilities', 'housing', 'food', 'cash_assistance', 'transportation'],
    freshness_days: 30,
    verification_required: true,
    directory: true,
    notes: 'CAP agencies — directory of local emergency assistance.',
  },
  [SOURCE_IDS.UNITED_WAY_211]: {
    id: SOURCE_IDS.UNITED_WAY_211,
    label: 'United Way 211',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['individual', 'family'],
    needs: ['utilities', 'housing', 'food', 'health', 'community'],
    freshness_days: 30,
    verification_required: true,
    directory: true,
    notes: 'United Way 211 referral directory.',
  },
  [SOURCE_IDS.FEEDING_AMERICA]: {
    id: SOURCE_IDS.FEEDING_AMERICA,
    label: 'Feeding America Food Bank Locator',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['individual', 'family'],
    needs: ['food'],
    freshness_days: 30,
    verification_required: true,
    directory: true,
    notes: 'Food bank locator — directory style.',
  },
  [SOURCE_IDS.ED_GOV_FAFSA]: {
    id: SOURCE_IDS.ED_GOV_FAFSA,
    label: 'studentaid.gov / FAFSA',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['student'],
    needs: ['education', 'scholarship', 'housing'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'Federal student aid programs.',
  },
  [SOURCE_IDS.HRSA_HEALTH_CENTERS]: {
    id: SOURCE_IDS.HRSA_HEALTH_CENTERS,
    label: 'HRSA Health Center Lookup',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECTORY,
    profile_types: ['individual', 'family'],
    needs: ['health', 'mental_health'],
    freshness_days: 30,
    verification_required: true,
    directory: true,
    notes: 'Federally qualified health centers — directory style.',
  },
  [SOURCE_IDS.FAITH_BASED_GRANTS]: {
    id: SOURCE_IDS.FAITH_BASED_GRANTS,
    label: 'Faith-Based Foundation Grants',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['church', 'ministry', 'nonprofit'],
    needs: ['community', 'food', 'housing', 'education'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'Faith-based foundations and ministries grants.',
  },
  [SOURCE_IDS.NATIONAL_VOLUNTEER_FIRE_COUNCIL]: {
    id: SOURCE_IDS.NATIONAL_VOLUNTEER_FIRE_COUNCIL,
    label: 'National Volunteer Fire Council',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['volunteer_fire', 'volunteer_fire_department'],
    needs: ['equipment', 'training', 'fire', 'public_safety'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'NVFC and partner programs for volunteer fire.',
  },
  [SOURCE_IDS.RURAL_FIRE_GRANTS]: {
    id: SOURCE_IDS.RURAL_FIRE_GRANTS,
    label: 'Rural Fire Grants',
    trust: SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['volunteer_fire', 'volunteer_fire_department'],
    needs: ['equipment', 'training', 'fire', 'public_safety', 'rural'],
    freshness_days: 30,
    verification_required: true,
    directory: false,
    notes: 'State Forestry / VFA / SAFER for rural departments.',
  },
  [SOURCE_IDS.MINORITY_BUSINESS_DEV]: {
    id: SOURCE_IDS.MINORITY_BUSINESS_DEV,
    label: 'Minority Business Development Agency',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['business', 'minority_owned_business'],
    needs: ['business', 'startup'],
    freshness_days: 7,
    verification_required: true,
    directory: false,
    notes: 'MBDA programs for minority-owned businesses.',
  },
  [SOURCE_IDS.WOMEN_OWNED_BUSINESS]: {
    id: SOURCE_IDS.WOMEN_OWNED_BUSINESS,
    label: 'Women-Owned Business Programs',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['business', 'women_owned_business'],
    needs: ['business', 'startup'],
    freshness_days: 7,
    verification_required: true,
    directory: false,
    notes: 'Women-owned business grant programs.',
  },
  [SOURCE_IDS.LIHEAP]: {
    id: SOURCE_IDS.LIHEAP,
    label: 'LIHEAP — Low Income Home Energy Assistance',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.BENEFIT,
    profile_types: ['individual', 'family'],
    needs: ['utilities', 'community', 'general'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'Federal/state utility assistance program — direct application.',
  },
  [SOURCE_IDS.SNAP]: {
    id: SOURCE_IDS.SNAP,
    label: 'SNAP — Supplemental Nutrition Assistance Program',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.BENEFIT,
    profile_types: ['individual', 'family'],
    needs: ['food', 'community', 'general'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'Federal nutrition assistance — direct application.',
  },
  [SOURCE_IDS.MEDICAID]: {
    id: SOURCE_IDS.MEDICAID,
    label: 'Medicaid / CHIP',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.BENEFIT,
    profile_types: ['individual', 'family'],
    needs: ['health', 'community', 'general'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'State Medicaid / CHIP programs — direct application.',
  },
  [SOURCE_IDS.PELL_GRANT]: {
    id: SOURCE_IDS.PELL_GRANT,
    label: 'Pell Grant',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['student'],
    needs: ['education', 'scholarship'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'Federal Pell Grant — direct application via FAFSA.',
  },
  [SOURCE_IDS.USED_DEPT_OF_ED]: {
    id: SOURCE_IDS.USED_DEPT_OF_ED,
    label: 'US Dept of Education Grant Programs',
    trust: SOURCE_TRUST_TIERS.OFFICIAL_PORTAL,
    default_kind: OPPORTUNITY_KINDS.DIRECT,
    profile_types: ['school', 'nonprofit', 'business', 'ministry'],
    needs: ['education', 'training', 'community'],
    freshness_days: 14,
    verification_required: true,
    directory: false,
    notes: 'Department of Education discretionary/formula grant programs.',
  },
})

/**
 * Get the registry entry for a source id. Returns null when unknown so
 * callers can decide whether to log/skip rather than throwing in pipelines.
 */
export function getSource(sourceId) {
  if (!sourceId) return null
  return SOURCES[String(sourceId)] ?? null
}

/**
 * Iterate registry as an array.
 */
export function listSources() {
  return Object.values(SOURCES)
}

/**
 * Plan source coverage for a profile.
 *
 * Returns an object describing which source ids the crawler/dispatcher
 * SHOULD query for the given profile, plus which ones it MUST query
 * (mission rule: every profile gets at least 3 source categories).
 *
 * Pure / synchronous: no DB calls. Caller is responsible for actually
 * dispatching the work.
 *
 * @param {object} profileContext - same shape as loadProfileContext output
 * @returns {{
 *   profile_type: string|null,
 *   needs: string[],
 *   sources_planned: string[],
 *   sources_required: string[],
 *   directory_sources: string[],
 *   direct_sources: string[],
 *   notes: string[]
 * }}
 */
export function planCoverage(profileContext = {}) {
  const profile = profileContext?.profile ?? profileContext ?? {}
  const signals = profileContext?.signals ?? {}

  const profileType =
    profile?.primary_type ??
    profile?.applicant_type ??
    profile?.organization_type ??
    null

  const setOrArrayToArray = (v) => {
    if (!v) return []
    if (Array.isArray(v)) return v
    if (typeof v?.values === 'function') return Array.from(v)
    return [String(v)]
  }
  const profileNeeds = setOrArrayToArray(signals?.needs)

  const planned = new Set()
  for (const src of listSources()) {
    const typeMatch =
      !profileType ||
      src.profile_types.length === 0 ||
      src.profile_types.some((t) => normalizeType(t) === normalizeType(profileType))
    const needMatch =
      profileNeeds.length === 0 ||
      src.needs.length === 0 ||
      src.needs.some((n) => profileNeeds.some((pn) => sameNeed(pn, n)))
    if (typeMatch && needMatch) planned.add(src.id)
  }

  // Mission rule: avoid silent zero-source runs and always plan ≥ 3
  // source categories per profile so the dispatcher never executes a
  // single-source crawl that quietly returns nothing useful.
  const FALLBACKS = [
    SOURCE_IDS.GRANTS_GOV,
    SOURCE_IDS.UNITED_WAY_211,
    SOURCE_IDS.COMMUNITY_ACTION,
    SOURCE_IDS.COF_FOUNDATION_LOCATOR,
  ]
  for (const fb of FALLBACKS) {
    if (planned.size >= 3) break
    planned.add(fb)
  }

  const required = new Set(planned)

  const plannedArr = Array.from(planned)
  const directory_sources = plannedArr.filter((id) => SOURCES[id]?.directory === true)
  const direct_sources = plannedArr.filter((id) => SOURCES[id]?.directory !== true)

  const notes = []
  if (!profileType) notes.push('profile_type missing — using broad fallback coverage')
  if (profileNeeds.length === 0) notes.push('no needs detected — querying broadly compatible sources')

  return {
    profile_type: profileType,
    needs: profileNeeds,
    sources_planned: plannedArr,
    sources_required: Array.from(required),
    directory_sources,
    direct_sources,
    notes,
  }
}

/**
 * Build a coverage report from a list of source-execution outcomes.
 * Crawlers call this after a run to emit a structured report so the
 * mission dashboard can show coverage metrics.
 *
 *   plan      — output from planCoverage()
 *   outcomes  — array of { source_id, queried, failed, found, error }
 *
 * Returns a structured object the mission dashboard / Anya / tests can
 * consume directly.
 */
export function buildCoverageReport(plan, outcomes = []) {
  const planned = new Set(plan?.sources_planned ?? [])
  const required = new Set(plan?.sources_required ?? [])

  const sources_queried = []
  const sources_failed = []
  let direct_opportunities_found = 0
  let directory_opportunities_found = 0

  for (const o of outcomes) {
    if (!o?.source_id) continue
    if (o.queried) sources_queried.push(o.source_id)
    if (o.failed || o.error) sources_failed.push({ source_id: o.source_id, error: o.error ?? 'unknown' })
    const src = SOURCES[o.source_id]
    if (src?.directory) {
      directory_opportunities_found += Number(o.found ?? 0)
    } else {
      direct_opportunities_found += Number(o.found ?? 0)
    }
  }

  const coverage_gaps = Array.from(required).filter((id) => !sources_queried.includes(id))

  return {
    profile_type: plan?.profile_type ?? null,
    sources_planned: Array.from(planned),
    sources_required: Array.from(required),
    sources_queried,
    sources_failed,
    coverage_gaps,
    direct_opportunities_found,
    directory_opportunities_found,
    notes: plan?.notes ?? [],
  }
}

/**
 * Build a sanitized list of grants.gov-friendly query terms from a profile
 * context. This replaces the legacy "search with empty keyword" call that
 * Phase 4 mission rule explicitly forbids ("do not call broad blank search
 * as 'ZIP match'").
 *
 * Returns at most `limit` non-blank, non-pii terms. Falls back to a small
 * set of broadly useful federal-grant categories when the profile is empty
 * — this preserves recall without sending an empty query.
 */
export function buildGrantsGovQueryTerms(profileContext = {}, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 8, 16))
  const profile = profileContext?.profile ?? profileContext ?? {}
  const signals = profileContext?.signals ?? {}

  const candidates = []
  const profileType =
    profile?.primary_type ?? profile?.applicant_type ?? profile?.organization_type ?? null
  if (profileType) candidates.push(String(profileType).replace(/_/g, ' '))

  const setOrArrayToArray = (v) => {
    if (!v) return []
    if (Array.isArray(v)) return v
    if (typeof v?.values === 'function') return Array.from(v)
    return [String(v)]
  }
  for (const need of setOrArrayToArray(signals?.needs)) candidates.push(String(need).replace(/_/g, ' '))
  for (const interest of setOrArrayToArray(signals?.interests)) candidates.push(String(interest).replace(/_/g, ' '))

  // De-dupe + drop empties + cap
  const seen = new Set()
  const out = []
  for (const t of candidates) {
    const v = String(t).trim().toLowerCase()
    if (!v) continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
    if (out.length >= limit) break
  }

  if (out.length === 0) {
    // BROAD FALLBACK — never empty string. Use the same set of broad
    // assistance categories the dispatcher uses for "no profile context".
    return ['community development', 'rural development', 'public safety', 'workforce development']
  }
  return out
}

function normalizeType(t) {
  return String(t || '').toLowerCase().trim().replace(/[^a-z0-9_]/g, '_')
}

function sameNeed(a, b) {
  const na = String(a || '').toLowerCase().replace(/_/g, ' ').trim()
  const nb = String(b || '').toLowerCase().replace(/_/g, ' ').trim()
  if (!na || !nb) return false
  return na === nb || na.includes(nb) || nb.includes(na)
}

export default {
  SOURCE_IDS,
  SOURCES,
  getSource,
  listSources,
  planCoverage,
  buildCoverageReport,
  buildGrantsGovQueryTerms,
}
