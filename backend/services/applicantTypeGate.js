// Hard applicant-type eligibility gate.
//
// Why this exists: the matching engine previously applied only a soft
// scoring penalty (eligibilityPenalty -= 25) when an opportunity's stated
// applicant types disagreed with the profile's resolved applicant_type. That
// meant Discover Grants surfaced things like "NSF CyberTraining" or
// "USDA AFRI Workforce Development" for an INDIVIDUAL profile (demo_senior_family),
// which the pipeline insert path then rejected with 400. Symptom: the UI
// shows results that explode on add-to-pipeline.
//
// Project rules referenced:
//   - "Counts displayed in the UI must map 1:1 to backend response fields."
//   - "If results are found but not displayed, treat this as a bug, not a
//     UX choice." (and its inverse: don't surface results that the writer
//     guaranteed-rejects.)
//   - "Population/eligibility mismatches must reduce score, not discard
//     results." → for partial mismatches we still soft-penalise. Hard
//     mismatches are reserved for opportunities whose eligibility text
//     explicitly excludes the profile category (e.g. "institutions of
//     higher education only").
//
// Decision values:
//   pass     – opportunity is compatible (or at least not explicitly hostile)
//   review   – opportunity has no eligibility data we can read; surface it
//              but mark match_decision=REVIEW with reason eligibility_unknown
//   mismatch – explicit hostile constraint (institution-only, government
//              agency only, 501(c)(3) required + individual profile, etc.).
//              The matching route drops these; the pipeline writer rejects
//              them with HTTP 400 ineligible_for_profile.

// FARM/AGRICULTURAL-PRODUCER blind spot (2026-08-01, the Anita class).
// Before this, the word "farm" appeared NOWHERE in this file. `bucket()` knew
// only individual/org/business, so an opportunity carrying the explicit
// `applicant_types: ['farm']` — exactly what the crawler-os `usda_conservation`
// (NRCS EQIP/CSP) registry lane emits — fell through `explicitMatchesBucket`'s
// "explicit types present but none match" branch and returned a HARD `mismatch`
// for EVERY profile bucket in the system. Not a penalty: Discover drops it,
// POST /grants/from-opportunity answers 400 `ineligible_for_profile`, and
// pipelineEligibilitySweep DISMISSES the row. The whole agriculture universe was
// structurally unreachable by every user. The identity vocabulary + the
// structured farm-declaration reader live in ONE registry so the discovery lane
// and this gate cannot drift.
import { safeParseArrayField } from './profileHelpers.js'
import { FARM_APPLICANT_TOKENS, hasFarmIdentity, isFarmApplicantToken, normalizeApplicantToken } from './eligibility/farmIdentity.js'
import { getParentChain, resolveProfileType } from './profileTypeRegistry.js'

// Registry roots that mean a person applies (individual-root family) vs an
// organization applies. Derived from the canonical profileTypeRegistry so a new
// individual-root type (disabled_adult, senior, medical_need, …) the hand-typed
// vocabularies below don't enumerate still buckets correctly instead of reading
// as "profile applicant type missing" — which forces the eligibility-confirmation
// cap and made EVERY match for a disabled_adult/senior profile REVIEW, never
// ACCEPT (prod 2026-08-23: disabled_adult 0/42, senior 0/94 accepts fleet-wide).
const ORG_ROOT_TYPES = new Set([
  'nonprofit', 'church', 'school', 'institution', 'university', 'public_agency',
  'government', 'local_government', 'educator', 'public_school', 'school_district',
  'library', 'organization',
])

/**
 * Bucket a profile type by its CANONICAL registry root family. Returns
 * 'individual' | 'org' | 'business' | 'farm' | null. Consulted only as a
 * fallback after the hand-typed sets, so it never changes an already-recognized
 * token — it only rescues individual-root sub-types the sets omit.
 */
