/**
 * htmlTextHygiene.js — decode HTML entities + normalize whitespace in
 * crawler-extracted text.
 *
 * WHY (owner QA pass, 2026-08-03): titles surfaced to the owner still carried
 * raw entities from aggregator feeds — "Research &amp; Development", "2024
 * &ndash; 2025 Program", "Community&nbsp;Grants" — because no ingest choke
 * point ever decoded them. The fix lives in ONE util consumed by BOTH the
 * ingest choke point (`opportunityInserter.upsertFundingOpportunity`) and the
 * owner-facing read paths (funding-sources route, item search), so rows already
 * persisted with entities render clean without waiting for a re-crawl.
 *
 * Deliberately dependency-free and conservative: named entities are a fixed
 * registry (the ones real feeds emit), numeric entities are decoded by code
 * point. Unknown entities are left verbatim — mangling text is worse than
 * showing an entity.
 */

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  ntilde: 'ñ',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  copy: '©',
  reg: '®',
  trade: '™',
  sect: '§',
  para: '¶',
  middot: '·',
  bull: '•',
  deg: '°',
  frac12: '½',
  frac14: '¼',
  times: '×',
  cent: '¢',
  pound: '£',
  euro: '€',
})

const ENTITY_RX = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,30});/g

/**
 * Decode HTML entities in a string. Double-encoded text ("&amp;ndash;") is
 * decoded twice (bounded — real feeds double-encode at most once, and the loop
 * stops as soon as a pass changes nothing).
 */
export function decodeHtmlEntities(value) {
  if (typeof value !== 'string' || value.indexOf('&') === -1) return value
  let out = value
  for (let pass = 0; pass < 2; pass += 1) {
    const next = out.replace(ENTITY_RX, (whole, body) => {
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X'
        const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
        try {
          return String.fromCodePoint(code)
        } catch {
          return whole
        }
      }
      const named = NAMED_ENTITIES[body.toLowerCase()]
      return named !== undefined ? named : whole
    })
    if (next === out) break
    out = next
  }
  return out
}

// Control characters (C0 minus tab/newline handling — whitespace collapse
// swallows tabs/newlines anyway) + DEL. Built via RegExp constructor so no raw
// control bytes ever sit in this source file (they got mangled once already).
const CONTROL_RX = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g')

/**
 * Owner-facing text hygiene: decode entities, strip control chars, collapse
 * whitespace runs, trim. Non-strings (incl. null/undefined) pass through
 * untouched — silence is not a value.
 */
export function cleanExtractedText(value) {
  if (typeof value !== 'string') return value
  return decodeHtmlEntities(value)
    .replace(CONTROL_RX, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export default { decodeHtmlEntities, cleanExtractedText }
