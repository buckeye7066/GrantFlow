/**
 * listingPageAmountAdapter.js — title-anchored amount reads for rows whose URL
 * is a known MULTI-AWARD LISTING page.
 *
 * THE GAP (Anya daily report 2026-07-27, `unanswered_unreadable` top host
 * ww5.clevelandstatecc.edu). Some pipeline rows point at a page that lists MANY
 * awards (a college scholarship portal, a foundation's "our scholarships"
 * page). Two failure modes meet there:
 *
 *   1. The stored host can be DEAD (ww5.clevelandstatecc.edu stopped answering
 *      on :443 entirely — verified from both local and prod egress 2026-07-27)
 *      or WAF-challenged from prod (www.clevelandstatecc.edu answers Railway
 *      with an HTTP 202 interstitial, migration 158's finding), while the SAME
 *      content is served live somewhere else (the Foundation's NextGen portal:
 *      HTTP 200 with real award copy from the prod container, verified
 *      2026-07-27). The generic page fetcher can only report the dead host.
 *   2. Whole-page extraction on a listing page MISATTRIBUTES: the first
 *      per-award phrase on the page belongs to SOME award, almost never the
 *      row's own. Measured live 2026-07-27: the CSCC scholarships page yields
 *      "labeled $1,000" (Presidential Honors' figure) and the foundation page
 *      yields "single $250" (Alumni Legacy's figure) for ANY row read against
 *      them — the Coca-Cola $237,500-for-a-$20,000-award class, one level up.
 *
 * So this adapter (a) routes registered hosts to the listing URL that is
 * actually READABLE from prod, and (b) extracts ONLY from the window anchored
 * at the row's OWN title on that page:
 *
 *   - A NUMERIC figure is accepted only NEAR the anchor (the program's own
 *     paragraph). A figure further away belongs to a sibling award and is
 *     never taken.
 *   - A status statement ('varies' / 'contact_required') is accepted from the
 *     wider window — "Award amounts vary." is exactly what an umbrella
 *     program's own section says.
 *   - Title not found on the page → an honest stable failure
 *     (`listing_title_not_found`), NEVER a denial: a closed portal listing
 *     teaches us we cannot see the program, not that the funder publishes
 *     nothing.
 *
 * NOT AN SSRF SURFACE. The fetched URL comes from this module's own frozen
 * registry, never from row data, and goes through the crawler-os production
 * fetcher (safe-URL validation, DNS-rebinding guard) like every page read.
 *
 * HONESTY CONTRACT — same shape as `enrichOpportunityAmountFromSource`
 * (services/amountEnrichment.js); an unrecognized row returns
 * `attempted:false` so the caller falls through unchanged.
 */

import { createLogger } from '../../utils/logger.js'
import { extractAwardAmountsFromText } from '../awardAmountExtractor.js'
import { htmlToText } from '../webGrantExtractor.js'

const log = createLogger('service:listingPageAmountAdapter')

/** Max characters of listing text scanned (mirrors amountEnrichment). */
const PAGE_TEXT_MAX_CHARS = 20_000

/**
 * A numeric figure must sit within this many characters of the row's title
 * anchor to count as the row's OWN figure. Calibrated on the live CSCC portal
 * 2026-07-27: "Presidential Honors Scholarship" → its "Award amount: $1,000"
 * is +428 chars; the umbrella "Foundation Scholarships" section ends well
 * before the first sibling figure at +1,896.
 */
const NEAR_NUMERIC_CHARS = 500

/** Wider window for status-only statements ("Award amounts vary."). */
const WINDOW_CHARS = 900

/**
 * The registry of known listing pages. `matchHosts` are matched against the
 * row's own URLs; `fetchUrl` is the page actually read — always the registry's
 * canonical live URL, never the row's (a registered host can be dead or
 * WAF-blocked; that is the point).
 *
 * ww5.clevelandstatecc.edu rides here as belt-and-braces for any row migration
 * 159/0163 missed: the host is dead, but its content lives on the portal.
 */
