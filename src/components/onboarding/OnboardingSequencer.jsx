import React from 'react'
import { useAuthStore } from '@/stores/authStore'
import AnyaGuidedTour from '@/components/onboarding/AnyaGuidedTour'
import GuidedCycleTour from '@/components/onboarding/GuidedCycleTour'
import HamiltonFollowUpPrompt from '@/components/onboarding/HamiltonFollowUpPrompt'

/**
 * Priority router for GrantFlow's first-run experiences -- renders at most
 * ONE thing so nothing stacks:
 *
 *   guidedCycleTourStatus === 'pending'   -> the new post-intake GuidedCycleTour
 *   guidedCycleTourStatus === 'completed' -> HamiltonFollowUpPrompt (renders
 *                                            nothing itself once it confirms
 *                                            a Hamilton authorization already
 *                                            exists — see that component)
 *   guidedCycleTourStatus === null        -> the older AnyaGuidedTour
 *                                            (pre-existing users, unaffected
 *                                            by this feature; self-gates on
 *                                            lastCompletedTourVersion)
 *   guidedCycleTourStatus === 'skipped'   -> neither; user opted all the way out
 *
 * Mount exactly once, replacing the previous bare <AnyaGuidedTour /> in
 * Layout.jsx.
 */
export default function OnboardingSequencer() {
  const guidedCycleTourStatus = useAuthStore((state) => state.guidedCycleTourStatus)

  if (guidedCycleTourStatus === 'pending') {
    return <GuidedCycleTour />
  }
  if (guidedCycleTourStatus === 'completed') {
    return <HamiltonFollowUpPrompt />
  }
  if (guidedCycleTourStatus === null || guidedCycleTourStatus === undefined) {
    return <AnyaGuidedTour />
  }
  return null
}
