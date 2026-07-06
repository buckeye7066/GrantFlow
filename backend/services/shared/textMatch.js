/**
 * textMatch — whole-word term matching for need/keyword scans.
 *
 * Plain `text.includes(term)` was the false-positive driver across every
 * need scanner in the product: 'rent' matched "parent"/"current" (→ phantom
 * housing need), 'bus' matched "business" (→ phantom transportation need),
 * 'car' matched "care"/"career", 'aid' matched "said"/"paid", 'ets' matched
 * "targets"/"assets" (→ phantom military-transition need). Because the
 * need-anchored score is needCoverage% × gates, phantom needs both dilute
 * the coverage denominator for real needs AND hand false coverage credit to
 * unrelated opportunities — the same substring-explosion class fixed for
 * applicant types on 2026-07-06 (the 13-bucket Axiom case).
 *
 * `containsTermWholeWord` requires the term to start and end on word
 * boundaries, with a small tolerance for common English suffixes so
 * existing keyword corpora keep their intended recall:
 *   'rent'   → rent, rents, rented, renting, rental   (NOT parent, current)
 *   'self-employ' → self-employed, self-employment
 *   'scholarship' → scholarships
 *
 * Regexes are compiled once per distinct term (module-level cache) so the
 * scoring hot path (candidates × needs × synonyms) stays cheap.
 */

const TERM_REGEX_CACHE = new Map()

// Common suffix continuations tolerated after a term so whole-word matching
// does not lose the plural/participle recall `includes()` had. Deliberately
// short — anything longer ("-ation", "-ity") changes the word's meaning too
// often to trust globally.
const SUFFIX_TOLERANCE = '(?:s|es|ed|ing|ment|al)?'

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compiled whole-word regex for a term (cached). Returns null for terms that
 * cannot anchor a word boundary (empty / punctuation-only).
 */
export function wholeWordTermRegex(term) {
  const raw = String(term ?? '').trim().toLowerCase()
  if (!raw || !/[a-z0-9]/.test(raw)) return null
  let re = TERM_REGEX_CACHE.get(raw)
  if (re === undefined) {
    // Word boundaries only anchor next to word characters; if the term starts
    // or ends with punctuation ("-something"), fall back to lookarounds that
    // reject an adjacent word character.
    const startsWord = /^[a-z0-9]/.test(raw)
    const endsWord = /[a-z0-9]$/.test(raw)
    const prefix = startsWord ? '\\b' : '(?<![a-z0-9])'
    const suffix = endsWord ? `${SUFFIX_TOLERANCE}\\b` : '(?![a-z0-9])'
    re = new RegExp(`${prefix}${escapeRegExp(raw)}${suffix}`, 'i')
    TERM_REGEX_CACHE.set(raw, re)
  }
  return re
}

/**
 * Whole-word (suffix-tolerant) containment test.
 *
 * @param {string} text haystack (any case)
 * @param {string} term needle keyword/phrase (any case)
 * @returns {boolean}
 */
export function containsTermWholeWord(text, term) {
  if (!text) return false
  const re = wholeWordTermRegex(term)
  return re ? re.test(String(text)) : false
}

/**
 * True when any of the terms appears as a whole word in the text.
 */
export function containsAnyTermWholeWord(text, terms) {
  if (!text || !Array.isArray(terms)) return false
  return terms.some((t) => containsTermWholeWord(text, t))
}
