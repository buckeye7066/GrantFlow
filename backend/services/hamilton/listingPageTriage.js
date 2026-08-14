/**
 * listingPageTriage.js — task-time page triage for Hamilton Autopilot.
 *
 * OWNER DIRECTIVE (2026-08-03): "If the discovery is a page for scholarships,
 * which several are, give Hamilton the ability to apply for whatever ones are
 * on that page that are relevant and applicable to the profile. Give his brain
 * the ability to decipher what is junk and what can be used … It would be a
 * shame to turn down a funding source because it is listed as one of several
 * on a page. … At the same time, he should be able to recognize junk."
 *
 * THE MEASURED FAILURE SHAPE (prod autopilot fleet, 2026-08-03, ~210 tasks on
 * profiles c4a92724/6b3c75ec): navigate → inspect finds field_count 0-2,
 * button_options [] → fill 0 → "no advance button found" → completed_draft or
 * no_progress with nothing done. The targets split into two classes the engine
 * could not tell apart:
 *   - LISTING pages full of REAL awards (bold.org/scholarships/category/housing,
 *     scholarships.com category pages, fastweb, scholarshipowl, the NGWeb
 *     /Scholarships/Search catalog with 557 items) — money the profile could
 *     actually pursue, one hop away;
 *   - finder/info pages with NO application surface at all
 *     (communityactionpartnership.com/find-a-cap, dol.gov WIOA,
 *     ed.gov state-contacts, offcampushousing listings).
 * Both previously dead-ended the same way; a LISTING must instead decompose
 * into per-award candidates (listingDecomposition.js) and a no-surface page
 * must terminate honestly instead of retrying forever.
 *
 * DESIGN RULES:
 *   - Deterministic signals FIRST (field count, award-link density, listing
 *     URL/title shape, award-phrase text density). The LLM is used only later,
 *     for ITEM ENUMERATION (llmPageExtract.extractListingAwardItems), never to
 *     decide the surface class.
 *   - Pure module: no Playwright, no DB, no network. The engine collects the
 *     snapshot; this module classifies it. Unit-testable against the real
 *     page shapes from tonight's traces.
 *   - Conservative about FORM: triage only runs where the engine has already
 *     hit a dead end (no fillable path / nothing filled), so a real
 *     multi-step form that starts sparse keeps its existing flow untouched.
 *
 * NGWeb trap baked in (measured on the real MTSU catalog snapshot): the
 * 557-item /Scholarships/Search page carries ~323k chars of award TEXT but
 * only FIVE anchors — items are text rows, not links. Link density alone
 * misses it; the text-density signal is what catches it.
 */

import { isListingSurface } from './portalSync/llmPageExtract.js'

/** A real application form has at least this many fillable fields. Tonight's
 * listing/finder traces all showed field_count 0-2 (a search box + filter). */
export const MIN_FORM_FIELDS = 3

/** Minimum award-shaped links for a page to classify LISTING on links alone. */
export const MIN_LISTING_LINKS = 5

/** With a listing-shaped URL/title, this many award links corroborate LISTING. */
export const MIN_LISTING_LINKS_WITH_URL = 2

/** Minimum award-phrase occurrences in page text for the NGWeb-style
 * text-rows-not-links catalog to classify LISTING (requires the listing
 * URL/title shape too — text density alone is a coincidence magnet on long
 * informational pages that merely discuss scholarships). */
export const MIN_AWARD_PHRASES_WITH_URL = 25

/** Link text that names an individual award (not navigation chrome). */
const AWARD_LINK_TEXT_RX = /\b(scholarship|fellowship|grant|award|bursary)s?\b/i

/** Link text that is navigation/marketing chrome, never an award item. The
 * "scholarship(s) search/directory/database" clause drops the catalog's own
 * self-link (e.g. NGWeb's "Scholarships Search" nav anchor), which otherwise
 * slips past the award-noun test as a false per-item link. */
const NAV_LINK_TEXT_RX = /^(home|about( us)?|contact( us)?|log ?in|sign ?(in|up)|register|apply now|search|browse|next|previous|back|more|see all|view all|faq|help|privacy|terms|donate|blog|news|scholarships?\s+(search|directory|database|finder|list(ings?)?))$/i

/** Award-phrase occurrences in text (bounded scan — the NGWeb catalog is 323k chars).
 *
 * The `s?` is load-bearing and was MISSING here while its sibling
 * AWARD_LINK_TEXT_RX above has always carried it. Without it the trailing `\b`
 * fails against the `s` in "Scholarships", so every PLURAL occurrence was
 * invisible to countAwardPhrases — and this text-density count is the ONLY
 * signal that catches the NGWeb-class catalog this module exists for (557 text
 * rows behind 5 nav anchors, per the file header). Scored against a hard
 * MIN_AWARD_PHRASES_WITH_URL = 25 bar, a category page that writes
 * "…Scholarships" in its headings and row labels could undercount straight past
 * the threshold and be classified NO_APPLICATION_SURFACE — the exact dead-end
 * listing decomposition was built to eliminate. */
