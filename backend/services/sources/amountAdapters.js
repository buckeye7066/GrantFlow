/**
 * amountAdapters.js — the registry of API adapters that can read an
 * opportunity's award figures from its source's OWN API instead of its web page.
 *
 * WHY A REGISTRY. `amountEnrichment.js` has exactly one generic strategy: fetch
 * the row's page and extract from the copy. That strategy is structurally blind
 * to any source that renders client-side — the fetcher gets a JS shell, the
 * extractor sees no award copy, and the sweep honestly reports `thin_page`
 * forever. Those sources are not a long tail; they are the biggest, most
 * federal, most-linked ones (grants.gov was 45 of 149 backlog rows in the
 * 2026-07-15 prod audit). Each needs its own API adapter, and CLAUDE.md's
 * standing rule for an enumerable inventory whose members are consulted from
 * more than one place is: REGISTRY plus a TOTALITY test, so a new member cannot
 * silently fall out of a consumer.
 *
 * CONTRACT. Every adapter is `{ id, matches(row) → boolean, enrich(row, deps) →
 * result }` where `result` is the shape `enrichOpportunityAmountFromSource`
 * returns — `{attempted, page_read, transient, found, reason?, amounts?}`. An
 * adapter that cannot identify the row MUST return `attempted:false` so the
 * caller falls back to the page fetcher rather than burning the row. See
 * `amountEnrichment.js` for why this distinction lives in the return value.
 *
 * ORDER. `matches()` is expected to be mutually exclusive (a row belongs to one
 * source); the first match wins, and the totality test asserts the set is
 * consistent.
 */

import { enrichAmountViaGrantsGovApi, isGrantsGovRow } from './grantsGovAmountAdapter.js'

/**
 * The registry.
 *
 * NOT YET COVERED — recorded here so the gap is visible rather than folklore:
 *
 *   sam.gov — also a JS shell to the fetcher. Its Opportunities v2 API is
 *     key-gated (`getSamGovApiKey()`) and, unlike grants.gov, it does not
 *     publish a per-award ceiling/floor for open solicitations: the `award`
 *     node appears on AWARDED notices and reports what was actually granted to
 *     a specific vendor, which is not the same fact as "what an applicant could
 *     receive". Adding it would need that distinction handled honestly, so it
 *     is deliberately absent rather than half-built.
 */
export const AMOUNT_ADAPTERS = Object.freeze([
  Object.freeze({
    id: 'grants_gov',
    matches: isGrantsGovRow,
    enrich: enrichAmountViaGrantsGovApi,
  }),
])

/** The adapter that owns this row, or null when none does. Pure. */
export function findAmountAdapter(row) {
  if (!row) return null
  for (const adapter of AMOUNT_ADAPTERS) {
    try {
      if (adapter.matches(row)) return adapter
    } catch {
      // A broken matcher must never take down enrichment for every other source.
    }
  }
  return null
}

export default { AMOUNT_ADAPTERS, findAmountAdapter }
