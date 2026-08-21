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

/**
 * LATIN-1 SUPPLEMENT LETTERS — the accented-letter half of the registry,
 * generated from one table so a gap cannot open one letter at a time.
 *
 * WHY (owner report 2026-08-21): a stored title read
 * `Improving global health security in C&ocirc;te d'Ivoire through
 * collaboration with local partners`. The row DID pass through the ingest
 * choke point; `ocirc` was simply absent from the hand-typed registry, which
 * held `eacute/egrave/agrave/ccedil/ntilde/uuml/ouml/auml` and none of the
 * circumflex, ring, slash, ligature, acute-vowel or thorn forms. Per the
 * module's own policy an unknown entity is left VERBATIM, so the defect is a
 * REGISTRY GAP that renders as raw markup to the owner — a hand-typed list of
 * a closed, finite character block is the wrong shape for the job.
 *
 * Case is significant here (`&Ocirc;` is `Ô`, not `ô`), so the decoder tries an
 * EXACT match before falling back to the lower-cased lookup the punctuation
 * entities rely on.
 */
const LATIN1_LETTER_ENTITIES = (() => {
  const out = {}
  const vowelBases = { a: 'a', e: 'e', i: 'i', o: 'o', u: 'u', y: 'y' }
  const accents = { grave: '̀', acute: '́', circ: '̂', tilde: '̃', uml: '̈', ring: '̊' }
  const supported = {
    grave: ['a', 'e', 'i', 'o', 'u'],
    acute: ['a', 'e', 'i', 'o', 'u', 'y'],
    circ: ['a', 'e', 'i', 'o', 'u'],
    tilde: ['a', 'n', 'o'],
    uml: ['a', 'e', 'i', 'o', 'u', 'y'],
    ring: ['a'],
  }
  for (const [accent, mark] of Object.entries(accents)) {
    for (const letter of supported[accent]) {
      const base = vowelBases[letter] ?? letter
      out[`${base}${accent}`] = `${base}${mark}`.normalize('NFC')
      out[`${base.toUpperCase()}${accent}`] = `${base.toUpperCase()}${mark}`.normalize('NFC')
    }
  }
  Object.assign(out, {
    ccedil: 'ç', Ccedil: 'Ç',
    ntilde: 'ñ', Ntilde: 'Ñ',
    oslash: 'ø', Oslash: 'Ø',
    aelig: 'æ', AElig: 'Æ',
    oelig: 'œ', OElig: 'Œ',
    szlig: 'ß',
    thorn: 'þ', THORN: 'Þ',
    eth: 'ð', ETH: 'Ð',
    scaron: 'š', Scaron: 'Š',
    yuml: 'ÿ', Yuml: 'Ÿ',
  })
  return out
})()

const NAMED_ENTITIES = Object.freeze({
  ...LATIN1_LETTER_ENTITIES,
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
      // EXACT first (case carries meaning for letters: `&Ocirc;` is `Ô`), then
      // the lower-cased fallback the punctuation entities have always used.
      const exact = Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : undefined
      if (exact !== undefined) return exact
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
// eslint-disable-next-line no-control-regex -- the control range IS the target
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

const SCRIPT_OR_STYLE_RX = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const TAG_RX = /<[^>]+>/g
const MAX_STRIP_PASSES = 5

/**
 * Convert untrusted HTML (crawled/scraped page bodies, remote portal content)
 * to plain text for downstream parsing/LLM input — NOT for re-rendering as
 * HTML. Two defects a naive single-pass `.replace(/<[^>]+>/g, ' ')` has:
 *
 * 1. bad-tag-filter (nested reconstitution): removing an INNER `<script>`
 *    match can leave behind fragments that reassemble into a live tag, e.g.
 *    `<scr<script></script>ipt>alert(1)</scr<script></script>ipt>` — a single
 *    pass removes the two empty `<script></script>` pairs and leaves a live
 *    `<script>alert(1)</script>` that was never itself matched. Looping the
 *    removal until a pass changes nothing closes that reconstitution gap.
 * 2. double-escaping: decoding HTML entities AFTER stripping tags lets inert
 *    encoded text ("&lt;script&gt;") come back out as a live tag the strip
 *    step already ran past. Decoding first (via decodeHtmlEntities, which is
 *    itself bounded) and stripping the decoded text second closes that gap.
 *
 * Non-strings pass through as ''.
 */
export function stripHtmlToPlainText(value) {
  if (typeof value !== 'string' || !value) return ''
  let text = decodeHtmlEntities(value)
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass += 1) {
    const next = text.replace(SCRIPT_OR_STYLE_RX, ' ')
    if (next === text) break
    text = next
  }
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass += 1) {
    const next = text.replace(TAG_RX, ' ')
    if (next === text) break
    text = next
  }
  return text.replace(CONTROL_RX, ' ').replace(/\s+/g, ' ').trim()
}

export default { decodeHtmlEntities, cleanExtractedText, stripHtmlToPlainText }