const AWARD_PHRASE_RX = /\b(scholarship|fellowship|grant|award|bursary)s?\b/gi
const MAX_TEXT_SCAN = 200_000

export const PAGE_SURFACES = Object.freeze({
  FORM: 'FORM',
  LISTING: 'LISTING',
  NO_APPLICATION_SURFACE: 'NO_APPLICATION_SURFACE',
})

/**
 * Links on the page that plausibly point at an individual award. Chrome and
 * bare-category links are excluded; dedup by href.
 *
 * @param {Array<{href?:string, text?:string}>} links
 * @returns {Array<{href:string, text:string}>}
 */
export function awardShapedLinks(links) {
  const out = []
  const seen = new Set()
  for (const l of Array.isArray(links) ? links : []) {
    const href = String(l?.href || '').trim()
    const text = String(l?.text || '').trim()
    if (!href || !text) continue
    if (!/^https?:/i.test(href)) continue
    if (NAV_LINK_TEXT_RX.test(text)) continue
    // An award item link names the award (or at least the award noun with
    // qualifiers). A bare "$2,000" card link also counts.
    if (!AWARD_LINK_TEXT_RX.test(text) && !/\$\s?[\d,]{3,}/.test(text)) continue
    // Too-short texts ("Grants") are category nav, not an item.
    if (text.length < 12 && !/\$/.test(text)) continue
    if (seen.has(href)) continue
    seen.add(href)
    out.push({ href, text: text.slice(0, 200) })
  }
  return out
}

/** Count award-noun occurrences in the page text, bounded. */
export function countAwardPhrases(text) {
  const t = String(text || '').slice(0, MAX_TEXT_SCAN)
  const m = t.match(AWARD_PHRASE_RX)
  return m ? m.length : 0
}

/**
 * Classify a rendered page the engine could not fill.
 *
 * @param {object} snapshot
 * @param {string|null} snapshot.url
 * @param {string|null} snapshot.title
 * @param {number} snapshot.fieldCount       visible fillable fields (engine's detectFields)
 * @param {Array<{href:string,text:string}>} snapshot.links  visible anchors (capped upstream)
 * @param {string} [snapshot.text]           visible page text (capped upstream)
 * @returns {{ surface: string, signals: string[], award_links: Array<{href:string,text:string}> }}
 */
export function triagePage({ url = null, title = null, fieldCount = 0, links = [], text = '' } = {}) {
  const signals = []
  const awardLinks = awardShapedLinks(links)
  const fields = Number(fieldCount) || 0

  if (fields >= MIN_FORM_FIELDS) {
    signals.push(`field_count:${fields}>=${MIN_FORM_FIELDS}`)
    return { surface: PAGE_SURFACES.FORM, signals, award_links: awardLinks }
  }

  const listingShaped = isListingSurface(url, title)
  if (listingShaped) signals.push('listing_url_or_title')

  if (awardLinks.length >= MIN_LISTING_LINKS) {
    signals.push(`award_links:${awardLinks.length}>=${MIN_LISTING_LINKS}`)
    return { surface: PAGE_SURFACES.LISTING, signals, award_links: awardLinks }
  }
  if (listingShaped && awardLinks.length >= MIN_LISTING_LINKS_WITH_URL) {
    signals.push(`award_links:${awardLinks.length}>=${MIN_LISTING_LINKS_WITH_URL}`)
    return { surface: PAGE_SURFACES.LISTING, signals, award_links: awardLinks }
  }
  if (listingShaped) {
    // NGWeb-style catalog: hundreds of award TEXT rows, almost no anchors.
    const phrases = countAwardPhrases(text)
    if (phrases >= MIN_AWARD_PHRASES_WITH_URL) {
      signals.push(`award_phrases:${phrases}>=${MIN_AWARD_PHRASES_WITH_URL}`)
      return { surface: PAGE_SURFACES.LISTING, signals, award_links: awardLinks }
    }
  }

  signals.push(`field_count:${fields}`, `award_links:${awardLinks.length}`)
  return { surface: PAGE_SURFACES.NO_APPLICATION_SURFACE, signals, award_links: awardLinks }
}

export const _internal = {
  AWARD_LINK_TEXT_RX, NAV_LINK_TEXT_RX, AWARD_PHRASE_RX, MAX_TEXT_SCAN,
}

export default { triagePage, awardShapedLinks, countAwardPhrases, PAGE_SURFACES, MIN_FORM_FIELDS }
