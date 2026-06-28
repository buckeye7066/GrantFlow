/**
 * nameParsing.js  (shared — imported by both backend and frontend)
 *
 * "Parse, baby, parse." A single source of truth for turning a single
 * `full_name` / `display_name` string (e.g. "Jordan Nicole Lane")
 * into the decomposed `{ first_name, middle_name, last_name }` shape that
 * the Hamilton automation agent and most application portals expect.
 *
 * Why this exists:
 *   The profile editor persists ONE canonical name field (`full_name` on the
 *   `basic_information` section, mirrored to `profiles.display_name`). But
 *   Hamilton's preflight (backend/services/hamilton/hamiltonPreflight.js)
 *   REQUIRES `basic_information.first_name` AND `basic_information.last_name`.
 *   Nothing wrote those, so every profile that only had a full name flagged
 *   BOTH as "missing information" — for every funding source — producing a
 *   wall of false blockers. Deriving the parts from the full name clears them
 *   at the source.
 *
 * Design notes / common-sense rules:
 *   - First token  → first_name.
 *   - Last token   → last_name (skipping a trailing generational suffix).
 *   - Everything between → middle_name.
 *   - Leading honorifics (Dr., Mr., Mrs., ...) are stripped.
 *   - Trailing suffixes (Jr., Sr., II, III, PhD, ...) are captured separately
 *     so "John Smith Jr." → first "John", last "Smith" (not "Jr.").
 *   - A single token → first_name only (last_name empty).
 *   - Organization-style names (Inc/LLC/Foundation/...) are NOT split — an org
 *     has no first/last name; returns { is_org: true } so callers can skip.
 */

const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'professor', 'rev', 'fr',
  'sr', 'sir', 'madam', 'madame', 'capt', 'captain', 'lt', 'sgt', 'hon',
])

const SUFFIXES = new Set([
  'jr', 'sr', 'ii', 'iii', 'iv', 'v', 'vi',
  'phd', 'md', 'dds', 'esq', 'jd', 'mba', 'rn', 'do', 'cpa',
])

// Tokens that mark a name as an organization rather than a person.
const ORG_MARKERS = [
  /\b(inc|incorporated|llc|llp|lp|ltd|corp|corporation|co)\b/i,
  /\b(foundation|fund|trust|institute|institution|society|association|assn)\b/i,
  /\b(university|college|school|academy|hospital|clinic|center|centre)\b/i,
  /\b(church|ministry|ministries|fellowship|diocese|parish)\b/i,
  /\b(department|agency|bureau|commission|council|coalition|alliance|network)\b/i,
  /\b(nonprofit|non-profit|charity|charities|group|partners|holdings|enterprises)\b/i,
]

function stripSuffixPunct(token) {
  return String(token || '').replace(/[.,]/g, '').toLowerCase()
}

/**
 * Does this name look like an organization rather than a person?
 */
export function looksLikeOrganization(fullName) {
  const s = String(fullName || '')
  return ORG_MARKERS.some((rx) => rx.test(s))
}

/**
 * Parse a full name string into its component parts.
 * Returns { first_name, middle_name, last_name, suffix, is_org }.
 * All string fields default to '' (never null/undefined) so callers can
 * safely write them straight into a section payload.
 */