function bucketByRegistryRoot(token) {
  const chain = new Set(
    [resolveProfileType(token), ...getParentChain(token)].filter(Boolean),
  )
  if (chain.size === 0) return null
  if (chain.has('farm')) return 'farm'
  if (chain.has('business')) return 'business'
  if ([...ORG_ROOT_TYPES].some((t) => chain.has(t))) return 'org'
  if (chain.has('individual')) return 'individual'
  return null
}

const INDIVIDUAL_LIKE = new Set([
  'individual',
  'individual_need',
  'individual_in_need',
  'family',
  'household',
  'medical_assistance',
  'student',
  'high_school_student',
  'college_student',
  'graduate_student',
  'returning_student',
  'veteran',
  'caregiver',
])

const ORG_LIKE = new Set([
  'organization',
  'nonprofit',
  'church',
  'school',
  'institution',
  'higher_education',
  'university',
  'government',
])

const BUSINESS_LIKE = new Set([
  'small_business',
  'business',
  'enterprise',
  'startup',
  'entrepreneur',
])

// Opportunity-side phrases that EXCLUDE individual profiles (the most common
// false-positive in production). All matched lowercase with word boundaries
// where reasonable. Keep the list narrow — we want to be conservative about
// hard exclusion per the project rule on score-reduction-vs-discard.
const INSTITUTION_ONLY_PATTERNS = [
  /\binstitutions?\s+of\s+higher\s+education\b/,
  /\baccredited\s+(?:university|college|institution|institutions|four-year)\b/,
  /\b(?:research|academic)\s+institutions?\s+only\b/,
  /\bprincipal\s+investigators?\s+at\s+(?:accredited|us|u\.s\.)\s+institutions?\b/,
  /\b(?:nih|nsf|hrsa|usda|epa|noaa)\s+research\s+institutions?\b/,
  /\bnonprofit\s+organizations?\s+only\b/,
  // ReDoS-hardened (js/polynomial-redos, 2026-08-01). The `501(c)(3)` spelling
  // tolerance used adjacent UNBOUNDED whitespace quantifiers — `\s*\(?\s*` —
  // and an optional literal cannot separate them, so a run of whitespace could
  // be split between the two `\s*` in O(n) ways at each of O(n) positions.
  // Measured on the shipped pattern: `"501" + "\t"×n`, 2k→3.5ms, 4k→14.8ms,
  // 8k→54.3ms, 16k→212.9ms — textbook quadratic. Opportunity text is
  // attacker-influenced (a crawled page's title/description reaches this gate),
  // so this was reachable. Every `\s*` INSIDE the token is now bounded: a
  // legal-entity designation never contains a 5-character whitespace run, and a
  // bounded quantifier makes the worst case constant instead of polynomial.
  // The `\s+` separators BETWEEN words are untouched — they are unambiguous.
  /\b501\s{0,4}\(?\s{0,4}c\s{0,4}\)?\s{0,4}\(?\s{0,4}3\s{0,4}\)?\s+(?:status\s+)?(?:required|only)\b/,
  /\bfederal\s+agenc(?:y|ies)\s+only\b/,
  /\bus\s+government\s+agenc(?:y|ies)\s+only\b/,
  /\bstate\s+government\s+agenc(?:y|ies)\s+only\b/,
  /\beligible\s+applicants?\s*[:\-—]\s*(?:institutions?|universities|colleges|nonprofit|state|federal)/,
  // Same hardening — and this one was FAR worse: THREE adjacent unbounded
  // whitespace quantifiers (`\s*\)?\s*\(?\s*`) make it super-quadratic.
  // Measured on the shipped pattern with `"must be 501c" + "\t"×n`:
  // 2k→2.1s, 4k→17.4s, 8k→137.4s. A single crawled page could hang a worker.
  /\bmust\s+be\s+(?:an?\s+)?(?:institution|university|college|nonprofit|state\s+agency|federal\s+agency|501\(?\s{0,4}c\s{0,4}\)?\s{0,4}\(?\s{0,4}3\s{0,4}\)?)\b/,
  // Specific embassy / mission programs mentioned in the bug report.
  /\bu\.?s\.?\s+mission\s+to\b/,
  /\bembassy\s+(?:program|grant|fund)\b/,
  // High-precision FEDERAL INSTITUTIONAL mechanisms (terms of art whose applicant
  // is always an institution / state / consortium — an individual literally
  // cannot apply). These caught Demo Student's bad pipeline rows (OSEP personnel
  // preparation, NRSA institutional training grants, OESE comprehensive centers,
  // NSF Space Grant). Deliberately narrow so they never hit an individual
  // scholarship or CE program ("training scholarship", "safety training", etc.).
  /\bpersonnel\s+preparation\b/,
  /\binstitutional\s+(?:research\s+)?training\s+grant\b/,
  /\bresearch\s+training\s+grant\s*\((?:t32|nrsa)\)/,
  /\bcomprehensive\s+centers?\s+program\b/,
  /\bspace\s+grant\s+(?:college|consorti)/,
  // FEDERAL / INSTITUTIONAL GRANT MECHANISMS — terms of art whose applicant is
  // always an institution, company, state, tribe, or a principal investigator
  // AT an institution, never a private individual. A student cannot apply to a
  // Broad Agency Announcement, a cooperative agreement, an SBIR/STTR, or a
  // request for concept notes. These caught the federal-NOFO flood a real
  // individual profile carried at "waiting for review" (2026-08-22): the
  // Navy/ONR/DARPA/NOAA Broad Agency Announcements, the CDC global-health
  // cooperative agreements, and the EDA/FTA/NRCS/ACL agency programs — every one
  // of which auto-submit would otherwise have sent a forensic-science student's
  // application to. Deliberately terms of art NO individual scholarship /
  // fellowship / benefit uses, so an individual award (Army ROTC, AAUW
  // Fellowship, HOPE, Pell) is never touched. Matched against title + description
  // + eligibility text via gatherOppText.
  /\bbroad\s+agency\s+announcement\b/,
  /\bcooperative\s+agreement\b/,
  /\bsmall\s+business\s+(?:innovation\s+research|technology\s+transfer)\b/,
  /\b(?:sbir|sttr)\b/,
  /\brequest\s+for\s+concept\s+notes?\b/,
  /\bnotice\s+of\s+intent\s+to\s+publish\b/,
  /\bresearch\s+experiences?\s+for\s+undergraduates\b/,
  // A grants.gov "Notice of Funding Opportunity" for a discretionary federal
  // grant is an institutional mechanism (states / locals / tribes / nonprofits /
  // IHEs / businesses apply — individuals receive BENEFITS and SCHOLARSHIPS
  // through other channels, which never carry this phrase).
  /\bnotice\s+of\s+funding\s+opportunity\b/,
]

