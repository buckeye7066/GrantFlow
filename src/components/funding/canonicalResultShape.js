/**
 * Canonical funding-result shape used by every funding card surface
 * (FundingResultCard.jsx, FundingDirectoryCard.jsx, etc.).
 *
 * Kept in its own file (no React imports) so that:
 *   - Pure logic / unit tests can pull it without booting the React tree.
 *   - Vite Fast Refresh stays well-typed for FundingResultCard.jsx
 *     (mixing component + non-component exports breaks HMR).
 */
export function canonicalResultShape() {
  return {
    id: 'string',
    title: 'string',
    sponsor: 'string',
    description: 'string',
    application_url: 'string?',
    source_url: 'string?',
    source: 'string',
    kind: 'direct|benefit|directory|referral|school_portal',
    source_trust_tier: 'official_api|official_portal|verified_directory|community_directory|open_web|manual_curated',
    link_status: 'verified|unverified|broken|redirect|unreachable',
    deadline: 'ISO date string?',
    deadline_type: 'fixed|rolling|ongoing?',
    amount_min: 'number?',
    amount_max: 'number?',
    amount_description: 'string?',
    amount_text: 'string?',
    amount_status: 'known|estimated|range|varies|not_listed|contact_required?',
    eligibility_summary: 'string?',
    match_score: 'number',
    match_decision: 'ACCEPT|REVIEW|REJECT',
    match_confidence: 'number',
    matched_profile_facts: 'string[]',
    ineligibility_reasons: 'string[]',
    next_action: 'apply|visit|contact|search_directory|request_info',
    threshold_relaxed: 'boolean?',
    relaxed_reason: 'string?',
  }
}

export default canonicalResultShape
