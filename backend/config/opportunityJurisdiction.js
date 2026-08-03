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

/**
 * Foreign funders that publish on GENERIC TLDs (.org/.com), which the ccTLD
 * rule can never see. Owner QA pass 2026-08-03: UK "LA Flex"/"Energy Saving
 * Grants" and India's "Tata Trusts — Individual Medical Grants" surfaced for
 * US individuals (Lisa Klinger, Vivian Millican; Tata mis-tagged "TN" on 4+
 * profiles) precisely because their hosts carry no jurisdiction-bearing suffix.
 *
 * TWO registries, both narrow by design (this is a funder-identity list, not a
 * topic denylist — the #937 phrase-decay warning in this file's header still
 * holds, which is why entries name a FUNDER, never a subject):
 *   - FOREIGN_FUNDER_HOSTS: hostname (registrable-suffix matched) → ISO country.
 *     Evidence is still the row's OWN url, same as the ccTLD rule.
 *   - FOREIGN_FUNDER_NAMES: word-bounded regex over the row's OWN sponsor/title
 *     (identity fields only — never description prose, #1086). Each entry names
 *     one real foreign funding organization/scheme.
 */
export const FOREIGN_FUNDER_HOSTS = Object.freeze({
  'tatatrusts.org': 'IN',
  'energysavinggrants.org': 'GB',
  'simpleenergyadvice.org.uk': 'GB',
})

export const FOREIGN_FUNDER_NAMES = Object.freeze([
  // Tata Trusts (India) — "Tata Trusts – Individual Medical Grants" et al.
  { rx: /\btata trusts?\b/i, country: 'IN', label: 'Tata Trusts' },
  // UK Local Authority Flexible Eligibility ("LA Flex") energy schemes.
  { rx: /\bla flex\b/i, country: 'GB', label: 'LA Flex (UK Local Authority Flexible Eligibility)' },
  // UK aggregator "Energy Saving Grants" — SPONSOR-anchored shape only: the
  // bare phrase "energy saving grants" is ordinary English a US program could
  // use in a title, so the title form requires the ECO/Great British Insulation
  // qualifier the UK scheme pages actually carry.
  { rx: /\benergy saving grants\b.{0,60}\b(?:eco4?|great british insulation|uk)\b/i, country: 'GB', label: 'Energy Saving Grants (UK)' },
])

/** Sponsor-only exact names (lower-cased equality) for funders whose name is
 * too generic to word-match in a title. */
export const FOREIGN_FUNDER_SPONSORS = Object.freeze({
  'energy saving grants': 'GB',
  'tata trusts': 'IN',
})

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
/** The FOREIGN_FUNDER_HOSTS country for a hostname (registrable-suffix match), or null. */
export function foreignFunderCountryOfHost(host) {
  const h = String(host ?? '').toLowerCase().trim()
  if (!h) return null
  for (const [funderHost, country] of Object.entries(FOREIGN_FUNDER_HOSTS)) {
    if (h === funderHost || h.endsWith(`.${funderHost}`)) return country
  }
  return null
}

export function detectForeignJurisdiction(row) {
  if (!row || typeof row !== 'object') return { foreign: false, cctld: null, host: null }
  for (const field of URL_FIELDS) {
    const host = hostnameOf(row[field])
    if (!host) continue
    const cctld = foreignCctldOfHost(host)
    if (cctld) return { foreign: true, cctld, host }
    // Same evidence class (the row's OWN url), different registry: a foreign
    // funder publishing on a generic TLD (tatatrusts.org) that the ccTLD rule
    // is structurally blind to.
    const funderCountry = foreignFunderCountryOfHost(host)
    if (funderCountry) return { foreign: true, cctld: funderCountry.toLowerCase(), host }
  }
  return { foreign: false, cctld: null, host: null }
}

/**
 * The SUPERSET detector for the whole foreign class: jurisdiction from the
 * row's own url (ccTLD or registered foreign-funder host) OR a registered
 * foreign FUNDER NAME stated in the row's own identity fields (sponsor/title —
 * never description prose). Returns the same shape as detectForeignJurisdiction
 * plus `funder` naming the matched registry entry when the evidence is a name.
 *
 * MISSING = NEUTRAL: a row with no urls and no matching identity text is never
 * foreign.
 */
/**
 * US diplomatic posts abroad, identity fields only, word-bounded. "Mission"
 * alone is ordinary English ("mission statement", church missions) — the
 * pattern requires the U.S./US prefix AND either the Embassy/Consulate noun or
 * "Mission to/in <somewhere>" (the State-Department naming shape).
 */
export const US_MISSION_ABROAD_RX =
  /\bu\.?s\.?\s+(?:embassy|consulate(?:\s+general)?)\b|\bu\.?s\.?\s+mission\s+(?:to|in)\s+\S/i

