/**
 * awardAmountExtractor.js — conservative PER-AWARD dollar extraction from
 * opportunity text.
 *
 * THE GAP THIS CLOSES (2026-07-05, extended 2026-07-06)
 * -----------------------------------------------------
 * Only ~19% of the funding_opportunities catalog carried amount_min/amount_max,
 * because amounts survived ingest ONLY when a structured source API provided
 * numeric fields — nothing ever read the text ("Scholarships of $2,500",
 * "awards range from $1,000 to $5,000", "up to $10,000") that most web-lane and
 * scraped sources put in title/description. With no amount anywhere, the
 * pipeline-value choke point (backend/config/pipelineValue.js) honestly shows
 * $0 for the row, so profile pipeline totals looked absurdly low.
 *
 * 2026-07-06 extension: even when no per-award NUMBER is knowable, the row
 * should carry the best available TEXT and an explicit status instead of a
 * blank. Every extraction now also yields:
 *   - amount_text        best matched excerpt ("up to $10,000", "amounts vary")
 *   - amount_status      'known' | 'range' | 'estimated' | 'varies' |
 *                        'contact_required' | 'not_listed'
 *   - amount_confidence  0..1 for numeric extractions, null otherwise
 *
 * DESIGN: precision over recall. A wrong dollar figure is worse than none —
 * it inflates pipeline totals and (for individual profiles) can trip the
 * individual-amount-ceiling purge. So:
 *   - Only explicit per-award phrasings match (range / "up to" / "award of" /
 *     "minimum award" / "average award" / "award amount: $X").
 *   - Program-total phrasings are rejected via a look-behind/ahead exclusion
 *     window ("$2 million in scholarships awarded annually" is a program
 *     total, not an award) — but a program-total-only page still preserves
 *     the excerpt as amount_text (status stays 'not_listed': the per-award
 *     figure is genuinely unknown; the text is the honest best-available).
 *   - "average award" figures are stored as status 'estimated' with LOWER
 *     confidence — an average is a real signal, not an entitlement.
 *   - Values outside $100–$10,000,000 are ignored.
 *   - Structured numeric fields from an adapter ALWAYS win; extraction runs
 *     only when both amount_min and amount_max are absent.
 *   - A TUITION-COVERAGE award ("pays tuition", "covers 100% of tuition and
 *     fees") is an explicit per-award semantic with no fixed figure → status
 *     'varies' + the phrase as amount_text, never a fabricated number
 *     (2026-08-03, the NM Lottery/Opportunity Scholarship class).
 */

const MULTIPLIERS = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6 }
const MIN_PLAUSIBLE = 100
const MAX_PLAUSIBLE = 10_000_000

// Confidence per extraction route. Numeric-only; status-only routes carry null.
const CONFIDENCE = Object.freeze({
  structured: 0.95,
  range: 0.9,
  labeled: 0.9,
  up_to: 0.85,
  single: 0.75,
  minimum: 0.7,
  average: 0.6,
})

/**
 * "We have no figure" and "the funder publishes no figure" are DIFFERENT facts,
 * and only a READ can tell them apart.
 *
 * `not_listed` is this extractor's DEFAULT — the value a row carries when
 * nothing has looked yet. It is SILENCE, and silence is not a denial (the same
 * reasoning that stops a re-crawl carrying no amount from clearing one:
 * `opportunityInserter.upsertFundingOpportunity`). So `not_listed` can never
 * license a claim about the source, only about us.
 *
 * `none_published` is the DENIAL: the funder's own page or API was actually
 * read (`page_read`) and states no per-award figure. It is EVIDENCE about the
 * world (G0 — read, never invented), and it is what lets a coverage metric
 * honestly stop counting a row as a miss. Nothing this module produces may
 * ever return it: it is written ONLY by `enforceAmountEnrichment` (the one
 * caller that performs the read), never by an extractor default and never by
 * an ingest. See `pipeline.amountCoverage` in `services/sam/samRegistry.js`.
 *
 * KEEP THESE DISTINCT. Collapsing `none_published` back into `not_listed` (or
 * letting ingest write it) re-opens the defect this exists to close: a row that
 * was never read becomes indistinguishable from one whose funder pays nothing,
 * and a coverage metric built on that conflation measures the world's
 * publishing habits while claiming to measure the crawler.
 */
