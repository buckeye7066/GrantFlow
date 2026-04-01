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
    enabled: Boolean(activeProfileId) && activeProfileId !== '__admin__' && profiles.length > 0,
    staleTime: 30_000,
  })

  // Treat profile as 'not yet known' (undefined) while query is in flight
  const profileDataReady = activeProfileId
    ? activeProfileDetail !== undefined
    : true
  const basicSection = activeProfileDetail?.sections?.find?.((s) => s.section_key === 'basic_information')?.data
  const hasZip = Boolean(basicSection?.zip?.trim?.())
  const hasState = Boolean(basicSection?.state?.trim?.())
  const activeProfileComplete = hasZip && hasState

  const shouldShow =
    prefsLoaded &&
    profileDataReady &&
    !hasCompletedOnboarding &&
    !completed &&
    !skipped &&
    (profiles.length === 0 || !activeProfileComplete)

  // Don't evaluate shouldShow until preferences have loaded at least once
  const shouldShow =
    prefsLoaded &&
    !hasCompletedOnboarding &&
    !completed &&
    !skipped &&
    (profiles.length === 0 || !activeProfileComplete)

  const [showWizard, setShowWizard] = React.useState(false)
  const dismissedRef = React.useRef(false)

  React.useEffect(() => {
    if (shouldShow && !dismissedRef.current) {
      setShowWizard(true)
    } else if (!shouldShow) {
      // Reset dismissed state when the trigger condition clears
      // so a genuinely new incomplete profile can show the wizard.
      dismissedRef.current = false
    }
  }, [shouldShow])

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
