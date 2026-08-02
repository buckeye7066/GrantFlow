/**
 * crisisNeedRecall.js — WHERE a person in crisis lives, and WHICH already-
 * catalogued local rows are allowed to reach them.
 *
 * THE DEFECT (measured read-only in prod, 2026-08-02T04:59Z). Help that already
 * exists never reaches the people it was written for. Of the ACTIVE catalog:
 *
 *   eviction / rental assistance   416 rows →  16 carry ANY match row
 *   homelessness / shelter         282 rows →  13
 *   utility / energy assistance    252 rows →  22
 *   food assistance                176 rows →   9
 *   foreclosure / mortgage          95 rows →  30
 *
 * The concrete pair, run through the REAL engine against the REAL profile:
 * Hollie Machelle Knox (family, North Ridgeville OH 44039 — Lorain County),
 * profile need `housing`, vs "Love INC Lorain County – Emergency Housing & Rent
 * Assistance". `computeMatchDecision` returns **ACCEPT 100**, and
 * `profile_opportunity_matches` held **no row at all**. Eight of her county's
 * awardable rows were in that state (HEAP 69, CHIP 62, Catholic Charities
 * Housing Services 50, the Lorain County Children & Families Mini Grant 55…),
 * while what DID reach her were three findhelp/USA.gov/HUD DIRECTORY pointers.
 *
 * NEVER SCORED, not scored-and-rejected. The cause is structural:
 * `crawlerOsPersistenceCore.persistRun` DELETEs a profile's `crawler-os` /
 * `crawler-os-xmatch` rows every run and re-inserts only what THAT run
 * re-found, so a row another run discovered for the same county is never
 * re-offered. Her three surviving matches all carry `matcher_version
 * 'crawler-os'`; every row above was found on a different day.
 *
 * THE KEY IS A REAL PLACE, NOT A STATE. Measured on real prod pairs with the
 * real engine, same run:
 *
 *   bare in-state (fo.state = profile state)            11,628 candidate rows
 *   county TOKEN in title/sponsor + state                  369 scanned
 *   county PHRASE ("<County> County") + state              280 scanned
 *   …+ the row serves a need the profile DECLARES           41 scanned → 21 linked
 *
 * Bare in-state has been measured at 5,393 / 6,210 / 218 links in three earlier
 * attempts and rejected every time; it is the flood. A row whose own title or
 * sponsor says "Lorain County" is making a claim about ITSELF. A `state` column
 * is making a claim about whichever profile's crawl found the row.
 *
 * CROSS-STATE LEAKAGE CANNOT HAPPEN THROUGH THIS KEY. A prior agent found a
 * Raleigh County, WV profile matched to a Raleigh, NC grant. Three independent
 * conditions each block it: (1) the phrase is "<County> County", and a grant
 * for the CITY of Raleigh NC never writes that; (2) `fo.state` must equal the
 * profile's state; (3) a row whose title declares its own state in the
 * canonical `"<Place>, XX — "` shape must declare THIS state
 * (`declaredStateFromTitle`).
 *
 * All four vocabularies are CONSUMED, never hand-typed: the crisis need set is
 * the `basic_needs` group of `CANONICAL_NEED_CATEGORIES`; the place anchor is
 * `resolveZipLocation` (the resolver `profileHelpers` / `profileTaxonomy` /
 * `nationalZipCrawler` already use); phrase containment is `titleStatesTerm`;
 * the state-declaration refusal is `declaredStateFromTitle`.
 */

import { CANONICAL_NEED_CATEGORIES } from '../constants/needCategories.js'
import { titleStatesTerm, normalizeTerm } from './profileDerivedFacts.js'
import { declaredStateFromTitle } from './opportunityJurisdiction.js'
import { resolveZipLocation } from '../services/geo/zipCountyResolver.js'
import { isRegionCode } from '../../shared/usStateCodes.js'
import { isFabricatedGeoSource } from './placeholderProfileSignals.js'

