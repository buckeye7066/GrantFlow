/**
 * opportunityJurisdiction.js — WHERE an opportunity is actually valid.
 *
 * Two mechanical, profile-agnostic rules that the geography gate needs and did
 * not have. Both are decided from facts the ROW carries about itself; neither
 * is a denylist of specific programs, sponsors, or ids.
 *
 * ── Rule 1: FOREIGN JURISDICTION ────────────────────────────────────────────
 * The match engine's geography gate (services/matchEngine.js makeDecision) only
 * ever compared a US STATE code. It has no concept of a COUNTRY, so a program
 * administered by another government simply had `state = NULL`, and — because
 * nothing set a state — the discovery bridge also stamped `is_national = 1`.
 * The result is worse than "not rejected": `oppIsNational` makes the geo tier
 * score the row as a NATIONWIDE US program, i.e. fully geographically eligible
 * for every US profile. Prod 2026-08-01: 146 active catalog rows on foreign
 * country-code domains (citizensinformation.ie, gov.uk, sassa.gov.za, dda.gov.in,
 * housingauthority.gov.hk …), 55 live match rows across 6 profiles.
 *
 * The evidence is the row's OWN url. A registrable suffix that is a country-code
 * TLD names the jurisdiction that publishes the page. Title/sponsor text is
 * deliberately NOT consulted — "Local Authorities" is a phrase, not a fact, and
 * matching on phrases is how a class fix decays into a denylist (#937/#943).
 *
 * ── Rule 2: A ROW THAT NAMES ITS OWN STATE IS NOT NATIONAL ──────────────────
 * County/city locator rows are minted per-place with the place in the TITLE
 * ("Polk County, TN — Local assistance programs near you (findhelp)") but are
 * persisted `state = NULL, is_national = 1, geo_county = NULL, geo_zip = NULL`.
 * So the ONE fact that scopes them lives in a string nothing geographic reads:
 * the state-mismatch gate short-circuits on an empty `opp.state`, and the geo
 * tier awards the full `national` subscale. Every profile in the fleet is then
 * "geographically eligible" for every other profile's county, and — because the
 * cross-profile (xmatch) lane scores against a thesis stub rather than the
 * profile's full inventory — those out-of-state locators OUT-SCORE the profile's
 * own in-state row. Prod 2026-08-01: 89 active rows declare a state in their own
 * title while stored national; 373 match rows across 37 of 39 profiles, of which
 * 213 are provably out-of-state for the matched profile.
 *
 * Recovering the declared state is not new information — it is reading the fact
 * the row already published about itself.
 */

import { normalizeState, isValidState } from '../utils/stateNormalization.js'

/**
 * Country-code TLDs treated as evidence of a non-US jurisdiction.
 *
 * REGISTRY (see CLAUDE.md "REGISTRY plus a TOTALITY test"): every member must be
 * a two-letter ccTLD whose registry is operated for a specific country, and must
 * NOT appear in JURISDICTION_NEUTRAL_HOSTS' TLDs by accident. Adding a member is
 * the supported way to extend coverage; the totality test asserts shape.
 *
 * Deliberately EXCLUDED (ccTLDs sold as generic/vanity suffixes, where the TLD
 * says nothing about jurisdiction): co, io, me, tv, ly, ai, fm, to, gg, cc, ws,
 * am, is, sh, st, nu, la, gl, mn, so, si, it is not exhaustive by design — this
 * set is an ALLOWLIST of jurisdiction-bearing suffixes, so an unlisted TLD is
 * simply never treated as foreign evidence (fail-open, never fail-loud).
 */
export const FOREIGN_CCTLDS = Object.freeze(new Set([
  'ae', 'ar', 'at', 'au', 'bd', 'be', 'br', 'ca', 'ch', 'cl', 'cn', 'co.uk',
  'cz', 'de', 'dk', 'eg', 'es', 'fi', 'fr', 'gh', 'gr', 'hk', 'hu', 'ie', 'il',
  'in', 'id', 'ir', 'it', 'jp', 'ke', 'kr', 'lk', 'mx', 'my', 'ng', 'nl', 'no',
  'np', 'nz', 'pe', 'ph', 'pk', 'pl', 'pt', 'ro', 'ru', 'sa', 'se', 'sg', 'th',
  'tr', 'tw', 'ua', 'uk', 'vn', 'za',
]))

/**
 * Hosts whose TLD is a DOMAIN HACK and therefore carries no jurisdiction
 * meaning. `lnkd.in` is LinkedIn's link shortener and in prod it fronts a US
 * (Alaska Fellows Program) posting — a naive `.in` rule calls that Indian.
 * A shortener also never identifies the funder, so it can never be evidence.
 *
 * REGISTRY: members are HOSTNAMES (lower-case, no scheme/port).
 */
export const JURISDICTION_NEUTRAL_HOSTS = Object.freeze(new Set([
  'lnkd.in',
  'bit.ly',
  'buff.ly',
  'goo.gl',
  'ow.ly',
  't.co',
  'tinyurl.com',
  'youtu.be',
]))

