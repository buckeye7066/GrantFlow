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
import { classifyProductionProfile } from '../../config/productionProfileScope.js'
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

function skippedWebSearch(profileContext = {}) {
  const scope = classifyProductionProfile(profileContext)
  if (scope.production) return null
  return {
    opportunities: [],
    debug: {
      queries: [],
      raw: 0,
      deduped: 0,
      skipped: true,
      reason: scope.reason,
    },
  }
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
 * Execute a list of web queries and merge the hits into deduped funding LEADS.
 * Shared by the profile-keyed lane (searchLocalWebByProfile) and the
 * need-keyed lane (searchNeedWebLeads) so both produce ONE lead shape:
 * record_origin='web_search', is_lead=true, no application_url (a lead's URL
 * is a source page to verify, never an application target).
 *
 * @param {string[]} queries
 * @param {Object} opts
 * @param {string|null} [opts.state]
 * @param {number} [opts.perQueryCount=6]
 * @param {number} [opts.timeoutMs=9000] Overall wall-clock budget.
 * @returns {Promise<{ opportunities: Object[], raw: number }>}
 */
async function collectWebLeads(queries, { state = null, perQueryCount = 6, timeoutMs = 9000 } = {}) {
  const deadline = Date.now() + Math.max(1000, Math.min(Number(timeoutMs) || 9000, 25000))
  let raw = 0

  const perQuery = await Promise.all(
    queries.map(async (query) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return []
      // try/catch (not .catch chaining) so a synchronous throw from the search
      // engine is swallowed too — this lane must NEVER fail the caller.
      let results = []
      try {
        results = await searchWeb(query, { count: perQueryCount, timeoutMs: Math.min(remaining, 8000) })
      } catch {
        results = []
      }
      return (results || []).map((r) => ({ ...r, _query: query }))
    }),
  )

  // Merge + dedupe by URL across queries, recording every query that surfaced it.
  const byUrl = new Map()
  for (const list of perQuery) {
    raw += list.length
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

  return { opportunities, raw }
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
  const skipped = skippedWebSearch(profileContext)
  if (skipped) return skipped

  const maxQueries = Math.max(1, Math.min(Number(opts.maxQueries) || 8, 12))
  const perQueryCount = Math.max(1, Math.min(Number(opts.perQueryCount) || 6, 15))
  const timeoutMs = Math.max(1000, Math.min(Number(opts.timeoutMs) || 9000, 25000))

  const queries = buildLocalFundingQueries(profileContext, maxQueries)
  const debug = { queries, raw: 0, deduped: 0 }
  if (queries.length === 0) return { opportunities: [], debug }

  const state = profileContext?.signals?.location?.state ?? profileContext?.profile?.state ?? null
  const { opportunities, raw } = await collectWebLeads(queries, { state, perQueryCount, timeoutMs })

  debug.raw = raw
  debug.deduped = opportunities.length
  log.info(`[liveWebSearch] ${queries.length} queries → ${debug.raw} raw → ${debug.deduped} unique local leads`)
  return { opportunities, debug }
}

/**
 * Build web queries for a CONCRETE user-stated need ("15 passenger van",
 * "help to pay for an Ethics Probe Class"). This is the item-funding lane:
 * the profile-keyed crawl has no reason to have fetched pages about a specific
 * item, so the need itself must drive the search. Queries anchor on:
 *   - the taxonomy phrase that matched (expandNeed's matchedKey — e.g.
 *     "passenger van", "probe class") when it is a phrase, else the raw need;
 *   - the applicant type (nonprofit / small business / school) so a nonprofit
 *     gets "passenger van grant nonprofit", not consumer-loan noise;
 *   - the profile's state for local funders;
 *   - variant 'gift' flips the intent to donation / in-kind programs
 *     ("organizations that donate passenger van") for the "find donation or
 *     gift programs" path.
 *
 * @param {string} needText - raw user need text
 * @param {Object|null} expandedNeed - output of needTaxonomy.expandNeed(needText)
 * @param {Object} [profileContext]
 * @param {Object} [opts]
 * @param {('funding'|'gift')} [opts.variant='funding']
 * @param {number} [opts.maxQueries=5]
 * @returns {string[]}
 */
export function buildNeedWebQueries(needText, expandedNeed = null, profileContext = {}, opts = {}) {
  const variant = opts.variant === 'gift' ? 'gift' : 'funding'
  const maxQueries = Math.max(1, Math.min(Number(opts.maxQueries) || 5, 8))
  const need = String(needText || '').replace(/\s+/g, ' ').trim()
  if (!need) return []

  const profile = profileContext?.profile ?? {}
  const signals = profileContext?.signals ?? {}
  const loc = signals?.location ?? {}
  const state = loc.state || profile.state || null

  const type = String(
    profile.primary_type || profile.applicant_type || signals.entityType || '',
  ).replace(/_/g, ' ').trim().toLowerCase()
  const applicantNoun =
    type.includes('nonprofit') || type.includes('501') || type.includes('church') || type.includes('ministry')
      ? 'nonprofit'
      : type.includes('business')
        ? 'small business'
        : type.includes('school')
          ? 'school'
          : ''

  // Core term: prefer the taxonomy PHRASE that matched (it strips filler like
  // "help to pay for an …"), but only when it is a phrase — a single-word key
  // like "vehicle" is a category, not the user's item.
  const matchedKey = String(expandedNeed?.matchedKey || '').trim()
  const core = matchedKey.includes(' ') ? matchedKey : need

  const queries = []
  const push = (q) => {
    const v = String(q || '').replace(/\s+/g, ' ').trim()
    if (v) queries.push(v)
  }

  if (variant === 'gift') {
    push(`"${core}" donation program ${applicantNoun}`)
    push(`organizations that donate ${core}`)
    push(`free ${core} ${applicantNoun || 'program'} ${state || ''}`)
    push(`${core} in-kind donation ${state || ''}`)
  } else {
    push(`"${core}" grant ${applicantNoun}`)
    push(`"${core}" funding assistance ${state || ''}`)
    push(`grant to pay for ${core} ${applicantNoun}`)
    // One taxonomy-broadened query (first synonym that differs from the core)
    const syn = (expandedNeed?.synonyms || []).find(
      (s) => s && String(s).toLowerCase() !== core.toLowerCase(),
    )
    if (syn) push(`${syn} ${applicantNoun ? `${applicantNoun} ` : ''}grant ${state || ''}`)
  }
  // When the core was distilled from a longer sentence, keep ONE raw-text query
  // so nothing the user typed is silently dropped.
  if (core.toLowerCase() !== need.toLowerCase()) {
    push(`${need} ${variant === 'gift' ? 'donation' : 'grant'}`)
  }

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
 * Run need-keyed live web searches and return funding LEADS for a concrete
 * item/need. Same safety posture as searchLocalWebByProfile: results are
 * labeled leads (record_origin='web_search'), display-merged by the caller,
 * NEVER ingested into the shared catalog unverified, and fully failure-tolerant.
 *
 * @param {Object} opts
 * @param {string} opts.needText
 * @param {Object|null} [opts.expandedNeed] - needTaxonomy.expandNeed output
 * @param {Object} [opts.profileContext]
 * @param {('funding'|'gift')} [opts.variant='funding']
 * @param {number} [opts.maxQueries=5]
 * @param {number} [opts.perQueryCount=6]
 * @param {number} [opts.timeoutMs=12000] Overall wall-clock budget.
 * @returns {Promise<{ opportunities: Object[], debug: Object }>}
 */
export async function searchNeedWebLeads({
  needText,
  expandedNeed = null,
  profileContext = {},
  variant = 'funding',
  maxQueries = 5,
  perQueryCount = 6,
  timeoutMs = 12000,
} = {}) {
  const skipped = skippedWebSearch(profileContext)
  if (skipped) return skipped

  const queries = buildNeedWebQueries(needText, expandedNeed, profileContext, { variant, maxQueries })
  const debug = { queries, raw: 0, deduped: 0 }
  if (queries.length === 0) return { opportunities: [], debug }

  const state = profileContext?.signals?.location?.state ?? profileContext?.profile?.state ?? null
  const { opportunities, raw } = await collectWebLeads(queries, {
    state,
    perQueryCount: Math.max(1, Math.min(Number(perQueryCount) || 6, 15)),
    timeoutMs,
  })

  debug.raw = raw
  debug.deduped = opportunities.length
  log.info(
    `[liveWebSearch] need "${String(needText).slice(0, 60)}" (${variant}): ${queries.length} queries → ${debug.raw} raw → ${debug.deduped} unique leads`,
  )
  return { opportunities, debug }
}

export default { searchLocalWebByProfile, buildLocalFundingQueries, buildNeedWebQueries, searchNeedWebLeads }
