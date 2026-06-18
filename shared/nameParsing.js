/**
 * nameParsing.js  (shared — imported by both backend and frontend)
 *
 * "Parse, baby, parse." A single source of truth for turning a single
 * `full_name` / `display_name` string (e.g. "Anastasia Nicole White")
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

export default { parseFullName, looksLikeOrganization, deriveNamePartsIntoBasicInfo }
