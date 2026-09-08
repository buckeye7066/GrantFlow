/**
 * Dashboard "next action" policy.
 *
 * Since 2026-09-07 the end-user sidebar carries the full non-admin tool set
 * (Find Funding, Work, the person's own profile). Only Automations and the
 * MyProfiles LIST stay hidden, so a CTA may point anywhere else. A Dashboard call-to-action
 * that routes an end user to one of those pages is a dead-end, so the
 * simplified branch here only ever lands on pages an end user can actually see
 * (their Pipeline, or Ask Anya).
 *
 * Kept as a pure function (no React, no hooks) so the routing policy is
 * unit-testable and cannot silently regress.
 */

// Route names that are hidden from the end-user navigation. A simplified-shell
// CTA must never point at any of these. Exported so the guard test can assert
// the policy mechanically.
export const HIDDEN_END_USER_ROUTES = Object.freeze([
  'Automation',
  'MyProfiles',
])

/**
 * Decide the single "next best action" for the Dashboard.
 *
 * @returns {{key: string, label: string, route: string} | null}
 */
export function pickDashboardNextAction({
  completionPct = 0,
  savedCount = 0,
  activeCount = 0,
  urgentCount = 0,
  isSimplified = false,
} = {}) {
  if (completionPct < 40) {
    return isSimplified
      ? { key: 'finish_profile', label: 'Finish filling in your profile', route: 'ProfileDetail', usesActiveProfile: true }
      : { key: 'complete_profile', label: 'Complete your profile for better matches', route: 'MyProfiles' }
  }
  if (savedCount === 0 && activeCount === 0) {
    return { key: 'discover', label: 'Discover grants matched to your profile', route: 'DiscoverGrants' }
  }
  if (urgentCount > 0) {
    return {
      key: 'deadlines',
      label: `${urgentCount} deadline${urgentCount > 1 ? 's' : ''} approaching — review now`,
      route: 'Pipeline',
    }
  }
  if (savedCount > 0 && activeCount === 0) {
    return { key: 'move_saved', label: 'Move saved grants into your pipeline', route: 'SavedGrants' }
  }
  return null
}