/** Every url field a catalog row may carry, in the order the row prefers them. */
const URL_FIELDS = Object.freeze([
  'source_url',
  'application_url',
  'apply_url',
  'url',
  'evidence_url',
  'info_url',
  'final_url',
])

/** Lower-cased hostname of a url string, or null when it is not parseable. */
export function hostnameOf(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const host = String(parsed.hostname || '').toLowerCase().replace(/\.+$/, '')
    return host || null
  } catch {
    return null
  }
}

/**
 * Decide whether a hostname names a foreign jurisdiction.
 * Returns the matched ccTLD (e.g. 'ie', 'co.uk') or null.
 */
export function foreignCctldOfHost(host) {
  const h = String(host ?? '').toLowerCase().trim()
  if (!h) return null
  if (JURISDICTION_NEUTRAL_HOSTS.has(h)) return null
  const labels = h.split('.').filter(Boolean)
  if (labels.length < 2) return null
  // Prefer the longest suffix so 'co.uk' wins over 'uk' when both are listed.
  const twoLabel = labels.slice(-2).join('.')
  if (FOREIGN_CCTLDS.has(twoLabel)) return twoLabel
  const tld = labels[labels.length - 1]
  return FOREIGN_CCTLDS.has(tld) ? tld : null
}

/**
 * Rule 1. Does this opportunity row publish itself from a foreign jurisdiction?
 *
 * @param {object} row catalog/opportunity-ish row (any url field shape)
 * @returns {{ foreign: boolean, cctld: string|null, host: string|null }}
 */
export function detectForeignJurisdiction(row) {
  if (!row || typeof row !== 'object') return { foreign: false, cctld: null, host: null }
  for (const field of URL_FIELDS) {
    const host = hostnameOf(row[field])
    if (!host) continue
    const cctld = foreignCctldOfHost(host)
    if (cctld) return { foreign: true, cctld, host }
  }
  return { foreign: false, cctld: null, host: null }
}

/**
 * A locator title states its place as `"<Place>, XX — <what it is>"`. Only that
 * exact, machine-minted shape is read: an arbitrary two-letter token anywhere in
 * a title is a coincidence (the #937 one-shared-token class), a comma + state
 * code + separator is a declaration.
 */
const TITLE_STATE_RX = /,\s*([A-Za-z]{2})\s*(?:—|–|-{1,2})\s/

/**
 * Rule 2. The US state (or CA province) a row declares in its OWN title, or null.
 *
 * @param {object|string} rowOrTitle
 * @returns {string|null} normalized 2-letter code
 */
export function declaredStateFromTitle(rowOrTitle) {
  const title = typeof rowOrTitle === 'string' ? rowOrTitle : String(rowOrTitle?.title ?? '')
  if (!title) return null
  const m = TITLE_STATE_RX.exec(title)
  if (!m) return null
  const code = normalizeState(m[1])
  if (!code || !isValidState(code)) return null
  return code
}

/**
 * Rule 2, applied. A row that declares a state in its title but carries NO
 * stored state is mis-scoped: return the corrected scope.
 *
 * The trigger is the EMPTY state, not `is_national` — an empty state is what
 * makes the gate short-circuit, and prod holds both shapes (`is_national = 1`
 * from the OS bridge's `geo.national ? 1 : 0`, and `is_national = 0` when the
 * lane emits no geography at all). Returns null when the row already carries a
 * state (idempotent by construction, and a source-supplied scope is never
 * overridden) or when it declares nothing.
 *
 * @returns {{ state: string, is_national: 0 }|null}
 */
export function correctedGeoScopeFromTitle(row) {
  if (!row || typeof row !== 'object') return null
  const storedState = String(row.state ?? '').trim()
  if (storedState) return null
  const declared = declaredStateFromTitle(row)
  if (!declared) return null
  return { state: declared, is_national: 0 }
}

/**
 * SQL prefilter (superset) for the declared-state title shape, as a LIKE list.
 *
 * The sweep MUST narrow in SQL, never after a LIMIT: an unscoped catalog holds
 * thousands of state-less rows, and a post-LIMIT JS filter would let rows that
 * declare nothing permanently starve the ones that do (the #944 class, where a
 * sweep read green while never reaching row 201). `_` matches exactly one
 * character in SQL LIKE, so `'%, __ —%'` is ", XX —" plus a superset of
 * coincidences that `declaredStateFromTitle` then rejects in JS.
 */
export const DECLARED_STATE_TITLE_LIKE_PATTERNS = Object.freeze([
  '%, __ —%', // em dash
  '%, __ –%', // en dash
  '%, __ -%', // hyphen
])

export default {
  FOREIGN_CCTLDS,
  JURISDICTION_NEUTRAL_HOSTS,
  hostnameOf,
  foreignCctldOfHost,
  detectForeignJurisdiction,
  declaredStateFromTitle,
  correctedGeoScopeFromTitle,
  DECLARED_STATE_TITLE_LIKE_PATTERNS,
}
