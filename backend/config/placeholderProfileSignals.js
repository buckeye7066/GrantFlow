/**
 * placeholderProfileSignals.js — the canonical, evidence-based test for a
 * profile that CANNOT BE SERVED because it declares nothing real.
 *
 * WHY THIS EXISTS (2026-08-02). The owner's standing goal is that "the crawlers
 * will always pull information from the profile prior to crawling … and add to
 * the database returns that fall below the profile's requested result number."
 * If the crawlers truly read the profile first, they would NOTICE THERE IS
 * NOTHING IN IT. They did not. Measured read-only in prod 2026-08-02T02:40Z,
 * `profile-melissa-justus` carries
 *
 *   basic_information.address = { street:'123 Main St', city:'Anytown',
 *                                 state:'USA', zip_code:'12345' }
 *   basic_information.email   = 'melissa.justus@example.com'  phone '555-1234'
 *   basic_information.notes   = 'Designated roster profile. Add the owner login
 *                                email here and in userProfileMappings.js …'
 *   location_focus.notes      = 'Synthetic location signal for crawler and
 *                                matcher coverage.'
 *
 * and NO education / health / financial / occupation / needs content at all —
 * yet 27 surfaced matches, every one a DIRECTORY, with INVENTED geography
 * (`Anytown, SA`, `Anchorage County, AK`, `Wayne County, MI`, `Dona Ana
 * County, NM`). It also sat in the result floor's "below target" set, which
 * would drive endless backfill for a profile that can never be satisfied —
 * manufacturing junk to hit a quota.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RULE, AND WHY A SPARSE-BUT-REAL PROFILE SURVIVES IT
 * ────────────────────────────────────────────────────────────────────────────
 *
 * A profile is UNCONFIGURED iff BOTH hold:
 *
 *   (A) MANDATORY — the `no_substance` family: NONE of the SUBSTANCE_PROBES
 *       fires. A substance probe reads the derivations the CRAWLERS THEMSELVES
 *       consume (`buildProfileSignals`, `deriveProfileFacts`) plus the canonical
 *       declared-fact sections. One single real declared fact — a need, a
 *       health condition, an occupation flag, a school, an income, a field of
 *       study, a stage of life, an aid-type preference, a program/service —
 *       and the profile is NEVER unconfigured, no matter how fake its address
 *       looks.
 *
 *   (B) CORROBORATION — at least MIN_CORROBORATING_FAMILIES (2) of the three
 *       remaining families (`identity`, `address`, `self_declared`) each
 *       contribute at least one signal.
 *
 * So the threshold is THREE families, one of which must be `no_substance`.
 * No single signal can ever decide this on its own — deliberately, because
 * every individual signal has a real-world false positive:
 *
 *   • `location_focus.notes = 'Synthetic location signal for crawler and
 *     matcher coverage.'` is carried by REAL prod profiles. `Angelika Ptak`
 *     (prod, 2 matches) has it — and a real gmail address, an empty address
 *     block, and `occupation.healthcare_worker = true`. Substance fires, so
 *     (A) fails and she is never flagged. Measured: her `signals.occupation`
 *     is `['healthcare_worker']` where all three placeholders' is `[]`.
 *   • `555-…` numbers and `example.com` addresses appear in real test data
 *     attached to real people mid-intake.
 *   • A brand-new signup with a real email and nothing filled in yet trips (A)
 *     but ZERO corroborating families, so it is left alone — "empty" is not
 *     "placeholder", and we would rather under-call than delete a real
 *     person's results.
 *
 * NOTHING HERE EVER EDITS A PROFILE. This module only produces a VERDICT plus
 * the named prerequisites a human must supply.
 */

import { normalizeState } from '../utils/stateNormalization.js'

/** The four evidence families. A verdict cites the family of every signal. */
export const PLACEHOLDER_SIGNAL_FAMILY = Object.freeze({
  IDENTITY: 'identity',
  ADDRESS: 'address',
  SELF_DECLARED: 'self_declared',
  NO_SUBSTANCE: 'no_substance',
})

/**
 * Corroborating families required BESIDES the mandatory `no_substance`.
 * 2 → three families total. Raising this makes the detector stricter; lowering
 * it below 2 would let a single family (e.g. a `555-` phone) decide, which is
 * exactly the "floor of ONE shared word" class this repo has shipped three
 * times (#937 / #943 / the Yana one-token gate).
 */
export const MIN_CORROBORATING_FAMILIES = 2

