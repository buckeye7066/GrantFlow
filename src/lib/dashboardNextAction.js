/**
 * Dashboard "next action" policy.
 *
 * The simplified (end-user) workspace hides Discovery, Automations, Saved
 * Grants, and the profile editor from navigation. A Dashboard call-to-action
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
  'DiscoverGrants',
  'Automation',
  'SavedGrants',
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
      ? { key: 'finish_profile', label: 'Ask Anya to finish your profile', route: 'Help' }
      : { key: 'complete_profile', label: 'Complete your profile for better matches', route: 'MyProfiles' }
  }
  if (savedCount === 0 && activeCount === 0) {
    return isSimplified
      ? { key: 'find_funding', label: 'Ask Anya to find funding for you', route: 'Help' }
      : { key: 'discover', label: 'Discover grants matched to your profile', route: 'DiscoverGrants' }
  }
  if (urgentCount > 0) {
    return {
      key: 'deadlines',
      label: `${urgentCount} deadline${urgentCount > 1 ? 's' : ''} approaching — review now`,
      route: 'Pipeline',
    }
  }
  if (savedCount > 0 && activeCount === 0) {
    return isSimplified
      ? { key: 'open_pipeline', label: 'Open your pipeline', route: 'Pipeline' }
      : { key: 'move_saved', label: 'Move saved grants into your pipeline', route: 'SavedGrants' }
  }
  return null
}
