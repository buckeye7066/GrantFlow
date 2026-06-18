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
    async discover({ limit = 100, states = null, queries = null } = {}) {
      const plans = Array.isArray(queries) && queries.length ? queries : DEFAULT_PROSPECT_QUERIES
      const stateList = Array.isArray(states) && states.length ? states : [null]
      const out = []
      const seen = new Set()
      outer:
      for (const state of stateList) {
        for (const plan of plans) {
          if (out.length >= limit) break outer
          let result
          try {
            result = await search({ q: plan.q, ntee: plan.ntee, state: state || undefined })
          } catch (err) {
            log.warn(`990 search failed for q="${plan.q}" state=${state || 'all'}: ${err?.message || err}`)
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
      return out
    },
  }
}

function registerDefaults() {
  if (!providers.has('propublica_990')) {
    registerProspectSource('propublica_990', makePropublica990Source())
  }
}

registerDefaults()
