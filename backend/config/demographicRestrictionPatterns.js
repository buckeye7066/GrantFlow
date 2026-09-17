/**
 * Shared demographic restriction classifiers.
 *
 * These predicates are consumed by both normalization and strict relevance
 * gates so the canonical match decision cannot disagree with a pre-filter over
 * the same opportunity text.
 */

export const WOMEN_EXCLUSIVE_OPPORTUNITY_PATTERN =
  /\b(?:women[\s-]?only|females?[\s-]?only|(?:for|to)\s+(?:women|females?)\s+only|(?:female|women)\s+(?:students?|applicants?|entrepreneurs?|founders?|business(?:es)?|owners?)\s+only|must\s+be\s+(?:a\s+)?(?:woman|female)|exclusively\s+for\s+(?:women|females?)|restricted\s+to\s+(?:women|females?)|open\s+only\s+to\s+(?:women|females?)|only\s+(?:women|females?)\s+(?:may|can)\s+apply)\b/i

export function isWomenExclusiveOpportunityText(value) {
  return WOMEN_EXCLUSIVE_OPPORTUNITY_PATTERN.test(String(value ?? ''))
}

/**
 * International-applicant restriction, two strengths (canonical_rules G4):
 *
 *   'exclusive' — the source states the restriction as a rule ("international
 *                 students only", "must be an international student", "F-1 visa
 *                 required", "not open to US citizens"). Hard gate against a
 *                 profile whose citizenship is KNOWN to be US; a missing field
 *                 when citizenship is unknown.
 *   'audience'  — the source describes its audience ("scholarships for
 *                 international students"). A soft contradiction for a known US
 *                 citizen → REVIEW, never REJECT; neutral otherwise.
 *
 * A mixed audience ("domestic and international students") is neither. Measured
 * 2026-09-17: an MTSU "International Merit Scholarship" ("…for international
 * students") scored ACCEPT 100 for a profile whose demographics say US citizen —
 * the engine detected foreign PUBLISHERS but had no notion of a foreign
 * APPLICANT requirement.
 */
export const INTERNATIONAL_EXCLUSIVE_OPPORTUNITY_PATTERN =
  /\b(?:international\s+(?:students?|applicants?|freshmen|scholars|candidates)\s+only|only\s+(?:open\s+to\s+)?international\s+(?:students?|applicants?)|(?:exclusively|solely)\s+(?:for|to)\s+international\s+(?:students?|applicants?|freshmen|scholars)|(?:restricted|limited|open\s+only)\s+to\s+international\s+(?:students?|applicants?|freshmen|scholars)|must\s+be\s+an?\s+(?:international|non-?u\.?s\.?|foreign)\s+(?:student|applicant|citizen|national)|non-?u\.?s\.?\s+citizens?\s+only|(?:f-?1|j-?1)\s+(?:student\s+)?visa\s+(?:holders?\s+)?(?:only|required|is\s+required)|not\s+(?:open|available)\s+to\s+u\.?s\.?\s+citizens)\b/i

export const INTERNATIONAL_AUDIENCE_OPPORTUNITY_PATTERN =
  /\b(?:(?:for|to|serving|supporting|helps?|assists?)\s+(?:new\s+|incoming\s+|first-year\s+|undergraduate\s+|graduate\s+)?international\s+(?:students?|applicants?|freshmen|scholars)|international\s+(?:students?|freshmen)\s+(?:who|planning|pursuing|enrolled|admitted|seeking))\b/i

export const MIXED_DOMESTIC_INTERNATIONAL_PATTERN =
  /\b(?:(?:domestic|u\.?s\.?|american)\s+(?:and|or|&|,)\s+international|international\s+(?:and|or|&|,)\s+(?:domestic|u\.?s\.?|american)|both\s+domestic\s+and\s+international|all\s+students\s+(?:regardless|including))\b/i

/** @returns {'exclusive'|'audience'|null} */
export function internationalStudentRestriction(value) {
  const text = String(value ?? '')
  if (!text) return null
  if (MIXED_DOMESTIC_INTERNATIONAL_PATTERN.test(text)) return null
  if (INTERNATIONAL_EXCLUSIVE_OPPORTUNITY_PATTERN.test(text)) return 'exclusive'
  if (INTERNATIONAL_AUDIENCE_OPPORTUNITY_PATTERN.test(text)) return 'audience'
  return null
}