/**
 * THE CRISIS NEED SET — the `basic_needs` group of the canonical registry, read
 * from the registry so a new basic need cannot silently fall out of this gate.
 * (housing, food, utilities, transportation, clothing_goods, cash_assistance,
 * emergency, legal.) A totality test asserts this is the whole group.
 */
export const CRISIS_NEED_IDS = Object.freeze(
  CANONICAL_NEED_CATEGORIES.filter((c) => c?.group === 'basic_needs').map((c) => c.id),
)

/** Membership test over the set above. */
export function isCrisisNeed(need) {
  return CRISIS_NEED_IDS.includes(String(need ?? '').trim().toLowerCase())
}

/**
 * What the second-level civil division is CALLED, per state. Louisiana has
 * parishes, Alaska boroughs/census areas, Puerto Rico municipios; everywhere
 * else it is a county. Getting this wrong does not mis-link — it simply fails
 * to match, which is silence, not a false positive.
 */
export const DEFAULT_COUNTY_SUFFIXES = Object.freeze(['county'])
export const COUNTY_SUFFIXES_BY_STATE = Object.freeze({
  LA: Object.freeze(['parish']),
  AK: Object.freeze(['borough', 'census area', 'municipality', 'city and borough']),
  PR: Object.freeze(['municipio']),
})

/** Every suffix that may legally follow a county name, for stripping. */
const ALL_SUFFIXES = Object.freeze([
  ...DEFAULT_COUNTY_SUFFIXES,
  ...Object.values(COUNTY_SUFFIXES_BY_STATE).flat(),
])

const SUFFIX_STRIP_RX = new RegExp(`[,\\s]+(?:${ALL_SUFFIXES.join('|')})\\b.*$`, 'i')

export function countySuffixesFor(state) {
  const st = String(state ?? '').trim().toUpperCase()
  return COUNTY_SUFFIXES_BY_STATE[st] ?? DEFAULT_COUNTY_SUFFIXES
}

/**
 * Two letters is a SHAPE; `REGION_CODES` is the AUTHORITY (#1094). A bare
 * `/^[A-Z]{2}$/` accepts "XX" and "ZZ", and it accepted the "SA" that
 * `inferLocationFromAddress` used to mint from the last two letters of "USA".
 */
function isStateCode(v) {
  return isRegionCode(String(v ?? '').trim().toUpperCase())
}

/**
 * "Bradley County, Tennessee" / "Doña Ana County" / "Lorain" → the bare county
 * NAME. Real prod profiles store all three shapes in the same field.
 */
export function normalizeCountyName(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  return s.replace(SUFFIX_STRIP_RX, '').replace(/,.*$/, '').trim()
}

/** The phrases a row must state about itself to claim this county. */
export function countyPhrasesFor(county, state) {
  const name = normalizeCountyName(county)
  if (!name) return []
  return countySuffixesFor(state).map((suffix) => `${name} ${suffix}`)
}

/**
 * THE PROFILE'S PLACE ANCHOR — a county AND a state, or nothing.
 *
 * Declared county wins. A ZIP is the fallback, and it is only as trustworthy as
 * the offline dataset behind `resolveZipLocation`, which is measurably wrong for
 * some ZIPs (37311 "Cleveland TN" resolves to Hamilton; the real county is
 * Bradley). So a ZIP-derived county must be CORROBORATED by a second field the
 * profile states itself: the resolver's city must equal the profile's declared
 * city. A profile that states a ZIP and no city gets no anchor — silence buys
 * nothing, in either direction.
 *
 * @returns {{county: string, state: string, via: 'declared'|'zip'}|null}
 */