// Opportunity-side phrases that EXCLUDE organisations (rare but real —
// e.g. "for individuals only" emergency-aid programs).
const INDIVIDUAL_ONLY_PATTERNS = [
  /\bfor\s+individuals?\s+only\b/,
  /\bonly\s+individuals?\s+(?:may|are\s+eligible)\b/,
  /\bnot\s+open\s+to\s+(?:organizations?|nonprofits?|businesses)\b/,
  /\b(?:individuals?|households?)\s+only\b/,
]

// Opportunity-side phrases that EXCLUDE for-profit / business applicants.
const NON_BUSINESS_PATTERNS = [
  /\bnon[\s-]?for[\s-]?profit\s+only\b/,
  /\bnot\s+open\s+to\s+for[\s-]?profit\b/,
  /\bonly\s+nonprofits?\s+(?:may\s+apply|are\s+eligible)\b/,
]

function bucket(profileType) {
  const t = normalizeApplicantToken(profileType)
  if (!t) return null
  // Farm is checked FIRST: 'agribusiness' / 'agricultural_business' contain
  // "business" and would otherwise be swallowed by the fuzzy business branch,
  // losing the producer identity that USDA/SARE programs actually gate on.
  if (isFarmApplicantToken(t)) return 'farm'
  if (INDIVIDUAL_LIKE.has(t)) return 'individual'
  if (ORG_LIKE.has(t)) return 'org'
  if (BUSINESS_LIKE.has(t)) return 'business'
  // Compound / fuzzy fallback — match by prefix
  if (t.startsWith('individual') || t.endsWith('_student') || t === 'family') return 'individual'
  if (t.includes('nonprofit') || t.includes('organization') || t.includes('church') || t.includes('school')) return 'org'
  if (t.includes('business') || t.includes('startup') || t.includes('entrepreneur')) return 'business'
  // Canonical registry root (anti-drift): the hand-typed sets above miss
  // individual-root types like disabled_adult / senior / medical_need, which
  // then resolved to NO bucket → 'profile_applicant_type_missing' → the
  // eligibility-confirmation cap held every one of their matches below ACCEPT.
  return bucketByRegistryRoot(t)
}