export function parseFullName(fullName) {
  const empty = { first_name: '', middle_name: '', last_name: '', suffix: '', is_org: false }
  const cleaned = String(fullName || '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return empty

  if (looksLikeOrganization(cleaned)) {
    return { ...empty, is_org: true }
  }

  // Split off a leading honorific.
  let tokens = cleaned.split(' ')
  if (tokens.length > 1 && HONORIFICS.has(stripSuffixPunct(tokens[0]))) {
    tokens = tokens.slice(1)
  }

  // Split off a trailing generational/credential suffix.
  let suffix = ''
  if (tokens.length > 1 && SUFFIXES.has(stripSuffixPunct(tokens[tokens.length - 1]))) {
    suffix = tokens[tokens.length - 1].replace(/[.,]+$/, '')
    tokens = tokens.slice(0, -1)
  }

  // Handle "Last, First Middle" comma form.
  if (cleaned.includes(',')) {
    const [lastPart, restPart] = cleaned.split(',', 2).map((s) => s.trim())
    const restTokens = restPart ? restPart.split(' ').filter(Boolean) : []
    if (lastPart && restTokens.length > 0) {
      return {
        first_name: restTokens[0],
        middle_name: restTokens.slice(1).join(' '),
        last_name: lastPart,
        suffix,
        is_org: false,
      }
    }
  }

  if (tokens.length === 0) return empty
  if (tokens.length === 1) {
    return { first_name: tokens[0], middle_name: '', last_name: '', suffix, is_org: false }
  }

  return {
    first_name: tokens[0],
    middle_name: tokens.slice(1, -1).join(' '),
    last_name: tokens[tokens.length - 1],
    suffix,
    is_org: false,
  }
}

function nonEmptyStr(v) {
  return typeof v === 'string' ? v.trim() !== '' : v !== null && v !== undefined && String(v).trim() !== ''
}

/**
 * Collapse a DOUBLED personal display name back to a single, most-complete name.
 *
 * Why this exists:
 *   The profile-merge path (services/profileDedupeService.js mergeValues) used
 *   to JOIN two overlapping name strings when it merged two profiles'
 *   basic_information.full_name — e.g. merging "Jordan Lane" with
 *   "Jordan Michael Lane" produced "Jordan Lane\nJordan Michael Lane", which
 *   synced into profiles.display_name and rendered as
 *   "Jordan Lane Jordan Michael Lane" in the profile header AND the generated
 *   PDF title. This helper is the single, shared collapser used both by the
 *   producer (so a name can never be doubled at write time) and by the boot
 *   sweep (so already-doubled rows self-heal).
 *
 * What counts as "doubled" (CONSERVATIVE — only clear cases collapse):
 *   1. EXACT repetition of the WHOLE string: "Jane Doe Jane Doe" -> "Jane Doe".
 *   2. Two halves that name the SAME person: the token sequence splits into two
 *      contiguous personal names that share the same first AND last token, where
 *      one half is a token-subsequence of the other. We keep the LONGER (more
 *      complete) half: "Jordan Lane Jordan Michael Lane"
 *      -> "Jordan Michael Lane".
 *
 * What is LEFT ALONE (returned whitespace-normalized but otherwise verbatim):
 *   - Non-doubled personal names: "Jordan Lane", "Mary Jane Watson",
 *     "John Q. Public".
 *   - Organization names (Inc/LLC/Foundation/Church/…): a repeated org token
 *     like "Church of God of Prophecy" is legitimate, never a person-name
 *     double — looksLikeOrganization() short-circuits the whole helper.
 *   - Hyphenated / compound surnames and any string we cannot prove is a clean
 *     two-half repeat sharing first+last (e.g. "Anna Maria Anna" has no shared
 *     surname across a clean split, so it is untouched).
 *
 * @param {string} name
 * @returns {string} the collapsed name, or the (whitespace-normalized) original when not doubled.
 */
export function dedupeProfileDisplayName(name) {
  if (name === null || name === undefined) return name
  const original = String(name)
  // Collapse any internal whitespace (including the `\n` the bad merge inserted)
  // to single spaces so token logic is uniform; this is also what the renderer
  // does, so it matches what the user actually sees.
  const normalized = original.replace(/\s+/g, ' ').trim()
  if (!normalized) return normalized

  // Never touch organization names — a repeated word there is legitimate.
  if (looksLikeOrganization(normalized)) return normalized

  const tokens = normalized.split(' ').filter(Boolean)
  // A double needs at least 4 tokens ("A B" + "A B"); fewer can't be a doubled
  // personal name. Single/compound names ("Mary Jane Watson") fall through here.
  if (tokens.length < 4) return normalized

  const lower = tokens.map((t) => t.toLowerCase())

  // CASE 1: exact whole-string repetition (even token count, both halves equal).
  if (tokens.length % 2 === 0) {
    const half = tokens.length / 2
    let mirror = true
    for (let i = 0; i < half; i += 1) {
      if (lower[i] !== lower[half + i]) { mirror = false; break }
    }
    if (mirror) {
      // "Jane Doe Jane Doe" -> "Jane Doe" (keep the original casing of half 1).
      return tokens.slice(0, half).join(' ')
    }
  }

  // CASE 2: two contiguous personal names that share first AND last token, one a
  // token-subsequence of the other. We only split where the SECOND half restarts
  // the name with the SAME first token as the whole string (the repeated given
  // name) AND both halves end on the SAME last token (the shared surname). We
  // scan every split point and accept the first that yields two same-person halves.
  const firstTok = lower[0]
  const lastTok = lower[lower.length - 1]
  for (let split = 1; split < tokens.length; split += 1) {
    const left = lower.slice(0, split)
    const right = lower.slice(split)
    // Each half must be a plausible personal name (>= 2 tokens: given + surname).
    if (left.length < 2 || right.length < 2) continue
    // The second half must restart the name: same given name, same surname.
    if (right[0] !== firstTok) continue
    if (left[left.length - 1] !== lastTok || right[right.length - 1] !== lastTok) continue
    // One half must be a token-subsequence of the other (same person, one fuller
    // form). isTokenSubsequence keeps order, so "robert white" ⊆ "robert michael white".
    const shortHalf = left.length <= right.length ? left : right
    const longHalf = left.length <= right.length ? right : left
    if (!isTokenSubsequence(shortHalf, longHalf)) continue
    // Keep the LONGER (more complete) half, preserving its original casing.
    const keepTokens = left.length >= right.length ? tokens.slice(0, split) : tokens.slice(split)
    return keepTokens.join(' ')
  }

  return normalized
}

/** True when every token of `sub` appears in `sup` in order (subsequence). */
function isTokenSubsequence(sub, sup) {
  let i = 0
  for (let j = 0; j < sup.length && i < sub.length; j += 1) {
    if (sup[j] === sub[i]) i += 1
  }
  return i === sub.length
}

/**
 * Given a basic_information section data object, return a (possibly) augmented
 * copy with first_name / middle_name / last_name derived from full_name (or a
 * supplied fallback display name) when they are missing. Never overwrites
 * values a human already entered. Returns the SAME object reference when no
 * change is needed, so callers can cheaply detect "did anything change?".
 *
 * @param {object} data         basic_information section payload
 * @param {string} [fallbackName] e.g. profiles.display_name, used when the
 *                                 section has no full_name of its own
 * @returns {{ data: object, changed: boolean }}
 */
export function deriveNamePartsIntoBasicInfo(data, fallbackName = '') {
  const src = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const nameSource = nonEmptyStr(src.full_name) ? src.full_name : fallbackName
  if (!nonEmptyStr(nameSource)) return { data: src, changed: false }

  const haveFirst = nonEmptyStr(src.first_name)
  const haveLast = nonEmptyStr(src.last_name)
  if (haveFirst && haveLast) return { data: src, changed: false }

  const parts = parseFullName(nameSource)
  if (parts.is_org) return { data: src, changed: false }
  // Need at least a first name to be worth writing; a one-word name still
  // clears the first_name blocker even if last_name stays empty.
  if (!nonEmptyStr(parts.first_name)) return { data: src, changed: false }

  const next = { ...src }
  let changed = false
  if (!haveFirst && nonEmptyStr(parts.first_name)) { next.first_name = parts.first_name; changed = true }
  if (!haveLast && nonEmptyStr(parts.last_name)) { next.last_name = parts.last_name; changed = true }
  if (!nonEmptyStr(src.middle_name) && nonEmptyStr(parts.middle_name)) { next.middle_name = parts.middle_name; changed = true }

  return changed ? { data: next, changed: true } : { data: src, changed: false }
}

export default { parseFullName, looksLikeOrganization, deriveNamePartsIntoBasicInfo, dedupeProfileDisplayName }