export function resolveProfileCountyAnchor(place) {
  // A PLACEHOLDER address is positive junk evidence, not silence (#1094):
  // `{city:'Anytown', state:'USA', zip:'12345'}` resolves to a real, plausible
  // Schenectady NY that the applicant has no connection to. `profileHelpers`
  // gates its own ZIP rescues on this; this gate reads the raw sections, so it
  // must consult the SAME registry rather than rely on the city check below.
  if (isFabricatedGeoSource({ city: place?.city, state: place?.state, zip: place?.zip })) return null
  const declaredState = String(place?.state ?? '').trim().toUpperCase()
  const declaredCounty = normalizeCountyName(place?.county)
  if (declaredCounty && isStateCode(declaredState)) {
    return { county: declaredCounty, state: declaredState, via: 'declared' }
  }
  const zipLoc = resolveZipLocation(place?.zip)
  if (!zipLoc?.county || !isStateCode(zipLoc.state)) return null
  // A declared state that CONTRADICTS the ZIP is a conflict, not a fallback.
  if (isStateCode(declaredState) && declaredState !== zipLoc.state) return null
  const declaredCity = normalizeTerm(place?.city)
  if (!declaredCity || declaredCity !== normalizeTerm(zipLoc.city)) return null
  const county = normalizeCountyName(zipLoc.county)
  if (!county) return null
  return { county, state: zipLoc.state, via: 'zip' }
}

/**
 * SQL LIKE pattern for PREDICATE-based candidate discovery. Candidate discovery
 * must be a SQL predicate, never a post-`LIMIT` JS filter (the #944 "green while
 * doing nothing" signature is `scanned === bound` forever), so this returns a
 * deliberate SUPERSET on the bare county name that `rowNamesProfileCounty` then
 * adjudicates row by row at token boundaries.
 */
export function countyLikePattern(county) {
  const name = normalizeTerm(normalizeCountyName(county))
  return name ? `%${name}%` : null
}

/**
 * Does the ROW claim this county, in its own IDENTITY fields (title + sponsor)?
 * Description prose is deliberately excluded (#1086: a gate's phrase must be one
 * the SOURCE wrote about itself, not one a paragraph mentions in passing).
 *
 * Returns false when the row's title DECLARES a different state — the Raleigh
 * County WV / Raleigh NC guard.
 */
export function rowNamesProfileCounty(row, county, state) {
  const phrases = countyPhrasesFor(county, state)
  if (phrases.length === 0) return false
  const hay = `${row?.title ?? ''} ${row?.sponsor ?? ''}`
  if (!phrases.some((phrase) => titleStatesTerm(phrase, hay))) return false
  const declared = declaredStateFromTitle(row)
  if (declared && declared !== String(state ?? '').trim().toUpperCase()) return false
  return true
}

/**
 * Filter any need list down to the crisis set. Pure; the SOURCE of the list is
 * what makes a claim honest, and that is `declaredCrisisNeeds` below.
 */
export function crisisNeedsOf(needCategories) {
  const out = new Set()
  for (const n of needCategories ?? []) {
    const id = String(n ?? '').trim().toLowerCase()
    if (isCrisisNeed(id)) out.add(id)
  }
  return out
}

/**
 * THE PROFILE'S SIDE — a DECLARATION, never an inference.
 *
 * `normalizeProfile().needCategories` and `buildProfileSignals().needs` are both
 * the WRONG source for a gate that claims the profile "declares" a need, and
 * measured 2026-08-02 both fail in the #1095 veteran way:
 *
 *   • a `family` profile with COMPLETELY EMPTY sections yields
 *     `['cash_assistance','housing','food']` — the type-shaped fallback
 *     `buildProfileSignals` injects so `needs` is never empty (#1094 named this
 *     `needsDefaulted`: "we could not read it" is not "there is nothing").
 *     Every household profile in the fleet would clear a crisis-need conjunct
 *     without stating anything.
 *   • `signals.needs` reads FREE TEXT, so the narrative "We do not need housing
 *     assistance or rent help of any kind" mints `housing` FROM ITS OWN DENIAL —
 *     the exact class as #1095's veteran gate matching "veteran" inside a
 *     denial and handing a nonprofit 24 sources. It also MISSES the structured
 *     `financial.funding_needs: ['housing']` entirely.
 *
 * So this registry reads STRUCTURED fields only — arrays a human/interview
 * filled, section keys that ARE canonical needs, and strict `=== true` booleans
 * (never `housing_situation` prose, for the reason above). It mirrors the
 * structured half of `profileNormalizer`'s own `rawNeeds` block and resolves
 * every value through the canonical `normalizeNeedCategory`, so the vocabulary
 * cannot drift. A totality test pins the field list and asserts no entry reads
 * free text.
 *
 * Measured effect on the real fleet: it keeps the flagship (Hollie Knox really
 * does declare `housing`) and drops the imprecision this PR had honestly flagged
 * — Vermilion Church, Focus Forward and Anastasia never declared a housing need
 * at all; the normalizer inferred it.
 */
