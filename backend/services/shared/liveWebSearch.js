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
 * @returns {Promise<{ opportunities: Object[], raw: number, search: Object }>}
 */
async function collectWebLeads(queries, { state = null, perQueryCount = 6, timeoutMs = 9000 } = {}) {
  const deadline = Date.now() + Math.max(1000, Math.min(Number(timeoutMs) || 9000, 25000))
  let raw = 0

  // "NOBODY FUNDS THIS" AND "WE COULD NOT LOOK" ARE DIFFERENT FACTS.
  //
  // Every provider failure here is swallowed into `[]` — deliberately, because
  // this lane must never fail its caller. But the OUTCOME was reported as a
  // bare count, so a total backend outage (SearXNG unreachable + Brave budget
  // paused + the DuckDuckGo breaker open) rendered byte-identically to a
  // successful search of an empty world: `raw: 0, deduped: 0`. Downstream that
  // reads as "the open web has no local/item funding for this profile", which
  // is a claim we have no evidence for.
  //
  // `searchWeb` already tells us which it was: webSearchEngine attaches a
  // non-enumerable `searchMeta` whose `status` is 'unavailable' (with a reason
  // like process_breaker_open / request_failed) or 'degraded_results'. Read it
  // and carry the verdict out, so a caller can say "we could not look" instead
  // of "there is nothing".
  const tally = { attempted: 0, ok: 0, empty: 0, unavailable: 0, degraded: 0, skipped_deadline: 0 }
  const reasons = new Set()

  const perQuery = await Promise.all(
    queries.map(async (query) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        tally.skipped_deadline += 1
        return []
      }
      tally.attempted += 1
      // try/catch (not .catch chaining) so a synchronous throw from the search
      // engine is swallowed too — this lane must NEVER fail the caller.
      let results = []
      try {
        results = await searchWeb(query, { count: perQueryCount, timeoutMs: Math.min(remaining, 8000) })
        const status = String(results?.searchMeta?.status || (results?.length ? 'ok' : 'empty'))
        if (results?.searchMeta?.reason) reasons.add(String(results.searchMeta.reason))
        if (status === 'unavailable') tally.unavailable += 1
        else if (status === 'degraded_results') tally.degraded += 1
        else if (status === 'empty') tally.empty += 1
        else tally.ok += 1
      } catch (err) {
        // A throw is an outage too — never an empty world.
        tally.unavailable += 1
        reasons.add(`threw:${err?.message || String(err)}`.slice(0, 120))
        results = []
      }
      return (results || []).map((r) => ({ ...r, _query: query }))
    }),
  )

  // The lane could genuinely look iff at least one query reached a provider and
  // got a real answer (ok, degraded, or an honest empty). If every attempted
  // query was unavailable, a zero result is a MEASUREMENT FAILURE, not a fact.
  const reached = tally.ok + tally.degraded + tally.empty
  const searchStatus =
    tally.attempted === 0 ? 'not_attempted'
      : reached === 0 ? 'unavailable'
        : tally.unavailable > 0 || tally.degraded > 0 ? 'degraded'
          : 'ok'

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

  return {
    opportunities,
    raw,
    search: {
      status: searchStatus,
      queries_total: queries.length,
      queries_attempted: tally.attempted,
      providers_reached: reached,
      providers_unavailable: tally.unavailable,
      providers_degraded: tally.degraded,
      queries_skipped_deadline: tally.skipped_deadline,
      reasons: Array.from(reasons).slice(0, 5),
    },
  }
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
  const { opportunities, raw, search } = await collectWebLeads(queries, { state, perQueryCount, timeoutMs })

  debug.raw = raw
  debug.deduped = opportunities.length
  // Carry the outage/empty distinction out to the caller (see collectWebLeads).
  debug.search_status = search.status
  debug.search = search
  if (search.status === 'unavailable') {
    log.error(
      `[liveWebSearch] SEARCH UNAVAILABLE: all ${search.queries_attempted} local-funding queries failed to reach a provider — ` +
        `0 leads here means we could NOT LOOK, not that none exist. reasons=${JSON.stringify(search.reasons)}`,
    )
  } else {
    log.info(
      `[liveWebSearch] ${queries.length} queries → ${debug.raw} raw → ${debug.deduped} unique local leads ` +
        `(search ${search.status}, ${search.providers_unavailable} unavailable)`,
    )
  }
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
  const city = loc.city || profile.city || null
  const county = loc.county || profile.county || null
  const state = loc.state || profile.state || null
  const cityState = [city, state].filter(Boolean).join(' ')
  const countyLabel = county ? (/county/i.test(county) ? county : `${county} County`) : null
  const locality = countyLabel || cityState || state || ''

  // Applicant identity comes from both the persisted profile row and the
  // canonical derived signals. A coarse/missing primary_type must not erase a
  // more specific applicant type derived from the rest of the profile.
  const applicantTypes = [
    profile.primary_type,
    profile.applicant_type,
    signals.entityType,
    ...asArray(signals.applicantTypes),
  ].map((value) => String(value || '').replace(/_/g, ' ').trim().toLowerCase()).filter(Boolean)
  const type = applicantTypes.join(' ')
  const applicantNoun =
    /nonprofit|501|church|ministry|foundation/.test(type)
      ? 'nonprofit'
      : /business|company|entrepreneur/.test(type)
        ? 'small business'
        : /school|college|university|education agency/.test(type)
          ? 'school'
          : /student/.test(type)
            ? 'student'
            : /veteran/.test(type)
              ? 'veteran'
              : /individual|person|family|disabled|senior/.test(type)
                ? 'individual'
                : ''

  // The exact free-text request is always searched first. Taxonomy expansion
  // broadens later queries; it may never replace or truncate the words the
  // profile owner entered (for example, "15 passenger bus", not merely
  // "vehicle", and "DME", not merely "medical").
  const exactNeed = need.replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim()
  const matchedKey = String(expandedNeed?.matchedKey || '').trim()
  const core = matchedKey.includes(' ') ? matchedKey : exactNeed

  // Reuse the canonical whole-profile term builder to add one mission/need
  // anchor without leaking names, contact details, IDs, or raw profile prose
  // into a search provider. This is the same structured profile vocabulary the
  // federal source planner consumes.
  let profileTerms = []
  try {
    profileTerms = buildGrantsGovQueryTerms(profileContext, { limit: 8 })
      .map((value) => String(value || '').trim())
      .filter((value) => value && !exactNeed.toLowerCase().includes(value.toLowerCase()))
  } catch { profileTerms = [] }

  const queries = []
  const push = (q) => {
    const v = String(q || '').replace(/\s+/g, ' ').trim()
    if (v) queries.push(v)
  }

  if (variant === 'gift') {
    push(`"${exactNeed}" donation program ${applicantNoun} ${state || ''}`)
    push(`organizations that donate "${exactNeed}" ${locality}`)
    push(`free "${exactNeed}" ${applicantNoun || 'assistance program'} ${locality}`)
    if (core.toLowerCase() !== exactNeed.toLowerCase()) {
      push(`"${core}" in-kind donation ${applicantNoun} ${state || ''}`)
    }
  } else {
    push(`"${exactNeed}" grant ${applicantNoun} ${state || ''}`)
    push(`"${exactNeed}" funding assistance ${locality}`)
    push(`grant to pay for "${exactNeed}" ${applicantNoun} ${locality}`)
    if (core.toLowerCase() !== exactNeed.toLowerCase()) {
      push(`"${core}" grant ${applicantNoun} ${state || ''}`)
    }
    // One taxonomy-broadened query, after the exact request has already been
    // preserved in multiple search shapes.
    const syn = (expandedNeed?.synonyms || []).find(
      (s) => s && String(s).toLowerCase() !== core.toLowerCase(),
    )
    if (syn) push(`"${syn}" ${applicantNoun ? `${applicantNoun} ` : ''}grant ${state || ''}`)
  }
  if (profileTerms[0]) {
    push(`"${exactNeed}" "${profileTerms[0]}" ${variant === 'gift' ? 'donation' : 'grant'} ${locality}`)
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
  const queries = buildNeedWebQueries(needText, expandedNeed, profileContext, { variant, maxQueries })
  const debug = { queries, raw: 0, deduped: 0 }
  if (queries.length === 0) return { opportunities: [], debug }

  const state = profileContext?.signals?.location?.state ?? profileContext?.profile?.state ?? null
  const { opportunities, raw, search } = await collectWebLeads(queries, {
    state,
    perQueryCount: Math.max(1, Math.min(Number(perQueryCount) || 6, 15)),
    timeoutMs,
  })

  debug.raw = raw
  debug.deduped = opportunities.length
  // Same outage-vs-empty distinction as the profile lane (see collectWebLeads).
  debug.search_status = search.status
  debug.search = search
  if (search.status === 'unavailable') {
    log.error(
      `[liveWebSearch] SEARCH UNAVAILABLE for need "${String(needText).slice(0, 60)}" (${variant}): ` +
        `all ${search.queries_attempted} queries failed to reach a provider — 0 leads means we could NOT LOOK. ` +
        `reasons=${JSON.stringify(search.reasons)}`,
    )
  } else {
    log.info(
      `[liveWebSearch] need "${String(needText).slice(0, 60)}" (${variant}): ${queries.length} queries → ${debug.raw} raw → ${debug.deduped} unique leads ` +
        `(search ${search.status}, ${search.providers_unavailable} unavailable)`,
    )
  }
  return { opportunities, debug }
}

export default { searchLocalWebByProfile, buildLocalFundingQueries, buildNeedWebQueries, searchNeedWebLeads }
