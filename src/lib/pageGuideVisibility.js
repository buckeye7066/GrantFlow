// Relative, not the `@/` alias: profileIdGuards.js is deliberately
// import-free so this rule can be unit-tested under `node --test`.
import { isRealProfileId } from '../api/profileIdGuards.js'

/**
 * Who sees the end-user page guide (the "How funding works" journey steps, the
 * active-profile picker, and the saved-work notice).
 *
 * It was gated on `!isAdmin` alone, which made every workflow change in #1628
 * invisible to the ONLY account that reviews the product — the owner's admin
 * login — so the work read as never implemented (owner report 2026-09-08).
 *
 * The guide explains the funding workspace for the ACTIVE PROFILE, so the rule
 * is about the workspace, not the role: anyone working inside a real profile
 * sees it. The admin workspace itself (no profile, or the `__admin__` sentinel)
 * still gets nothing, because there is no journey to explain there.
 *
 * This deliberately does NOT extend to the end-user ONBOARDING sequencer:
 * admins are never re-interviewed (enforceAdminReinterviewSuppression).
 */
export function shouldShowPageGuide({ isAdmin, activeProfileId } = {}) {
  if (!isAdmin) return true
  return isRealProfileId(activeProfileId)
}

export default shouldShowPageGuide
