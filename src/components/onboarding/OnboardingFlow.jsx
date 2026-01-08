import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import OnboardingVideo from './OnboardingVideo'
import ProfileCreationWizard from './ProfileCreationWizard'

export default function OnboardingFlow() {
  const navigate = useNavigate()
  const {
    hasSeenOnboarding,
    needsProfileCreation,
    profiles,
    markOnboardingComplete,
    setNeedsProfileCreation,
    user,
    onboardingVideoRequested,
    profileWizardRequested,
    acknowledgeOnboardingVideo,
    acknowledgeProfileWizard,
  } = useAuthStore((state) => ({
    hasSeenOnboarding: state.hasSeenOnboarding,
    needsProfileCreation: state.needsProfileCreation,
    profiles: state.profiles,
    markOnboardingComplete: state.markOnboardingComplete,
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
    // Admin users should never see onboarding
    if (user?.is_admin) {
      return
    }

    if (!hasSeenOnboarding) {
      setShowVideo(true)
      return
    }

    if (needsProfileCreation && profiles.length === 0) {
      setShowProfileWizard(true)
    }
  }, [hasSeenOnboarding, needsProfileCreation, profiles, user])

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
      <OnboardingVideo
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