export const DECLARED_NEED_FIELDS = Object.freeze([
  Object.freeze({ id: 'profiles.needs', read: (p) => list(p?.needs) }),
  Object.freeze({ id: 'profiles.need_categories', read: (p) => list(p?.need_categories) }),
  Object.freeze({ id: 'section.needs', array: true, key: 'needs' }),
  Object.freeze({ id: 'section.need_categories', array: true, key: 'need_categories' }),
  Object.freeze({ id: 'section.primary_needs', array: true, key: 'primary_needs' }),
  Object.freeze({ id: 'section.support_needs', array: true, key: 'support_needs' }),
  Object.freeze({ id: 'section.funding_needs', array: true, key: 'funding_needs' }),
  Object.freeze({ id: 'section_key_is_a_need', sectionKey: true }),
])

/**
 * Housing-instability declarations that are BOOLEANS. `housing_situation` is
 * deliberately absent: it is prose, and prose cannot be told from its denial.
 */
export const HOUSING_INSTABILITY_FLAGS = Object.freeze([
  'housing_instability', 'risk_of_eviction', 'homeless', 'temporary_housing',
])

function list(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    const t = v.trim()
    if (t.startsWith('[')) { try { const p = JSON.parse(t); return Array.isArray(p) ? p : [] } catch { return [] } }
    return t ? [t] : []
  }
  return []
}

export function declaredCrisisNeeds(profile, sections, normalizeNeedCategory, needAliasMap) {
  const raw = []
  for (const f of DECLARED_NEED_FIELDS) {
    if (typeof f.read === 'function') { raw.push(...f.read(profile)); continue }
    for (const [sectionKey, sectionData] of Object.entries(sections ?? {})) {
      if (!sectionData || typeof sectionData !== 'object') continue
      const answers = sectionData.answers ?? sectionData
      if (!answers || typeof answers !== 'object') continue
      if (f.array) { raw.push(...list(answers[f.key])); continue }
      if (f.sectionKey) {
        const k = String(sectionKey).toLowerCase()
        const base = k.replace(/_information$/, '')
        if (needAliasMap?.[k]) raw.push(k)
        else if (base !== k && needAliasMap?.[base]) raw.push(base)
      }
    }
  }
  // Strict booleans only — `=== true`, the #1095 rule.
  for (const [sectionKey, sectionData] of Object.entries(sections ?? {})) {
    if (!/^(housing|shelter)(_information)?$/i.test(sectionKey)) continue
    const answers = sectionData?.answers ?? sectionData
    if (!answers || typeof answers !== 'object') continue
    if (HOUSING_INSTABILITY_FLAGS.some((flag) => answers[flag] === true)) raw.push('housing')
  }
  return crisisNeedsOf(raw.map((v) => normalizeNeedCategory?.(v)).filter(Boolean))
}

export function rowServesCrisisNeed(needTypesSupported, crisisNeeds) {
  if (!crisisNeeds || crisisNeeds.size === 0) return false
  for (const n of needTypesSupported ?? []) {
    if (crisisNeeds.has(String(n ?? '').trim().toLowerCase())) return true
  }
  return false
}

export default {
  CRISIS_NEED_IDS,
  DECLARED_NEED_FIELDS,
  HOUSING_INSTABILITY_FLAGS,
  declaredCrisisNeeds,
  COUNTY_SUFFIXES_BY_STATE,
  DEFAULT_COUNTY_SUFFIXES,
  isCrisisNeed,
  countySuffixesFor,
  normalizeCountyName,
  countyPhrasesFor,
  resolveProfileCountyAnchor,
  countyLikePattern,
  rowNamesProfileCounty,
  crisisNeedsOf,
  rowServesCrisisNeed,
}
