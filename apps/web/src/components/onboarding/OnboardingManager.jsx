import React, { useContext } from 'react';
import { OnboardingProvider, OnboardingContext, useOnboarding } from './OnboardingContext';
import AnimatedIntroScreen from './ui/AnimatedIntroScreen';
import SpotlightHighlighter from './ui/SpotlightHighlighter';
import ChecklistPanel from './ui/ChecklistPanel';
import CompletionCelebration from './ui/CompletionCelebration';

function OnboardingUI() {
  const context = useContext(OnboardingContext);
  
  // Safe if not in provider
  if (!context) {
    return null;
  }
  
  const { showIntro, activeTour, isDismissed } = context;

  // Don't render anything if dismissed
  if (isDismissed) {
    return (
      <>
        <ChecklistPanel />
        <CompletionCelebration />
      </>
    );
  }

  return (
    <>
      {showIntro && <AnimatedIntroScreen />}
      {activeTour && <SpotlightHighlighter />}
      <ChecklistPanel />
      <CompletionCelebration />
    </>
  );
}

export default function OnboardingManager({ user, children }) {
  if (!user?.id) {
    return <>{children}</>;
  }

  return (
    <OnboardingProvider user={user}>
      {children}
      <OnboardingUI />
    </OnboardingProvider>
  );
}

// Export hook for use in other components
export { useOnboarding } from './OnboardingContext';