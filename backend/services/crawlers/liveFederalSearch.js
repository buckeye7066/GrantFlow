/**
 * Live, profile-driven federal opportunity search (multi-source).
 *
 * Why this exists (root-cause fix):
 *   The Discover pipeline historically acquired candidates ONLY from curated
 *   in-memory catalogs + templated geo stubs, then used the profile merely to
 *   RANK that fixed universe. Profile-derived search terms were built
 *   (buildGrantsGovQueryTerms) but never used to ACQUIRE new opportunities, so
 *   a profile whose real grants weren't already in the catalog got geo-stubs
 *   and generic national programs — "funding sources that have nothing to do
 *   with the profile". This module closes that gap: it turns the WHOLE profile
 *   (type + needs + interests) into live keyword queries against every federal
 *   source we integrate, so the candidate set is driven by the profile.
 *
 * Sources (each profile-keyword-driven, each independently failure-isolated):
 *   - Grants.gov  (search2 keyword)        — open federal grants. NO API key.
 *   - SAM.gov     (v2 title keyword)       — open solicitations/grants. Needs
 *                                            SAM_GOV_API_KEY (set in prod);
 *                                            silently skips when absent.
 *   - USASpending (keywords[] filter)      — PAST awards → is_active=0 agency
 *                                            INTELLIGENCE, not actionable grants.
 *                                            NO API key.
 *   - NIH RePORTER (advanced_text_search)  — NIH-funded project records. NO key.
 *
 * Design notes / goals & rules alignment:
 *   - Recall over precision (rule G4): fetch broadly per profile term; let the
 *     downstream trust/relevance/score layers decide what to display. We never
 *     hard-filter here.
 *   - Failure-tolerant + time-bounded (rules G1/G6): a source/network failure
 *     yields fewer/zero results plus a structured debug entry; it never throws
 *     into the request path or blocks past the budget. One slow/broken source
 *     never starves the others.
 *   - Results carry their native canonical shape (+ source tag + matched_terms
 *     for explainability) so callers can ingest them (open grants persist with
 *     profile_id IS NULL → legitimately-national; satisfies G3) and/or
 *     display-merge the actionable (is_active !== 0) ones.
 */

// Use the NORMALIZED shim (returns { opportunities } in canonical shape and
// accepts { limit, keyword }). The raw crawler export returns { oppHits } —
// reading res.opportunities off it silently yields ZERO Grants.gov results.
import { fetchGrantsGov } from '../sources/grantsGov.js'
import { fetchSamGov } from '../sources/samGov.js'
import { fetchUSASpending } from '../sources/usaSpending.js'
import { fetchOpportunities as fetchNihReporter } from '../../src/integrations/nihReporter.js'
import { buildGrantsGovQueryTerms } from '../sourceRegistry.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:liveFederalSearch')

/** Resolve a promise to a fallback value if it does not settle within ms. */
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve(fallback)
      }
    }, Math.max(1, ms))
    Promise.resolve(promise).then(
      (v) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(v)
        }
      },
      (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          log.warn(`[liveFederalSearch] query failed: ${err?.message ?? err}`)
          resolve(fallback)
        }
      },
    )
  })
}

const oppsOf = (res) =>
  Array.isArray(res) ? res : Array.isArray(res?.opportunities) ? res.opportunities : []

const remainingMs = (deadline) => deadline - Date.now()

/**
 * Per-source runners. Each receives (terms, profileContext, deadline) and
 * returns an array of opportunities in that source's native canonical shape.
 * Each is wrapped by the caller so an individual failure is isolated.
 */
const SOURCES = {
  // Open federal grants — one keyword query per term (no API key).
  async grants_gov(terms, _ctx, deadline, opts) {
    const perTermLimit = opts.perTermLimit
    const settled = await Promise.all(
      terms.map(async (keyword) => {
        const rem = remainingMs(deadline)
        if (rem <= 0) return []
        const res = await withTimeout(fetchGrantsGov({ keyword, limit: perTermLimit }), rem, { opportunities: [] })
        return oppsOf(res).map((o) => ({ ...o, _matchedTerm: keyword }))
      }),
    )
    return settled.flat()
  },

  // Open solicitations/grants — title keyword per term. Skips without a key.
  // Capped to fewer terms than Grants.gov: SAM.gov is rate-limited and keyed.
  async sam_gov(terms, _ctx, deadline, opts) {
    const perTermLimit = Math.min(opts.perTermLimit, 20)
    const samTerms = terms.slice(0, Math.min(terms.length, 4))
    const settled = await Promise.all(
      samTerms.map(async (keyword) => {
        const rem = remainingMs(deadline)
        if (rem <= 0) return []
        const res = await withTimeout(fetchSamGov({ keyword, limit: perTermLimit, ptype: 'g' }), rem, { opportunities: [] })
        return oppsOf(res).map((o) => ({ ...o, _matchedTerm: keyword }))
      }),
    )
    return settled.flat()
  },

  // PAST awards → agency intelligence (is_active=0). Single call: the endpoint
  // accepts a keywords[] array, so all terms go in one request.
  async usaspending(terms, _ctx, deadline, opts) {
    const rem = remainingMs(deadline)
    if (rem <= 0) return []
    const res = await withTimeout(
      fetchUSASpending({ keywords: terms, limit: Math.min(opts.perTermLimit * 2, 50), page: 1 }),
      rem,
      { opportunities: [] },
    )
    return oppsOf(res).map((o) => ({ ...o, _matchedTerm: 'profile' }))
  },

  // NIH-funded project records — free-text search. Single call: RePORTER uses
  // implicit AND, so we cap to the first few terms (joined) to avoid 0 results.
  async nih_reporter(terms, _ctx, deadline, opts) {
    const rem = remainingMs(deadline)
    if (rem <= 0) return []
    const text = terms.slice(0, 3).join(', ')
    if (!text) return []
    const res = await withTimeout(
      fetchNihReporter({ text, limit: Math.min(opts.perTermLimit * 2, 50), offset: 0 }),
      rem,
      [],
    )
    return oppsOf(res).map((o) => ({ ...o, _matchedTerm: 'profile' }))
  },
}