/**
 * Resolve the SET of applicant buckets a profile legitimately holds.
 *
 * A profile is not always ONE thing. The owner's farm case is a person who also
 * runs a farm business: stripping either identity is a defect. Anita reads as
 * `individual` from the profiles row, and her farm never voted, so every
 * `applicant_types: ['farm']` opportunity hard-mismatched her. The gate now
 * evaluates EVERY identity the profile can prove and hard-rejects only when the
 * opportunity is hostile to ALL of them — the same conservative posture the
 * module header describes ("don't reject based on something we can't verify").
 *
 * @param {string|string[]|Set<string>|null|undefined} profileApplicantType
 * @param {object} [context]
 * @param {Record<string, any>} [context.sections] - section_key → data
 * @param {object} [context.profile] - the profiles row
 * @returns {Set<'individual'|'org'|'business'|'farm'>}
 */
export function resolveProfileBuckets(profileApplicantType, context = {}) {
  const raw = profileApplicantType instanceof Set
    ? [...profileApplicantType]
    : Array.isArray(profileApplicantType)
      ? profileApplicantType
      : [profileApplicantType]

  const buckets = new Set()
  for (const value of raw) {
    const b = bucket(value)
    if (b) buckets.add(b)
  }

  // STRUCTURED farm declaration (occupation.farmer checkbox, a farm-vocabulary
  // declared type, or a NAICS sector-11 code). Never inferred from prose.
  if (context && (context.sections || context.profile)) {
    if (hasFarmIdentity({ profile: context.profile ?? null, sections: context.sections ?? null })) {
      buckets.add('farm')
    }
  }
  return buckets
}

/**
 * INDIVIDUAL-ASSISTANCE SHAPE — TITLE + SPONSOR ONLY (the precise-detector
 * doctrine: full-text patterns over-match eligibility prose). Used solely to
 * SOFTEN a structured-type mismatch from hard-reject to review; it never
 * admits anything and never raises a score.
 *
 * Deliberately narrow. "Research Experiences for Undergraduates",
 * "Developmental Sciences", "FY25 Long Range Broad Agency Announcement" and the
 * six ACL institutional NOFOs from the 2026-08-21 owner report match NOTHING
 * here, so they keep their hard mismatch.
 */
const INDIVIDUAL_ASSISTANCE_TITLE_PATTERNS = Object.freeze([
  /\bscholarships?\b/i,
  /\bfellowships?\b/i,
  /\bbursary\b/i,
  /\btuition\b/i,
  /\bemergency\s+(?:aid|assistance|fund|grant|relief)\b/i,
  /\b(?:rent|rental|utility|energy|heating|water)\s+assistance\b/i,
  /\bfood\s+(?:assistance|pantry|bank)\b/i,
  /\bhardship\s+(?:fund|grant|assistance)\b/i,
  /\bcopay\s+assistance\b/i,
  /\bpatient\s+assistance\b/i,
  /\bstudent\s+aid\b/i,
  /\bbenefits?\s+program\b/i,
])

