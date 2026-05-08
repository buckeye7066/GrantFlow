import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import OnboardingManual from './OnboardingManual'
import ProfileCreationWizard from './ProfileCreationWizard'
import { CURRENT_MANUAL_VERSION } from '@/config/helpRegistry'

export default function OnboardingFlow() {
  const navigate = useNavigate()
  const {
    hasCompletedOnboarding,
    needsProfileCreation,
    profiles,
    markOnboardingComplete,
    markManualSeen,
    setNeedsProfileCreation,
    user,
    onboardingVideoRequested,
    profileWizardRequested,
    acknowledgeOnboardingVideo,
    acknowledgeProfileWizard,
  } = useAuthStore((state) => ({
    hasCompletedOnboarding: state.hasCompletedOnboarding,
    needsProfileCreation: state.needsProfileCreation,
    profiles: state.profiles,
    markOnboardingComplete: state.markOnboardingComplete,
    markManualSeen: state.markManualSeen,
    setNeedsProfileCreation: state.setNeedsProfileCreation,
    user: state.user,
    onboardingVideoRequested: state.onboardingVideoRequested,
    profileWizardRequested: state.profileWizardRequested,
    acknowledgeOnboardingVideo: state.acknowledgeOnboardingVideo,
    acknowledgeProfileWizard: state.acknowledgeProfileWizard,
  }))

  const [showVideo, setShowVideo] = useState(false)
  const [showProfileWizard, setShowProfileWizard] = useState(false)

  useEffect(() => {
    // Wait for auth bootstrap to populate `user`. If we trigger the manual
    // before then, an admin signing in briefly sees the onboarding wizard
    // because `user?.is_admin` is undefined for the first paint and
    // `hasCompletedOnboarding` defaults to false.
    if (!user) {
      return
    }
    // Admin users never get auto-triggered onboarding
    if (user?.is_admin) {
      // If a previous render opened the manual before user arrived, close it.
      setShowVideo(false)
      setShowProfileWizard(false)
      return
    }

    // Only show manual to users who have not yet completed onboarding (backend state)
    if (!hasCompletedOnboarding) {
      setShowVideo(true)
      return
    }

    if (needsProfileCreation && profiles.length === 0) {
      setShowProfileWizard(true)
    }
  }, [hasCompletedOnboarding, needsProfileCreation, profiles, user])

  // Manual relaunch via "User Manual" button in header (works for all users)
  useEffect(() => {
    if (onboardingVideoRequested) {
      setShowVideo(true)
      acknowledgeOnboardingVideo()
    }
  }, [onboardingVideoRequested, acknowledgeOnboardingVideo])

  useEffect(() => {
    if (profileWizardRequested) {
      setShowProfileWizard(true)
      acknowledgeProfileWizard()
    }
  }, [profileWizardRequested, acknowledgeProfileWizard])

  const handleVideoComplete = () => {
    setShowVideo(false)
    markOnboardingComplete()
    markManualSeen(CURRENT_MANUAL_VERSION)
    
    // Check if we need to create a profile
    if (profiles.length === 0) {
      setShowProfileWizard(true)
    } else {
      // Go to dashboard if they already have profiles
      navigate('/Dashboard', { replace: true })
    }
  }

  const handleVideoSkip = () => {
    setShowVideo(false)
    markOnboardingComplete()
    
    // Still need profile creation
    if (profiles.length === 0) {
      setShowProfileWizard(true)
    } else {
      navigate('/Dashboard', { replace: true })
    }
  }

  const handleProfileCreated = () => {
    setShowProfileWizard(false)
    setNeedsProfileCreation(false)
    navigate('/Dashboard', { replace: true })
  }

  const handleProfileSkipped = () => {
    // For now, don't allow skipping profile creation
    // This ensures users have at least one profile
    // If we want to allow skipping in the future, uncomment below:
    // setShowProfileWizard(false)
    // setNeedsProfileCreation(false)
    // navigate('/Dashboard', { replace: true })
  }

  return (
    <>
      <OnboardingManual
        open={showVideo}
        onComplete={handleVideoComplete}
        onSkip={handleVideoSkip}
      />
      <ProfileCreationWizard
        open={showProfileWizard}
        onComplete={handleProfileCreated}
        onSkip={handleProfileSkipped}
      />
    </>
  )
}

