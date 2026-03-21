/**
 * Gate that shows FirstRunOnboardingWizard when:
 * - User has 0 profiles, OR
 * - User has profiles but active profile is missing zip/state.
 * Uses backend preferences for completion/skip (no localStorage).
 */
import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/api/client'
import FirstRunOnboardingWizard from './FirstRunOnboardingWizard'

export default function FirstRunOnboardingGate({ profiles = [], activeProfileId }) {
  const { data: prefs } = useQuery({
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

  const basicSection = activeProfileDetail?.sections?.find?.((s) => s.section_key === 'basic_information')?.data
  const hasZip = Boolean(basicSection?.zip?.trim?.())
  const hasState = Boolean(basicSection?.state?.trim?.())
  const activeProfileComplete = hasZip && hasState

  const shouldShow =
    !completed &&
    !skipped &&
    (profiles.length === 0 || !activeProfileComplete)

  const [showWizard, setShowWizard] = React.useState(false)

  React.useEffect(() => {
    if (shouldShow) setShowWizard(true)
  }, [shouldShow])

  const handleComplete = () => {
    setShowWizard(false)
  }

  const handleSkip = () => {
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
