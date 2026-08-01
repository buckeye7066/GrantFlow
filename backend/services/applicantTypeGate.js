// Hard applicant-type eligibility gate.
//
// Why this exists: the matching engine previously applied only a soft
// scoring penalty (eligibilityPenalty -= 25) when an opportunity's stated
// applicant types disagreed with the profile's resolved applicant_type. That
// meant Discover Grants surfaced things like "NSF CyberTraining" or
// "USDA AFRI Workforce Development" for an INDIVIDUAL profile (Luibov),
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
  // cannot apply). These caught Anastasia's bad pipeline rows (OSEP personnel
  // preparation, NRSA institutional training grants, OESE comprehensive centers,
  // NSF Space Grant). Deliberately narrow so they never hit an individual
  // scholarship or CE program ("training scholarship", "safety training", etc.).
  /\bpersonnel\s+preparation\b/,
  /\binstitutional\s+(?:research\s+)?training\s+grant\b/,
  /\bresearch\s+training\s+grant\s*\((?:t32|nrsa)\)/,
  /\bcomprehensive\s+centers?\s+program\b/,
  /\bspace\s+grant\s+(?:college|consorti)/,
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
  return null
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

function gatherExplicitTypes(opportunity) {
  const out = []
  for (const field of ['applicant_types', 'eligible_profile_types', 'eligibility_types', 'eligible_applicants']) {
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

function explicitMatchesBucket(types, profileBucket) {
  if (!types.length) return null
  const set = new Set(types)
  switch (profileBucket) {
    case 'individual':
      if ([
        'individual', 'individuals', 'family', 'families', 'household', 'households',
        'student', 'students', 'consumer', 'consumers', 'patient', 'patients',
        'person', 'people', 'resident', 'residents',
      ].some((k) => set.has(k))) return 'pass'
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
function evaluateOneBucket(profileBucket, explicitTypes, oppText) {
  // 1. Explicit applicant_types lists win — they are usually crawler-set
  //    and reliable. Mismatch here is hard.
  const explicitDecision = explicitMatchesBucket(explicitTypes, profileBucket)
  if (explicitDecision === 'pass') return { decision: 'pass', reason: 'explicit_applicant_types_match' }
  if (explicitDecision === 'mismatch') {
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

  // A profile may hold MORE THAN ONE identity (the owner's farm case: a person
  // who also runs a farm business). A hard mismatch is a claim that the
  // applicant can never be the applicant — so it may only be returned when the
  // opportunity is hostile to EVERY identity the profile can prove. Any single
  // identity that passes carries the whole profile.
  let firstMismatch = null
  let firstReview = null
  for (const b of buckets) {
    const result = evaluateOneBucket(b, explicitTypes, oppText)
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
