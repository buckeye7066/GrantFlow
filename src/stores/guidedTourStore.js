import { create } from 'zustand'
import { useAuthStore } from '@/stores/authStore'
import { GUIDED_TOUR_STEPS } from '@/config/guidedCycleTourSteps'

function stepIndex(stepId) {
  return GUIDED_TOUR_STEPS.findIndex((s) => s.id === stepId)
}

const RAN_THIS_SESSION_KEY = 'grantflow:guided_tour_ran_this_session'

/**
 * True once the guided tour has started in this browser tab session (set by
 * start(), survives page refreshes via sessionStorage, cleared only when the
 * tab/window closes). Other first-run features (e.g. LoginGapInterviewLauncher)
 * use this -- not just the live 'pending' status -- to stay suppressed for the
 * REST of the session the tour ran in, not just resume the instant it
 * finishes. They're meant to show up on a later, separate login, not
 * immediately stack right after this one ends.
 */
export function hasGuidedTourRunThisSession() {
  if (typeof window === 'undefined') return false
  try {
    return window.sessionStorage.getItem(RAN_THIS_SESSION_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Cross-page state for the post-intake guided first-cycle tour. Mounted once
 * (via GuidedCycleTour in Layout.jsx) so it survives navigation across
 * DiscoverGrants -> Pipeline -> GrantDetail -> Hamilton's portal-open flow.
 *
 * Page components register a ref for any DOM node a step might spotlight
 * (registerTarget) and call reportCompletion(stepId) from the specific,
 * already-existing action handler a step is waiting on (crawl results ready,
 * added to pipeline, dragged to a new stage, Hamilton portal opened) --
 * see guidedCycleTourSteps.js for which step waits on which event.
 *
 * Not persisted across a page refresh mid-tour by design: this is a
 * first-run experience immediately after signup, so restarting from step
 * one on an accidental refresh is an acceptable, simple fallback rather
 * than adding localStorage/session persistence for an edge case.
 */
export const useGuidedTourStore = create((set, get) => ({
  isActive: false,
  currentStepId: null,
  targets: {}, // { [targetKey]: RefObject }
  completedStepIds: {}, // { [stepId]: true } once an event-gated step's event has fired

  start() {
    try {
      window.sessionStorage.setItem(RAN_THIS_SESSION_KEY, '1')
    } catch {
      // ignore (private browsing / storage disabled) -- worst case the gap
      // interview can resume in the same session instead of waiting for the next
    }
    set({ isActive: true, currentStepId: GUIDED_TOUR_STEPS[0]?.id ?? null, completedStepIds: {} })
  },

  registerTarget(key, ref) {
    set((s) => ({ targets: { ...s.targets, [key]: ref } }))
  },

  unregisterTarget(key) {
    set((s) => {
      const next = { ...s.targets }
      delete next[key]
      return { targets: next }
    })
  },

  advance() {
    const idx = stepIndex(get().currentStepId)
    const next = GUIDED_TOUR_STEPS[idx + 1]
    if (next) {
      set({ currentStepId: next.id })
    } else {
      get().finish()
    }
  },

  back() {
    const idx = stepIndex(get().currentStepId)
    const prev = idx > 0 ? GUIDED_TOUR_STEPS[idx - 1] : null
    if (prev) set({ currentStepId: prev.id })
  },

  skip() {
    set({ isActive: false, currentStepId: null })
    useAuthStore.getState().markGuidedCycleTourStatus('skipped')
  },

  finish() {
    set({ isActive: false, currentStepId: null })
    useAuthStore.getState().markGuidedCycleTourStatus('completed')
  },

  /** Called from surgical hook-in points at existing action call sites. */
  reportCompletion(stepId) {
    const { isActive, currentStepId } = get()
    if (!isActive) return
    set((s) => ({ completedStepIds: { ...s.completedStepIds, [stepId]: true } }))
    if (currentStepId === stepId) {
      get().advance()
    }
  },
}))
