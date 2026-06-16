import React, { useMemo } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'

import { AnyaIntakeResults } from '@/components/anya/AnyaIntakeResults'

/**
 * Route-level wrapper for the Anya intake match results screen.
 *
 * Anya's onboarding flow navigates here on completion via:
 *   navigate('/AnyaIntakeResults', { state: { profileId, intakeAnswers, intakeSessionId, profile } })
 *
 * It also accepts `?profile_id=` so the screen is shareable / refreshable.
 */
export default function AnyaIntakeResultsPage() {
  const location = useLocation()
  const [searchParams] = useSearchParams()

  const state = location.state || {}
  const profileId = useMemo(
    () => state.profileId || searchParams.get('profile_id') || searchParams.get('profileId') || null,
    [state.profileId, searchParams],
  )

  return (
    <div className="container mx-auto max-w-5xl py-6">
      <AnyaIntakeResults
        profileId={profileId}
        profile={state.profile || null}
        intakeAnswers={state.intakeAnswers || {}}
        intakeSessionId={state.intakeSessionId || null}
      />
    </div>
  )
}