export const AMOUNT_STATUS_NONE_PUBLISHED = 'none_published'

export const AMOUNT_STATUSES = Object.freeze([
  'known',
  'estimated',
  'range',
  'varies',
  'not_listed',
  'contact_required',
  AMOUNT_STATUS_NONE_PUBLISHED,
])

// "$1,234", "$1,234.56", "$1.5 million", "$10k"
const MONEY = String.raw`\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(k|thousand|m|million)?\b`

const RE_RANGE = new RegExp(
  String.raw`(?:from|between)?\s*${MONEY}\s*(?:to|and|through|[-–—])\s*(?:up\s+to\s+)?${MONEY}`,
  'i',
)
const RE_UP_TO = new RegExp(
  String.raw`\b(?:up\s+to|a\s+maximum\s+of|maximum(?:\s+award)?\s+of|max(?:imum)?\s*:?|as\s+much\s+as|not\s+(?:to\s+)?exceed(?:ing)?)\s*${MONEY}`,
  'i',
)
// Explicitly labeled amount ("award amount: $2,500", "scholarship amount is $1,000").
const RE_LABELED = new RegExp(
  String.raw`\b(?:awards?|scholarships?|grants?|stipends?|reimbursements?)\s+amounts?\s*(?:is|are|:)?\s*${MONEY}`,
  'i',
)
// Floor-only phrasings ("minimum award of $500", "awards start at $1,000").
const RE_MINIMUM = new RegExp(
  String.raw`\b(?:minimum(?:\s+award)?\s+(?:of|:)?|awards?\s+(?:start|begin)\s+at|starting\s+at|at\s+least)\s*${MONEY}`,
  'i',
)
// Average/typical award ("average award of $5,000") — an ESTIMATE, not a ceiling.
const RE_AVERAGE = new RegExp(
  String.raw`\b(?:average|typical|median)\s+(?:(?:award|grant|scholarship|stipend)\s+)?(?:(?:amount|size|value)\s+)?(?:of\s+|is\s+|:\s*)?${MONEY}`,
  'i',
)
// Exact-award phrasings, both orders: "award of $2,500" and "$2,500 scholarship".
const AWARD_NOUN = String.raw`(?:awards?|scholarships?|grants?|prizes?|stipends?|fellowships?|reimbursements?)`
const RE_SINGLE = [
  new RegExp(String.raw`${AWARD_NOUN}\s+(?:of|worth|valued\s+at)\s+${MONEY}`, 'i'),
  new RegExp(String.raw`${MONEY}\s+${AWARD_NOUN}\b`, 'i'),
  new RegExp(String.raw`(?:receive|awarded|win)\s+(?:an?\s+)?${MONEY}`, 'i'),
  new RegExp(String.raw`${MONEY}\s+(?:per|each)\s+(?:year|recipient|student|awardee|winner|semester)`, 'i'),
]

// Status-only phrasings — no dollar figure required.
const RE_VARIES =
  /\b(?:awards?|amounts?|funding|grant\s+amounts?|scholarship\s+amounts?)\s+(?:will\s+)?(?:vary|varies)\b|\bamounts?\s*:\s*varies\b|\bvaries\s+(?:by|depending|based)\b|^\s*varies\.?\s*$/i
const RE_CONTACT =
  /\bcontact\s+(?:the\s+)?(?:funder|foundation|sponsor|program|organization|office)\s+for\s+(?:award|funding|amount|grant)\b|\b(?:amounts?|awards?)\s+(?:are\s+)?(?:available|determined|provided)\s+(?:up)?on\s+request\b/i

