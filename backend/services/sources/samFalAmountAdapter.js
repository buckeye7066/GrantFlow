/**
 * samFalAmountAdapter.js — read a SAM.gov Assistance Listing's award figures
 * from SAM's own listing API instead of its web page.
 *
 * WHY THIS EXISTS. 43 active-pipeline rows (prod census 2026-07-22) point at
 * `sam.gov/fal/<id>/view` — Federal Assistance Listings, the successor to the
 * CFDA program directory. The page is a JS shell to the fetcher (thin_page
 * forever), and the fix-cycle-1 structural rule honestly classifies these rows
 * DIRECTORY (a program locator). But a listing is not ONLY a pointer: SAM
 * publishes each program's "Range and Average of Financial Assistance" as free
 * text in the listing's own data (`financial.additionalInfo` — e.g. 93.867
 * Vision Research: "Research Grants (R): $12,400 to $2,178,277; Avg $422,981"),
 * which is exactly the per-award copy the conservative extractor exists to
 * parse. Leaving that unread repeats the #954 discarded-fact sin: the honest
 * answer is one API call away and nothing was asking.
 *
 * THE API. `https://sam.gov/api/prod/sgs/v1/search/?index=cfda&q=<number>` —
 * SAM.gov's own listing search (the same backend its SPA reads), keyless,
 * `Accept: application/hal+json` REQUIRED (a plain Accept gets an HTTP 406;
 * verified live 2026-07-22). Each hit carries `_id` (the exact hex id in our
 * rows' `/fal/<id>/view` URLs) and `programNumber` (the CFDA number our rows
 * store as source_id, e.g. "11.033"), so a row can be matched EXACTLY — a
 * near-miss hit is a different federal program, and taking hits[0]
 * unconditionally is the sort-without-a-floor class this repo has already been
 * burned by.
 *
 * WHAT IS DELIBERATELY NOT HERE. sam.gov CONTRACT opportunities
 * (`sam.gov/opp/...`) stay unadapted: their `award` node is what a specific
 * vendor WAS granted, which is not the same fact as "what an applicant could
 * receive". This adapter matches ONLY the /fal/ listing shape.
 *
 * NOT AN SSRF SURFACE. Like the grants.gov adapter, this module never
 * dereferences a URL carried on the row — it parses an id/number OUT of the
 * row and sends it to a hardcoded sam.gov endpoint as a query parameter.
 *
 * HONESTY CONTRACT — same shape as `enrichOpportunityAmountFromSource`:
 *   found + amounts    — the listing's financial text states a per-award figure
 *                        and the conservative extractor accepted it.
 *   page_read, !found  — the listing WAS read and publishes no parseable
 *                        per-award figure. When it publishes prose (e.g.
 *                        "refer to the NOFO on Grants.Gov") that prose rides
 *                        along as an honest amount_text label.
 *   environment: true  — 401/403/429: OUR egress is refused; never the row's
 *                        fault, never burns, becomes `unanswered_blocked`.
 *   transient: true    — 5xx/408/transport; the row keeps its chance.
 *   attempted: false   — not a /fal/ row; caller falls through unchanged.
 */

import { createLogger } from '../../utils/logger.js'
import { extractAwardAmountsFromText } from '../awardAmountExtractor.js'

const log = createLogger('service:samFalAmountAdapter')

/** SAM.gov assistance-listing search API (the SPA's own data backend). */
export const SAM_FAL_SEARCH_URL = 'https://sam.gov/api/prod/sgs/v1/search/'

/** Network timeout for one API call. */
const API_TIMEOUT_MS = 20_000

/** Max characters of listing prose persisted as an amount_text label. */
const AMOUNT_TEXT_MAX_CHARS = 300

/** `sam.gov/fal/<hex id>/view` — the listing detail URL our rows carry. */
const RE_FAL_URL_ID = /sam\.gov\/fal\/([0-9a-f]{20,64})\/view/i

/** CFDA / Assistance Listing number, e.g. "11.033", "93.867". */
const RE_AL_NUMBER = /^\d{2}\.\d{3}$/

/** Row source spellings in live use for SAM. */
const RE_SAM_SOURCE = /^sam[._]?gov$/i

/** The row's /fal/ listing id, or null. Pure; exported for tests. */
export function extractFalIdFromUrl(row) {
  for (const url of [row?.source_url, row?.application_url, row?.evidence_url]) {
    const m = String(url ?? '').match(RE_FAL_URL_ID)
    if (m) return m[1].toLowerCase()
  }
  return null
}

/**
 * Is this row a SAM.gov ASSISTANCE LISTING (never a contract opportunity)?
 * Positive shape only: a /fal/ URL, or the sam.gov source carrying an
 * assistance-listing number. Pure; exported for tests.
 */
export function isSamFalRow(row) {
  if (extractFalIdFromUrl(row)) return true
  const source = String(row?.source ?? row?.record_origin ?? '').trim()
  const sourceId = String(row?.source_id ?? '').trim()
  return RE_SAM_SOURCE.test(source) && RE_AL_NUMBER.test(sourceId)
}

