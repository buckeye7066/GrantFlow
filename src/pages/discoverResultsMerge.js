import { dedupeFundingResults } from '@/utils/fundingDedupe'

// Pure helpers for the DiscoverGrants results view. Extracted so the
// merge/selection/reconciliation logic is unit-testable without mounting the
// whole page (which pulls in the auth store, a dozen api modules, and the
// react-query graph).

const scoreOf = (o) => {
  const n = Number(o?.match_score ?? o?.match ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Decide which catalog-opportunity list to RENDER.
 *
 * The live catalog query (GET /api/matching/profile/:id/opportunities) can
 * momentarily 503 (`catalog_busy`) / 504 when a concurrent discovery crawl
 * saturates the DB. On a hard error with no cached success, the query's data is
 * empty — and if the view renders straight from it, the profile's stored
 * matches vanish, leaving only the live run's handful of results (the
 * "20 sources matched, 2 shown" collapse).
 *
 * Rule: only REPLACE the visible catalog list on a genuine success (an empty
 * success is legitimate — the user raised the score floor). While the query is
 * loading or erroring, keep the last good list so a transient failure or an
 * in-flight live run can NEVER blank the stored matches.
 *
 * @param {{ hasFreshSuccess: boolean, fresh: any[], lastGood: any[] }} args
 * @returns {any[]}
 */
export function selectVisibleCatalog({ hasFreshSuccess, fresh, lastGood }) {
  if (hasFreshSuccess) return Array.isArray(fresh) ? fresh : []
  return Array.isArray(lastGood) ? lastGood : []
}

/**
 * Union the profile's stored catalog matches with the live-run results, deduped
 * and sorted by score. The live run AUGMENTS the stored set — it must never
 * replace it.
 *
 * @param {any[]} catalog
 * @param {any[]} live
 * @returns {any[]}
 */
export function mergeDiscoveryResults(catalog, live) {
  const merged = dedupeFundingResults([
    ...(Array.isArray(catalog) ? catalog : []),
    ...(Array.isArray(live) ? live : []),
  ])
  return merged.sort((a, b) => scoreOf(b) - scoreOf(a))
}

/**
 * Reconcile the coverage panel's "N sources with matches" against the count
 * actually rendered, so a silent "20 matched / 2 shown" can't recur. Returns a
 * descriptor the UI turns into a plain-language line, or null when there is
 * nothing to reconcile.
 *
 * `belowFloorCount` (from the score histogram) is the authoritative signal that
 * real matches are hidden by the current score filter; `matchedSourceCount` is
 * contextual ("N of your searched sources have matches"). Units differ
 * deliberately — sources vs opportunities — so the copy never conflates them.
 *
 * @param {{ shownCount: number, matchedSourceCount: number, belowFloorCount: number, minScore: number }} args
 * @returns {null | { shown: number, matched: number, belowFloorCount: number, minScore: number, hidden: boolean }}
 */
export function buildResultsReconciliation({ shownCount, matchedSourceCount, belowFloorCount, minScore }) {
  const shown = Number(shownCount) || 0
  const matched = Number(matchedSourceCount) || 0
  const below = Number(belowFloorCount) || 0
  if (matched <= 0 && below <= 0) return null
  // Matches exist below the user's score filter -> some are provably hidden.
  const hidden = below > 0
  return {
    shown,
    matched,
    belowFloorCount: below,
    minScore: Number(minScore) || 0,
    hidden,
  }
}
