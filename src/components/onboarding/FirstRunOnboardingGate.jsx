/**
 * Gate that shows FirstRunOnboardingWizard when:
 * - User has 0 profiles, OR
 * - User has profiles but active profile is missing zip/state.
 * Uses backend preferences for completion/skip (no localStorage).
 * Respects backend has_completed_onboarding — existing users are never re-shown the wizard.
 */
import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/api/client'
import { isRealProfileId } from '@/api/profileIdGuards'
import { useAuthStore } from '@/stores/authStore'
import FirstRunOnboardingWizard from './FirstRunOnboardingWizard'

export default function FirstRunOnboardingGate({ profiles = [], activeProfileId }) {
  // If the user has already completed onboarding (backend state), never show the gate.
  const hasCompletedOnboarding = useAuthStore((state) => state.hasCompletedOnboarding)

  const { data: prefs, isSuccess: prefsLoaded } = useQuery({
    queryKey: ['userPreferences'],
    queryFn: () => apiFetch('/api/preferences'),
    staleTime: 60_000,
  })

  const custom = prefs?.custom_preferences ?? {}
  const completed = Boolean(custom.onboarding_wizard_completed)
  const skipped = Boolean(custom.onboarding_wizard_skipped)

  const { data: activeProfileDetail } = useQuery({
    queryKey: ['profile', activeProfileId],
    queryFn: () => apiFetch(`/api/profiles/${activeProfileId}`),
    enabled: isRealProfileId(activeProfileId) && profiles.length > 0,
    staleTime: 30_000,
  })

  // Treat profile as 'not yet known' (undefined) while query is in flight
  // Only declare profile ready when we either have no profiles at all
// (nothing to load) or we have an activeProfileId AND its data has loaded.
// If profiles exist but no activeProfileId is selected yet, hold off
// so we don't falsely trigger the wizard on a transient null.
const profileDataReady =
  profiles.length === 0
    ? true
    : activeProfileId
      ? activeProfileDetail !== undefined
      : false
  const basicSection = activeProfileDetail?.sections?.find?.((s) => s.section_key === 'basic_information')?.data
  const hasZip = Boolean(basicSection?.zip?.trim?.())
  const hasState = Boolean(basicSection?.state?.trim?.())
  // A profile is considered 'complete enough to skip onboarding' only when
  // it has location AND at least one needs-signal section populated.
  // This ensures users who only provided a zip are still guided to enrich
  // their profile for deep matching (Goal 5, Goal 10).
  const needsSections = ['housing', 'education', 'health', 'employment', 'business', 'military', 'family', 'emergency']
  const hasNeedsData = Boolean(
    activeProfileDetail?.sections?.some?.(
      (s) => needsSections.includes(s.section_key) && s.data && Object.keys(s.data).length > 0
    )
  )
  const activeProfileComplete = hasZip && hasState && hasNeedsData

  const shouldShow =
    prefsLoaded &&
    profileDataReady &&
    !hasCompletedOnboarding &&
    !completed &&
    !skipped &&
    (profiles.length === 0 || !activeProfileComplete)

  const [showWizard, setShowWizard] = React.useState(false)
  const dismissedRef = React.useRef(false)

  const prevActiveProfileIdRef = React.useRef(activeProfileId)

  React.useEffect(() => {
    // If the active profile changed, the user is working with a different
    // profile â reset the dismissed flag so the wizard can re-trigger
    // for the new (possibly incomplete) profile.
    if (activeProfileId !== prevActiveProfileIdRef.current) {
      prevActiveProfileIdRef.current = activeProfileId
      dismissedRef.current = false
    }

    if (shouldShow && !dismissedRef.current) {
      setShowWizard(true)
    }
  }, [shouldShow, activeProfileId])

  const handleComplete = () => {
    dismissedRef.current = true
    setShowWizard(false)
  }

  const handleSkip = () => {
    dismissedRef.current = true
    setShowWizard(false)
  }

  return (
    <>
      {showWizard && (
        <FirstRunOnboardingWizard
          open={showWizard}
          onComplete={handleComplete}
          onSkip={handleSkip}
          profiles={profiles}
          activeProfileId={activeProfileId}
        />
      )}
    </>
  )
}