/**
 * RFC 2606 / RFC 6761 reserved domains — these can never belong to a real
 * mailbox, by standard. Not a denylist of "suspicious" hosts.
 */
export const PLACEHOLDER_EMAIL_DOMAINS = Object.freeze(
  new Set(['example.com', 'example.org', 'example.net', 'example.edu', 'invalid', 'localhost', 'test']),
)

/** Placeholder CITY tokens. Normalized lowercase, whole-value comparison. */
export const PLACEHOLDER_CITY_TOKENS = Object.freeze(
  new Set(['anytown', 'any town', 'yourtown', 'your town', 'your city', 'sometown', 'cityville', 'city name']),
)

/**
 * Placeholder ZIPs. NOTE `12345` IS a real, assigned ZIP (a single GE building
 * in Schenectady, NY) — which is exactly why it is dangerous: on its own it
 * looks resolvable. It is therefore never decisive alone; see
 * `isFabricatedGeoSource`.
 */
export const PLACEHOLDER_ZIP_CODES = Object.freeze(
  new Set(['12345', '00000', '11111', '54321', '99999']),
)

/** Placeholder STREET lines (the classic docs/sample address). */
export const PLACEHOLDER_STREET_RX =
  /^(?:123|1234)\s{1,3}(?:main|elm|any)\s{1,3}(?:st|street|ave|avenue|rd|road|ln|lane|dr|drive)\.?$/i

/** NANP-reserved fictional exchange (555-0100..555-0199 and the bare 555-XXXX
 *  form real placeholder data uses), plus the "1234567890" keyboard run. */
export const PLACEHOLDER_PHONE_RX =
  /^\+?1?[\s\-.()]{0,4}(?:555[\s\-.()]{0,4}\d{4}|234[\s\-.()]{0,4}567[\s\-.()]{0,4}890)$/

/** Placeholder person names. Whole-value comparison after normalization. */
export const PLACEHOLDER_NAME_TOKENS = Object.freeze(
  new Set(['john doe', 'jane doe', 'john q public', 'test user', 'first last', 'your name']),
)

/**
 * Text a profile carries that DECLARES ITSELF a placeholder. These are phrases
 * GrantFlow's own seeders write, so this is self-report, not inference.
 */
export const SELF_DECLARED_PLACEHOLDER_RX =
  /(designated roster profile|demo profile|synthetic location signal|placeholder profile|sample profile|for (?:validating|testing) (?:intake|grantflow)|update as needed|add the owner login email)/i

/**
 * SQL LIKE superset used for CANDIDATE DISCOVERY (never as the authority).
 * The sweep narrows `profile_sections` with these in the WHERE clause so a
 * bound can only ever limit DELETES, never DISCOVERY — the #944 post-`LIMIT`
 * class this repo has been bitten by four times. `detectUnconfiguredProfile`
 * is the authority and re-adjudicates every candidate the SQL returns.
 */
export const PLACEHOLDER_SECTION_LIKE_PATTERNS = Object.freeze([
  '%@example.com%',
  '%@example.org%',
  '%@example.net%',
  '%Anytown%',
  '%anytown%',
  '%123 Main St%',
  '%123 Main Street%',
  '%555-1234%',
  '%Designated roster profile%',
  '%Demo profile%',
  '%Synthetic location signal%',
  '%placeholder profile%',
])

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const norm = (v) => str(v).toLowerCase().replace(/\s+/g, ' ')
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const size = (v) => {
  if (!v) return 0
  if (Array.isArray(v)) return v.filter(Boolean).length
  if (v instanceof Set) return v.size
  if (typeof v === 'object') return Object.keys(v).length
  return 0
}

/**
 * A section COUNTS as declared content only when it holds a value a human
 * actually supplied. An object of empty strings / zeros / `false` flags is a
 * blank form, not a declaration — counting keys would make every seeded
 * section look like substance.
 */
const NON_ANSWERS = new Set(['', 'n/a', 'na', 'none', 'unknown', 'not applicable', 'tbd'])
function hasDeclaredContent(section) {
  const s = obj(section)
  for (const value of Object.values(s)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'boolean') { if (value === true) return true; continue }
    if (typeof value === 'number') { if (Number.isFinite(value) && value !== 0) return true; continue }
    if (typeof value === 'string') { if (!NON_ANSWERS.has(norm(value))) return true; continue }
    if (Array.isArray(value)) { if (value.filter(Boolean).length > 0) return true; continue }
    if (typeof value === 'object' && hasDeclaredContent(value)) return true
  }
  return false
}

