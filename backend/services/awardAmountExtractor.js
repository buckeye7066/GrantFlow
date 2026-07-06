/**
 * awardAmountExtractor.js — conservative PER-AWARD dollar extraction from
 * opportunity text.
 *
 * THE GAP THIS CLOSES (2026-07-05)
 * --------------------------------
 * Only ~19% of the funding_opportunities catalog carried amount_min/amount_max,
 * because amounts survived ingest ONLY when a structured source API provided
 * numeric fields — nothing ever read the text ("Scholarships of $2,500",
 * "awards range from $1,000 to $5,000", "up to $10,000") that most web-lane and
 * scraped sources put in title/description. With no amount anywhere, the
 * pipeline-value choke point (backend/config/pipelineValue.js) honestly shows
 * $0 for the row, so profile pipeline totals looked absurdly low.
 *
 * DESIGN: precision over recall. A wrong dollar figure is worse than none —
 * it inflates pipeline totals and (for individual profiles) can trip the
 * individual-amount-ceiling purge. So:
 *   - Only explicit per-award phrasings match (range / "up to" / "award of").
 *   - Program-total phrasings are rejected via a look-behind/ahead exclusion
 *     window ("$2 million in scholarships awarded annually" is a program
 *     total, not an award).
 *   - Values outside $100–$10,000,000 are ignored.
 *   - Structured numeric fields from an adapter ALWAYS win; extraction runs
 *     only when both amount_min and amount_max are absent.
 */

const MULTIPLIERS = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6 }
const MIN_PLAUSIBLE = 100
const MAX_PLAUSIBLE = 10_000_000

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
// Exact-award phrasings, both orders: "award of $2,500" and "$2,500 scholarship".
const AWARD_NOUN = String.raw`(?:awards?|scholarships?|grants?|prizes?|stipends?|fellowships?)`
const RE_SINGLE = [
  new RegExp(String.raw`${AWARD_NOUN}\s+(?:of|worth|valued\s+at)\s+${MONEY}`, 'i'),
  new RegExp(String.raw`${MONEY}\s+${AWARD_NOUN}\b`, 'i'),
  new RegExp(String.raw`(?:receive|awarded|win)\s+(?:an?\s+)?${MONEY}`, 'i'),
  new RegExp(String.raw`${MONEY}\s+(?:per|each)\s+(?:year|recipient|student|awardee|winner|semester)`, 'i'),
]

// A dollar figure in these contexts is a PROGRAM total / org financial, never a
// per-award amount. Checked in a window around the match.
const RE_EXCLUDE_BEFORE = /(?:total(?:ing|s)?|in\s+total|aggregate|annually\s+(?:awards?|distributes?)|has\s+(?:awarded|distributed|given)|over|more\s+than|assets|revenue|budget|endowment|raised)\s*(?:of|:)?\s*$/i
const RE_EXCLUDE_AFTER = /^\s+in\s+(?:total\s+)?(?:funding|grants?|scholarships?|awards?)/i

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

/**
 * Extract a per-award amount (or range) from free text.
 * @returns {{ amount_min: number|null, amount_max: number|null, matched: string|null }}
 */
export function extractAwardAmountsFromText(text) {
  const none = { amount_min: null, amount_max: null, matched: null }
  const t = String(text || '')
  if (!t.includes('$')) return none

  const range = firstUnexcluded(t, RE_RANGE)
  if (range) {
    const lo = parseMoney(range[1], range[2])
    const hi = parseMoney(range[3], range[4])
    if (lo !== null && hi !== null && lo < hi) {
      return { amount_min: lo, amount_max: hi, matched: 'range' }
    }
  }

  const upTo = firstUnexcluded(t, RE_UP_TO)
  if (upTo) {
    const hi = parseMoney(upTo[1], upTo[2])
    if (hi !== null) return { amount_min: null, amount_max: hi, matched: 'up_to' }
  }

  for (const re of RE_SINGLE) {
    const single = firstUnexcluded(t, re, { checkAfter: true })
    if (single) {
      const v = parseMoney(single[1], single[2])
      if (v !== null) return { amount_min: v, amount_max: v, matched: 'single' }
    }
  }
  return none
}

/**
 * Resolve an opportunity's amount_min/amount_max for persistence: structured
 * numeric fields ALWAYS win; text extraction (title + amount_description +
 * description) fills in ONLY when both are absent.
 */
export function resolveOpportunityAmounts(opportunity) {
  const structuredMin = typeof opportunity?.amount_min === 'number' ? opportunity.amount_min : null
  const structuredMax = typeof opportunity?.amount_max === 'number' ? opportunity.amount_max : null
  if (structuredMin !== null || structuredMax !== null) {
    return { amount_min: structuredMin, amount_max: structuredMax, extracted: false }
  }
  const text = [opportunity?.title, opportunity?.amount_description, opportunity?.description]
    .filter(Boolean)
    .join(' \n ')
  const { amount_min, amount_max, matched } = extractAwardAmountsFromText(text)
  return { amount_min, amount_max, extracted: matched !== null }
}

export default { extractAwardAmountsFromText, resolveOpportunityAmounts }
