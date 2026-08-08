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