/** A structurally well-formed EIN (`12-3456789`) — not prose, not "N/A". */
const EIN_RX = /^\d{2}-?\d{7}$/
/** A structurally well-formed SAM.gov UEI: 12 alphanumerics. */
const UEI_RX = /^[A-Z0-9]{12}$/i

/** Every free-text note field a seeder could stamp a self-declaration into. */
function selfDeclaredText(sections) {
  const s = obj(sections)
  return [
    obj(s.basic_information).notes,
    obj(s.location_focus).notes,
    obj(s.financial_information).notes,
    obj(s.narrative).mission,
    obj(s.narrative).primary_goal,
  ]
    .map(str)
    .filter(Boolean)
    .join(' • ')
}

/**
 * PLACEHOLDER_SIGNALS — the registry. Each entry names the family it belongs
 * to, the PREREQUISITE a human must supply to clear it (the "blocked, with the
 * prerequisite named" posture the EVA runner uses), and a pure test.
 *
 * Totality-tested: every family in PLACEHOLDER_SIGNAL_FAMILY except
 * `no_substance` (which is derived from SUBSTANCE_PROBES) must be represented,
 * and every id must be unique.
 */
export const PLACEHOLDER_SIGNALS = Object.freeze([
  {
    id: 'reserved_email_domain',
    family: PLACEHOLDER_SIGNAL_FAMILY.IDENTITY,
    prerequisite: 'basic_information.email — a real, reachable email address',
    test({ sections }) {
      const email = norm(obj(obj(sections).basic_information).email)
      const at = email.lastIndexOf('@')
      if (at < 0) return null
      const domain = email.slice(at + 1)
      return PLACEHOLDER_EMAIL_DOMAINS.has(domain) ? `email domain "${domain}" is RFC-reserved` : null
    },
  },
  {
    id: 'fictional_phone',
    family: PLACEHOLDER_SIGNAL_FAMILY.IDENTITY,
    prerequisite: 'basic_information.phone — a real phone number',
    test({ sections }) {
      const phone = str(obj(obj(sections).basic_information).phone)
      if (!phone) return null
      return PLACEHOLDER_PHONE_RX.test(phone) ? `phone "${phone}" is a reserved/fictional number` : null
    },
  },
  {
    id: 'placeholder_person_name',
    family: PLACEHOLDER_SIGNAL_FAMILY.IDENTITY,
    prerequisite: 'basic_information.full_name — the applicant’s real name',
    test({ profile, sections }) {
      const name = norm(obj(obj(sections).basic_information).full_name) || norm(obj(profile).display_name)
      if (!name) return null
      return PLACEHOLDER_NAME_TOKENS.has(name) ? `name "${name}" is a placeholder` : null
    },
  },
  {
    id: 'placeholder_street',
    family: PLACEHOLDER_SIGNAL_FAMILY.ADDRESS,
    prerequisite: 'basic_information.address.street — a real street address',
    test({ sections }) {
      const addr = obj(obj(sections).basic_information).address
      const street = typeof addr === 'string' ? addr : str(obj(addr).street || obj(addr).line1)
      if (!street) return null
      return PLACEHOLDER_STREET_RX.test(street) ? `street "${street}" is a sample address` : null
    },
  },
  {
    id: 'placeholder_city',
    family: PLACEHOLDER_SIGNAL_FAMILY.ADDRESS,
    prerequisite: 'basic_information.address.city — the city the applicant lives in',
    test({ sections }) {
      const addr = obj(obj(sections).basic_information).address
      const city = norm(obj(addr).city)
      if (!city) return null
      return PLACEHOLDER_CITY_TOKENS.has(city) ? `city "${city}" is a placeholder` : null
    },
  },
  {
    id: 'unresolvable_state',
    family: PLACEHOLDER_SIGNAL_FAMILY.ADDRESS,
    prerequisite: 'basic_information.address.state — a 2-letter US state/territory code',
    test({ sections }) {
      const addr = obj(obj(sections).basic_information).address
      const raw = str(obj(addr).state || obj(addr).region)
      if (!raw) return null
      // The canonical registry decides — never a hand-typed list of codes.
      return normalizeState(raw) ? null : `state "${raw}" is not a valid state/territory code`
    },
  },
  {
    id: 'self_declared_placeholder',
    family: PLACEHOLDER_SIGNAL_FAMILY.SELF_DECLARED,
    prerequisite: 'the profile’s own notes still say it is a roster/demo/synthetic placeholder',
    test({ sections }) {
      const text = selfDeclaredText(sections)
      const m = text.match(SELF_DECLARED_PLACEHOLDER_RX)
      return m ? `notes declare: "${m[0]}"` : null
    },
  },
])