/**
 * Run live federal opportunity search across all sources, driven by the full
 * profile.
 *
 * @param {Object} profileContext  Loaded profile context ({ profile, signals }).
 * @param {Object} [opts]
 * @param {string[]} [opts.searchTerms]  Pre-derived terms; built from the
 *   profile when omitted.
 * @param {number} [opts.maxTerms=6]      Max distinct keyword queries to run.
 * @param {number} [opts.perTermLimit=15] Base per-query row cap.
 * @param {number} [opts.timeoutMs=8000]  Overall wall-clock budget (all sources).
 * @param {string[]} [opts.sources]       Subset of source keys to run (default all).
 * @returns {Promise<{ opportunities: Object[], debug: Object }>}
 */
export async function searchLiveFederalByProfile(profileContext = {}, opts = {}) {
  const maxTerms = Math.max(1, Math.min(Number(opts.maxTerms) || 6, 12))
  const perTermLimit = Math.max(1, Math.min(Number(opts.perTermLimit) || 15, 50))
  const timeoutMs = Math.max(1000, Math.min(Number(opts.timeoutMs) || 8000, 25000))
  const sourceKeys = Array.isArray(opts.sources) && opts.sources.length
    ? opts.sources.filter((k) => k in SOURCES)
    : Object.keys(SOURCES)

  let terms = Array.isArray(opts.searchTerms) && opts.searchTerms.length ? opts.searchTerms : []
  if (terms.length === 0) {
    try {
      terms = buildGrantsGovQueryTerms(profileContext, { limit: maxTerms })
    } catch (err) {
      log.warn(`[liveFederalSearch] term derivation failed: ${err?.message ?? err}`)
      terms = []
    }
  }
  terms = terms.map((t) => String(t || '').trim()).filter(Boolean).slice(0, maxTerms)

  const debug = { terms, sources: {}, raw: 0, deduped: 0 }
  if (terms.length === 0) return { opportunities: [], debug }

  const deadline = Date.now() + timeoutMs

  // Run every source in parallel; isolate failures per source so one broken or
  // slow source can never starve the rest.
  const perSource = await Promise.all(
    sourceKeys.map(async (key) => {
      try {
        const opportunities = await SOURCES[key](terms, profileContext, deadline, { perTermLimit })
        debug.sources[key] = { count: opportunities.length }
        return { key, opportunities }
      } catch (err) {
        debug.sources[key] = { count: 0, error: String(err?.message ?? err) }
        log.warn(`[liveFederalSearch] source ${key} failed: ${err?.message ?? err}`)
        return { key, opportunities: [] }
      }
    }),
  )

  // Merge + dedupe across sources. The same opportunity can match several
  // profile terms (and rarely appear in two sources); collapse on the strongest
  // identity available, recording every term that surfaced it.
  const byKey = new Map()
  const keyOf = (o) =>
    (o?.source && o?.source_id ? `${o.source}:${o.source_id}` : null) ||
    o?.application_url ||
    o?.source_url ||
    String(o?.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

  for (const { opportunities } of perSource) {
    debug.raw += opportunities.length
    for (const opp of opportunities) {
      const k = keyOf(opp)
      if (!k) continue
      const term = opp._matchedTerm || 'profile'
      if (!byKey.has(k)) {
        const { _matchedTerm, ...rest } = opp
        byKey.set(k, { ...rest, matched_terms: [term] })
      } else {
        const existing = byKey.get(k)
        if (!existing.matched_terms.includes(term)) existing.matched_terms.push(term)
      }
    }
  }

  const opportunities = Array.from(byKey.values())
  debug.deduped = opportunities.length
  log.info(
    `[liveFederalSearch] ${terms.length} terms across [${sourceKeys.join(',')}] → ${debug.raw} raw → ${debug.deduped} unique`,
  )
  return { opportunities, debug }
}

export default { searchLiveFederalByProfile }
