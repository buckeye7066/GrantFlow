/**
 * Automation must never declare a funder decision.
 *
 * `validateAdvance` only blocked BACKWARD moves, so a model that read an
 * application page optimistically could advance a grant all the way to
 * 'awarded' with no external evidence. That writes the one number the product
 * is judged on — did this profile actually receive money — from an inference,
 * which would make the outcome report worse than useless.
 *
 * Awards and declines now enter only from captured portal evidence or from the
 * profile owner recording them (POST /grant-applications/:id/outcome).
 */

import { describe, expect, it } from 'vitest'

const { validateAdvance, isExternalOutcomeStatus } = await import('../services/pipelineAutomation.js')

describe('validateAdvance outcome guard', () => {
  it('refuses to let automation advance a grant to awarded', () => {
    expect(validateAdvance('submitted', 'awarded')).toBe('submitted')
  })

  it('refuses to let automation advance a grant to declined', () => {
    expect(validateAdvance('submitted', 'declined')).toBe('submitted')
  })

  it('still allows ordinary forward progress through the pipeline', () => {
    // NOTE: this module's STATUS_ORDER is the legacy vocabulary and does not
    // contain the canonical RC-13 stages (ready_to_submit, gathering_documents),
    // so those are rejected as unknown here. Asserted with statuses the
    // automation actually recognizes.
    expect(validateAdvance('drafting', 'portal')).toBe('portal')
    expect(validateAdvance('portal', 'submitted')).toBe('submitted')
  })

  it('still refuses backward moves', () => {
    expect(validateAdvance('submitted', 'drafting')).toBe('submitted')
  })

  it('leaves an already-recorded outcome untouched rather than churning it', () => {
    // The grant is already awarded (a human or portal evidence put it there);
    // re-suggesting the same status must be a no-op, not a rewrite.
    expect(validateAdvance('awarded', 'awarded')).toBe('awarded')
  })

  it('identifies which statuses require external evidence', () => {
    expect(isExternalOutcomeStatus('awarded')).toBe(true)
    expect(isExternalOutcomeStatus('declined')).toBe(true)
    expect(isExternalOutcomeStatus('submitted')).toBe(false)
    expect(isExternalOutcomeStatus('drafting')).toBe(false)
  })
})