export function looksLikeIndividualAssistance(opportunity) {
  if (!opportunity || typeof opportunity !== 'object') return false
  const identity = `${opportunity.title ?? ''} ${opportunity.sponsor || opportunity.funder || ''}`
  if (!identity.trim()) return false
  return INDIVIDUAL_ASSISTANCE_TITLE_PATTERNS.some((rx) => rx.test(identity))
}

function gatherOppText(opportunity) {
  const bullets = safeParseArrayField(opportunity?.eligibility_bullets, [])
  const parts = [
    opportunity?.title,
    opportunity?.description,
    opportunity?.eligibility,
    opportunity?.eligibility_text,
    Array.isArray(bullets) ? bullets.join(' ') : '',
  ]
  return parts.filter(Boolean).map((s) => String(s).toLowerCase()).join(' ')
}

/**
 * STRUCTURED APPLICANT TYPES — the field this gate reads must be the field the
 * database actually stores (2026-08-21, measured).
 *
 * Until now this list held only `applicant_types` / `eligible_profile_types` /
 * `eligibility_types` / `eligible_applicants`. **None of those is a column on
 * `funding_opportunities`.** The stored column is `entity_types_allowed`
 * (`db/schema.sql:150`, pg `0168_funding_opportunity_match_semantics.sql`), and
 * `opportunityContract.js` already reads it as `row.applicant_types ??
 * row.entity_types_allowed` — this gate did not. Both real call sites
 * (`matchEngine.js:4373`, `pipelineEligibilitySweep.js:127`) pass a DB row, so
 * `gatherExplicitTypes` returned `[]` for every persisted opportunity and the
 * structured half of the gate never executed once in production.
 *
 * Measured on the local catalog replica (525 active rows) BEFORE this change:
 * every NSF research grant, the ONR/NRL Long Range BAA, the FTA and EDA NOFOs
 * and the HUD homeless-assistance rows returned `{decision:'pass', reason:null}`
 * for a `college_student` profile — while their own `entity_types_allowed` read
 * `["nonprofit","school","government","business","vfd","farm"]`, i.e. a list
 * that explicitly excludes an individual. That is the exact class the owner
 * reported on 2026-08-21: an individual undergraduate holding 105 queued
 * applications to institutional federal NOFOs she cannot apply to at all.
 *
 * Adding the column is a HARDENING, so three rails come with it:
 *  1. `*` (and `any`/`all`) is a WILDCARD, not a type. `withFallback()` in
 *     `crawler-os/crawlerVocabulary.js` emits `['*']` when a lane states
 *     nothing; without this rail those 12 rows would hard-mismatch EVERY
 *     bucket — the gate would have gone from blind to hostile.
 *  2. The individual vocabulary is widened to the population tokens the
 *     registries actually emit (`veteran`, `senior`, `caregiver`,
 *     `military_spouse`, …). A row typed `["individual","family","veteran"]`
 *     already passed on `individual`; one typed only `["veteran"]` would not
 *     have.
 *  3. An INDIVIDUAL-ASSISTANCE-shaped row is never HARD-rejected on structured
 *     types alone — see `looksLikeIndividualAssistance`. The crawler infers
 *     these types from prose, so a church-run rent-assistance program tagged
 *     `["church"]` must be softened to `review`, not deleted. Same posture the
 *     module header describes: hard mismatch only where we are confident.
 */
const STRUCTURED_APPLICANT_TYPE_FIELDS = Object.freeze([
  'applicant_types',
  'eligible_profile_types',
  'eligibility_types',
  'eligible_applicants',
  // The COLUMN. Do not remove: without it this gate reads nothing off a DB row.
  'entity_types_allowed',
])

/** Tokens that mean "unrestricted / not stated", never a concrete applicant. */
const WILDCARD_APPLICANT_TOKENS = new Set(['*', 'any', 'all', 'anyone', 'unrestricted'])

