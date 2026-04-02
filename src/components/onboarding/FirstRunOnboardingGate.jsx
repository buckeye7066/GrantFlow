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
  const activeProfileComplete = hasZip && hasState

  const shouldShow =
    prefsLoaded &&
    profileDataReady &&
    !hasCompletedOnboarding &&
    !completed &&
    !skipped &&
    (profiles.length === 0 || !activeProfileComplete)

  const [showWizard, setShowWizard] = React.useState(false)
  const dismissedRef = React.useRef(false)

  React.useEffect(() => {
    if (shouldShow && !dismissedRef.current) {
      setShowWizard(true)
    }
    // Do NOT reset dismissedRef here. It should only be reset when
    // shouldShow has been stably false for a meaningful period, which
    // is handled naturally because a new incomplete profile will produce
    // a new activeProfileId, causing the profile query to refetch and
    // dismissedRef to remain false from its initial value on remount.
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
