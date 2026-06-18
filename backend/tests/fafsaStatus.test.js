/**
 * Unit tests for backend/services/college/fafsaStatus.js
 */

import { describe, it, expect } from 'vitest'
import {
  FAFSA_STAGES,
  isKnownStage,
  deriveFafsaCompleted,
  nextAction,
  normalizeFafsaStatus,
  setFafsaStage,
  describeFafsaStatus,
} from '../services/college/fafsaStatus.js'

describe('stage basics', () => {
  it('exposes an ordered stage list with labels + next actions', () => {
    expect(FAFSA_STAGES[0].key).toBe('not_started')
    expect(FAFSA_STAGES[FAFSA_STAGES.length - 1].key).toBe('complete')
    expect(FAFSA_STAGES.every((s) => s.label && s.next)).toBe(true)
  })
  it('isKnownStage / nextAction', () => {
    expect(isKnownStage('submitted')).toBe(true)
    expect(isKnownStage('bogus')).toBe(false)
    expect(nextAction('submitted')).toMatch(/SAI/i)
  })
})

describe('deriveFafsaCompleted', () => {
  it('is true at/after submitted, false before', () => {
    expect(deriveFafsaCompleted('not_started')).toBe(false)
    expect(deriveFafsaCompleted('in_progress')).toBe(false)
    expect(deriveFafsaCompleted('submitted')).toBe(true)
    expect(deriveFafsaCompleted('verification')).toBe(true)
    expect(deriveFafsaCompleted('complete')).toBe(true)
  })
})

describe('normalizeFafsaStatus (back-compat)', () => {
  it('prefers a stored fafsa_status object', () => {
    const s = normalizeFafsaStatus({ fafsa_status: { stage: 'processed', updated_at: 't', history: [{ stage: 'processed', at: 't' }] } })
    expect(s.stage).toBe('processed')
    expect(s.history).toHaveLength(1)
  })
  it('derives from the legacy boolean when no object', () => {
    expect(normalizeFafsaStatus({ fafsa_completed: true }).stage).toBe('submitted')
    expect(normalizeFafsaStatus({ fafsa_completed: false }).stage).toBe('not_started')
    expect(normalizeFafsaStatus({}).stage).toBe('not_started')
  })
  it('ignores an unknown stored stage and falls back', () => {
    expect(normalizeFafsaStatus({ fafsa_status: { stage: 'nope' }, fafsa_completed: true }).stage).toBe('submitted')
  })
})

describe('setFafsaStage', () => {
  it('advances, syncs the boolean, and appends history', () => {
    const r = setFafsaStage({ stage: 'in_progress', history: [] }, 'submitted', { now: 't1' })
    expect(r.ok).toBe(true)
    expect(r.status.stage).toBe('submitted')
    expect(r.fafsa_completed).toBe(true)
    expect(r.status.history.at(-1)).toEqual({ stage: 'submitted', at: 't1' })
  })
  it('allows backward corrections', () => {
    const r = setFafsaStage({ stage: 'submitted', history: [] }, 'in_progress', { now: 't2' })
    expect(r.ok).toBe(true)
    expect(r.fafsa_completed).toBe(false)
  })
  it('rejects an unknown stage', () => {
    expect(setFafsaStage({}, 'bogus')).toEqual({ ok: false, error: 'unknown_stage' })
  })
  it('caps history growth', () => {
    let status = { stage: 'not_started', history: Array.from({ length: 60 }, (_, i) => ({ stage: 'in_progress', at: String(i) })) }
    const r = setFafsaStage(status, 'submitted', { now: 'x' })
    expect(r.status.history.length).toBeLessThanOrEqual(50)
    expect(r.status.history.at(-1).stage).toBe('submitted')
  })
})

describe('describeFafsaStatus', () => {
  it('returns a UI-ready view', () => {
    const v = describeFafsaStatus({ fafsa_status: { stage: 'verification' } })
    expect(v).toMatchObject({ stage: 'verification', completed: true })
    expect(v.label).toMatch(/verification/i)
    expect(v.next_action).toMatch(/documents/i)
    expect(v.stages.length).toBe(FAFSA_STAGES.length)
  })
})