function gatherExplicitTypes(opportunity) {
  const out = []
  for (const field of STRUCTURED_APPLICANT_TYPE_FIELDS) {
    const parsed = safeParseArrayField(opportunity?.[field], [])
    if (Array.isArray(parsed) && parsed.length > 0) {
      for (const v of parsed) {
        if (v === null || v === undefined) continue
        const lowered = String(v).trim().toLowerCase()
        if (!lowered) continue
        out.push(lowered)
        // ALSO push the underscore-normalized form so a source that writes
        // "agricultural producer" / "small business" is recognised by the
        // underscore-keyed vocabularies below. Both forms are kept because the
        // existing lists contain hyphenated literals ('non-profit') that
        // normalizing alone would break.
        const normalized = normalizeApplicantToken(lowered)
        if (normalized && normalized !== lowered) out.push(normalized)
      }
    }
  }
  return out
}

/**
 * Population tokens that name a PERSON. Sourced from what the live registries
 * actually emit into `entity_types_allowed` (measured on the catalog replica:
 * `["individual","family","veteran","student"]`, `["individual","family",
 * "veteran","senior"]`, `["student","family"]`, `["individual","family",
 * "veteran","active_duty","guard_reserve","transitioning_service_member",
 * "military_spouse","student"]`, `["individual","student"]`). A row typed with
 * ONLY one of the narrower tokens must pass an individual profile, not
 * hard-mismatch it.
 */
const INDIVIDUAL_APPLICANT_TOKENS = Object.freeze([
  'individual', 'individuals', 'family', 'families', 'household', 'households',
  'student', 'students', 'consumer', 'consumers', 'patient', 'patients',
  'person', 'people', 'resident', 'residents',
  'veteran', 'veterans', 'senior', 'seniors', 'elder', 'elders',
  'caregiver', 'caregivers', 'parent', 'parents', 'youth', 'child', 'children',
  'homeowner', 'homeowners', 'renter', 'renters', 'tenant', 'tenants',
  'active_duty', 'guard_reserve', 'transitioning_service_member',
  'military_spouse', 'survivor', 'survivors', 'disabled', 'low_income',
])

function explicitMatchesBucket(types, profileBucket) {
  if (!types.length) return null
  const set = new Set(types)
  // A wildcard is an ABSENCE of a restriction, not a restriction that excludes
  // everyone. `withFallback()` writes `['*']` whenever a lane stated nothing.
  if ([...set].some((t) => WILDCARD_APPLICANT_TOKENS.has(t))) return 'pass'
  switch (profileBucket) {
    case 'individual':
      if (INDIVIDUAL_APPLICANT_TOKENS.some((k) => set.has(k))) return 'pass'
      break
    case 'org':
      if ([
        'organization', 'organizations', 'nonprofit', 'nonprofits', 'non-profit',
        '501c3', '501(c)(3)', 'church', 'school', 'institution', 'institutions',
        'university', 'college', 'state', 'state_agency', 'government', 'public_agency',
      ].some((k) => set.has(k))) return 'pass'
      break
    case 'business':
      if ([
        'small_business', 'business', 'businesses', 'enterprise', 'startup', 'entrepreneur', 'for_profit',
      ].some((k) => set.has(k))) return 'pass'
      break
    case 'farm':
      // A farm operation IS a for-profit business — USDA/FSA/SBA treat it as
      // one, and crawler-os already widens farm → business on both sides of its
      // own gate (crawler-os/matchEngine.js APPLICANT_TYPE_TO_CANONICAL_ALLOWED
      // / OPPORTUNITY_APPLICANT_TYPE_TO_ALLOWED). So a farm applicant passes
      // BOTH the agricultural-producer vocabulary and the business vocabulary.
      if (FARM_APPLICANT_TOKENS.some((k) => set.has(k))) return 'pass'
      if ([
        'small_business', 'business', 'businesses', 'enterprise', 'startup', 'entrepreneur', 'for_profit',
        'rural_business',
      ].some((k) => set.has(k))) return 'pass'
      break
    default:
      return null
  }
  // We have explicit types but none match the profile's bucket → hard mismatch.
  return 'mismatch'
}

