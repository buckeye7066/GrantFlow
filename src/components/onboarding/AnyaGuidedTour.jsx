/**
 * AnyaGuidedTour — versioned guided tour shown on login for non-admin users.
 *
 * Shows when last_completed_tour_version < CURRENT_TOUR_VERSION.
 * Admin users are never auto-shown the tour.
 * On completion or skip, calls PATCH /api/auth/onboarding-state to persist state.
 */
import React, { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ChevronLeft, ChevronRight, X, CheckCircle, Sparkles } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { CURRENT_TOUR_VERSION, getTourStepsForRole } from '@/config/helpRegistry'
import { NAV_GROUPS } from '@/nav/navConfig'
import { Link } from 'react-router-dom'

function getNavIconForGroup(groupId) {
  const group = NAV_GROUPS.find((g) => g.groupId === groupId)
  return group?.icon ?? null
}

export default function AnyaGuidedTour() {
  const {
    user,
    lastCompletedTourVersion,
    markTourComplete,
  } = useAuthStore((state) => ({
    user: state.user,
    lastCompletedTourVersion: state.lastCompletedTourVersion,
    markTourComplete: state.markTourComplete,
  }))

  const [isOpen, setIsOpen] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)

  const isAdmin = Boolean(user?.is_admin)
  const role = isAdmin ? 'admin' : 'user'
  const steps = getTourStepsForRole(role)

  useEffect(() => {
    // Admin users never get auto-shown the tour
    if (isAdmin) return
    // Show tour if user hasn't completed the current version yet
    if (user && (lastCompletedTourVersion ?? 0) < CURRENT_TOUR_VERSION) {
      setIsOpen(true)
      setCurrentStep(0)
    }
  }, [user, isAdmin, lastCompletedTourVersion])

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep((s) => s + 1)
    } else {
      handleComplete()
    }
  }

  const handlePrev = () => {
    if (currentStep > 0) {
      setCurrentStep((s) => s - 1)
    }
  }

  const handleComplete = () => {
    setIsOpen(false)
    markTourComplete(CURRENT_TOUR_VERSION)
  }

  const handleSkip = () => {
    setIsOpen(false)
    markTourComplete(CURRENT_TOUR_VERSION)
  }

  if (!isOpen || steps.length === 0) return null

  const step = steps[currentStep]
  const GroupIcon = getNavIconForGroup(step.navGroup)
  const isLastStep = currentStep === steps.length - 1

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleSkip() }}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="h-5 w-5 text-primary" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Quick Tour · Step {currentStep + 1} of {steps.length}
            </span>
          </div>
          <DialogTitle className="flex items-center gap-2 text-xl">
            {GroupIcon && <GroupIcon className="h-5 w-5 shrink-0 text-primary" />}
            {step.title}
          </DialogTitle>
          <DialogDescription className="text-base leading-relaxed">
            {step.description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {step.purpose && step.purpose !== step.description && (
            <p className="text-sm text-muted-foreground italic">{step.purpose}</p>
          )}
          {step.mainActions && step.mainActions.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                What you can do here
              </p>
              <ul className="space-y-1">
                {step.mainActions.map((action) => (
                  <li key={action} className="flex items-start gap-2 text-sm">
                    <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                    {action}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="pt-1">
            <Link
              to={step.route}
              onClick={handleSkip}
              className="text-sm text-primary hover:underline"
            >
              Go to {step.title} →
            </Link>
          </div>
        </div>

        {/* Progress dots */}
        <div className="flex justify-center gap-1.5 py-1">
          {steps.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Go to step ${i + 1}`}
              onClick={() => setCurrentStep(i)}
              className={`h-2 rounded-full transition-all ${
                i === currentStep ? 'w-4 bg-primary' : 'w-2 bg-muted-foreground/30'
              }`}
            />
          ))}
        </div>

        <DialogFooter className="flex justify-between sm:justify-between gap-2">
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={handleSkip} className="text-muted-foreground">
              <X className="h-4 w-4 mr-1" />
              Skip tour
            </Button>
          </div>
          <div className="flex gap-2">
            {currentStep > 0 && (
              <Button type="button" variant="outline" size="sm" onClick={handlePrev}>
                <ChevronLeft className="h-4 w-4 mr-1" />
                Back
              </Button>
            )}
            {isLastStep ? (
              <Button type="button" onClick={handleComplete} size="sm" className="bg-green-600 hover:bg-green-700">
                <CheckCircle className="h-4 w-4 mr-1" />
                Done
              </Button>
            ) : (
              <Button type="button" onClick={handleNext} size="sm">
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
