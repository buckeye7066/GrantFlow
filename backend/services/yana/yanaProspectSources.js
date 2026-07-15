/**
 * yanaProspectSources.js
 *
 * Yana's OUTBOUND prospect discovery. Yana finds organizations that are NOT
 * yet GrantFlow clients but could benefit (grant-seeking nonprofits), so John
 * can do outreach. This is distinct from the legacy path that scanned the
 * operator's OWN `organizations` table (you don't prospect yourself).
 *
 * Design: a pluggable PROVIDER REGISTRY. Each provider implements
 *   async discover({ limit, ... }) => Array<ProspectCandidate>
 * so new universes (business registries, grants.gov applicants, …) can be
 * added without touching the qualify/enrich/push pipeline.
 *
 * The first concrete provider is ProPublica 990 (free, no API key): it yields
 * real nonprofit IDENTITIES (name, EIN, NTEE→cause, location, financials, a
 * research profile URL). 990 has NO email/website — that contact gap is closed
 * downstream by yanaContactEnrichment.js. A prospect therefore lands as
 * `needs_enrichment` until it has a real contact channel, then `qualified`.
 *
 * A ProspectCandidate is shaped to feed scoreOrganizationLead() directly:
 *   { source, external_id, organization_name, organization_type, entity_type,
 *     ein, location, city, state, mission, focus_areas, program_areas,
 *     website, email, source_urls, profile_url, evidence }
 */

import { searchOrganizations as realSearchOrganizations } from '../../src/integrations/propublica990.js'
import { NTEE_DESCRIPTIONS, NEED_TO_NTEE_MAP } from '../../constants/nteeMapping.js'
import { createLogger } from '../../utils/logger.js'
import { searchPlaces as realOsmSearchPlaces } from './osmProvider.js'
import { searchResearchOrganizations as realSearchResearchOrgs } from '../../src/integrations/nihReporter.js'

const log = createLogger('yanaProspectSources')

// ── Provider registry ────────────────────────────────────────────────────────
const providers = new Map()

export function registerProspectSource(name, provider) {
  if (!name || !provider || typeof provider.discover !== 'function') {
    throw new Error('registerProspectSource: provider must implement discover()')
  }
  providers.set(String(name), provider)
}

export function getProspectSource(name) { return providers.get(String(name)) || null }
export function listProspectSources() { return Array.from(providers.keys()) }
export function _resetProspectSources() { providers.clear(); registerDefaults() }

// ── NTEE → cause focus ───────────────────────────────────────────────────────
// Reverse the canonical need→NTEE map so a 990 NTEE letter yields GrantFlow
// cause tags (focus_areas) the matcher and John's packet understand.
const NTEE_LETTER_TO_NEEDS = (() => {
  const out = {}
  for (const [need, codes] of Object.entries(NEED_TO_NTEE_MAP || {})) {
    for (const code of codes) {
      const letter = String(code).charAt(0).toUpperCase()
      if (!out[letter]) out[letter] = []
      if (!out[letter].includes(need)) out[letter].push(need)
    }
  }
  return out
})()

function nteeToFocusAreas(nteeCode) {
  const letter = String(nteeCode || '').charAt(0).toUpperCase()
  return NTEE_LETTER_TO_NEEDS[letter] ? [...NTEE_LETTER_TO_NEEDS[letter]] : []
}

function nteeToMission(nteeCode) {
  const desc = NTEE_DESCRIPTIONS?.[String(nteeCode || '').charAt(0).toUpperCase()]
    || NTEE_DESCRIPTIONS?.[nteeCode]
  return desc ? `Nonprofit active in ${desc}.` : null
}

/**
 * Map a normalized ProPublica 990 org into a Yana prospect candidate. Contact
 * fields (email/website) are intentionally null — 990 doesn't carry them; they
 * are filled by enrichment. `source_urls` carries the research profile URL so
 * the prospect is auditable even before enrichment.
 */
