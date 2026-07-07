import React from 'react'
import { useAuthStore } from '@/stores/authStore'
import ForcedWelcomeVideo from '@/components/onboarding/ForcedWelcomeVideo'
import AnyaGuidedTour from '@/components/onboarding/AnyaGuidedTour'
import GuidedCycleTour from '@/components/onboarding/GuidedCycleTour'
import ResetOnboardingFlow from '@/components/onboarding/ResetOnboardingFlow'
import HamiltonFollowUpPrompt from '@/components/onboarding/HamiltonFollowUpPrompt'
import ErrorBoundary from '@/components/shared/ErrorBoundary'

/**
 * Priority router for GrantFlow's first-run experiences -- renders at most
 * ONE thing so nothing stacks:
 *
 *   forcedWelcomeVideo (set)                        -> ForcedWelcomeVideo, the
 *                                                      NEW HIGHEST priority: a
 *                                                      one-time, non-dismissible
 *                                                      full-screen video that
 *                                                      must be watched before
 *                                                      ANY onboarding/interview/
 *                                                      tour/dashboard. Beats
 *                                                      'pending_reinterview' so a
 *                                                      targeted user who is ALSO
 *                                                      flagged for onboarding
 *                                                      still sees the video first.
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
  const forcedWelcomeVideo = useAuthStore((state) => state.forcedWelcomeVideo)

  let content = null
  if (forcedWelcomeVideo?.url) {
    // NEW HIGHEST priority: the one-time forced welcome video beats every other
    // first-run branch (incl. 'pending_reinterview').
    content = <ForcedWelcomeVideo />
  } else if (guidedCycleTourStatus === 'pending') {
    content = <GuidedCycleTour />
  } else if (guidedCycleTourStatus === 'pending_reinterview') {
    content = <ResetOnboardingFlow />
  } else if (guidedCycleTourStatus === 'completed') {
    content = <HamiltonFollowUpPrompt />
  } else if (guidedCycleTourStatus === null || guidedCycleTourStatus === undefined) {
    content = <AnyaGuidedTour />
  }
  if (!content) return null

  // Onboarding is an overlay on top of a working app — if any of it throws,
  // it must disappear (error still reported via captureFrontendException),
  // never replace the app with an error card or take the shell down with it.
  return <ErrorBoundary fallback={null}>{content}</ErrorBoundary>
}