export const LISTING_PAGES = Object.freeze([
  Object.freeze({
    id: 'cscc_scholarship_portal',
    matchHosts: Object.freeze([
      'clevelandstatecc.scholarships.ngwebsolutions.com',
      'ww5.clevelandstatecc.edu',
    ]),
    fetchUrl: 'https://clevelandstatecc.scholarships.ngwebsolutions.com/Scholarships/Search',
  }),
  Object.freeze({
    // MTSU Computer Science awards page (Anya 2026-08-18 amount_recall_miss
    // for graduate_student: Dr. Nancy Wahl / Mack Thweatt / Outstanding
    // Student Award). Verified live 2026-08-18: the department page names
    // those three and states NO per-award figure for them; the S-STEM
    // section further down does ("up to $6000.00 per year") and title
    // anchoring is what keeps that sibling figure off the other awards.
    // Path-prefixed so a HOPE / collegepays row on mtsu.edu is never
    // stolen from the generic page fetch (attempted:true short-circuits).
    id: 'mtsu_cs_scholarships',
    matchHosts: Object.freeze(['www.mtsu.edu', 'mtsu.edu']),
    matchPathPrefixes: Object.freeze(['/csc/scholarships']),
    fetchUrl: 'https://www.mtsu.edu/csc/scholarships/',
  }),
])

/** Title tokens too generic to anchor a section on their own. */
const GENERIC_TITLE_TOKENS = new Set([
  'the', 'of', 'and', 'for', 'a', 'an', 'in',
  'scholarship', 'scholarships', 'grant', 'grants', 'award', 'awards',
  'program', 'programs', 'fund', 'funds',
])

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase()
  } catch {
    return null
  }
}

function pathOf(url) {
  try {
    return new URL(String(url)).pathname.toLowerCase()
  } catch {
    return null
  }
}

function pathMatchesPrefix(pathname, prefix) {
  const raw = String(prefix || '').toLowerCase().trim()
  if (!raw || !pathname) return false
  const normalized = raw.endsWith('/') ? raw.slice(0, -1) : raw
  return pathname === normalized || pathname === `${normalized}/` || pathname.startsWith(`${normalized}/`)
}

/** The registry entry that owns this row, or null. Pure; exported for tests. */
export function findListingPageEntry(row) {
  const urls = [row?.source_url, row?.application_url, row?.evidence_url, row?.url].filter(Boolean)
  if (urls.length === 0) return null
  for (const entry of LISTING_PAGES) {
    const prefixes = Array.isArray(entry.matchPathPrefixes) ? entry.matchPathPrefixes : null
    for (const url of urls) {
      const host = hostOf(url)
      if (!host || !entry.matchHosts.includes(host)) continue
      if (prefixes && prefixes.length > 0) {
        const pathname = pathOf(url)
        if (!pathname || !prefixes.some((p) => pathMatchesPrefix(pathname, p))) continue
      }
      return entry
    }
  }
  return null
}