export function mapNonprofitToProspect(org, { source = 'propublica_990' } = {}) {
  if (!org || !org.ein || !org.name || org.name === 'Unknown') return null
  const focus = nteeToFocusAreas(org.ntee_code)
  const mission = nteeToMission(org.ntee_code)
  const location = [org.city, org.state].filter(Boolean).join(', ') || null
  const evidence = []
  if (mission) evidence.push({ type: 'mission_statement', text: mission })
  if (focus.length) evidence.push({ type: 'focus_areas', value: focus })
  if (Number.isFinite(org.income_amount) || Number.isFinite(org.revenue_amount)) {
    evidence.push({
      type: 'irs_990_financials',
      revenue: org.total_revenue ?? org.revenue_amount ?? org.income_amount ?? null,
      assets: org.asset_amount ?? null,
      ntee_code: org.ntee_code ?? null,
    })
  }
  return {
    source,
    external_id: String(org.ein),
    ein: String(org.ein),
    organization_name: org.name,
    organization_type: 'nonprofit',
    entity_type: 'nonprofit',
    nonprofit_type: 'nonprofit',
    city: org.city || null,
    state: org.state || null,
    location,
    mission,
    focus_areas: focus,
    program_areas: [],
    website: null,
    website_url: null,
    email: null,
    profile_url: org.profile_url || null,
    source_urls: org.profile_url ? [org.profile_url] : [],
    public_evidence: evidence,
  }
}

// ── ProPublica 990 provider ──────────────────────────────────────────────────
// Default cause keywords used as the 990 search `q` (the API requires a query).
// Paired with NTEE filters they surface grant-seeking nonprofits by cause.
const DEFAULT_PROSPECT_QUERIES = Object.freeze([
  { q: 'education foundation', ntee: 'B' },
  { q: 'community health', ntee: 'E' },
  { q: 'youth services', ntee: 'O' },
  { q: 'housing assistance', ntee: 'L' },
  { q: 'food bank', ntee: 'K' },
  { q: 'arts council', ntee: 'A' },
  { q: 'environmental conservation', ntee: 'C' },
  { q: 'human services', ntee: 'P' },
])

/**
 * @param {object} [deps]
 * @param {Function} [deps.searchOrganizations] injectable for tests — defaults
 *        to the live ProPublica integration.
 */
export function makePropublica990Source(deps = {}) {
  const search = typeof deps.searchOrganizations === 'function'
    ? deps.searchOrganizations
    : realSearchOrganizations
  return {
    name: 'propublica_990',
    // `page`/`pages` let the caller PAGINATE ProPublica results. The scheduler
    // advances a persisted page cursor across runs (see discoverProspects) so
    // each run surfaces NEW orgs instead of re-scanning page 0 forever — the
    // "frozen universe" bug where every run re-found the same ~40 orgs (all
    // already pushed to John) and thus pushed 0 new leads.
    async discover({ limit = 100, states = null, queries = null, page = 0, pages = 1 } = {}) {
      const plans = Array.isArray(queries) && queries.length ? queries : DEFAULT_PROSPECT_QUERIES
      const stateList = Array.isArray(states) && states.length ? states : [null]
      const startPage = Number.isInteger(page) && page >= 0 ? page : 0
      const pageCount = Number.isInteger(pages) && pages > 0 ? pages : 1
      const out = []
      const seen = new Set()
      outer:
      for (const state of stateList) {
        for (let p = startPage; p < startPage + pageCount; p += 1) {
          for (const plan of plans) {
            if (out.length >= limit) break outer
            let result
            try {
              result = await search({ q: plan.q, ntee: plan.ntee, state: state || undefined, page: p })
            } catch (err) {
              log.warn(`990 search failed for q="${plan.q}" state=${state || 'all'} page=${p}: ${err?.message || err}`)
              continue
            }
            for (const org of result?.organizations || []) {
              if (out.length >= limit) break
              const prospect = mapNonprofitToProspect(org)
              if (!prospect) continue
              if (seen.has(prospect.external_id)) continue
              seen.add(prospect.external_id)
              out.push(prospect)
            }
          }
        }
      }
      return out
    },
  }
}

