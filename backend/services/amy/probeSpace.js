/**
 * probeSpace.js — the ADVERSARIAL probe space Amy searches for holes.
 *
 * THE DEFECT THIS EXISTS TO CLOSE (2026-08-02)
 * -------------------------------------------
 * Amy's cohort was a FIXED CATALOG: 32 archetypes in `syntheticProfileCatalog`,
 * every one of them run every night, varied only by a seeded pick from a
 * hard-coded list of TEN cities. Measured in prod on 2026-08-02, the night's
 * `by_category` histogram is literally the catalog — the same 32 keys, 1 or 2
 * each. That is a REGRESSION SUITE, not a search: it re-asks the same 32
 * questions nightly and can only ever find holes it has already found.
 *
 * Two structural consequences, both measured:
 *   1. Every catalog archetype is SINGLE-AXIS — a veteran OR a business, a
 *      church OR a nonprofit. The planner gates on the INTERSECTION, so
 *      "a veteran starting a food truck in West Virginia" was UNTESTABLE.
 *   2. Forty of the fifty states, and every state's counties, had never been
 *      exercised at all (Indiana was absent from `LOCATIONS` entirely until
 *      PR #1095 added Kokomo).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * A 4-axis space whose values are READ OUT OF THE CANONICAL REGISTRIES — never
 * hand-typed here, because hand-typing a subset of a registry is the bug this
 * repo shipped three times in one week:
 *
 *   entity    ← `PROFILE_TYPES`               (services/profileTypeRegistry.js, 50)
 *   identity  ← `HEALTH_DIAGNOSIS_FLAGS` (services/profileHelpers.js)
 *             ∪ `STAGE_KNOWN`            (config/stageOfLifeEligibility.js)
 *             ∪ the `population` group of `CANONICAL_NEED_CATEGORIES`
 *   need      ← `CANONICAL_NEED_CATEGORIES`   (constants/needCategories.js, 32)
 *   geography ← `STATE_REGISTRY`              (services/shared/data/stateRegistry.js, 51)
 *
 * A CELL is one point in that space — `{entity, identity, need, state}` — i.e.
 * a real applicant intersection: "a veteran (identity) running a small business
 * (entity) who needs startup capital (need) in West Virginia (geography)".
 *
 * WHY PAIRWISE. The full space is ~1.98M plausible cells; at 50 probes a night it could
 * never be covered and "coverage" would be meaningless. The unit of coverage is
 * therefore the PAIR (2-wise combinatorial coverage, the standard result that
 * most interaction defects are exposed by some pair of factors): a cell covers
 * the six pairs among its four axis values, so 50 probes can retire up to 300
 * pairs a night against a denominator of 9,134 (measured 2026-08-02). That is a
 * finite, reportable horizon — and, crucially, a HONEST DENOMINATOR: the
 * convergence metric can say "gaps fell AND breadth rose", which is the only
 * way to tell "no gaps left" from "we stopped looking".
 *
 * TWO CLASSIFICATIONS ARE DECLARED HERE, AND BOTH ARE TOTAL.
 *   - `ROOT_CLASS` maps every ROOT of the profile-type registry's parent chains
 *     to individual/org. It is applied through `entityRoot`, so the 50 leaf
 *     types classify themselves; only the 7 roots the registry actually
 *     produces are declared (14 individual / 36 org, verified 2026-08-02).
 *   - `NEED_APPLICABILITY` classifies every one of the 32 canonical needs as
 *     individual / org / both. A person does not apply for "capacity building";
 *     a school district does not apply for "cash assistance". This is a
 *     judgement, so it is TOTALITY-TESTED (`amyProbeSpace.test.js` fails if a
 *     need is missing or unknown) rather than a filter over a subset.
 *
 * `LOCALITIES` supplies one real city/county/ZIP per state so the hyperlocal
 * and county lanes have something to gate on. Public place data only — the
 * same category of information as the ten cities it replaces, and no PII.
 *
 * Pure: no I/O, no clock, no randomness. Everything is a function of the
 * registries.
 */

import { PROFILE_TYPES } from '../profileTypeRegistry.js'
import { CANONICAL_NEED_CATEGORIES, NEED_CATEGORY_GROUPS } from '../../constants/needCategories.js'
import { STATE_REGISTRY } from '../shared/data/stateRegistry.js'
import { HEALTH_DIAGNOSIS_FLAGS } from '../profileHelpers.js'
import { STAGE_KNOWN } from '../../config/stageOfLifeEligibility.js'

