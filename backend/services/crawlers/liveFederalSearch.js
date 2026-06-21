/**
 * Live, profile-driven federal opportunity search.
 *
 * Why this exists (root-cause fix):
 *   The Discover pipeline historically acquired candidates ONLY from curated
 *   in-memory catalogs + templated geo stubs, then used the profile merely to
 *   RANK that fixed universe. Profile-derived search terms were built
 *   (buildGrantsGovQueryTerms) but never used to ACQUIRE new opportunities, so
 *   a profile whose real grants weren't already in the catalog got geo-stubs
 *   and generic national programs — "funding sources that have nothing to do
 *   with the profile". This module closes that gap: it turns the WHOLE profile
 *   (type + needs + interests) into live keyword queries against Grants.gov and
 *   returns real opportunities so the candidate set is driven by the profile,
 *   not just its state.
 *
 * Design notes / goals & rules alignment:
 *   - Grants.gov search2 works WITHOUT an API key (X-API-Key sent only when
 *     GRANTS_GOV_API_KEY is set), so this works in any environment.
 *   - Recall over precision (canonical rule G4): we fetch broadly by each
 *     profile term and let the downstream trust/relevance/score layers decide
 *     what to display. We never hard-filter here.
 *   - Failure-tolerant + time-bounded (rule G1/G6): any source or network
 *     failure yields fewer/zero results and a structured debug entry; it never
 *     throws into the request path or blocks past the budget.
 *   - Results are returned in the canonical transformGrantsGovOpportunity shape
 *     so callers can ingest them (profile_id IS NULL → legitimately-global
 *     federal grants, satisfying G3) and/or display-merge them.
 */

import { fetchGrantsGov } from '../grantsDotGovCrawler.js'
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
    }, ms)
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
          log.warn(`[liveFederalSearch] term query failed: ${err?.message ?? err}`)
          resolve(fallback)
        }
      },
    )
  })
}

/**
 * Run live federal keyword searches derived from the full profile.
 *
 * @param {Object} profileContext  Loaded profile context ({ profile, signals }).
 * @param {Object} [opts]
 * @param {string[]} [opts.searchTerms]  Pre-derived terms; built from the
 *   profile when omitted.
 * @param {number} [opts.maxTerms=6]     Max distinct keyword queries to run.
 * @param {number} [opts.perTermLimit=15] Max rows fetched per keyword query.
 * @param {number} [opts.timeoutMs=7000] Overall wall-clock budget.
 * @returns {Promise<{ opportunities: Object[], debug: Object }>}
 */
export async function searchLiveFederalByProfile(profileContext = {}, opts = {}) {
  const maxTerms = Math.max(1, Math.min(Number(opts.maxTerms) || 6, 12))
  const perTermLimit = Math.max(1, Math.min(Number(opts.perTermLimit) || 15, 50))
  const timeoutMs = Math.max(1000, Math.min(Number(opts.timeoutMs) || 7000, 20000))

  let terms = Array.isArray(opts.searchTerms) && opts.searchTerms.length
    ? opts.searchTerms
    : []
  if (terms.length === 0) {
    try {
      terms = buildGrantsGovQueryTerms(profileContext, { limit: maxTerms })
    } catch (err) {
      log.warn(`[liveFederalSearch] term derivation failed: ${err?.message ?? err}`)
      terms = []
    }
  }
  terms = terms
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .slice(0, maxTerms)

  const debug = { terms, queried: 0, raw: 0, deduped: 0, errors: [] }
  if (terms.length === 0) return { opportunities: [], debug }

  const deadline = Date.now() + timeoutMs
  const settled = await Promise.all(
    terms.map(async (keyword) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { keyword, opportunities: [] }
      const res = await withTimeout(
        fetchGrantsGov({ keyword, limit: perTermLimit }),
        remaining,
        { opportunities: [], _timedOut: true },
      )
      if (res?._timedOut) debug.errors.push({ keyword, error: 'timeout' })
      return { keyword, opportunities: Array.isArray(res?.opportunities) ? res.opportunities : [] }
    }),
  )

  // Merge + dedupe across all term queries. The same federal opportunity
  // commonly matches several profile terms; collapse on the strongest
  // identity available (source_id → application_url → normalized title).
  const byKey = new Map()
  const keyOf = (o) =>
    o?.source_id ||
    o?.application_url ||
    o?.source_url ||
    String(o?.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

  for (const { keyword, opportunities } of settled) {
    if (opportunities.length) debug.queried += 1
    debug.raw += opportunities.length
    for (const opp of opportunities) {
      const k = keyOf(opp)
      if (!k) continue
      if (!byKey.has(k)) {
        // Record which profile term surfaced it — useful for explainability.
        byKey.set(k, { ...opp, matched_terms: [keyword] })
      } else {
        const existing = byKey.get(k)
        if (!existing.matched_terms.includes(keyword)) existing.matched_terms.push(keyword)
      }
    }
  }

  const opportunities = Array.from(byKey.values())
  debug.deduped = opportunities.length
  log.info(
    `[liveFederalSearch] ${terms.length} terms → ${debug.raw} raw → ${debug.deduped} unique federal opportunities`,
  )
  return { opportunities, debug }
}

export default { searchLiveFederalByProfile }
