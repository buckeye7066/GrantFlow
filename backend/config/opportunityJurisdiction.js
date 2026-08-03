/**
 * opportunityJurisdiction.js — WHERE an opportunity is actually valid.
 *
 * Mechanical, profile-agnostic rules that the geography gate needs and did not
 * have. They are decided from facts the ROW carries about itself, never from the
 * profile or the crawl that happened to discover the row.
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
 * ── Rule 2: A ROW THAT NAMES ITS OWN STATE IS NOT NATIONAL ──────────────────
 * County/city locator rows are minted per-place with the place in the TITLE
 * ("Polk County, TN — Local assistance programs near you (findhelp)") but are
 * persisted `state = NULL, is_national = 1, geo_county = NULL, geo_zip = NULL`.
 * So the ONE fact that scopes them lives in a string nothing geographic reads.
 *
 * ── Rule 3: A REGISTERED U.S. FUNDER OUTRANKS CRAWL-STAMPED STATE NOISE ─────
 * Owner QA 2026-08-03 found "Ohio RDA" tagged TN and Central Piedmont funding
 * attached to a Cleveland State profile. A concrete funder's official host or
 * exact identity is objective jurisdiction evidence; the state copied from the
 * search/profile context is not. The narrow registry lives in
 * canonicalUsJurisdiction.js and may override that contradictory stored value.
 */

import {
  canonicalUsFunderJurisdiction,
  correctedCanonicalUsScope,
} from './canonicalUsJurisdiction.js'
import { declaredStateFromTitle as declaredStateCodeFromTitle } from './stateTitleDeclaration.js'

/**
 * Existing consumers ask this authority for the row's declared state. Preserve
 * the exact `Place, XX — ...` parser, but let an objective registered funder
 * identity/host win first so item search and match scoring cannot replay a
 * contradictory crawl-stamped state.
 */
export function declaredStateFromTitle(rowOrTitle) {
  const row = typeof rowOrTitle === 'string' ? { title: rowOrTitle } : rowOrTitle
  return canonicalUsFunderJurisdiction(row)?.state ?? declaredStateCodeFromTitle(rowOrTitle)
}

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
 */
export const FOREIGN_FUNDER_HOSTS = Object.freeze({
  'tatatrusts.org': 'IN',
  'energysavinggrants.org': 'GB',
  'simpleenergyadvice.org.uk': 'GB',
})

export const FOREIGN_FUNDER_NAMES = Object.freeze([
  { rx: /\btata trusts?\b/i, country: 'IN', label: 'Tata Trusts' },
  { rx: /\bla flex\b/i, country: 'GB', label: 'LA Flex (UK Local Authority Flexible Eligibility)' },
  { rx: /\benergy saving grants\b.{0,60}\b(?:eco4?|great british insulation|uk)\b/i, country: 'GB', label: 'Energy Saving Grants (UK)' },
])

/** Sponsor-only exact names for funders whose name is too generic to match in a title. */
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

/** Decide whether a hostname names a foreign jurisdiction. */
export function foreignCctldOfHost(host) {
  const h = String(host ?? '').toLowerCase().trim()
  if (!h) return null
  if (JURISDICTION_NEUTRAL_HOSTS.has(h)) return null
  const labels = h.split('.').filter(Boolean)
  if (labels.length < 2) return null
  const twoLabel = labels.slice(-2).join('.')
  if (FOREIGN_CCTLDS.has(twoLabel)) return twoLabel
  const tld = labels[labels.length - 1]
  return FOREIGN_CCTLDS.has(tld) ? tld : null
}

/** The FOREIGN_FUNDER_HOSTS country for a hostname, or null. */
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
    const funderCountry = foreignFunderCountryOfHost(host)
    if (funderCountry) return { foreign: true, cctld: funderCountry.toLowerCase(), host }
  }
  return { foreign: false, cctld: null, host: null }
}

/**
 * Superset foreign detector: row URL jurisdiction OR registered foreign funder
 * identity. Missing evidence is neutral.
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
 * Apply the two writer-side U.S. scope repairs.
 *
 * A registered canonical funder MAY override a contradictory non-empty stored
 * state. The generic `Place, XX — ...` rule remains conservative and repairs
 * only an empty state, preserving the source-supplied-scope invariant for all
 * unregistered rows.
 */
export function correctedGeoScopeFromTitle(row) {
  if (!row || typeof row !== 'object') return null
  const canonical = correctedCanonicalUsScope(row)
  if (canonical) return canonical

  const storedState = String(row.state ?? '').trim()
  if (storedState) return null
  const declared = declaredStateCodeFromTitle(row)
  if (!declared) return null
  return { state: declared, is_national: 0 }
}

/**
 * SQL prefilter (superset) for a url on a foreign ccTLD. JS adjudicates every
 * candidate; LIKE alone never decides.
 */
export function foreignUrlLikePatterns() {
  const out = []
  for (const tld of FOREIGN_CCTLDS) {
    out.push(`%.${tld}/%`, `%.${tld} %`, `%.${tld}:%`, `%.${tld}?%`)
  }
  for (const host of Object.keys(FOREIGN_FUNDER_HOSTS)) {
    out.push(`%${host}%`)
  }
  return out
}

/** SQL prefilter for registered foreign funder identities. */
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

export function foreignUrlSqlPredicate(hayExpr) {
  const params = foreignUrlLikePatterns()
  const clause = params.map(() => `${hayExpr} LIKE ?`).join(' OR ')
  return { clause: `(${clause})`, params }
}

export const DECLARED_STATE_TITLE_LIKE_PATTERNS = Object.freeze([
  '%, __ —%',
  '%, __ –%',
  '%, __ -%',
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