// ── AXIS 1: ENTITY (what the applicant IS) ────────────────────────────────

/**
 * The class of every ROOT in the profile-type registry's parent chains.
 *
 * Declared at the ROOT, applied through `entityRoot`, so adding a new leaf
 * type to `PROFILE_TYPES` classifies itself. A root this map does not know is a
 * TEST FAILURE, never a silent default — `amyProbeSpace.test.js` enumerates the
 * roots the live registry actually produces and asserts each is present.
 *
 * `educator` is individual because a teacher is a PERSON who applies for
 * classroom funding; `school` is the institution. `other` is org because the
 * org shape is the conservative one — it asks for organizational identifiers a
 * person's profile simply leaves blank, rather than asserting a household.
 */
export const ROOT_CLASS = Object.freeze({
  individual: 'individual',
  educator: 'individual',
  business: 'org',
  nonprofit: 'org',
  public_agency: 'org',
  school: 'org',
  other: 'org',
})

export const ENTITY_IDS = Object.freeze(Object.keys(PROFILE_TYPES))

/**
 * The root of a profile type's parent chain (itself when it has no parents).
 *
 * TRAP: `parentTypes` is NOT ordered furthest-last. `medical_need` declares
 * `['individual','family']` and `regional_planning_agency` declares
 * `['public_agency','local_government']`, so taking the LAST element returns a
 * MID-chain type (`family`, `local_government`) and six of the fifty types
 * classified as `null` — they would have silently left the entity axis and
 * shrunk the coverage denominator without failing anything. Walk `parentTypes[0]`
 * transitively instead, which terminates on a genuine root for all 50.
 */
export function entityRoot(entityId) {
  let cur = String(entityId ?? '')
  const seen = new Set()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const parents = PROFILE_TYPES[cur]?.parentTypes
    if (!Array.isArray(parents) || parents.length === 0) return cur
    cur = String(parents[0])
  }
  return cur
}

/** 'individual' | 'org' — derived, never hand-typed per leaf type. */
export function entityClass(entityId) {
  return ROOT_CLASS[entityRoot(entityId)] || null
}

/** Every root the LIVE registry produces (the totality test's denominator). */
export function observedEntityRoots() {
  return [...new Set(ENTITY_IDS.map(entityRoot))].sort()
}

// ── AXIS 2: IDENTITY (who the applicant is, or whom an org serves) ────────

/**
 * WHICH AXIS EACH NEED GROUP BELONGS TO.
 *
 * The canonical need registry mixes three different KINDS of thing behind one
 * `id`, and the first cut of this module put all of them on the need axis. The
 * result was measurably incoherent probes — "an animal rescue that needs
 * *women*", "a food pantry that needs *municipality*" — which burn a nightly
 * slot on a question no applicant asks and whose "gap" proves nothing. The
 * groups are therefore assigned a ROLE:
 *
 *   need              a thing an applicant is trying to solve → the NEED axis
 *   identity          who the applicant is / whom they serve → the IDENTITY axis
 *   entity_descriptor what kind of body is applying → already the ENTITY axis
 *
 * TOTAL over `NEED_CATEGORY_GROUPS` — a new group with no role fails
 * `amyProbeSpace.test.js` rather than silently vanishing from the space (which
 * would shrink the coverage denominator with nothing to show for it).
 */
export const NEED_GROUP_ROLE = Object.freeze({
  basic_needs: 'need',
  health_wellness: 'need',
  education_career: 'need',
  specialized: 'need',
  population: 'identity',
  organization: 'entity_descriptor',
})

/** Group ids the live registry declares (the totality test's denominator). */
export const OBSERVED_NEED_GROUPS = Object.freeze(
  [...new Set([
    ...NEED_CATEGORY_GROUPS.map((g) => g.key),
    ...CANONICAL_NEED_CATEGORIES.map((n) => n.group),
  ])].filter(Boolean).sort(),
)

/**
 * The population-facing need ids are a `group` in the canonical need registry,
 * so the population identities are READ from it rather than restated.
 */
const POPULATION_IDENTITIES = Object.freeze(
  CANONICAL_NEED_CATEGORIES.filter((n) => NEED_GROUP_ROLE[n.group] === 'identity').map((n) => n.id),
)

/**
 * The identity axis. `none` is a first-class value: an applicant who declares
 * no population/health/stage identity is the commonest real profile, and it
 * must stay reachable or the space would probe only edge cases.
 *
 * SEMANTICS DIFFER BY ENTITY CLASS AND THAT IS THE POINT: an individual entity
 * IS the identity ("a veteran"); an org entity SERVES it ("a nonprofit serving
 * veterans"). Both are real product questions and both were untested.
 */
