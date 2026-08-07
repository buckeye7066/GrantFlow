/**
 * Shared demographic restriction classifiers.
 *
 * These predicates are consumed by both normalization and strict relevance
 * gates so the canonical match decision cannot disagree with a pre-filter over
 * the same opportunity text.
 */

export const WOMEN_EXCLUSIVE_OPPORTUNITY_PATTERN =
  /\b(?:women[\s-]?only|female[\s-]?only|for\s+women\s+only|female\s+(?:students?|applicants?|entrepreneurs?)\s+only|must be (?:a )?(?:woman|female)|exclusively for (?:women|females?)|restricted to (?:women|females?)|amber grant for women|society of women engineers|women(?:'s)?\s+engineers?|(?:scholarships?|grants?|awards?)\s+for\s+female\s+(?:students?|applicants?))\b/i

export function isWomenExclusiveOpportunityText(value) {
  return WOMEN_EXCLUSIVE_OPPORTUNITY_PATTERN.test(String(value ?? ''))
}