/**
 * SUBSTANCE_PROBES — what makes a profile SERVABLE. Each probe reads a
 * derivation the crawlers themselves consume, or a canonical declared-fact
 * section. ANY ONE firing means the profile is NOT unconfigured.
 *
 * `prerequisite` is what gets reported to the owner when NOTHING fires: the
 * specific things that must be filled in before a crawl can mean anything.
 */
export const SUBSTANCE_PROBES = Object.freeze([
  {
    // DECLARED needs, read at the DECLARATION SITES — never `signals.needs`.
    //
    // `signals.needs` is INFERRED, and measured against prod on 2026-08-02 it
    // is inferred from things that are not declarations:
    //   • it is NEVER empty — `buildProfileSignals` injects a type-shaped
    //     fallback, which is where John Doe's whole need list
    //     (utilities/housing/food/healthcare/cash_assistance) came from;
    //   • on `profile-melissa-justus` its only two entries (`cash_assistance`,
    //     `internet`) come from `organization_details` boolean flags
    //     (`broadband_unserved`, …) on a profile whose `primary_type` is
    //     `individual` — the documented Kimberly-Botts hallucination class
    //     (`enforceIndividualOrgSectionConflict`), i.e. an AI-enrichment
    //     artifact derived from an address reading "Anytown, USA".
    // `needsDefaulted` is still consulted so the fallback can never count, but
    // the authority is what the profile actually filled in. `profileSchema`
    // names the declaration sites: need CATEGORIES are controlled tags on
    // `programs_services`, plus the explicit need arrays and health supports.
    id: 'declared_needs',
    prerequisite: 'a declared NEED (housing, medical, education, food, …)',
    read: ({ profile, sections }) => {
      const p = obj(profile)
      const s = obj(sections)
      if (size(p.needs) > 0 || size(p.need_categories) > 0) return true
      if (hasDeclaredContent(s.needs) || hasDeclaredContent(s.assistance_needs)) return true
      const health = obj(s.health)
      return size(health.support_needs) > 0 || size(health.conditions) > 0
    },
  },
  {
    // A public-benefit enrolment is a hard, human-entered eligibility fact.
    id: 'sections.government_assistance',
    prerequisite: 'public benefits currently received (SNAP / TANF / SSI / Section 8 …)',
    read: ({ sections }) => hasDeclaredContent(obj(sections).government_assistance),
  },
  {
    id: 'sections.housing',
    prerequisite: 'housing status',
    read: ({ sections }) => hasDeclaredContent(obj(sections).housing),
  },
  {
    id: 'signals.health',
    prerequisite: 'a health condition or support need, if any applies',
    read: ({ signals }) => size(obj(signals).health) > 0,
  },
  {
    id: 'signals.occupation',
    prerequisite: 'an occupation / employment status',
    read: ({ signals }) => size(obj(signals).occupation) > 0,
  },
  {
    id: 'signals.demographics',
    prerequisite: 'demographic eligibility facts (age band, veteran status, …)',
    read: ({ signals }) => size(obj(signals).demographics) > 0,
  },
  {
    id: 'facts.topicalTerms',
    prerequisite: 'a field of study or subject interest',
    read: ({ facts }) => size(obj(facts).topicalTerms) > 0,
  },
  {
    id: 'facts.stageOfLife',
    prerequisite: 'education stage (high school / undergraduate / graduate)',
    read: ({ facts }) => Boolean(obj(facts).stageOfLife?.value),
  },
  {
    id: 'facts.institutions',
    prerequisite: 'a school attended or applied to',
    read: ({ facts }) => {
      const i = obj(obj(facts).institutions)
      return size(i.attended) > 0 || size(i.aspirational) > 0
    },
  },
  {
    id: 'facts.academicStanding',
    prerequisite: 'GPA / ACT / SAT, if a student',
    read: ({ facts }) => {
      const a = obj(obj(facts).academicStanding)
      return Boolean(a.gpa?.value || a.act?.value || a.sat?.value)
    },
  },
  {
    id: 'facts.acceptedAidTypes',
    prerequisite: 'which aid types are acceptable (grant / scholarship / loan)',
    read: ({ facts }) => obj(obj(facts).acceptedAidTypes).declared === true,
  },
  {
    id: 'sections.education',
    prerequisite: 'the education section',
    read: ({ sections }) => hasDeclaredContent(obj(sections).education),
  },
  {
    id: 'sections.financial_income',
    prerequisite: 'household income or an honest financial-need level',
    read: ({ sections }) => {
      const fin = { ...obj(obj(sections).financial), ...obj(obj(sections).financial_information) }
      const income = Number(fin.household_income ?? fin.annual_income ?? NaN)
      if (Number.isFinite(income) && income > 0) return true
      const level = norm(fin.financial_need_level)
      // "Unknown" is SILENCE, not a declaration (the `not_listed` vs
      // `none_published` rule, one level up).
      return Boolean(level) && !NON_ANSWERS.has(level)
    },
  },
  {
    id: 'sections.programs_services',
    prerequisite: 'programs or services the applicant runs or needs',
    read: ({ sections }) => hasDeclaredContent(obj(sections).programs_services),
  },
  {
    id: 'sections.organization_mission',
    prerequisite: 'an organization mission, if this is an org profile',
    read: ({ sections }) => {
      const m = str(obj(obj(sections).organization_details).mission)
      return m.length > 0 && !NON_ANSWERS.has(norm(m))
    },
  },
  {
    // A REAL registration identifier is substance for an org profile. It is
    // read STRUCTURALLY (a well-formed EIN/UEI), never by presence: prod's
    // `profile-melissa-justus` carries an `ein` that is a paragraph of prose
    // ("EIN (Tax ID) is not applicable as this application is submitted by an
    // individual…") and `uei: 'N/A'`.
    //
    // Deliberately NOT substance: `organization_details`' boolean flags and
    // `annual_budget` / `staff_count`. On a PERSON-type profile that whole
    // section is the documented Kimberly-Botts hallucination class
    // (`enforceIndividualOrgSectionConflict`) — an AI-enrichment artifact, not
    // a declaration — and on the placeholder profiles those flags
    // (`in_appalachian_region`, `in_usda_persistent_poverty_county`, …) are
    // GEOGRAPHY claims derived from an address that reads "Anytown, USA".
    // A real organization that filled in a budget also names itself.
    id: 'sections.organization_registration',
    prerequisite: 'a real EIN or SAM.gov UEI, if this is an org profile',
    read: ({ sections }) => {
      const o = obj(obj(sections).organization_details)
      return EIN_RX.test(str(o.ein)) || UEI_RX.test(str(o.uei))
    },
  },
])