/**
 * Decide whether an opportunity is eligible for a profile of the given
 * applicant type. Returns { decision, reason }.
 *
 * @param {object} opportunity
 * @param {string|null|undefined} profileApplicantType - resolved by
 *   loadProfileContext (profileRow.applicant_type || profileRow.primary_type
 *   || basic.profile_category).
 * @returns {{ decision: 'pass'|'review'|'mismatch', reason: string|null }}
 */
function evaluateOneBucket(profileBucket, explicitTypes, oppText, softenStructured = false) {
  // 1. Explicit applicant_types lists win — they are usually crawler-set
  //    and reliable. Mismatch here is hard.
  const explicitDecision = explicitMatchesBucket(explicitTypes, profileBucket)
  if (explicitDecision === 'pass') return { decision: 'pass', reason: 'explicit_applicant_types_match' }
  if (explicitDecision === 'mismatch') {
    // SAFETY VALVE (2026-08-21). The structured types the crawler writes are
    // INFERRED from the row's own prose (`crawlerVocabulary.APPLICANT_RULES`),
    // so a church-run emergency-rent program is typed `["church"]` from the
    // word "Church" in its title — the exact shape `matchEngine.js` already
    // guards ("Emmanuel Lutheran Church – Emergency Rent Assistance"). A HARD
    // mismatch DELETES a pipeline row, so an assistance-shaped record is only
    // ever softened to `review` (a score penalty), never hard-rejected on
    // structured types alone. Prose-based INSTITUTION_ONLY_PATTERNS below are
    // unaffected — an explicit "institutions of higher education" still bars.
    // ORDER MATTERS: the softener only ever covers types the CRAWLER inferred,
    // so the FUNDER's own prose is consulted first and still bars hard.
    if (softenStructured && (profileBucket === 'individual' || profileBucket === 'farm')) {
      for (const pat of INSTITUTION_ONLY_PATTERNS) {
        if (pat.test(oppText)) return { decision: 'mismatch', reason: `institution_only_excludes_${profileBucket}` }
      }
      return { decision: 'review', reason: 'explicit_applicant_types_mismatch_softened_individual_assistance' }
    }
    return { decision: 'mismatch', reason: 'explicit_applicant_types_mismatch' }
  }

  // 2. Free-text exclusivity phrases. Conservative: only the patterns
  //    above trigger a hard mismatch.
  if (profileBucket === 'individual') {
    for (const pat of INSTITUTION_ONLY_PATTERNS) {
      if (pat.test(oppText)) return { decision: 'mismatch', reason: 'institution_only_excludes_individual' }
    }
  }
  if (profileBucket === 'org') {
    for (const pat of INDIVIDUAL_ONLY_PATTERNS) {
      if (pat.test(oppText)) return { decision: 'mismatch', reason: 'individual_only_excludes_organization' }
    }
  }
  // A farm is neither an institution, a nonprofit, nor a government agency, so
  // the institution-only vocabulary excludes it exactly as it excludes an
  // individual. This is load-bearing: without it, adding the farm bucket would
  // WEAKEN the gate for a farm-owning individual — her farm identity would sail
  // past a "nonprofit organizations only" / "institutions of higher education"
  // program that her individual identity correctly hard-mismatches.
  if (profileBucket === 'farm') {
    for (const pat of INSTITUTION_ONLY_PATTERNS) {
      if (pat.test(oppText)) return { decision: 'mismatch', reason: 'institution_only_excludes_farm' }
    }
  }
  // A farm is a for-profit operation, so it is excluded by exactly the phrases
  // that exclude a business — mirrored deliberately rather than widened.
  if (profileBucket === 'business' || profileBucket === 'farm') {
    const suffix = profileBucket === 'farm' ? 'farm' : 'business'
    for (const pat of NON_BUSINESS_PATTERNS) {
      if (pat.test(oppText)) return { decision: 'mismatch', reason: `nonprofit_only_excludes_${suffix}` }
    }
    for (const pat of INDIVIDUAL_ONLY_PATTERNS) {
      if (pat.test(oppText)) return { decision: 'mismatch', reason: `individual_only_excludes_${suffix}` }
    }
  }

  // 3. Default: pass when we have no contrary signal but acknowledge that
  //    eligibility is unknown when there is genuinely no eligibility data.
  if (!explicitTypes.length && !oppText) {
    return { decision: 'review', reason: 'eligibility_unknown' }
  }
  return { decision: 'pass', reason: null }
}