export const IDENTITY_IDS = Object.freeze([
  'none',
  ...POPULATION_IDENTITIES,
  ...[...HEALTH_DIAGNOSIS_FLAGS].map((f) => `health:${f}`),
  ...STAGE_KNOWN.filter((s) => s !== 'unclassified').map((s) => `stage:${s}`),
])

/** Split an identity id into its kind + bare token. */
export function identityParts(identityId) {
  const raw = String(identityId ?? 'none')
  if (raw === 'none') return { kind: 'none', token: null }
  const idx = raw.indexOf(':')
  if (idx === -1) return { kind: 'population', token: raw }
  return { kind: raw.slice(0, idx), token: raw.slice(idx + 1) }
}

// ── AXIS 3: NEED (what the applicant is trying to solve) ──────────────────

/**
 * The NEED axis: only the groups whose role is `need`. Population ids live on
 * the identity axis and organization ids are already the entity axis, so
 * including them here would double-count them and mint incoherent cells.
 */
export const NEED_IDS = Object.freeze(
  CANONICAL_NEED_CATEGORIES.filter((n) => NEED_GROUP_ROLE[n.group] === 'need').map((n) => n.id),
)

/**
 * need id → the canonical registry row (label / query vocabulary / group).
 * Keyed over the WHOLE registry, not just the need axis: the identity axis
 * reads population rows out of it for their vocabulary.
 */
export const NEED_BY_ID = Object.freeze(
  Object.fromEntries(CANONICAL_NEED_CATEGORIES.map((n) => [n.id, n])),
)

/**
 * Which entity class can plausibly ASK for each canonical need.
 *
 * TOTAL over `CANONICAL_NEED_CATEGORIES` — a missing or unknown id fails
 * `amyProbeSpace.test.js`. This exists to keep PRECISION over volume: probing
 * "a school district needing cash assistance" burns one of fifty nightly slots
 * on a question no real applicant asks, and a gap it "finds" is not a gap.
 *
 * `both` is used wherever the need is genuinely asked by people AND
 * organizations (food, housing, legal, disaster, technology, agriculture…).
 */
export const NEED_APPLICABILITY = Object.freeze({
  // Basic needs — a household asks; a shelter/pantry/agency also asks, for the
  // people it houses and feeds.
  housing: 'both',
  food: 'both',
  utilities: 'both',
  transportation: 'both',
  clothing_goods: 'both',
  cash_assistance: 'individual',
  emergency: 'both',
  legal: 'both',
  // Health & wellness.
  health_medical: 'both',
  mental_health: 'both',
  disability: 'both',
  substance_recovery: 'both',
  // Education & career.
  education: 'both',
  employment: 'both',
  technology_equipment: 'both',
  business: 'both',
  // Population-specific — a person belongs to the population, an org serves it.
  veteran: 'both',
  senior: 'both',
  children_youth: 'both',
  family_life: 'both',
  women: 'both',
  minority: 'both',
  immigrant_refugee: 'both',
  tribal: 'both',
  // Organization types — nobody applies to these as a PERSON; they describe the
  // applying institution.
  nonprofit_ministry: 'org',
  public_safety: 'org',
  municipality: 'org',
  // Specialized.
  research_arts: 'both',
  environment: 'org',
  agriculture: 'both',
  community_development: 'org',
  rural: 'both',
})

// ── AXIS 4: GEOGRAPHY (all 50 states + DC, not ten cities) ────────────────

export const STATE_IDS = Object.freeze(Object.keys(STATE_REGISTRY))

/**
 * One real city / county / downtown ZIP per state, so the county and hyperlocal
 * lanes have a place to gate on. PUBLIC PLACE DATA ONLY — the same category of
 * information as the ten cities this replaces, and no personal data of any kind.
 *
 * TOTALITY-TESTED against `STATE_REGISTRY`: a state with no locality would
 * silently drop out of the geography axis and the coverage denominator would
 * quietly shrink — exactly the "stopped looking" failure this whole module
 * exists to make impossible.
 *
 * Places are deliberately mid-size / non-metro where a state has one: the
 * hyperlocal recall question is far more interesting outside the largest metro,
 * and prod's own gap history clusters there. Virginia uses a TOWN in a county
 * (Christiansburg / Montgomery) rather than one of the state's independent
 * cities, so `county` is a real county everywhere.
 */