/**
 * detectUnconfiguredProfile — the verdict.
 *
 * @param {object}  input
 * @param {object}  input.profile   the `profiles` row
 * @param {object}  input.sections  { [section_key]: parsedJson }
 * @param {object} [input.signals]  buildProfileSignals() output (optional)
 * @param {object} [input.facts]    deriveProfileFacts() output (optional)
 * @returns {{
 *   unconfigured: boolean,
 *   families: string[],
 *   signals: Array<{id:string, family:string, evidence:string, prerequisite:string}>,
 *   substance: string[],
 *   missing_prerequisites: string[],
 *   reason: string|null
 * }}
 */
export function detectUnconfiguredProfile({ profile = {}, sections = {}, signals = null, facts = null } = {}) {
  const ctx = { profile: obj(profile), sections: obj(sections), signals: obj(signals), facts: obj(facts) }

  const substance = SUBSTANCE_PROBES.filter((p) => {
    try { return p.read(ctx) === true } catch { return false }
  }).map((p) => p.id)

  const hits = []
  for (const sig of PLACEHOLDER_SIGNALS) {
    let evidence = null
    try { evidence = sig.test(ctx) } catch { evidence = null }
    if (evidence) hits.push({ id: sig.id, family: sig.family, evidence, prerequisite: sig.prerequisite })
  }

  const corroborating = new Set(hits.map((h) => h.family))
  const families = [...corroborating]
  const noSubstance = substance.length === 0
  if (noSubstance) families.push(PLACEHOLDER_SIGNAL_FAMILY.NO_SUBSTANCE)

  const unconfigured = noSubstance && corroborating.size >= MIN_CORROBORATING_FAMILIES

  // What a human must supply. The placeholder fields that were positively
  // detected come first (they are concrete and already wrong), then the
  // substance the profile has never declared.
  const missing = unconfigured
    ? [...hits.map((h) => h.prerequisite), ...SUBSTANCE_PROBES.slice(0, 4).map((p) => p.prerequisite)]
    : []

  return {
    unconfigured,
    families,
    signals: hits,
    substance,
    missing_prerequisites: [...new Set(missing)],
    reason: unconfigured
      ? `no declared need/eligibility content, and placeholder evidence in ${corroborating.size} families (${[...corroborating].join(', ')})`
      : null,
  }
}

