/**
 * A locator/resource may be shown at REVIEW, but may never claim the direct
 * funding certification represented by ACCEPT. Kept pure so the invariant is
 * independently testable and reusable by any future scoring facade.
 */
export function guardDirectFundingDecision({
  decision,
  explanation,
  reasons = [],
  isDirectoryResource = false,
} = {}) {
  if (String(decision || '').toUpperCase() !== 'ACCEPT' || !isDirectoryResource) {
    return { decision, explanation, reasons: Array.isArray(reasons) ? reasons : [] }
  }

  return {
    decision: 'REVIEW',
    explanation: 'This is a directory or referral resource, not a direct funding opportunity.',
    reasons: [
      ...(Array.isArray(reasons) ? reasons : []),
      'Directory locator cannot be certified as a direct funding match',
    ],
  }
}

export default { guardDirectFundingDecision }
