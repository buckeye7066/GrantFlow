import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { STEP_ORDER, getNextStep, calculateProgress, PAGE_TOURS } from './onboardingSteps';

export const OnboardingContext = createContext(null);

export function OnboardingProvider({ children, user }) {
  const queryClient = useQueryClient();
  const [showIntro, setShowIntro] = useState(false);
  const [activeTour, setActiveTour] = useState(null);
  const [tourStep, setTourStep] = useState(0);
  const [showChecklist, setShowChecklist] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);

  // Fetch onboarding progress - with error handling for new users
  const { data: progress, isLoading } = useQuery({
    queryKey: ['onboardingProgress', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      try {
        const results = await base44.entities.OnboardingProgress.filter({
          user_id: user.id
        });
        return results?.[0] || null;
      } catch (err) {
        console.warn('[OnboardingContext] Error fetching progress:', err);
        return null;
      }
    },
    enabled: !!user?.id,
    staleTime: 30000,
    retry: 1
  });

  // Mutation for updating progress - with error handling
  const updateProgressMutation = useMutation({
    mutationFn: async (updates) => {
      const now = new Date().toISOString();
      
      try {
        if (progress?.id) {
          return await base44.entities.OnboardingProgress.update(progress.id, {
            ...updates,
            last_updated: now
          });
        } else {
          return await base44.entities.OnboardingProgress.create({
            user_id: user.id,
            completed_steps: [],
            dismissed: false,
            started_date: now,
            last_updated: now,
            ...updates
          });
        }
      } catch (err) {
        console.warn('[OnboardingContext] Error updating progress:', err);
        // Don't throw - onboarding should degrade gracefully
        return null;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['onboardingProgress', user?.id] });
    },
    onError: (err) => {
      console.warn('[OnboardingContext] Mutation error:', err);
    }
  });

  // Check if user is new and should see intro
  useEffect(() => {
    if (!isLoading && user?.id) {
      if (!progress && !showIntro) {
        // New user - show intro after brief delay
        const timer = setTimeout(() => setShowIntro(true), 1000);
        return () => clearTimeout(timer);
      }
    }
  }, [isLoading, progress, user?.id, showIntro]);

  // Safe defaults to prevent crashes on undefined values
  const completedSteps = Array.isArray(progress?.completed_steps) ? progress.completed_steps : [];
  const isDismissed = progress?.dismissed === true;
  const progressPercent = calculateProgress(completedSteps) || 0;
  const nextStep = getNextStep(completedSteps);
  const isComplete = progressPercent === 100;

  const completeStep = useCallback(async (stepId) => {
    if (completedSteps.includes(stepId)) return;
    
    const newCompleted = [...completedSteps, stepId];
    await updateProgressMutation.mutateAsync({
      completed_steps: newCompleted
    });

    // Check for completion celebration
    if (calculateProgress(newCompleted) === 100) {
      setShowCelebration(true);
    }
  }, [completedSteps, updateProgressMutation]);

  const skipOnboarding = useCallback(async () => {
    setShowIntro(false);
    setActiveTour(null);
    setShowChecklist(false);
    await updateProgressMutation.mutateAsync({ dismissed: true });
  }, [updateProgressMutation]);

  const resumeOnboarding = useCallback(async () => {
    await updateProgressMutation.mutateAsync({ dismissed: false });
    if (nextStep) {
      if (nextStep.type === 'intro') {
        setShowIntro(true);
      } else if (nextStep.type === 'tour') {
        startTour(nextStep.id);
      }
    }
  }, [updateProgressMutation, nextStep]);

  const restartOnboarding = useCallback(async () => {
    await updateProgressMutation.mutateAsync({
      completed_steps: [],
      dismissed: false,
      started_date: new Date().toISOString()
    });
    setShowIntro(true);
  }, [updateProgressMutation]);

  const startTour = useCallback((tourId) => {
    setActiveTour(tourId);
    setTourStep(0);
    setShowIntro(false);
  }, []);

  const startPageTour = useCallback((pageName) => {
    const tour = PAGE_TOURS[pageName];
    if (tour) {
      setActiveTour(tour.id);
      setTourStep(0);
    }
  }, []);

  const nextTourStep = useCallback(() => {
    const currentTour = Object.values(PAGE_TOURS).find(t => t.id === activeTour);
    if (currentTour && tourStep < currentTour.steps.length - 1) {
      setTourStep(prev => prev + 1);
    } else {
      // Tour complete
      completeStep(activeTour);
      setActiveTour(null);
      setTourStep(0);
    }
  }, [activeTour, tourStep, completeStep]);

  const prevTourStep = useCallback(() => {
    if (tourStep > 0) {
      setTourStep(prev => prev - 1);
    }
  }, [tourStep]);

  const endTour = useCallback(() => {
    setActiveTour(null);
    setTourStep(0);
  }, []);

  const beginOnboarding = useCallback(() => {
    setShowIntro(true);
  }, []);

  const value = {
    // State
    isLoading,
    progress,
    completedSteps,
    isDismissed,
    progressPercent,
    nextStep,
    isComplete,
    showIntro,
    activeTour,
    tourStep,
    showChecklist,
    showCelebration,

    // Actions
    completeStep,
    skipOnboarding,
    resumeOnboarding,
    restartOnboarding,
    startTour,
    startPageTour,
    nextTourStep,
    prevTourStep,
    endTour,
    beginOnboarding,
    setShowIntro,
    setShowChecklist,
    setShowCelebration
  };

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const context = useContext(OnboardingContext);
  // Return null instead of throwing - allows graceful degradation
  return context;
}