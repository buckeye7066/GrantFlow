/**
 * opportunityFundability.js — single source of truth for "can you write a grant
 * PROPOSAL for this opportunity?"
 *
 * The catalog deliberately holds more than direct grants: DIRECTORY rows are
 * locators (a pointer to more funders), BENEFIT rows are government entitlements
 * (SNAP, LIHEAP, Medicaid, SSA survivors — you enroll by eligibility, you don't
 * write a proposal), and PAST_AWARD_INTEL is historical market data. Those are
 * useful as RESOURCES but must never appear in proposal-writing surfaces — the
 * grant Pipeline and the AI Grant Scorer dropdown — where the user saw e.g.
 * "Veterans Crisis Line", "HRSA Find a Health Center", and "Medicaid and CHIP"
 * mixed in with fundable grants.
 *
 * Mirrors OPPORTUNITY_KIND in backend/crawler-os/contract.js. Kept here in shared/
 * so the SAME predicate runs in the backend (pipeline insertion + grants query)
 * AND the frontend (scorer dropdown) — no drift between them.
 */

// Kinds you actually submit a proposal/application for.
export const PROPOSAL_ELIGIBLE_KINDS = Object.freeze([
  'DIRECT_GRANT', 'PROGRAM', 'SCHOLARSHIP', 'IN_KIND',
])

// Kinds that are reference/referral only — never a proposal target.
export const NON_PROPOSAL_KINDS = Object.freeze([
  'DIRECTORY', 'BENEFIT', 'PAST_AWARD_INTEL',
])

export function opportunityKindOf(opp) {
  return String(opp?.opportunity_kind ?? opp?.kind ?? '').toUpperCase()
}

/**
 * True when an opportunity belongs in proposal-writing contexts. A blank/unknown
 * kind defaults to ELIGIBLE (legacy rows predating kind classification stay
 * visible) UNLESS other directory signals are present, so we never hide a real
 * grant — we only exclude the things that are explicitly not proposals.
 */
export function isProposalEligibleOpportunity(opp) {
  if (!opp) return false
  const kind = opportunityKindOf(opp)
  if (NON_PROPOSAL_KINDS.includes(kind)) return false
  // Legacy directory signals on rows with no canonical kind.
  if (String(opp.type ?? '').toUpperCase() === 'DIRECTORY') return false
  if (String(opp.opportunity_type ?? '').toUpperCase() === 'DIRECTORY') return false
  if (opp.is_directory_resource || opp.is_directory || opp.excluded_from_grant_scoring) return false
  return true
}

export default { PROPOSAL_ELIGIBLE_KINDS, NON_PROPOSAL_KINDS, opportunityKindOf, isProposalEligibleOpportunity }