export function evaluateApplicantTypeEligibility(opportunity, profileApplicantType, context = {}) {
  const buckets = resolveProfileBuckets(profileApplicantType, context)
  if (buckets.size === 0) {
    // Profile doesn't tell us anything reliable — don't reject results based
    // on something we can't verify. Mark as review so the matcher can still
    // surface them with a softer decision.
    return { decision: 'review', reason: 'profile_applicant_type_missing' }
  }

  const oppText = gatherOppText(opportunity)
  const explicitTypes = gatherExplicitTypes(opportunity)
  const softenStructured = looksLikeIndividualAssistance(opportunity)

  // Federal NOFO feeds are organizational mechanisms unless the row positively
  // identifies an individual-assistance shape. Empty entity_types_allowed is
  // not evidence that a person can apply.
  const sourceIdentity = `${opportunity?.source ?? ''} ${opportunity?.record_origin ?? ''} ${opportunity?.source_url ?? ''}`.toLowerCase()
  const federalNofoSource = /grants(?:\.gov|_gov)|notice of funding opportunity/.test(sourceIdentity)
  if (
    federalNofoSource &&
    buckets.size === 1 &&
    buckets.has('individual') &&
    explicitTypes.length === 0 &&
    !softenStructured
  ) {
    return { decision: 'mismatch', reason: 'federal_nofo_excludes_individual' }
  }

  // A profile may hold MORE THAN ONE identity (the owner's farm case: a person
  // who also runs a farm business). A hard mismatch is a claim that the
  // applicant can never be the applicant — so it may only be returned when the
  // opportunity is hostile to EVERY identity the profile can prove. Any single
  // identity that passes carries the whole profile.
  let firstMismatch = null
  let firstReview = null
  for (const b of buckets) {
    const result = evaluateOneBucket(b, explicitTypes, oppText, softenStructured)
    if (result.decision === 'pass') {
      return { decision: 'pass', reason: result.reason, matched_bucket: b }
    }
    if (result.decision === 'review' && !firstReview) firstReview = { ...result, matched_bucket: b }
    if (result.decision === 'mismatch' && !firstMismatch) firstMismatch = { ...result, matched_bucket: b }
  }
  // No bucket passed. A review anywhere is softer than a mismatch and wins.
  if (firstReview) return firstReview
  return firstMismatch ?? { decision: 'review', reason: 'eligibility_unknown' }
}

/**
 * Convenience helper for callers that just need a yes/no for hard exclusion.
 * Returns true ONLY for explicit mismatches — review-state opportunities are
 * NOT excluded.
 */
export function isHardApplicantTypeMismatch(opportunity, profileApplicantType, context = {}) {
  const evalResult = evaluateApplicantTypeEligibility(opportunity, profileApplicantType, context)
  return evalResult.decision === 'mismatch'
}

export const __testables = {
  bucket,
  // Exposed so a STATIC test can assert none of these patterns ever regrows two
  // adjacent UNBOUNDED whitespace quantifiers — the js/polynomial-redos shape.
  // A timing test alone cannot hold this line: it is inherently noisy, and the
  // pattern that took 137s at 8k chars is only ever a one-character edit away.
  ELIGIBILITY_PATTERNS: Object.freeze({
    INSTITUTION_ONLY_PATTERNS,
    INDIVIDUAL_ONLY_PATTERNS,
    NON_BUSINESS_PATTERNS,
  }),
}
