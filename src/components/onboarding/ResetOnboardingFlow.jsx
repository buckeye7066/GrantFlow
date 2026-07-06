import React, { useState } from 'react'
import { isGapGateEnabled } from '@/lib/gapGateFlag'
import OnboardingVideo from '@/components/onboarding/OnboardingVideo'
import LoginGapInterviewLauncher from '@/components/profiles/LoginGapInterviewLauncher'
import GuidedCycleTour from '@/components/onboarding/GuidedCycleTour'

/**
 * ResetOnboardingFlow — the "treat this existing user like a new user again"
 * experience (guidedCycleTourStatus === 'pending_reinterview', set via a
 * one-time admin bulk-reset, distinct from 'pending' which means a genuine
 * brand-new signup that already went through Anya's intake interview on
 * /start). Sequences, in order:
 *
 *   1. the intro video (auto-played)
 *   2. Anya's existing gap-filling interview (LoginGapInterviewLauncher --
 *      safe to reuse as-is: it already writes into the user's EXISTING
 *      profile via persistGapAnswers, never creates a new account/profile)
 *   3. the guided first-cycle tour (GuidedCycleTour, same as for new signups)
 *
 * After this one-time sequence finishes, guidedCycleTourStatus becomes
 * 'completed' (set by GuidedCycleTour same as always) and
 * LoginGapInterviewLauncher goes back to its normal global behavior (App.jsx
 * suppresses ITS mount only while status === 'pending_reinterview', so
 * ordinary recurring gap-asking resumes on this user's next login onward).
 */
export default function ResetOnboardingFlow() {
  const [step, setStep] = useState('video')

  const goToGapInterviewOrSkip = () => {
    // If the gap gate is globally disabled (kill switch), don't wait on a
    // launcher that will never render -- go straight to the tour.
    setStep(isGapGateEnabled() ? 'gap-interview' : 'tour')
  }

  if (step === 'video') {
    return (
      <OnboardingVideo
        open
        onComplete={goToGapInterviewOrSkip}
        onSkip={goToGapInterviewOrSkip}
      />
    )
  }

  if (step === 'gap-interview') {
    return <LoginGapInterviewLauncher onFinished={() => setStep('tour')} />
  }

  return <GuidedCycleTour />
}
