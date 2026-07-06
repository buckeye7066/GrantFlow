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
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('guidedTourStore unblock/completion semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useGuidedTourStore.setState({
      isActive: false,
      currentStepId: null,
      targets: {},
      completedStepIds: {},
      stepNotes: {},
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
})
