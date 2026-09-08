import React from 'react'
import { useAuthStore } from '@/stores/authStore'
import ForcedWelcomeVideo from '@/components/onboarding/ForcedWelcomeVideo'
import AnyaGuidedTour from '@/components/onboarding/AnyaGuidedTour'
import GuidedCycleTour from '@/components/onboarding/GuidedCycleTour'
import ResetOnboardingFlow from '@/components/onboarding/ResetOnboardingFlow'
import HamiltonFollowUpPrompt from '@/components/onboarding/HamiltonFollowUpPrompt'
import EndUserWelcomeGuide from '@/components/onboarding/EndUserWelcomeGuide'
import ErrorBoundary from '@/components/shared/ErrorBoundary'

/** One sequencer, with mandatory welcome content ahead of optional guidance. */
export default function OnboardingSequencer({ endUser = false }) {
  const guidedCycleTourStatus = useAuthStore((state) => state.guidedCycleTourStatus)
  const forcedWelcomeVideo = useAuthStore((state) => state.forcedWelcomeVideo)
  const profileCompletion = useAuthStore((state) => state.profileCompletion)
  let content = null
  if (forcedWelcomeVideo?.url) {
    content = <ForcedWelcomeVideo />
  } else if (endUser && profileCompletion?.blocked) {
    // The existing required-profile gate owns this step.
    content = null
  } else if (guidedCycleTourStatus === 'pending') {
    content = endUser ? <EndUserWelcomeGuide /> : <GuidedCycleTour />
  } else if (guidedCycleTourStatus === 'pending_reinterview') {
    content = <ResetOnboardingFlow endUser={endUser} />
  } else if (guidedCycleTourStatus === 'completed') {
    content = endUser ? null : <HamiltonFollowUpPrompt />
  } else if (guidedCycleTourStatus === null || guidedCycleTourStatus === undefined) {
    content = endUser ? null : <AnyaGuidedTour />
  }
  if (!content) return null
  return <ErrorBoundary fallback={null}>{content}</ErrorBoundary>
}
