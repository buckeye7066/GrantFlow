/**
 * Content-level applicability rules shared by the canonical match decision and
 * legacy lead filtering. These rules describe what the source actually is;
 * they must not be re-invented by a display consumer after a decision has been
 * persisted.
 */

export const PROCUREMENT_CONTRACT_PATTERN =
  /\b(contract opportunity|statement of work|bidder|vendor)\b/i

function textValues(value) {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap((entry) => textValues(entry))
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return []
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        return textValues(JSON.parse(text))
      } catch {
        // A non-JSON string that starts with punctuation is still source text.
      }
    }
    return [text]
  }
  if (typeof value === 'object') return Object.values(value).flatMap((entry) => textValues(entry))
  return [String(value)]
}

export function fundingSourcePolicyText(opportunity = {}) {
  return [
    opportunity.title,
    opportunity.description,
    opportunity.summary,
    opportunity.sponsor,
    opportunity.funder,
    opportunity.organization,
    opportunity.eligibility_text,
    opportunity.eligibility,
    opportunity.restrictions,
    opportunity.amount_description,
    opportunity.keywords,
    opportunity.categories,
    opportunity.eligibility_bullets,
    opportunity.tags,
  ]
    .flatMap((value) => textValues(value))
    .join(' ')
}

export function isProcurementContractOpportunity(opportunity) {
  return PROCUREMENT_CONTRACT_PATTERN.test(fundingSourcePolicyText(opportunity))
}

export default {
  PROCUREMENT_CONTRACT_PATTERN,
  fundingSourcePolicyText,
  isProcurementContractOpportunity,
}