// TUITION-COVERAGE awards (the NM Lottery / NM Opportunity Scholarship class,
// Amy `amount_recall_miss:high_school_student`, 2026-08-03). The funder's own
// copy states the award IS tuition coverage — real prod ingest text:
//   "This scholarship pays tuition and is awarded beginning with the second…"
//   "The Lottery Scholarship covers 100% of tuition for recent New Mexico…"
//   "…covers any gap in tuition and allowable fees…, potentially covering up
//    to 100% of tuition and allowable fees."
// That is an EXPLICIT per-award semantic with no fixed dollar figure — the
// value varies by institution and enrolled credit hours — so the honest result
// is status 'varies' with the phrase as amount_text, NEVER a number (inventing
// a dollar figure for "covers tuition" would fabricate exactly the class of
// value the plausibility doctrine exists to prevent). The connector list is a
// closed set on purpose: a coverage verb must reach "tuition" through known
// award phrasing only, so "covers everything except tuition" (arbitrary words
// between) and bare mentions ("eligible for in-state tuition", "help pay for
// college") can never match.
const RE_TUITION_COVERAGE = new RegExp(
  String.raw`\b(?:covers?|covering|pays?|paying|waives?|waiving)\s+`
    + String.raw`(?:(?:any\s+gap\s+in|up\s+to|all(?:\s+of)?|full|remaining|the\s+(?:full\s+)?cost\s+of|a\s+portion\s+of|\d{1,3}\s*(?:%|percent)(?:\s+of)?)\s+)*`
    + String.raw`(?:in-?state\s+|resident\s+)?tuition\b`,
  'i',
)
// A negated coverage claim ("does not cover tuition") is NOT a tuition award.
const RE_TUITION_NEGATION = /\b(?:not|never|no|isn'?t|doesn'?t|don'?t|won'?t|cannot|can'?t|except(?:ing)?|excluding)\s+(?:\w+\s+){0,2}$/i

// "TUITION-FREE" — the Tennessee Promise class (Amy
// `amount_recall_miss:high_school_student`, 2026-08-15). Real prod ingest text:
//   "A scholarship providing two years of tuition-free college for eligible
//    students in Tennessee."
// The coverage-verb rule above cannot reach it (there is no covers/pays/waives
// verb — the adjective IS the claim), yet it is the same explicit per-award
// semantic with no fixed dollar figure, so the honest result is identical:
// status 'varies' + the phrase as amount_text, never a fabricated number. The
// pattern requires the hyphen/space compound ("tuition-free", "tuition free")
// so bare mentions of "tuition" or "free" can never match, and the same
// negation window applies ("is not tuition-free" stays silence).
const RE_TUITION_FREE = /\btuition[-\s]free\b/i

// A dollar figure in these contexts is a PROGRAM total / org financial, never a
// per-award amount. Checked in a window around the match.
// `annual(ly) SCHOLARSHIPS/AWARDS/GRANTS of $X` (note: PLURAL award noun) is a
// program's yearly disbursement total, not a per-award figure — Coca-Cola's page
// leads with "annual scholarships of $3.55 million awarded through the program".
// PLURAL is the discriminator: "an annual scholarship of $5,000" (SINGULAR) is a
// real per-award phrasing and is deliberately NOT matched here.
const RE_EXCLUDE_BEFORE = /(?:total(?:ing|s)?|in\s+total|aggregate|annual(?:ly)?\s+(?:scholarships|awards|grants|stipends|fellowships)|annually\s+(?:awards?|distributes?)|has\s+(?:awarded|distributed|given)|over|more\s+than|assets|revenue|incomes?|sales|budgets?|endowment|raised|available)\s*(?:of|:|is)?\s*$/i
const RE_EXCLUDE_AFTER = /^\s+in\s+(?:total\s+)?(?:funding|grants?|scholarships?|awards?)/i
// Subset of the exclusion contexts that identify a PROGRAM TOTAL specifically
// (worth preserving as amount_text) vs. org financials (assets/revenue — noise).
const RE_PROGRAM_TOTAL_BEFORE = /(?:total(?:ing|s)?|in\s+total|aggregate|annually\s+(?:awards?|distributes?)|total\s+funding\s+available|available)\s*(?:of|:|is)?\s*$/i

// AGGREGATE phrasings: a figure that is "N awards up to $X" or "$X across N
// tiers/recipients annually" is a PROGRAM TOTAL, not a per-award amount, even
// though "up to $X" reads as per-award in isolation.
//
// THE BUG THIS CLOSES (2026-07-17, Coca-Cola Scholars): the page says both
// "receive this $20,000 scholarship" (the real award) and, for a DIFFERENT
// program, "awards 200 stipends (up to $237,500) annually across four tiers"
// (an annual total across 200 recipients). RE_UP_TO matched "$237,500" first
// and returned it, so the pipeline showed a WRONG figure 12× the real award —
// worse than a blank (precision-over-recall doctrine). Excluding the aggregate
// lets the extractor fall through to "$20,000 scholarship" (RE_SINGLE) and
// return the correct per-award figure.
//   - BEFORE: a COUNT of awards precedes the figure ("200 stipends (up to $").
//   - AFTER: the figure is spread across N recipients/tiers or is an annual
//     program sum ("$X annually across four tiers", "$X to 150 recipients").
// Precision guard: both require a NUMBER, so genuine per-award phrasings
// ("up to $10,000 in scholarship support", "$2,500 to each recipient") are
// untouched — they carry no count.
const RE_AGGREGATE_BEFORE =
  /\b\d{1,4}\s+(?:stipends?|awards?|scholarships?|grants?|fellowships?|prizes?|recipients?|winners?|awardees?|scholars?)\b[^$]{0,40}$/i
const RE_AGGREGATE_AFTER =
  /^[^.$]{0,48}?\b(?:annually\s+across|across\s+\d+\s+(?:tiers?|categor|recipients?|programs?|awards?)|to\s+\d+\s+(?:recipients?|students?|winners?|awardees?|scholars?|families|households))/i
// "annual SCHOLARSHIPS of $X" (PLURAL award noun) spans the before/match
// boundary — for a "$X scholarships of" match the award noun is INSIDE the
// matched text, so a before-only window never sees the plural. Checked against
// `before + match`. PLURAL only: "an annual scholarship of $5,000" (singular,
// per-award) is deliberately preserved.
const RE_ANNUAL_PLURAL_TOTAL =
  /\bannual(?:ly)?\s+(?:scholarships|awards|grants|stipends|fellowships)\s+(?:of|worth|valued\s+at)\s*\$/i

function parseMoney(numStr, unit) {
  const base = Number(String(numStr).replace(/,/g, ''))
  if (!Number.isFinite(base)) return null
  const value = base * (MULTIPLIERS[String(unit || '').toLowerCase()] || 1)
  if (value < MIN_PLAUSIBLE || value > MAX_PLAUSIBLE) return null
  return Math.round(value)
}

function excluded(text, matchIndex, matchLength, { checkAfter = false } = {}) {
  const before = text.slice(Math.max(0, matchIndex - 56), matchIndex)
  if (RE_EXCLUDE_BEFORE.test(before)) return true
  // AGGREGATE guard runs for EVERY pattern (not gated on checkAfter): "N awards
  // up to $X" and "$X across N tiers" are program totals no matter which pattern
  // matched the figure — and the costliest miss is exactly RE_UP_TO/RE_RANGE,
  // which do NOT set checkAfter. Both windows require a count, so a bare
  // per-award "up to $10,000 in support" is never caught.
  if (RE_AGGREGATE_BEFORE.test(before)) return true
  const aggAfter = text.slice(matchIndex + matchLength, matchIndex + matchLength + 56)
  if (RE_AGGREGATE_AFTER.test(aggAfter)) return true
  // "annual scholarships of $X" — the plural award noun lives inside the match,
  // so test across the before/match boundary.
  if (RE_ANNUAL_PLURAL_TOTAL.test(before + text.slice(matchIndex, matchIndex + matchLength))) return true
  // The after-window ("$2 million in grants") only disambiguates BARE-verb
  // phrasings ("awarded $X", "receive $X"). Range/"up to" matches are already
  // explicitly per-award — "up to $10,000 in scholarship support" must pass.
  if (!checkAfter) return false
  const after = text.slice(matchIndex + matchLength, matchIndex + matchLength + 32)
  return RE_EXCLUDE_AFTER.test(after)
}

function firstUnexcluded(text, re, opts) {
  const m = re.exec(text)
  if (!m) return null
  if (excluded(text, m.index, m[0].length, opts)) return null
  return m
}

// Best-available excerpt for display: the matched phrase, whitespace-collapsed,
// bounded so a runaway match can never bloat the column.
function excerpt(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, 140) : null
}