export const LOCALITIES = Object.freeze({
  AL: { city: 'Birmingham', county: 'Jefferson', zip: '35203' },
  AK: { city: 'Anchorage', county: 'Anchorage', zip: '99501' },
  AZ: { city: 'Phoenix', county: 'Maricopa', zip: '85003' },
  AR: { city: 'Little Rock', county: 'Pulaski', zip: '72201' },
  CA: { city: 'Fresno', county: 'Fresno', zip: '93721' },
  CO: { city: 'Pueblo', county: 'Pueblo', zip: '81003' },
  CT: { city: 'New Haven', county: 'New Haven', zip: '06510' },
  DE: { city: 'Wilmington', county: 'New Castle', zip: '19801' },
  DC: { city: 'Washington', county: 'District of Columbia', zip: '20001' },
  FL: { city: 'Pensacola', county: 'Escambia', zip: '32502' },
  GA: { city: 'Albany', county: 'Dougherty', zip: '31701' },
  HI: { city: 'Honolulu', county: 'Honolulu', zip: '96813' },
  ID: { city: 'Boise', county: 'Ada', zip: '83702' },
  IL: { city: 'Rockford', county: 'Winnebago', zip: '61101' },
  IN: { city: 'Kokomo', county: 'Howard', zip: '46901' },
  IA: { city: 'Des Moines', county: 'Polk', zip: '50309' },
  KS: { city: 'Wichita', county: 'Sedgwick', zip: '67202' },
  KY: { city: 'Hazard', county: 'Perry', zip: '41701' },
  LA: { city: 'Shreveport', county: 'Caddo', zip: '71101' },
  ME: { city: 'Bangor', county: 'Penobscot', zip: '04401' },
  MD: { city: 'Cumberland', county: 'Allegany', zip: '21502' },
  MA: { city: 'Springfield', county: 'Hampden', zip: '01103' },
  MI: { city: 'Flint', county: 'Genesee', zip: '48502' },
  MN: { city: 'Duluth', county: 'St. Louis', zip: '55802' },
  MS: { city: 'Jackson', county: 'Hinds', zip: '39201' },
  MO: { city: 'Springfield', county: 'Greene', zip: '65806' },
  MT: { city: 'Billings', county: 'Yellowstone', zip: '59101' },
  NE: { city: 'Omaha', county: 'Douglas', zip: '68102' },
  NV: { city: 'Reno', county: 'Washoe', zip: '89501' },
  NH: { city: 'Manchester', county: 'Hillsborough', zip: '03101' },
  NJ: { city: 'Camden', county: 'Camden', zip: '08103' },
  NM: { city: 'Gallup', county: 'McKinley', zip: '87301' },
  NY: { city: 'Buffalo', county: 'Erie', zip: '14202' },
  NC: { city: 'Greenville', county: 'Pitt', zip: '27834' },
  ND: { city: 'Fargo', county: 'Cass', zip: '58102' },
  OH: { city: 'Columbus', county: 'Franklin', zip: '43215' },
  OK: { city: 'Tulsa', county: 'Tulsa', zip: '74103' },
  OR: { city: 'Medford', county: 'Jackson', zip: '97501' },
  PA: { city: 'Erie', county: 'Erie', zip: '16501' },
  RI: { city: 'Providence', county: 'Providence', zip: '02903' },
  SC: { city: 'Florence', county: 'Florence', zip: '29501' },
  SD: { city: 'Rapid City', county: 'Pennington', zip: '57701' },
  TN: { city: 'Nashville', county: 'Davidson', zip: '37203' },
  TX: { city: 'El Paso', county: 'El Paso', zip: '79901' },
  UT: { city: 'Ogden', county: 'Weber', zip: '84401' },
  VT: { city: 'Rutland', county: 'Rutland', zip: '05701' },
  VA: { city: 'Christiansburg', county: 'Montgomery', zip: '24073' },
  WA: { city: 'Spokane', county: 'Spokane', zip: '99201' },
  WV: { city: 'Beckley', county: 'Raleigh', zip: '25801' },
  WI: { city: 'Green Bay', county: 'Brown', zip: '54301' },
  WY: { city: 'Casper', county: 'Natrona', zip: '82601' },
})

/** The full locality record for a state (never invents one). */
export function localityFor(stateCode) {
  const loc = LOCALITIES[String(stateCode ?? '').toUpperCase()]
  return loc ? { state: String(stateCode).toUpperCase(), ...loc } : null
}

// ── CELLS + PAIRS ─────────────────────────────────────────────────────────

/** The axis names, in the fixed order every pair key is built from. */
export const AXES = Object.freeze(['entity', 'identity', 'need', 'state'])