// ── Geo place → prospect mapper ───────────────────────────────────────────────
// Maps a normalized place (from the keyless OpenStreetMap source) into a Yana
// prospect candidate. A website lets scoreOrganizationLead award `has_website`
// immediately and gives contact enrichment a homepage to read for an email — so
// a geo-local prospect can graduate to `qualified` the same way a 990 prospect
// does. external_id is the place's stable id (dedup key).
export function mapPlaceToProspect(place, { source = 'openstreetmap' } = {}) {
  if (!place || !place.name) return null
  const evidence = []
  if (Array.isArray(place.types) && place.types.length) {
    evidence.push({ type: 'place_types', value: place.types.slice(0, 10) })
  }
  if (place.address) evidence.push({ type: 'address', text: place.address })
  if (place.phone) evidence.push({ type: 'contact', name: null, title: null, phone: place.phone, email: null })
  return {
    source,
    external_id: place.place_id ? String(place.place_id) : null,
    organization_name: place.name,
    organization_type: 'organization',
    entity_type: 'organization',
    city: null,
    state: null,
    location: place.address || null,
    mission: null,
    focus_areas: [],
    program_areas: [],
    website: place.website || null,
    website_url: place.website || null,
    phone: place.phone || null,
    email: null,
    profile_url: place.website || null,
    source_urls: place.website ? [place.website] : [],
    public_evidence: evidence,
  }
}

/**
 * OpenStreetMap (Overpass) prospect source — the FREE, keyless geo-local source.
 * Finds local mission/community orgs near the discovery geography. It needs no
 * API key/billing; it only needs a `location` (it geo-anchors via Nominatim), so
 * it honestly no-ops when no location is known.
 *
 * @param {object} [deps]
 * @param {Function} [deps.searchPlaces] injectable for tests — defaults to the live OSM integration.
 */
