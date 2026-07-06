import React, { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X } from 'lucide-react'
import { useGuidedTourStore } from '@/stores/guidedTourStore'
import { GUIDED_TOUR_STEPS } from '@/config/guidedCycleTourSteps'
import AnyaCoachmark from '@/components/onboarding/AnyaCoachmark'
import AutomationChoiceBody from '@/components/onboarding/AutomationChoiceBody'

// Keyed by STEP id (what isNextDisabled checks), not by event name.
const EVENT_HINTS = {
  'discover-crawl': "Waiting for real matches to come in — this only takes a moment.",
  'discover-add': 'Add a funding source above to continue.',
  'pipeline-drag': 'Drag the card into the next column to continue.',
  'hamilton-open': 'Click the button above to continue.',
}

// Shown instead of a locked Next when the step's anchor element never mounted
// (nothing in the pipeline yet, no grant selected, ...) — the action the step
// waits on can't be performed, so the user may move on.
const TARGET_MISSING_NOTE = "This part isn't on your screen right now — that's okay, we can keep going."

/**
 * Route-following orchestrator for the guided first-cycle tour. Mounted
 * once (via OnboardingSequencer, only while guidedCycleTourStatus ===
 * 'pending'). Reads the current step from useGuidedTourStore, auto-navigates
 * to that step's route, and renders an AnyaCoachmark spotlighting whatever
 * DOM node the page has registered for that step's targetKey.
 */
export default function GuidedCycleTour() {
  const navigate = useNavigate()
  const location = useLocation()

  const isActive = useGuidedTourStore((s) => s.isActive)
  const currentStepId = useGuidedTourStore((s) => s.currentStepId)
  const targets = useGuidedTourStore((s) => s.targets)
  const completedStepIds = useGuidedTourStore((s) => s.completedStepIds)
  const stepNotes = useGuidedTourStore((s) => s.stepNotes)
  const advance = useGuidedTourStore((s) => s.advance)
  const back = useGuidedTourStore((s) => s.back)
  const skip = useGuidedTourStore((s) => s.skip)
  const start = useGuidedTourStore((s) => s.start)

  const [targetReady, setTargetReady] = useState(false)
  // True once the target poll below gives up: the step's anchor never mounted
  // (empty pipeline, no grant selected, ...). Rather than stranding the user
  // with nothing but the skip button, we fall back to a centered card with
  // Next enabled so the tour can continue without the spotlight.
  const [targetMissing, setTargetMissing] = useState(false)

  // Start the tour exactly once, on mount (OnboardingSequencer only mounts
  // this component while the tour is pending, so mounting IS the trigger).
  useEffect(() => {
    start()
  }, [])

  const stepIdx = GUIDED_TOUR_STEPS.findIndex((s) => s.id === currentStepId)
  const step = stepIdx >= 0 ? GUIDED_TOUR_STEPS[stepIdx] : null

  // Auto-navigate to the current step's route.
  useEffect(() => {
    if (!isActive || !step) return
    if (location.pathname !== step.route) {
      navigate(step.route)
    }
  }, [isActive, step?.id, step?.route, location.pathname])

  // Poll for the target ref becoming available after a route change (the
  // destination page's own useEffect registers it shortly after mount).
  useEffect(() => {
    setTargetReady(false)
    setTargetMissing(false)
    if (!step || !step.targetKey) {
      setTargetReady(true)
      return undefined
    }
    if (location.pathname !== step.route) return undefined

    let cancelled = false
    let attempts = 0
    const check = () => {
      if (cancelled) return
      const ref = targets[step.targetKey]
      if (ref?.current) {
        setTargetReady(true)
        setTargetMissing(false)
        return
      }
      attempts += 1
      if (attempts < 40) {
        setTimeout(check, 150)
      } else {
        setTargetMissing(true)
      }
    }
    check()
    return () => {
      cancelled = true
    }
  }, [step, location.pathname, targets])

  if (!isActive || !step) return null

  // Always-available exit, independent of whether a specific step's
  // coachmark manages to render (e.g. its target never mounts).
  const exitAffordance = (
    <button
      type="button"
      onClick={skip}
      className="fixed bottom-4 right-4 z-[10000] flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-500 shadow-lg hover:text-slate-700"
    >
      <X className="h-3 w-3" /> Skip guided tour
    </button>
  )

  if (location.pathname !== step.route || (!targetReady && !targetMissing)) {
    return exitAffordance
  }

  // A missing anchor renders as a centered card (targetRef null) with Next
  // enabled — never leave Next locked on an action the user cannot take.
  const targetRef = !targetMissing && step.targetKey ? targets[step.targetKey] ?? null : null
  const isEventGated = step.completion?.startsWith('event:')
  const isNextDisabled = isEventGated && !completedStepIds[step.id] && !targetMissing
  const unblockNote = stepNotes[step.id] ?? (targetMissing ? TARGET_MISSING_NOTE : null)

  const body = step.kind === 'automation-choice'
    ? <AutomationChoiceBody onDone={advance} />
    : step.body

  return (
    <>
      <AnyaCoachmark
        targetRef={targetRef}
        title={step.title}
        body={body}
        stepIndex={stepIdx}
        stepCount={GUIDED_TOUR_STEPS.length}
        onNext={step.kind === 'automation-choice' ? null : advance}
        onBack={stepIdx > 0 ? back : null}
        onSkip={skip}
        isNextDisabled={isNextDisabled}
        nextHint={isNextDisabled ? EVENT_HINTS[step.id] : unblockNote}
      />
      {exitAffordance}
    </>
  )
}