/**
 * Fetch the listing record for a row, exact-matched by hex id or program
 * number. Returns { ok, hit, status, transient, environment, reason }.
 * Never throws. Exported for tests.
 */
export async function fetchFalListing(row, { fetchImpl = fetch } = {}) {
  const falId = extractFalIdFromUrl(row)
  const alNumber = RE_AL_NUMBER.test(String(row?.source_id ?? '').trim())
    ? String(row.source_id).trim()
    : null
  const query = alNumber ?? falId
  if (!query) return { ok: false, transient: false, reason: 'no_identifier' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const url = `${SAM_FAL_SEARCH_URL}?index=cfda&q=${encodeURIComponent(query)}&page=0&size=5`
    const res = await fetchImpl(url, {
      method: 'GET',
      // hal+json is REQUIRED — a plain Accept is answered with HTTP 406.
      headers: { Accept: 'application/hal+json' },
      signal: controller.signal,
    })
    const status = res?.status ?? null
    if (!res?.ok) {
      const code = Number(status)
      const environment = code === 401 || code === 403 || code === 429
      const transient = !Number.isFinite(code) || environment || code === 408 || code >= 500
      return { ok: false, status, transient, environment, reason: status ? `http_${status}` : 'transport' }
    }
    const data = await res.json()
    const hits = Array.isArray(data?._embedded?.results) ? data._embedded.results : []
    // EXACT identity only — and the URL's hex id OUTRANKS the row's program
    // number. When the URL carries a /fal/<id>/ the id IS the row's identity:
    // a hit matching only a (possibly stale/mismatched) source_id number would
    // accept financial text for a DIFFERENT assistance listing (gate finding).
    // The number is the identity only for rows with no /fal/ URL at all.
    const hit = hits.find((h) =>
      falId
        ? String(h?._id ?? '').toLowerCase() === falId
        : (alNumber && String(h?.programNumber ?? '').trim() === alNumber),
    ) ?? null
    if (!hit) return { ok: false, status, transient: false, reason: 'listing_not_found' }
    return { ok: true, hit, status, transient: false }
  } catch (err) {
    return { ok: false, status: null, transient: true, reason: `error:${err?.message ?? 'unknown'}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * enrichAmountViaSamFal — the adapter entry point. Contract-compatible with
 * `enrichOpportunityAmountFromSource` (see module header).
 */
export async function enrichAmountViaSamFal(row, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch
  if (!isSamFalRow(row)) {
    return { attempted: false, page_read: false, transient: false, found: false, reason: 'not_sam_fal' }
  }
  try {
    const res = await fetchFalListing(row, { fetchImpl })
    if (!res.ok) {
      // `listing_not_found`/`no_identifier` are STABLE facts about this row
      // (transient:false → the sweep stops asking); HTTP/transport failures
      // keep their environment/transient classification.
      return {
        attempted: true,
        page_read: false,
        transient: res.transient === true,
        environment: res.environment === true,
        status: res.status ?? null,
        found: false,
        reason: `sam_fal_api_failed:${res.reason ?? 'unknown'}`,
      }
    }

    // "Range and Average of Financial Assistance" — free text on the listing.
    // The conservative extractor is the ONLY thing allowed to turn it into
    // numbers (aggregate exclusions and all).
    const financialText = String(res.hit?.financial?.additionalInfo ?? '').trim()
    if (financialText) {
      const extracted = extractAwardAmountsFromText(financialText)
      const hasNumber = typeof extracted.amount_min === 'number' || typeof extracted.amount_max === 'number'
      if (hasNumber) {
        return {
          attempted: true,
          page_read: true,
          transient: false,
          found: true,
          reason: 'sam_fal_api',
          amounts: extracted,
        }
      }
      // Prose without a parseable per-award figure ("refer to the NOFO…"):
      // a real read, recorded as an honest text label, never a number.
      return {
        attempted: true,
        page_read: true,
        transient: false,
        found: false,
        reason: 'no_per_award_amount_in_listing',
        amount_text: financialText.slice(0, AMOUNT_TEXT_MAX_CHARS),
        amount_status: extracted.amount_status !== 'not_listed' ? extracted.amount_status : null,
      }
    }

    // The listing publishes NO financial-assistance text at all (e.g. 84.126):
    // an evidenced denial from the authoritative source.
    return {
      attempted: true,
      page_read: true,
      transient: false,
      found: false,
      reason: 'no_award_amount_published',
    }
  } catch (err) {
    // Defence in depth — "never throws", so a throw here is a bug: retryable.
    log.warn(`[samFalAmountAdapter] failed for "${row?.title ?? '?'}": ${err?.message ?? err}`)
    return { attempted: true, page_read: false, transient: true, found: false, reason: `error:${err?.message ?? 'unknown'}` }
  }
}

export default {
  enrichAmountViaSamFal,
  isSamFalRow,
  extractFalIdFromUrl,
  fetchFalListing,
  SAM_FAL_SEARCH_URL,
}