export function makeOpenStreetMapSource(deps = {}) {
  const search = typeof deps.searchPlaces === 'function' ? deps.searchPlaces : realOsmSearchPlaces
  return {
    name: 'openstreetmap',
    // `locations` (array) anchors one run on SEVERAL areas (owner-directed
    // geographic focus, e.g. three specific counties), splitting `limit`
    // across them; `location` (single) is the original form and still works.
    async discover({ limit = 40, location = null, locations = null } = {}) {
      const anchors = (Array.isArray(locations) && locations.length
        ? locations
        : [location])
        .map((l) => String(l || '').trim())
        .filter(Boolean)
      if (!anchors.length) {
        log.info('openstreetmap source skipped — no discovery location to anchor on')
        return []
      }
      const perAnchor = Math.max(1, Math.floor(limit / anchors.length))
      const out = []
      const seen = new Set()
      for (const anchor of anchors) {
        if (out.length >= limit) break
        let places = []
        try {
          places = await search({ location: anchor, limit: perAnchor })
        } catch (err) {
          log.warn(`openstreetmap search failed for "${anchor}": ${err?.message || err}`)
          continue
        }
        for (const place of places || []) {
          if (out.length >= limit) break
          const prospect = mapPlaceToProspect(place, { source: 'openstreetmap' })
          if (!prospect) continue
          const key = prospect.external_id
            ? `id:${prospect.external_id}`
            : `name:${String(prospect.organization_name).trim().toLowerCase()}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push(prospect)
        }
      }
      return out
    },
  }
}

// ── NIH RePORTER: the biomedical research audience ───────────────────────────
// The audience axiombiolabs.org actually speaks to — its site leads with a
// patent-pending CAR-Treg transplant-tolerance platform, then genomics/CRISPR,
// molecular diagnostics and environmental DNA — is academic and hospital
// research institutions working those same problems. NIH RePORTER is where they
// are publicly enumerable, and an active NIH award proves BOTH halves of a Yana
// lead at once: the org does this science, and it demonstrably pursues grant
// funding. That second half is what keeps John's GrantFlow pitch honest here —
// the same "past federal recipients actively seek grants" rationale the
// usaspending source rests on.
//
// Each topic mirrors one of the site's five platforms so the discovered
// universe tracks what Axiom actually publishes. `focus_areas` are canonical
// GrantFlow cause tags (NEED_TO_NTEE_MAP keys) so these leads speak the same
// vocabulary as every other source.
export const RESEARCH_TOPICS = Object.freeze([
  Object.freeze({
    id: 'transplant_tolerance',
    text: 'transplant immune tolerance regulatory T cell',
    label: 'transplant immunology and immune tolerance',
    focus_areas: ['health_medical'],
  }),
  Object.freeze({
    id: 'cell_therapy',
    text: 'CAR T cell therapy immunotherapy',
    label: 'engineered cell therapy and immuno-oncology',
    focus_areas: ['health_medical'],
  }),
  Object.freeze({
    id: 'gene_editing',
    text: 'CRISPR gene editing',
    label: 'CRISPR and gene-editing research',
    focus_areas: ['health_medical', 'technology_equipment'],
  }),
  Object.freeze({
    id: 'genomic_diagnostics',
    text: 'genomic sequencing variant interpretation diagnostics',
    label: 'genomics and molecular diagnostics',
    focus_areas: ['health_medical', 'technology_equipment'],
  }),
  Object.freeze({
    id: 'environmental_dna',
    text: 'environmental DNA metagenomics pathogen surveillance',
    label: 'environmental DNA and molecular surveillance',
    focus_areas: ['environment', 'technology_equipment'],
  }),
])

/**
 * Map an NIH RePORTER institution into a Yana prospect candidate.
 *
 * Every field is derived from what NIH actually published — never inferred.
 * RePORTER carries no email/website (enrichment closes that gap downstream, so
 * these land `needs_enrichment` exactly like a 990 prospect), and the
 * institution's real project titles become `program_areas` while the contact PI
 * becomes the named contact, giving John concrete, checkable specifics to
 * personalize against instead of a generic pitch.
 */
export function mapResearchOrgToProspect(org, { source = 'nih_reporter', topic = null } = {}) {
  if (!org || !org.org_id || !org.name) return null

  const topics = Array.isArray(org.topics) ? org.topics : []
  const investigators = Array.isArray(org.investigators) ? org.investigators : []
  const projectTitles = topics.map((t) => t?.title).filter(Boolean)

  // Factual, countable mission line — no adjectives NIH didn't earn.
  const area = topic?.label || 'biomedical research'
  const projectCount = Number(org.project_count) || projectTitles.length
  const missionBits = [
    `Research institution with ${projectCount} active NIH-funded ${projectCount === 1 ? 'project' : 'projects'} in ${area}`,
  ]
  if (org.latest_fiscal_year) missionBits.push(`most recent award FY${org.latest_fiscal_year}`)
  if (org.departments?.length) missionBits.push(`departments include ${org.departments.slice(0, 3).join(', ').toLowerCase()}`)
  const mission = `${missionBits.join('; ')}.`

  const contactPi = investigators[0] || null

  const evidence = [
    { type: 'nih_awards', project_count: projectCount, award_total: org.award_total ?? null, latest_fiscal_year: org.latest_fiscal_year ?? null, source_url: org.detail_url || null },
  ]
  if (investigators.length) {
    evidence.push({ type: 'principal_investigators', value: investigators.map((i) => [i.name, i.title].filter(Boolean).join(' — ')).slice(0, 3) })
  }

  const location = [org.city, org.state].filter(Boolean).join(', ') || null

  return {
    source,
    external_id: String(org.org_id),
    organization_name: org.name,
    organization_type: 'research_institution',
    entity_type: 'research_institution',
    city: org.city || null,
    state: org.state || null,
    location,
    mission,
    focus_areas: topic?.focus_areas ? [...topic.focus_areas] : ['health_medical'],
    // Real NIH project titles — the specifics John's "their work" paragraph needs.
    program_areas: projectTitles.slice(0, 5),
    contact_name: contactPi?.name || null,
    contact_title: contactPi?.title || null,
    website: null,
    website_url: null,
    email: null,
    profile_url: org.detail_url || null,
    source_urls: org.detail_url ? [org.detail_url] : [],
    public_evidence: evidence,
  }
}

/**
 * NIH RePORTER prospect source — free, keyless, national by default.
 *
 * Geography is deliberately NOT defaulted to YANA_TARGET_AREAS. Those counties
 * are the right frame for local community nonprofits; research institutions are
 * a national universe and Axiom's collaboration framing is national, so the
 * caller must opt in to a state filter (`states`) rather than silently losing
 * ~48 states of the audience to a setting meant for a different source.
 *
 * @param {object} [deps]
 * @param {Function} [deps.searchResearchOrganizations] injectable for tests.
 */
export function makeNihReporterSource(deps = {}) {
  const search = typeof deps.searchResearchOrganizations === 'function'
    ? deps.searchResearchOrganizations
    : realSearchResearchOrgs
  return {
    name: 'nih_reporter',
    /**
     * @param {object} [args]
     * @param {number} [args.limit] max prospects across all topics
     * @param {Array}  [args.topics] override RESEARCH_TOPICS
     * @param {string[]} [args.states] optional 2-letter state filter
     * @param {number[]} [args.fiscalYears] restrict to these FYs (default: recent two)
     */
    async discover({ limit = 50, topics = null, states = null, fiscalYears = null, offset = 0 } = {}) {
      const plans = Array.isArray(topics) && topics.length ? topics : RESEARCH_TOPICS
      // Recent fiscal years only: an org with a CURRENT award is actively
      // running the work and actively seeking funding. A 2005 award proves
      // neither, and would make John's outreach reference stale science.
      const fy = Array.isArray(fiscalYears) && fiscalYears.length
        ? fiscalYears
        : (() => { const y = new Date().getFullYear(); return [y - 1, y] })()

      const perTopic = Math.max(1, Math.floor(limit / plans.length))
      const out = []
      const seen = new Set()

      for (const plan of plans) {
        if (out.length >= limit) break
        let orgs = []
        try {
          orgs = await search({ text: plan.text, limit: perTopic, states, fiscalYears: fy, offset })
        } catch (err) {
          log.warn(`nih_reporter search failed for "${plan.id}": ${err?.message || err}`)
          continue
        }
        for (const org of orgs || []) {
          if (out.length >= limit) break
          const prospect = mapResearchOrgToProspect(org, { topic: plan })
          if (!prospect) continue
          // One institution can fund work across several topics — keep the
          // first (its best-matching topic) rather than emitting duplicates.
          if (seen.has(prospect.external_id)) continue
          seen.add(prospect.external_id)
          out.push(prospect)
        }
      }
      return out
    },
  }
}

function registerDefaults() {
  if (!providers.has('propublica_990')) {
    registerProspectSource('propublica_990', makePropublica990Source())
  }
  // NIH RePORTER: free + keyless, so the biomedical research audience is
  // reachable out of the box like the other no-key sources.
  if (!providers.has('nih_reporter')) {
    registerProspectSource('nih_reporter', makeNihReporterSource())
  }
  // OpenStreetMap: the free, keyless geo-local source — active by default (no
  // key needed), so geo-local prospecting works out of the box.
  if (!providers.has('openstreetmap')) {
    registerProspectSource('openstreetmap', makeOpenStreetMapSource())
  }
}

registerDefaults()
