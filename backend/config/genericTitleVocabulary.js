// backend/config/genericTitleVocabulary.js
//
// THE generic-title vocabulary — one registry, two consumers.
//
// A "generic" title names no concrete program, just a way to look for one
// ("funding finder", "list of grants", "search portal"). Such a row can be a
// useful pointer, but it is not a strong match for a SPECIFIC profile.
//
// This list previously existed TWICE, drifted:
//   - amyReport.js  GENERIC_TITLE_RX   (the detector that FLAGS false positives)
//   - profileSpecificGate.js GENERIC_ONLY_RE (the gate that REJECTS them)
// They shared 4 of ~12 terms, and the gate is only reachable from the pipeline
// path — never from crawler-os discovery, which is what Amy actually measures.
// So Amy reported "generic result ACCEPTED" for phrasings no gate could ever
// catch, and the finding was unactionable by construction. Per CLAUDE.md's
// enumerable-inventory rule, the set now lives in ONE place with a totality
// test binding both consumers.
//
// Pure, no I/O. Phrases are LITERAL text, never regex source: they are escaped
// before compilation so an owner-approved addition can never inject a pattern
// (or a catastrophic backtrack) into the matcher.

/**
 * Baseline vocabulary: the union of the two drifted lists, deduped.
 * Every phrase must be generic in ANY context — a word that is generic for one
 * profile but concrete for another (e.g. "housing") does NOT belong here.
 */
export const GENERIC_TITLE_PHRASES = Object.freeze([
  // — from both lists —
  'funding finder',
  'benefit finder',
  'grant search',
  'search portal',
  // — detector-only (amyReport) —
  'directory',
  'resource guide',
  'resource center',
  'resource finder',
  'general funding',
  'general assistance',
  'find funding',
  'find grants',
  'find help',
  'list of',
  'database of',
  'portal',
  // — gate-only (profileSpecificGate) —
  'general funding support',
  'resource directory',
  'service directory',
  'funding opportunities',
])

/**
 * Owner-approved ADDITIONS (Amy's `relevance_precision` lever). Additive only —
 * a baseline phrase can never be removed by an override, so this lever can only
 * ever tighten precision, never loosen a guard that already holds.
 */
let _additions = []

/** Live merged vocabulary + its compiled matcher (rebuilt on every set). */
let _live = [...GENERIC_TITLE_PHRASES]
let _rx = compile(_live)

function escapeLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compile(phrases) {
  const alts = phrases
    .map((p) => String(p ?? '').trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length) // longest-first so "resource directory" wins over "directory"
    .map(escapeLiteral)
    .join('|')
  return alts ? new RegExp(`\\b(?:${alts})\\b`, 'i') : null
}

/** Normalize + validate a proposed additions list. Returns the accepted list. */
export function sanitizeGenericTitleAdditions(list, { maxPhrases = 40, maxLength = 60 } = {}) {
  if (!Array.isArray(list)) return []
  const baseline = new Set(GENERIC_TITLE_PHRASES)
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const p = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
    // A phrase must be real words, long enough to be meaningful, and not a
    // single short token that would swallow legitimate titles ("aid", "fund").
    if (p.length < 4 || p.length > maxLength) continue
    if (!/^[a-z0-9][a-z0-9 &'/-]*$/.test(p)) continue
    if (baseline.has(p) || seen.has(p)) continue
    seen.add(p)
    out.push(p)
    if (out.length >= maxPhrases) break
  }
  return out
}

export function getGenericTitleAdditions() {
  return [..._additions]
}

/** Replace the additions (additive over the frozen baseline) and recompile. */
export function setGenericTitleAdditions(list) {
  _additions = sanitizeGenericTitleAdditions(list)
  _live = [...GENERIC_TITLE_PHRASES, ..._additions]
  _rx = compile(_live)
  return [..._additions]
}

/** The full live vocabulary (baseline + approved additions). */
export function getGenericTitlePhrases() {
  return [..._live]
}

/**
 * Is this title generic — i.e. does it name a way to LOOK for funding rather
 * than a specific program? The single predicate both the engine's ACCEPT cap
 * and Amy's false-positive detector must use.
 */
export function isGenericTitle(title) {
  const t = String(title ?? '')
  if (!t) return false
  return _rx ? _rx.test(t) : false
}

/**
 * Concrete need/program words that prove a row is about a SPECIFIC thing even
 * though its title also carries a generic word ("Cancer Resource Directory" is
 * a cancer row). Mirrors the profileSpecificGate carve-out so the engine cap
 * and the gate agree on what rescues a generically-titled row.
 */
const CONCRETE_RE =
  /\b(fafsa|pell|scholarship|tuition|rent|housing|utility|food|medical|business|veteran|disability|farm|classroom|student aid|cancer|dementia|alzheimer|transportation|hearing|deaf|apnea|assistive)\b/i

/** True when the row is generic AND has no concrete anchor to rescue it. */
export function isGenericOnly(text) {
  const t = String(text ?? '')
  if (!t) return false
  return isGenericTitle(t) && !CONCRETE_RE.test(t)
}

export default {
  GENERIC_TITLE_PHRASES,
  getGenericTitlePhrases,
  getGenericTitleAdditions,
  setGenericTitleAdditions,
  sanitizeGenericTitleAdditions,
  isGenericTitle,
  isGenericOnly,
}