// Program-total-only text ("$2 million in scholarships awarded annually",
// "Total funding available: $500,000"): the per-award figure is unknown, but
// the text is worth preserving. Returns the contextual excerpt or null.
function findProgramTotalText(text) {
  const re = new RegExp(MONEY, 'gi')
  let m
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 56), m.index)
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40)
    if (RE_PROGRAM_TOTAL_BEFORE.test(before) || RE_EXCLUDE_AFTER.test(after)) {
      const start = Math.max(0, m.index - 40)
      const end = Math.min(text.length, m.index + m[0].length + 40)
      return excerpt(text.slice(start, end))
    }
  }
  return null
}

function numericResult(min, max, matched, status, matchText) {
  return {
    amount_min: min,
    amount_max: max,
    matched,
    amount_text: excerpt(matchText),
    amount_status: status,
    amount_confidence: CONFIDENCE[matched] ?? null,
  }
}

/**
 * Extract a per-award amount (or range) — or, failing that, the best available
 * amount TEXT + status — from free text.
 * @returns {{ amount_min: number|null, amount_max: number|null, matched: string|null,
 *             amount_text: string|null, amount_status: string, amount_confidence: number|null }}
 */
export function extractAwardAmountsFromText(text) {
  const t = String(text || '')
  const none = {
    amount_min: null,
    amount_max: null,
    matched: null,
    amount_text: null,
    amount_status: 'not_listed',
    amount_confidence: null,
  }

  if (t.includes('$')) {
    const range = firstUnexcluded(t, RE_RANGE)
    if (range) {
      const lo = parseMoney(range[1], range[2])
      const hi = parseMoney(range[3], range[4])
      if (lo !== null && hi !== null && lo < hi) {
        return numericResult(lo, hi, 'range', 'range', range[0])
      }
    }

    const upTo = firstUnexcluded(t, RE_UP_TO)
    if (upTo) {
      const hi = parseMoney(upTo[1], upTo[2])
      if (hi !== null) return numericResult(null, hi, 'up_to', 'range', upTo[0])
    }

    // Labeled amount ("award amount: $2,500") — exact, high confidence.
    const labeled = firstUnexcluded(t, RE_LABELED)
    if (labeled) {
      const v = parseMoney(labeled[1], labeled[2])
      if (v !== null) return numericResult(v, v, 'labeled', 'known', labeled[0])
    }

    // Floor-only ("minimum award of $500") — must run BEFORE RE_SINGLE, whose
    // "award of $X" pattern would otherwise claim it as an exact amount.
    const minOnly = firstUnexcluded(t, RE_MINIMUM)
    if (minOnly) {
      const lo = parseMoney(minOnly[1], minOnly[2])
      if (lo !== null) return numericResult(lo, null, 'minimum', 'range', minOnly[0])
    }

    // Average award — an ESTIMATE. Also must precede RE_SINGLE ("average award
    // of $5,000" contains "award of $5,000").
    const avg = firstUnexcluded(t, RE_AVERAGE)
    if (avg) {
      const v = parseMoney(avg[1], avg[2])
      if (v !== null) return numericResult(v, v, 'average', 'estimated', avg[0])
    }

    for (const re of RE_SINGLE) {
      const single = firstUnexcluded(t, re, { checkAfter: true })
      if (single) {
        const v = parseMoney(single[1], single[2])
        if (v !== null) return numericResult(v, v, 'single', 'known', single[0])
      }
    }
  }

  // No per-award number. Preserve the best available signal instead of blank.
  const varies = RE_VARIES.exec(t)
  if (varies) {
    return { ...none, amount_text: excerpt(varies[0]), amount_status: 'varies' }
  }
  const contact = RE_CONTACT.exec(t)
  if (contact) {
    return { ...none, amount_text: excerpt(contact[0]), amount_status: 'contact_required' }
  }
  // Tuition-coverage: an explicit per-award semantic whose dollar value varies
  // by institution — a real answer, not silence. Status only; never a number.
  const tuition = RE_TUITION_COVERAGE.exec(t)
  if (tuition && !RE_TUITION_NEGATION.test(t.slice(Math.max(0, tuition.index - 40), tuition.index))) {
    return { ...none, amount_text: excerpt(tuition[0]), amount_status: 'varies' }
  }
  // "tuition-free" is the same per-award semantic stated as an adjective
  // (Tennessee Promise: "two years of tuition-free college").
  const tuitionFree = RE_TUITION_FREE.exec(t)
  if (tuitionFree && !RE_TUITION_NEGATION.test(t.slice(Math.max(0, tuitionFree.index - 40), tuitionFree.index))) {
    return { ...none, amount_text: excerpt(tuitionFree[0]), amount_status: 'varies' }
  }
  if (t.includes('$')) {
    const totalText = findProgramTotalText(t)
    if (totalText) return { ...none, amount_text: totalText }
  }
  return none
}

