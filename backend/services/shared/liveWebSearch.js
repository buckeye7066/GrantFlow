/**
 * Live, profile-driven web search for LOCAL / non-federal funding.
 *
 * Why this exists:
 *   Federal APIs (Grants.gov/SAM/USASpending/NIH — see liveFederalSearch.js)
 *   never surface a local funder like a county EMS scholarship or a city
 *   community-foundation grant: those have no API, they live on the open web.
 *   This module turns the WHOLE profile (location + type + needs + interests)
 *   into funding-oriented web queries and returns real, clickable LEADS.
 *
 * Safety posture (canonical goal #1: "real sources, not junk"):
 *   - Results are LEADS, not verified opportunities. They carry
 *     record_origin='web_search' (NOT in UNTRUSTED_ORIGINS, so they are not
 *     hard-dropped) and source_trust 'unknown' → the canonical trust layer
 *     renders them low-trust, ranked BEHIND official/verified sources, and the
 *     route's relevance filter still gates them against the profile.
 *   - Callers should DISPLAY-merge these (so local sources surface for this
 *     profile) but NOT ingest them into the shared global catalog unverified —
 *     that would let open-web noise pollute every other profile's results.
 *   - Backed by webSearchEngine (Brave when keyed, else DuckDuckGo); fully
 *     failure-tolerant and time-bounded.
 */

import { searchWeb } from './webSearchEngine.js'
import { buildGrantsGovQueryTerms } from '../sourceRegistry.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:liveWebSearch')

function asArray(v) {
  if (!v) return []
  if (Array.isArray(v)) return v
  if (typeof v?.values === 'function') return Array.from(v)
  return [String(v)]
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

// Stable id from the URL so repeated runs map a lead to the same row (no
// Math.random / Date — those are non-deterministic and break dedupe/caching).
function stableId(url) {
  let hash = 0
  const s = String(url || '')
  for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0
  return `web-${hash.toString(36)}`
}

/**
 * Build funding-oriented web queries from the full profile. Combines geography
 * (city / county / state) with funding nouns and the profile's own needs/
 * interests so a paramedic in Cleveland TN gets e.g. `"Bradley County" EMS
 * scholarship`, not a generic national query.
 */
export function buildLocalFundingQueries(profileContext = {}, maxQueries = 8) {
  const profile = profileContext?.profile ?? {}
  const signals = profileContext?.signals ?? {}
  const loc = signals?.location ?? {}
  const city = loc.city || profile.city || null
  const county = loc.county || profile.county || null
  const state = loc.state || profile.state || null
  const cityState = [city, state].filter(Boolean).join(' ')
  const countyLabel = county ? (/county/i.test(county) ? county : `${county} County`) : null

  const type = String(
    profile.primary_type || profile.applicant_type || signals.entityType || '',
  ).replace(/_/g, ' ').trim().toLowerCase()
  const isStudent = type.includes('student') || asArray(signals.applicantTypes).includes('student')
  const isNonprofit = type.includes('nonprofit') || type.includes('501')
  const isBusiness = type.includes('business')

  // Profile needs/interests, reused from the canonical term builder.
  let needTerms = []
  try {
    needTerms = buildGrantsGovQueryTerms(profileContext, { limit: 4 }).filter(
      (t) => !['community development', 'rural development', 'public safety', 'workforce development'].includes(t),
    )
  } catch { needTerms = [] }

  const queries = []
  const push = (q) => { const v = String(q || '').trim(); if (v) queries.push(v) }

  // Geography × funding noun.
  if (countyLabel) {
    push(`"${countyLabel}" ${state || ''} grant`.trim())
    push(`"${countyLabel}" scholarship`)
    push(`"${countyLabel}" community foundation`)
  }
  if (cityState) {
    push(`"${cityState}" assistance program`)
    push(`"${cityState}" grant`)
  }

  // Need × geography (the highest-signal local queries).
  for (const need of needTerms.slice(0, 3)) {
    const where = countyLabel || cityState || state || ''
    push(`${need} ${isStudent ? 'scholarship' : 'grant'} ${where}`.trim())
  }

  // Type-aware local funders.
  if (state) {
    if (isNonprofit) push(`${state} community foundation nonprofit grant`)
    else if (isStudent) push(`${state} local scholarship`)
    else if (isBusiness) push(`${state} small business grant local`)
  }

  // De-dupe, drop anything with no geographic OR need anchor (avoid generic
  // national noise — that is the federal layer's job), cap.
  const seen = new Set()
  const out = []
  for (const q of queries) {
    const k = q.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(q)
    if (out.length >= maxQueries) break
  }
  return out
}

/**
 * Run profile-driven local web searches and return funding LEADS.
 *
 * @param {Object} profileContext
 * @param {Object} [opts]
 * @param {number} [opts.maxQueries=8]
 * @param {number} [opts.perQueryCount=6]
 * @param {number} [opts.timeoutMs=9000] Overall wall-clock budget.
 * @returns {Promise<{ opportunities: Object[], debug: Object }>}
 */
export async function searchLocalWebByProfile(profileContext = {}, opts = {}) {
  const maxQueries = Math.max(1, Math.min(Number(opts.maxQueries) || 8, 12))
  const perQueryCount = Math.max(1, Math.min(Number(opts.perQueryCount) || 6, 15))
  const timeoutMs = Math.max(1000, Math.min(Number(opts.timeoutMs) || 9000, 25000))

  const queries = buildLocalFundingQueries(profileContext, maxQueries)
  const debug = { queries, raw: 0, deduped: 0 }
  if (queries.length === 0) return { opportunities: [], debug }

  const state = profileContext?.signals?.location?.state ?? profileContext?.profile?.state ?? null
  const deadline = Date.now() + timeoutMs

  const perQuery = await Promise.all(
    queries.map(async (query) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return []
      const results = await searchWeb(query, { count: perQueryCount, timeoutMs: Math.min(remaining, 8000) })
        .catch(() => [])
      return results.map((r) => ({ ...r, _query: query }))
    }),
  )

  // Merge + dedupe by URL across queries, recording every query that surfaced it.
  const byUrl = new Map()
  for (const list of perQuery) {
    debug.raw += list.length
    for (const r of list) {
      const key = String(r.url).toLowerCase().replace(/\/$/, '')
      if (!key) continue
      if (!byUrl.has(key)) byUrl.set(key, { ...r, _queries: [r._query] })
      else {
        const e = byUrl.get(key)
        if (!e._queries.includes(r._query)) e._queries.push(r._query)
      }
    }
  }

  const opportunities = Array.from(byUrl.values()).map((r) => ({
    id: stableId(r.url),
    source: 'web_search',
    source_id: r.url,
    title: r.title || extractDomain(r.url) || 'Funding lead',
    name: r.title || extractDomain(r.url) || 'Funding lead',
    sponsor: extractDomain(r.url),
    description: r.snippet || '',
    url: r.url,
    source_url: r.url,
    application_url: null,
    state: state || null,
    is_national: 0,
    opportunity_type: 'program',
    record_origin: 'web_search',
    categories: ['web_discovered'],
    keywords: r._queries,
    match_reasons: [`Discovered via web search: ${r._queries[0]}`],
    matched_terms: r._queries,
    is_active: 1,
    is_lead: true,
  }))

  debug.deduped = opportunities.length
  log.info(`[liveWebSearch] ${queries.length} queries → ${debug.raw} raw → ${debug.deduped} unique local leads`)
  return { opportunities, debug }
}

export default { searchLocalWebByProfile, buildLocalFundingQueries }