/**
 * isFabricatedGeoSource — would deriving a location from these fields INVENT a
 * place rather than read one?
 *
 * THIS EXISTS BECAUSE FIXING ONE FABRICATION UNMASKED A WORSE ONE. Once the
 * address-inference regex stopped minting `"SA"` from `state:'USA'`,
 * `buildProfileSignals`' ZIP rescue (`if (location.zip && !location.state)`)
 * became reachable for `profile-melissa-justus` and resolved her placeholder
 * ZIP `12345` to **Schenectady, NY** — a real, plausible-looking place she has
 * no connection to, which would then have titled `Schenectady County, NY —
 * Local assistance programs near you`. "Anytown, SA" at least LOOKED wrong.
 *
 * The bar is TWO corroborating signals, never one, because each alone has a
 * real false positive: ZIP 12345 is genuinely assigned (a GE building in
 * Schenectady), a city can legitimately be unusual, and a blank state is
 * ordinary. A real person living at 12345 who leaves `state` blank still gets
 * their ZIP resolved — their city is "Schenectady", not "Anytown".
 *
 * @param {{city?:unknown, state?:unknown, zip?:unknown}} loc
 * @returns {boolean}
 */
export function isFabricatedGeoSource(loc = {}) {
  let signals = 0
  if (isPlaceholderPlaceLabel(loc?.city)) signals += 1
  const rawState = str(loc?.state)
  // A state that is PRESENT but unresolvable is a positive junk declaration —
  // an ABSENT state is ordinary silence and counts for nothing.
  if (rawState && !normalizeState(rawState)) signals += 1
  const zip = str(loc?.zip).slice(0, 5)
  if (zip && PLACEHOLDER_ZIP_CODES.has(zip)) signals += 1
  return signals >= 2
}

/**
 * placePrefixOfTitle — the place a county/city locator names in its own title.
 * The lane mints `"<Place> — <base title>"` (countyCityDirectoryAdapter), so
 * the prefix before the first em/en-dash IS the declared place. One parser,
 * consumed by the engine gate and the boot sweep, so they cannot drift.
 */
export function placePrefixOfTitle(title) {
  // Bounded on both sides — see the js/polynomial-redos note above.
  const m = String(title || '').match(/^(.{2,60}?)\s{1,3}(?:—|–|--)\s{1,3}/)
  return m ? m[1] : null
}

/**
 * isPlaceholderPlaceLabel — is this place string one the system FABRICATED from
 * a placeholder profile ("Anytown", "Anytown, SA")? Used by the county/city
 * locator adapter (write side), the match engine (per-call gate) and the boot
 * sweep (net) so all three agree on one rule.
 */
export function isPlaceholderPlaceLabel(place) {
  const p = norm(place)
  if (!p) return false
  // Strip a trailing ", XX" state suffix (valid or not) and a "County/Parish/
  // Borough" head noun, then compare the bare place token.
  //
  // EVERY QUANTIFIER HERE IS BOUNDED (js/polynomial-redos). `norm()` has
  // already collapsed whitespace runs to a single space and trimmed, so an
  // unbounded `\s*` next to `$` adds no capability — only ambiguous
  // backtracking on an attacker-supplied run of tabs.
  const bare = p.replace(/, ?[a-z]{2,3}$/, '').replace(/ (county|parish|borough)$/, '').trim()
  return PLACEHOLDER_CITY_TOKENS.has(bare)
}

export default {
  PLACEHOLDER_SIGNAL_FAMILY,
  MIN_CORROBORATING_FAMILIES,
  PLACEHOLDER_EMAIL_DOMAINS,
  PLACEHOLDER_CITY_TOKENS,
  PLACEHOLDER_STREET_RX,
  PLACEHOLDER_PHONE_RX,
  PLACEHOLDER_NAME_TOKENS,
  SELF_DECLARED_PLACEHOLDER_RX,
  PLACEHOLDER_SECTION_LIKE_PATTERNS,
  PLACEHOLDER_SIGNALS,
  SUBSTANCE_PROBES,
  detectUnconfiguredProfile,
  isFabricatedGeoSource,
  placePrefixOfTitle,
  isPlaceholderPlaceLabel,
  PLACEHOLDER_ZIP_CODES,
}
