import { create } from 'zustand'
import { useAuthStore } from '@/stores/authStore'
import { GUIDED_TOUR_STEPS } from '@/config/guidedCycleTourSteps'

function stepIndex(stepId) {
  return GUIDED_TOUR_STEPS.findIndex((s) => s.id === stepId)
}

const RAN_THIS_SESSION_KEY = 'grantflow:guided_tour_ran_this_session'
const PROGRESS_KEY = 'grantflow:guided_tour_progress'

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
 * Tab-session persistence for mid-tour progress, so an accidental refresh
 * resumes at the SAME step instead of restarting from step one. sessionStorage
 * (not localStorage) on purpose: it clears when the tab closes, so a later
 * separate login starts the tour fresh, and nothing leaks between users on a
 * shared machine. All access is best-effort — storage failures degrade to the
 * old restart-from-step-one behavior, never an error.
 */
function saveProgress(state) {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(
      PROGRESS_KEY,
      JSON.stringify({
        currentStepId: state.currentStepId,
        completedStepIds: state.completedStepIds,
        stepNotes: state.stepNotes,
        tourGrantId: state.tourGrantId,
      }),
    )
  } catch {
    // ignore — refresh will simply restart the tour
  }
}

function loadProgress() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(PROGRESS_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw)
    // Only trust a saved step that still exists in the registry (a deploy can
    // rename/remove steps between the save and the refresh).
    if (!saved || stepIndex(saved.currentStepId) < 0) return null
    return {
      currentStepId: saved.currentStepId,
      completedStepIds: saved.completedStepIds && typeof saved.completedStepIds === 'object' ? saved.completedStepIds : {},
      stepNotes: saved.stepNotes && typeof saved.stepNotes === 'object' ? saved.stepNotes : {},
      tourGrantId: typeof saved.tourGrantId === 'string' || typeof saved.tourGrantId === 'number' ? saved.tourGrantId : null,
    }
  } catch {
    return null
  }
}

function clearProgress() {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(PROGRESS_KEY)
  } catch {
    // ignore
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
 */
export const useGuidedTourStore = create((set, get) => ({
  isActive: false,
  currentStepId: null,
  targets: {}, // { [targetKey]: RefObject }
  completedStepIds: {}, // { [stepId]: true } once an event-gated step's event has fired
  stepNotes: {}, // { [stepId]: string } honest explanation shown when a step was unblocked without its real action
  // The pipeline grant the tour is carrying through steps 4-8 — captured when
  // the user adds a match to the pipeline (or drags a card), so the
  // /GrantDetail steps can open a REAL grant instead of the bare route's
  // not-found state.
  tourGrantId: null,

  start() {
    try {
      window.sessionStorage.setItem(RAN_THIS_SESSION_KEY, '1')
    } catch {
      // ignore (private browsing / storage disabled) -- worst case the gap
      // interview can resume in the same session instead of waiting for the next
    }
    const saved = loadProgress()
    if (saved) {
      // Same-tab refresh mid-tour: resume where the user left off.
      set({ isActive: true, ...saved })
      return
    }
    set({
      isActive: true,
      currentStepId: GUIDED_TOUR_STEPS[0]?.id ?? null,
      completedStepIds: {},
      stepNotes: {},
      tourGrantId: null,
    })
    saveProgress(get())
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
      saveProgress(get())
    } else {
      get().finish()
    }
  },

  back() {
    const idx = stepIndex(get().currentStepId)
    const prev = idx > 0 ? GUIDED_TOUR_STEPS[idx - 1] : null
    if (prev) {
      set({ currentStepId: prev.id })
      saveProgress(get())
    }
  },

  skip() {
    set({ isActive: false, currentStepId: null })
    clearProgress()
    useAuthStore.getState().markGuidedCycleTourStatus('skipped')
  },

  finish() {
    set({ isActive: false, currentStepId: null })
    clearProgress()
    useAuthStore.getState().markGuidedCycleTourStatus('completed')
  },

  /** Called from surgical hook-in points at existing action call sites. */
  reportCompletion(stepId) {
    const { isActive, currentStepId } = get()
    if (!isActive) return
    set((s) => {
      const nextNotes = { ...s.stepNotes }
      delete nextNotes[stepId] // the real action happened after all; drop any impossible-action note
      return { completedStepIds: { ...s.completedStepIds, [stepId]: true }, stepNotes: nextNotes }
    })
    if (currentStepId === stepId) {
      get().advance() // advance() persists
    } else {
      saveProgress(get())
    }
  },

  /**
   * Remember which pipeline grant the tour should open on the /GrantDetail
   * steps. Called from the same hook-in points as reportCompletion — adding a
   * match to the pipeline and dragging a card. A genuine no-op outside the
   * tour.
   */
  setTourGrantId(grantId) {
    if (!get().isActive || grantId === null || grantId === undefined) return
    set({ tourGrantId: grantId })
    saveProgress(get())
  },

  /**
   * Unblock an event-gated step WITHOUT auto-advancing — used when the real
   * action the step waits on has become impossible (e.g. a finished search
   * returned zero matches, so there is nothing to add to the pipeline).
   * The note replaces the step's waiting hint so the copy stays honest about
   * why the user may continue. reportCompletion still wins if the real
   * action happens later.
   */
  unblockStep(stepId, note) {
    if (!get().isActive) return
    set((s) => {
      if (s.completedStepIds[stepId]) return s
      return {
        completedStepIds: { ...s.completedStepIds, [stepId]: true },
        stepNotes: note ? { ...s.stepNotes, [stepId]: note } : s.stepNotes,
      }
    })
    saveProgress(get())
  },
}))
