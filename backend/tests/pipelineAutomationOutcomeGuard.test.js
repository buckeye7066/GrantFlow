/**
 * Pipeline automation may organize preparation, but an AI inference may never
 * become proof that an application was submitted or that a funder decided it.
 */

import { describe, expect, it } from 'vitest'

const {
  PIPELINE_AUTOMATION_STATUSES,
  isExternalOutcomeStatus,
  isPipelineAutomationProcessable,
  validateAdvance,
} = await import('../services/pipelineAutomation.js')
const {
  PIPELINE_ALLOWED_STATUSES,
  buildPipelineAutomationPrompt,
} = await import('../prompts/pipelineAutomation.js')

describe('pipeline automation lifecycle guard', () => {
  it('uses the shared canonical pre-submission lifecycle', () => {
    expect(PIPELINE_AUTOMATION_STATUSES).toEqual([
      'discovered',
      'saved',
      'interested',
      'gathering_documents',
      'drafting',
      'ready_to_submit',
    ])
    expect(PIPELINE_ALLOWED_STATUSES).toEqual(PIPELINE_AUTOMATION_STATUSES)
  })

  it('canonicalizes legacy preparation stages while allowing real forward progress', () => {
    expect(validateAdvance('drafting', 'portal')).toBe('gathering_documents')
    expect(validateAdvance('gathering_documents', 'ready_to_submit')).toBe('ready_to_submit')
  })

  it('refuses to infer submission or any post-submission outcome', () => {
    expect(validateAdvance('ready_to_submit', 'submitted')).toBe('ready_to_submit')
    expect(validateAdvance('drafting', 'pending_review')).toBe('drafting')
    expect(validateAdvance('submitted', 'awarded')).toBe('submitted')
    expect(validateAdvance('submitted', 'declined')).toBe('submitted')
  })

  it('leaves already-recorded external evidence untouched', () => {
    expect(validateAdvance('submitted', 'drafting')).toBe('submitted')
    expect(validateAdvance('awarded', 'awarded')).toBe('awarded')
  })

  it('identifies every stage that requires external evidence', () => {
    for (const status of ['submitted', 'pending_review', 'follow_up', 'awarded', 'declined']) {
      expect(isExternalOutcomeStatus(status)).toBe(true)
      expect(isPipelineAutomationProcessable(status)).toBe(false)
    }
    expect(isExternalOutcomeStatus('ready_to_submit')).toBe(false)
    expect(isPipelineAutomationProcessable('portal')).toBe(true)
  })

  it('the model prompt never authorizes an evidence-free submission', () => {
    const rendered = buildPipelineAutomationPrompt({
      grant: { id: 'g-1', status: 'drafting' },
      organization: null,
      milestones: [],
      documents: [],
      drafts: [],
      expenses: [],
      profileSummary: null,
    })
    expect(rendered).toContain('This automation NEVER submits an application')
    expect(rendered).toContain('at most "ready_to_submit"')
    expect(rendered).not.toMatch(/"submitted"\s+—\s+The application can be sent/i)
    expect(rendered).not.toContain('portal, submitted, or pending_review')
  })
})
