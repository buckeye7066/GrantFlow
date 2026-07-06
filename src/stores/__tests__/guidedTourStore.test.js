/**
 * guidedTourStore — the unblockStep vs reportCompletion semantics that keep
 * the guided first-cycle tour free of dead ends:
 *
 *   - unblockStep enables an event-gated step's Next WITHOUT auto-advancing
 *     (the user reads the honest note and moves on themselves).
 *   - reportCompletion still auto-advances when the real action happens, and
 *     clears any impossible-action note left by an earlier unblockStep.
 *   - both are no-ops while the tour is inactive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// guidedTourStore transitively imports authStore -> the real @/api/client,
// irrelevant here (same reasoning as hamiltonWatchedOpen.test.js).
const markGuidedCycleTourStatus = vi.fn()
vi.mock('@/stores/authStore', () => ({
  useAuthStore: { getState: () => ({ markGuidedCycleTourStatus }) },
}))

import { useGuidedTourStore } from '@/stores/guidedTourStore'
import { GUIDED_TOUR_STEPS } from '@/config/guidedCycleTourSteps'

const FIRST_STEP = GUIDED_TOUR_STEPS[0].id
const SECOND_STEP = GUIDED_TOUR_STEPS[1].id
const THIRD_STEP = GUIDED_TOUR_STEPS[2].id

// Minimal sessionStorage stub so persistence paths run in the node env.
function installWindowWithSessionStorage() {
  const bag = new Map()
  global.window = {
    sessionStorage: {
      getItem: (k) => (bag.has(k) ? bag.get(k) : null),
      setItem: (k, v) => bag.set(k, String(v)),
      removeItem: (k) => bag.delete(k),
    },
  }
  return bag
}

describe('guidedTourStore unblock/completion semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete global.window
    useGuidedTourStore.setState({
      isActive: false,
      currentStepId: null,
      targets: {},
      completedStepIds: {},
      stepNotes: {},
      tourGrantId: null,
    })
  })

  it('unblockStep is a no-op while the tour is inactive', () => {
    useGuidedTourStore.getState().unblockStep(SECOND_STEP, 'note')
    expect(useGuidedTourStore.getState().completedStepIds).toEqual({})
    expect(useGuidedTourStore.getState().stepNotes).toEqual({})
  })

  it('unblockStep enables the step without advancing and records the note', () => {
    const store = useGuidedTourStore.getState()
    store.start()
    expect(useGuidedTourStore.getState().currentStepId).toBe(FIRST_STEP)

    useGuidedTourStore.getState().unblockStep(SECOND_STEP, 'No matches this time.')

    const state = useGuidedTourStore.getState()
    expect(state.completedStepIds[SECOND_STEP]).toBe(true)
    expect(state.stepNotes[SECOND_STEP]).toBe('No matches this time.')
    // Crucially: the user was NOT yanked forward.
    expect(state.currentStepId).toBe(FIRST_STEP)
  })

  it('reportCompletion on the current step auto-advances and clears any unblock note', () => {
    const store = useGuidedTourStore.getState()
    store.start()
    store.advance() // -> SECOND_STEP
    useGuidedTourStore.getState().unblockStep(SECOND_STEP, 'stale note')

    useGuidedTourStore.getState().reportCompletion(SECOND_STEP)

    const state = useGuidedTourStore.getState()
    expect(state.currentStepId).toBe(THIRD_STEP)
    expect(state.completedStepIds[SECOND_STEP]).toBe(true)
    expect(state.stepNotes[SECOND_STEP]).toBeUndefined()
  })

  it('unblockStep never attaches a note to a step already completed for real', () => {
    const store = useGuidedTourStore.getState()
    store.start()
    useGuidedTourStore.getState().reportCompletion(SECOND_STEP)

    useGuidedTourStore.getState().unblockStep(SECOND_STEP, 'should not appear')

    expect(useGuidedTourStore.getState().stepNotes[SECOND_STEP]).toBeUndefined()
  })

  it('start() resets notes and completions from a prior run', () => {
    const store = useGuidedTourStore.getState()
    store.start()
    useGuidedTourStore.getState().unblockStep(SECOND_STEP, 'old note')
    useGuidedTourStore.getState().start()

    const state = useGuidedTourStore.getState()
    expect(state.completedStepIds).toEqual({})
    expect(state.stepNotes).toEqual({})
  })

  it('setTourGrantId records the grant only while the tour is active', () => {
    useGuidedTourStore.getState().setTourGrantId('g-1')
    expect(useGuidedTourStore.getState().tourGrantId).toBeNull()

    useGuidedTourStore.getState().start()
    useGuidedTourStore.getState().setTourGrantId('g-1')
    expect(useGuidedTourStore.getState().tourGrantId).toBe('g-1')
  })
})

describe('guidedTourStore tab-session persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useGuidedTourStore.setState({
      isActive: false,
      currentStepId: null,
      targets: {},
      completedStepIds: {},
      stepNotes: {},
      tourGrantId: null,
    })
  })

  afterEach(() => {
    delete global.window
  })

  it('resumes at the saved step (with completions and grant) after a simulated refresh', () => {
    installWindowWithSessionStorage()
    const store = useGuidedTourStore.getState()
    store.start()
    useGuidedTourStore.getState().reportCompletion(SECOND_STEP) // completes + persists
    useGuidedTourStore.getState().advance() // FIRST -> SECOND
    useGuidedTourStore.getState().setTourGrantId('g-42')
    const midTourStep = useGuidedTourStore.getState().currentStepId

    // Simulated refresh: in-memory store resets, sessionStorage survives.
    useGuidedTourStore.setState({
      isActive: false,
      currentStepId: null,
      targets: {},
      completedStepIds: {},
      stepNotes: {},
      tourGrantId: null,
    })
    useGuidedTourStore.getState().start()

    const state = useGuidedTourStore.getState()
    expect(state.isActive).toBe(true)
    expect(state.currentStepId).toBe(midTourStep)
    expect(state.completedStepIds[SECOND_STEP]).toBe(true)
    expect(state.tourGrantId).toBe('g-42')
  })

  it('skip() clears saved progress so a later start is fresh', () => {
    installWindowWithSessionStorage()
    useGuidedTourStore.getState().start()
    useGuidedTourStore.getState().advance()
    useGuidedTourStore.getState().skip()

    useGuidedTourStore.getState().start()
    expect(useGuidedTourStore.getState().currentStepId).toBe(FIRST_STEP)
  })

  it('ignores saved progress whose step no longer exists in the registry', () => {
    const bag = installWindowWithSessionStorage()
    bag.set(
      'grantflow:guided_tour_progress',
      JSON.stringify({ currentStepId: 'step-removed-by-deploy', completedStepIds: {}, stepNotes: {}, tourGrantId: null }),
    )
    useGuidedTourStore.getState().start()
    expect(useGuidedTourStore.getState().currentStepId).toBe(FIRST_STEP)
  })

  it('works without window (storage failures degrade to restart-from-step-one)', () => {
    const store = useGuidedTourStore.getState()
    store.start()
    store.advance()
    expect(useGuidedTourStore.getState().currentStepId).toBe(SECOND_STEP)
  })
})