// Source shapes whose structured numbers come from an OFFICIAL feed (grants.gov
// / sam.gov / agency APIs). Official per-award ceilings can legitimately be
// enormous (state DOT infrastructure awards), so the plausibility window below
// never second-guesses them. Everything else (web_search / LLM-extracted /
// aggregator rows) gets the same window text extraction already obeys.
const RE_OFFICIAL_SOURCE = /^(grants[._]?gov|sam[._]?gov|sbir[._]?gov|federal[._]?register|usaspending|simpler[._]?grants|nih|nsf|usda(_rd)?|fema(_afg)?|hud|hrsa|ed[._]?gov|doe|dot|epa|imls)$/i

export function isOfficialAmountSource(opportunity) {
  const tier = String(opportunity?.source_trust_tier ?? opportunity?.trust_tier ?? '').toLowerCase()
  if (tier.includes('official')) return true
  return RE_OFFICIAL_SOURCE.test(String(opportunity?.source ?? '').trim())
}

/** Plausibility window bounds, exported for the boot-sweep net. */
export const AMOUNT_MIN_PLAUSIBLE = MIN_PLAUSIBLE
export const AMOUNT_MAX_PLAUSIBLE = MAX_PLAUSIBLE

/**
 * Confidence for a figure taken from a source's OWN structured fields — the
 * value this module already assigns such amounts in resolveOpportunityAmounts.
 *
 * Exported so the API adapters (services/sources/*) persist the SAME numeric
 * scale rather than inventing one. `amount_confidence` is a REAL column: an
 * adapter that returned the string 'high' typechecked fine, passed every
 * (SQLite, typeless) unit test, and then threw `invalid input syntax for type
 * real: "high"` against Postgres in prod — where the sweep had ALREADY marked
 * the row attempted, so the row was burned and the write it was burned for
 * never happened.
 */
