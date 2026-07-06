import React from 'react'
import { useAuthStore } from '@/stores/authStore'
import AnyaGuidedTour from '@/components/onboarding/AnyaGuidedTour'
import GuidedCycleTour from '@/components/onboarding/GuidedCycleTour'
import ResetOnboardingFlow from '@/components/onboarding/ResetOnboardingFlow'
import HamiltonFollowUpPrompt from '@/components/onboarding/HamiltonFollowUpPrompt'

/**
 * Priority router for GrantFlow's first-run experiences -- renders at most
 * ONE thing so nothing stacks:
 *
 *   guidedCycleTourStatus === 'pending'             -> the new post-intake
 *                                                      GuidedCycleTour (brand
 *                                                      new signup -- Anya's
 *                                                      intake interview
 *                                                      already ran on /start)
 *   guidedCycleTourStatus === 'pending_reinterview' -> ResetOnboardingFlow
 *                                                      (existing user reset to
 *                                                      the new-user experience
 *                                                      via an admin bulk
 *                                                      operation: video ->
 *                                                      Anya's gap interview ->
 *                                                      guided tour)
 *   guidedCycleTourStatus === 'completed'           -> HamiltonFollowUpPrompt
 *                                                      (renders nothing itself
 *                                                      once it confirms a
 *                                                      Hamilton authorization
 *                                                      already exists)
 *   guidedCycleTourStatus === null                  -> the older AnyaGuidedTour
 *                                                      (pre-existing, un-reset
 *                                                      users; self-gates on
 *                                                      lastCompletedTourVersion)
 *   guidedCycleTourStatus === 'skipped'              -> neither; user opted
 *                                                      all the way out
 *
 * Mount exactly once, replacing the previous bare <AnyaGuidedTour /> in
 * Layout.jsx.
 */
export default function OnboardingSequencer() {
  const guidedCycleTourStatus = useAuthStore((state) => state.guidedCycleTourStatus)

  if (guidedCycleTourStatus === 'pending') {
    return <GuidedCycleTour />
  }
  if (guidedCycleTourStatus === 'pending_reinterview') {
    return <ResetOnboardingFlow />
  }
  if (guidedCycleTourStatus === 'completed') {
    return <HamiltonFollowUpPrompt />
  }
  if (guidedCycleTourStatus === null || guidedCycleTourStatus === undefined) {
    return <AnyaGuidedTour />
  }
  return null
}