export function detectForeignOpportunity(row) {
  const byUrl = detectForeignJurisdiction(row)
  if (byUrl.foreign) return { ...byUrl, funder: null }
  if (!row || typeof row !== 'object') return { foreign: false, cctld: null, host: null, funder: null }
  const sponsor = String(row.sponsor ?? row.funder ?? '').trim()
  const title = String(row.title ?? '').trim()
  const sponsorKey = sponsor.toLowerCase()
  if (sponsorKey && FOREIGN_FUNDER_SPONSORS[sponsorKey]) {
    return {
      foreign: true,
      cctld: FOREIGN_FUNDER_SPONSORS[sponsorKey].toLowerCase(),
      host: null,
      funder: sponsor,
    }
  }
  const identity = `${title} ${sponsor}`.trim()
  if (identity) {
    for (const entry of FOREIGN_FUNDER_NAMES) {
      if (entry.rx.test(identity)) {
        return { foreign: true, cctld: entry.country.toLowerCase(), host: null, funder: entry.label }
      }
    }
    // US diplomatic missions abroad: a "U.S. Mission to Azerbaijan" / "U.S.
    // Embassy Luanda" program is US-government-FUNDED but serves audiences IN
    // that country — no domestic profile can act on it. Live leak measured
    // 2026-08-03: the first write-enabled catalog-rescore pass linked "U.S.
    // Mission to Azerbaijan — English-Language Program" to a TN student at
    // score 53 (12 mission/embassy rows total in the pass), exactly the class
    // the flood dry-run flagged. The country varies per row, so cctld stays
    // null; `foreign: true` is the verdict consumers act on.
    if (US_MISSION_ABROAD_RX.test(identity)) {
      return { foreign: true, cctld: null, host: null, funder: 'U.S. diplomatic mission abroad' }
    }
  }
  return { foreign: false, cctld: null, host: null, funder: null }
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
/**
 * SQL prefilter (superset) for a url on a foreign ccTLD, as a LIKE list.
 *
 * WHY THIS EXISTS — the 2026-08-01 prod regression. The first version of
 * `enforceForeignJurisdictionMatches` selected match rows with NO WHERE clause
 * at all and decided foreign-ness in JS *after* `LIMIT ?`. With ~11.5k match
 * rows and a 2 000 bound it scanned an arbitrary, unordered slice: the live boot
 * summary recorded `{"name":"foreign_jurisdiction_matches","repaired":1,
 * "scanned":2000}` — 1 of 516 foreign rows removed, the other 515 structurally
 * unreachable no matter how many times it ran. That is exactly the #944
 * "green while doing nothing" class this repo already documents for amount
 * enrichment, and the sibling sweeps written in the same PR all had a SQL
 * predicate; this one did not.
 *
 * A host sits on a ccTLD when the url contains `.<tld>` followed by a path,
 * port, query, fragment, or end-of-string. Callers concatenate the url columns
 * with a separator AND a trailing one, so "end of string" is covered by the
 * space form and the whole set is four shapes per TLD. This is a SUPERSET —
 * `detectForeignJurisdiction` still decides, so a coincidental match (a path
 * segment like `/report.ie/`) is rejected in JS, and `JURISDICTION_NEUTRAL_HOSTS`
 * still wins.
 */
export function foreignUrlLikePatterns() {
  const out = []
  for (const tld of FOREIGN_CCTLDS) {
    out.push(`%.${tld}/%`, `%.${tld} %`, `%.${tld}:%`, `%.${tld}?%`)
  }
  // Registered foreign-funder hosts on generic TLDs — a bare substring is a
  // safe SUPERSET here (the JS detector re-adjudicates by parsed hostname).
  for (const host of Object.keys(FOREIGN_FUNDER_HOSTS)) {
    out.push(`%${host}%`)
  }
  return out
}

/**
 * SQL prefilter (superset) for the row's own IDENTITY text naming a registered
 * foreign funder, as a LIKE list over a lower-cased title+sponsor haystack.
 * `detectForeignOpportunity` adjudicates each hit — a LIKE match alone never
 * decides (the "energy saving grants" phrase needs its UK qualifier in JS).
 */
export function foreignFunderNameLikePatterns() {
  // Deliberate SUPERSET (detectForeignOpportunity adjudicates each hit):
  // '%u.s. mission%' also matches "U.S. Mission Statement" — the JS regex's
  // "Mission to/in" shape is what decides.
  return [
    '%tata trust%', '%la flex%', '%energy saving grants%',
    '%u.s. mission%', '%us mission%', '%u.s. embassy%', '%us embassy%', '%consulate%',
  ]
}

export function foreignFunderNameSqlPredicate(hayExpr) {
  const params = foreignFunderNameLikePatterns()
  const clause = params.map(() => `${hayExpr} LIKE ?`).join(' OR ')
  return { clause: `(${clause})`, params }
}

/**
 * Build the `(hay LIKE ? OR hay LIKE ? …)` clause + params for a url haystack
 * expression. Dialect-agnostic: LIKE and `||` behave the same on SQLite and
 * Postgres, and every url column is lower-cased by the caller.
 */
export function foreignUrlSqlPredicate(hayExpr) {
  const params = foreignUrlLikePatterns()
  const clause = params.map(() => `${hayExpr} LIKE ?`).join(' OR ')
  return { clause: `(${clause})`, params }
}

export const DECLARED_STATE_TITLE_LIKE_PATTERNS = Object.freeze([
  '%, __ —%', // em dash
  '%, __ –%', // en dash
  '%, __ -%', // hyphen
])

export default {
  FOREIGN_CCTLDS,
  JURISDICTION_NEUTRAL_HOSTS,
  FOREIGN_FUNDER_HOSTS,
  FOREIGN_FUNDER_NAMES,
  FOREIGN_FUNDER_SPONSORS,
  US_MISSION_ABROAD_RX,
  hostnameOf,
  foreignCctldOfHost,
  foreignFunderCountryOfHost,
  detectForeignJurisdiction,
  detectForeignOpportunity,
  declaredStateFromTitle,
  correctedGeoScopeFromTitle,
  DECLARED_STATE_TITLE_LIKE_PATTERNS,
  foreignUrlLikePatterns,
  foreignFunderNameLikePatterns,
  foreignFunderNameSqlPredicate,
  foreignUrlSqlPredicate,
}