export const AMOUNT_CONFIDENCE_STRUCTURED = CONFIDENCE.structured

function formatUsd(n) {
  return `$${Number(n).toLocaleString('en-US')}`
}

/**
 * Resolve an opportunity's amount fields for persistence: structured numeric
 * fields win; text extraction (title + amount_description + description)
 * fills in ONLY when both are absent. Always yields amount_status (+ text /
 * confidence when knowable) so no row is left blank when something is known.
 *
 * PLAUSIBILITY GUARD (2026-07-06): structured numbers used to be trusted
 * unconditionally, so a web/LLM-extracted row could carry a federal PROGRAM
 * APPROPRIATION as its per-award ceiling — HUD Section 4's $42,000,000 landed
 * in amount_max off an aggregator page, was defaulted into amount_requested,
 * and single-handedly fabricated ~99% of two org pipelines' dollar value.
 * Untrusted-source structured amounts outside the same window text extraction
 * obeys ($100–$10M) are now demoted to TEXT: the figure is preserved as the
 * honest best-available excerpt, but no numeric per-award claim is made
 * (per-award figure genuinely unknown → status 'not_listed').
 */
export function resolveOpportunityAmounts(opportunity) {
  // A structured 0 (or negative) is NOT a per-award figure — it is an
  // extraction artifact meaning "no amount", and treating it as a number
  // short-circuits text extraction entirely (`typeof 0 === 'number'`), so a
  // row whose own description states a real per-award semantic never gets
  // read. Live class (Amy `amount_recall_miss:high_school_student`,
  // 2026-08-03): prod NM Opportunity Scholarship rows carried
  // `amount_min: 0` beside "covers 100% of tuition and course-specific fees"
  // — the structured branch demoted the zero to "$0 (program funding level)"
  // text and the tuition-coverage phrasing was never consulted. Non-positive
  // structured values are treated as ABSENT so extraction can run; a genuine
  // floor of $0 carries no information a null does not.
  const structuredMin =
    typeof opportunity?.amount_min === 'number' && opportunity.amount_min > 0
      ? opportunity.amount_min
      : null
  const structuredMax =
    typeof opportunity?.amount_max === 'number' && opportunity.amount_max > 0
      ? opportunity.amount_max
      : null
  if (structuredMin !== null || structuredMax !== null) {
    const ceiling = structuredMax ?? structuredMin
    const floor = structuredMin ?? structuredMax
    const implausible = ceiling > MAX_PLAUSIBLE || floor > MAX_PLAUSIBLE || ceiling < MIN_PLAUSIBLE
    if (implausible && !isOfficialAmountSource(opportunity)) {
      const rangeText =
        structuredMin !== null && structuredMax !== null && structuredMin !== structuredMax
          ? `${formatUsd(structuredMin)} – ${formatUsd(structuredMax)} (program funding level)`
          : `${formatUsd(ceiling)} (program funding level)`
      return {
        amount_min: null,
        amount_max: null,
        extracted: false,
        amount_text: rangeText,
        amount_status: 'not_listed',
        amount_confidence: null,
      }
    }
    const status =
      structuredMin !== null && structuredMax !== null && structuredMin === structuredMax
        ? 'known'
        : 'range'
    return {
      amount_min: structuredMin,
      amount_max: structuredMax,
      extracted: false,
      amount_text: null,
      amount_status: status,
      amount_confidence: CONFIDENCE.structured,
    }
  }
  const text = [opportunity?.title, opportunity?.amount_description, opportunity?.description]
    .filter(Boolean)
    .join(' \n ')
  const result = extractAwardAmountsFromText(text)
  // A short human amount_description ("Varies", "Contact funder") is the best
  // display text when extraction found nothing better.
  if (!result.amount_text && opportunity?.amount_description) {
    const desc = excerpt(opportunity.amount_description)
    if (desc && desc.length <= 80) {
      result.amount_text = desc
      if (result.amount_status === 'not_listed') {
        if (/\bvar(?:y|ies)\b/i.test(desc)) result.amount_status = 'varies'
        else if (/\bcontact\b/i.test(desc)) result.amount_status = 'contact_required'
      }
    }
  }
  return {
    amount_min: result.amount_min,
    amount_max: result.amount_max,
    extracted: result.matched !== null,
    amount_text: result.amount_text,
    amount_status: result.amount_status,
    amount_confidence: result.amount_confidence,
  }
}

export default { extractAwardAmountsFromText, resolveOpportunityAmounts, AMOUNT_STATUSES }
