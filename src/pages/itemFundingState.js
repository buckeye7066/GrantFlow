/**
 * Item Funding scanner state helpers (kept out of ItemFunding.jsx so the page
 * file exports only the component — react-refresh/only-export-components).
 *
 * Reset the search filters WITHOUT dropping the selected profile.
 *
 * The pre-fix reset wrote `profileId: "all"`, and because the zero-result
 * guidance's "Try broader words" action calls the reset, the selected profile
 * silently reverted to "All profiles" after the first fruitless search —
 * every follow-up then returned 0 with the live web lane reporting "Needs a
 * profile" (owner QA pass, 2026-08-03). A reset clears WHAT is searched,
 * never WHO it is searched for.
 */
export function resetFiltersPreservingProfile(prev) {
  return {
    ...prev,
    item: "",
    state: "all",
    includeNational: true,
  }
}

export default { resetFiltersPreservingProfile }