/** Stable key for one cell. */
export function cellKey(cell) {
  return AXES.map((a) => `${a}=${cell?.[a] ?? ''}`).join('|')
}

/** Parse a cell key back into a cell (tolerant; unknown keys yield nulls). */
export function parseCellKey(key) {
  const out = {}
  for (const part of String(key ?? '').split('|')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    out[part.slice(0, idx)] = part.slice(idx + 1)
  }
  return AXES.every((a) => out[a]) ? out : null
}

/** The six unordered axis pairs a cell covers. */
export function cellPairs(cell) {
  const pairs = []
  for (let i = 0; i < AXES.length; i++) {
    for (let j = i + 1; j < AXES.length; j++) {
      pairs.push(`${AXES[i]}:${cell?.[AXES[i]] ?? ''}~${AXES[j]}:${cell?.[AXES[j]] ?? ''}`)
    }
  }
  return pairs
}

/**
 * Is this cell a question a real applicant could ask?
 *
 * The ONLY restriction is the need↔entity-class one. Identity is deliberately
 * unrestricted: an org "serving" a population or a diagnosis is as real a
 * question as a person "being" one, and those org×identity intersections
 * (a disease-specific nonprofit, a school serving high-schoolers) are precisely
 * the cells the single-axis catalog could never reach.
 */
export function isPlausibleCell(cell) {
  const klass = entityClass(cell?.entity)
  if (!klass) return false
  if (!IDENTITY_IDS.includes(String(cell?.identity))) return false
  if (!STATE_IDS.includes(String(cell?.state))) return false
  const applies = NEED_APPLICABILITY[String(cell?.need)]
  if (!applies) return false
  return applies === 'both' || applies === klass
}

/**
 * The DENOMINATOR: every pair that a plausible cell could ever cover.
 *
 * Computed from the axes rather than by enumerating cells (the cell space is
 * ~2.4M), and restricted to pairs a PLAUSIBLE cell can actually reach — an
 * unreachable pair in the denominator would make 100% coverage impossible and
 * turn the convergence metric into decoration.
 */
export function enumerateReachablePairs() {
  const pairs = new Set()
  const classOf = Object.fromEntries(ENTITY_IDS.map((e) => [e, entityClass(e)]))
  const needsFor = (klass) => NEED_IDS.filter((n) => {
    const a = NEED_APPLICABILITY[n]
    return a === 'both' || a === klass
  })
  const needsByClass = { individual: needsFor('individual'), org: needsFor('org') }
  const anyNeed = new Set([...needsByClass.individual, ...needsByClass.org])

  for (const e of ENTITY_IDS) {
    const klass = classOf[e]
    if (!klass) continue
    for (const i of IDENTITY_IDS) pairs.add(`entity:${e}~identity:${i}`)
    for (const n of needsByClass[klass]) pairs.add(`entity:${e}~need:${n}`)
    for (const s of STATE_IDS) pairs.add(`entity:${e}~state:${s}`)
  }
  for (const i of IDENTITY_IDS) {
    for (const n of anyNeed) pairs.add(`identity:${i}~need:${n}`)
    for (const s of STATE_IDS) pairs.add(`identity:${i}~state:${s}`)
  }
  for (const n of anyNeed) {
    for (const s of STATE_IDS) pairs.add(`need:${n}~state:${s}`)
  }
  return pairs
}

/** Size of the reachable pair space (the convergence denominator). */
export function reachablePairCount() {
  return enumerateReachablePairs().size
}

/** Total plausible CELLS — reported for honesty about what pairwise omits. */
export function plausibleCellCount() {
  let total = 0
  for (const e of ENTITY_IDS) {
    const klass = entityClass(e)
    if (!klass) continue
    const needs = NEED_IDS.filter((n) => {
      const a = NEED_APPLICABILITY[n]
      return a === 'both' || a === klass
    }).length
    total += needs * IDENTITY_IDS.length * STATE_IDS.length
  }
  return total
}

export default {
  AXES,
  ROOT_CLASS,
  ENTITY_IDS,
  IDENTITY_IDS,
  NEED_IDS,
  NEED_BY_ID,
  NEED_APPLICABILITY,
  STATE_IDS,
  LOCALITIES,
  entityRoot,
  entityClass,
  observedEntityRoots,
  identityParts,
  localityFor,
  cellKey,
  parseCellKey,
  cellPairs,
  isPlausibleCell,
  enumerateReachablePairs,
  reachablePairCount,
  plausibleCellCount,
}
