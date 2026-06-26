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

import { safeParseArrayField } from './profileHelpers.js'

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
  /\b501\s*\(?\s*c\s*\)?\s*\(?\s*3\s*\)?\s+(?:status\s+)?(?:required|only)\b/,
  /\bfederal\s+agenc(?:y|ies)\s+only\b/,
  /\bus\s+government\s+agenc(?:y|ies)\s+only\b/,
  /\bstate\s+government\s+agenc(?:y|ies)\s+only\b/,
  /\beligible\s+applicants?\s*[:\-—]\s*(?:institutions?|universities|colleges|nonprofit|state|federal)/,
  /\bmust\s+be\s+(?:an?\s+)?(?:institution|university|college|nonprofit|state\s+agency|federal\s+agency|501\(?\s*c\s*\)?\s*\(?\s*3\s*\)?)\b/,
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
  const t = String(profileType || '').trim().toLowerCase().replace(/\s+/g, '_')
  if (!t) return null
  if (INDIVIDUAL_LIKE.has(t)) return 'individual'
  if (ORG_LIKE.has(t)) return 'org'
  if (BUSINESS_LIKE.has(t)) return 'business'
  // Compound / fuzzy fallback — match by prefix
  if (t.startsWith('individual') || t.endsWith('_student') || t === 'family') return 'individual'
  if (t.includes('nonprofit') || t.includes('organization') || t.includes('church') || t.includes('school')) return 'org'
  if (t.includes('business') || t.includes('startup') || t.includes('entrepreneur')) return 'business'
  return null
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
        out.push(String(v).trim().toLowerCase())
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
export function evaluateApplicantTypeEligibility(opportunity, profileApplicantType) {
  const profileBucket = bucket(profileApplicantType)
  if (!profileBucket) {
    // Profile doesn't tell us anything reliable — don't reject results based
    // on something we can't verify. Mark as review so the matcher can still
    // surface them with a softer decision.
    return { decision: 'review', reason: 'profile_applicant_type_missing' }
  }

  const oppText = gatherOppText(opportunity)
  const explicitTypes = gatherExplicitTypes(opportunity)

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
  if (profileBucket === 'business') {
    for (const pat of NON_BUSINESS_PATTERNS) {
      if (pat.test(oppText)) return { decision: 'mismatch', reason: 'nonprofit_only_excludes_business' }
    }
    for (const pat of INDIVIDUAL_ONLY_PATTERNS) {
      if (pat.test(oppText)) return { decision: 'mismatch', reason: 'individual_only_excludes_business' }
    }
  }

  // 3. Default: pass when we have no contrary signal but acknowledge that
  //    eligibility is unknown when there is genuinely no eligibility data.
  if (!explicitTypes.length && !oppText) {
    return { decision: 'review', reason: 'eligibility_unknown' }
  }
  return { decision: 'pass', reason: null }
}

/**
 * Convenience helper for callers that just need a yes/no for hard exclusion.
 * Returns true ONLY for explicit mismatches — review-state opportunities are
 * NOT excluded.
 */
export function isHardApplicantTypeMismatch(opportunity, profileApplicantType) {
  const evalResult = evaluateApplicantTypeEligibility(opportunity, profileApplicantType)
  return evalResult.decision === 'mismatch'
}