/** Is this row served by a registered listing page? Pure; exported for tests. */
export function isListingPageRow(row) {
  return findListingPageEntry(row) !== null
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Find the row's own section on the listing page: the first occurrence of the
 * LONGEST title suffix still carrying a distinctive token. Suffixes handle the
 * sponsor-prefixed title shape ("Cleveland State Community College Foundation
 * Scholarships" anchors at the page's "Foundation Scholarships" heading);
 * tokens are joined tolerantly so "Adrienne Emond/Delta Kappa Gamma" matches
 * across its punctuation. An all-generic suffix ("Scholarships") proves
 * nothing and never anchors. Pure; exported for tests.
 *
 * @returns {{ index: number, phrase: string } | null} index into the
 *   whitespace-collapsed text this module extracts from
 */
export function findTitleAnchor(text, title) {
  const tokens = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.length === 0) return null
  for (let start = 0; start < tokens.length; start++) {
    const rest = tokens.slice(start)
    if (rest.length < 2 && start > 0) break
    if (!rest.some((t) => !GENERIC_TITLE_TOKENS.has(t))) break
    const re = new RegExp(rest.map(escapeRe).join('[^a-z0-9]{1,5}'), 'i')
    const m = re.exec(text)
    if (m) return { index: m.index, phrase: m[0] }
  }
  return null
}

/**
 * Extract the row's own answer from its anchored section.
 * Pure; exported for tests.
 */
export function extractAnchoredAmounts(text, title) {
  const collapsed = String(text || '').replace(/\s+/g, ' ')
  const anchor = findTitleAnchor(collapsed, title)
  if (!anchor) return { anchored: false }

  const nearWindow = collapsed.slice(anchor.index, anchor.index + NEAR_NUMERIC_CHARS)
  const near = extractAwardAmountsFromText(nearWindow)
  if (typeof near.amount_min === 'number' || typeof near.amount_max === 'number') {
    return { anchored: true, amounts: near }
  }

  // No figure in the program's own paragraph. A status statement may still sit
  // in the wider section — but NEVER a sibling's number.
  const wide = extractAwardAmountsFromText(collapsed.slice(anchor.index, anchor.index + WINDOW_CHARS))
  if (wide.amount_status === 'varies' || wide.amount_status === 'contact_required') {
    return {
      anchored: true,
      amount_text: wide.amount_text,
      amount_status: wide.amount_status,
    }
  }
  return { anchored: true }
}

/**
 * enrichAmountViaListingPage — the adapter entry point. Contract-compatible
 * with `enrichOpportunityAmountFromSource` (see module header).
 */
export async function enrichAmountViaListingPage(row, deps = {}) {
  const entry = findListingPageEntry(row)
  if (!entry) {
    return { attempted: false, page_read: false, transient: false, found: false, reason: 'not_listing_page' }
  }
  try {
    let fetcher = deps.fetcher
    if (!fetcher) {
      const { makeProductionFetcher } = await import('../crawlerOsService.js')
      fetcher = makeProductionFetcher()
    }
    const res = await fetcher.fetch(entry.fetchUrl)
    if (!res?.ok || !res.body) {
      const code = Number(res?.status ?? NaN)
      // Same classification as the generic page branch: 401/403/429 refuse OUR
      // egress (environment, parked not burned); statusless/5xx/408 are a bad
      // night (transient); other 4xx are stable facts about the listing URL.
      const environment = code === 401 || code === 403 || code === 429
      const transient = environment || !Number.isFinite(code) || code === 408 || code >= 500
      return {
        attempted: true,
        page_read: false,
        transient,
        environment,
        status: res?.status ?? null,
        found: false,
        reason: `listing_fetch_failed:${res?.status ?? res?.error ?? 'unknown'}`,
      }
    }
    const text = htmlToText(res.body, PAGE_TEXT_MAX_CHARS)
    if (text.length < 200) {
      // A WAF interstitial / JS shell — we read nothing about the row.
      return { attempted: true, page_read: false, transient: false, found: false, reason: 'thin_page' }
    }

    const result = extractAnchoredAmounts(text, row?.title)
    if (!result.anchored) {
      // The page is live but does not name this program (a portal only lists
      // OPEN awards). We learned we cannot SEE the row — not that its funder
      // publishes nothing — so this is a stable failure, never a denial.
      return { attempted: true, page_read: false, transient: false, found: false, reason: 'listing_title_not_found' }
    }
    if (result.amounts) {
      return { attempted: true, page_read: true, transient: false, found: true, reason: 'listing_page_anchored', amounts: result.amounts }
    }
    return {
      attempted: true,
      page_read: true,
      transient: false,
      found: false,
      reason: 'no_per_award_amount_in_listing_section',
      amount_text: result.amount_text ?? null,
      amount_status: result.amount_status ?? null,
    }
  } catch (err) {
    // Defence in depth — "never throws", so a throw here is a bug: retryable.
    log.warn(`[listingPageAmountAdapter] failed for "${row?.title ?? '?'}": ${err?.message ?? err}`)
    return { attempted: true, page_read: false, transient: true, found: false, reason: `error:${err?.message ?? 'unknown'}` }
  }
}

export default {
  LISTING_PAGES,
  findListingPageEntry,
  isListingPageRow,
  findTitleAnchor,
  extractAnchoredAmounts,
  enrichAmountViaListingPage,
}
