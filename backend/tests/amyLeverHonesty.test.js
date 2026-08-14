/**
 * AN APPLIED LEVER IS NEVER REPORTED AS 'none' (2026-08-14).
 *
 * Amy may auto-apply five levers; two of them EDIT FILES — `scoring_weights`
 * rewrites `backend/config/matchThresholds.js` and `source_keyword_coverage`
 * rewrites the coverage overrides. Both follow apply -> re-crawl -> keep-or-
 * revert. Two defects made that window dishonest and, worse, leaky:
 *
 *   1. THE CATCH DESTROYED THE RECORD. `catch { weightTuning = { change:false,
 *      error } }` assigned a FRESH object, discarding `applied`. The run summary
 *      then computed `kept ? 'kept' : applied?.applied ? 'reverted' : 'none'`
 *      and printed `weights_tuned: 'none'` while the edit was live on disk.
 *      Real work reported as no work — the mirror of the silent-no-op defect.
 *
 *   2. THE REVERT WAS NOT IN A `finally`. It sat on the else-branch of the
 *      validation `if`, so anything thrown between `apply()` and that branch —
 *      the re-crawl, the metric computation — left the scoring contract
 *      mutated. `enforceInvariants` has a boot net for Amy's PROFILES and none
 *      for her EDITS, so nothing downstream would ever have put it back.
 *
 * These tests drive `describeLeverOutcome` directly (the reporting half) and the
 * revert contract through a fake editor (the leak half). `runAmyTraining` needs
 * a whole live cohort, so exercising the window through it would test the
 * fixture, not the rule.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { describeLeverOutcome } from '../services/amy/amyAgent.js'

const AGENT_SRC = () =>
  fs.readFileSync(new URL('../services/amy/amyAgent.js', import.meta.url), 'utf8')

describe('describeLeverOutcome — "none" may only mean nothing was written', () => {
  it('reports none when the lever never ran or never changed anything', () => {
    expect(describeLeverOutcome(null)).toBe('none')
    expect(describeLeverOutcome({ change: false })).toBe('none')
    expect(describeLeverOutcome({ change: true, applied: { applied: false } })).toBe('none')
  })

  it('reports kept and reverted for the two validated outcomes', () => {
    expect(describeLeverOutcome({ applied: { applied: true }, validation: { kept: true } })).toBe('kept')
    expect(describeLeverOutcome({ applied: { applied: true }, validation: { kept: false, reverted: true } }))
      .toBe('reverted')
  })

  it('does NOT report "none" for an edit that was written but never validated', () => {
    // THE DEFECT, verbatim: apply() succeeded, then the re-crawl threw and the
    // catch replaced the object, leaving only `applied`. Pre-fix this printed
    // 'none' while matchThresholds.js was still edited.
    const afterCatch = { change: false, error: 'recrawl exploded', applied: { applied: true } }
    expect(describeLeverOutcome(afterCatch)).not.toBe('none')
    expect(describeLeverOutcome(afterCatch)).toBe('applied_unvalidated')
  })

  it('reports a FAILED revert as its own loud state, never as kept or none', () => {
    const stuck = { applied: { applied: true }, revert_failed: 'EACCES writing matchThresholds.js' }
    expect(describeLeverOutcome(stuck)).toBe('applied_REVERT_FAILED')
    expect(describeLeverOutcome(stuck)).not.toBe('none')
    expect(describeLeverOutcome(stuck)).not.toBe('kept')
  })
})

describe('the apply -> validate window cannot leak a file edit', () => {
  /**
   * The shipped shape, reduced to the contract under test: a reference held
   * OUTSIDE the try, a catch that MERGES rather than replaces, and a `finally`
   * that restores any apply the run never validated.
   */
  async function runLeverWindow({ applyResult, duringValidation }) {
    let tuning = null
    let appliedRef = null
    const restored = []
    const editor = {
      apply: async () => applyResult,
      restore: async (a) => { restored.push(a) },
    }
    try {
      tuning = { change: true, applied: null, validation: null }
      const applied = await editor.apply()
      appliedRef = applied
      tuning.applied = applied
      if (applied?.applied) {
        await duringValidation()
        tuning.validation = { kept: true }
      }
    } catch (err) {
      tuning = { ...(tuning ?? { change: false }), error: err?.message }
    } finally {
      if (appliedRef?.applied && !tuning?.validation) {
        await editor.restore(appliedRef)
        tuning = { ...(tuning ?? {}), validation: { kept: false, reverted: true, reason: 'unvalidated_after_error' } }
      }
    }
    return { tuning, restored }
  }

  it('restores the edit when validation throws', async () => {
    const { tuning, restored } = await runLeverWindow({
      applyResult: { applied: true, backup_path: '/tmp/x.bak' },
      duringValidation: async () => { throw new Error('recrawl exploded') },
    })
    expect(restored).toHaveLength(1)
    expect(tuning.error).toBe('recrawl exploded')
    // The catch MERGED, so the applied record survived to be reported.
    expect(tuning.applied).toEqual({ applied: true, backup_path: '/tmp/x.bak' })
    expect(describeLeverOutcome(tuning)).toBe('reverted')
  })

  it('does NOT restore an edit that validated successfully', async () => {
    const { tuning, restored } = await runLeverWindow({
      applyResult: { applied: true },
      duringValidation: async () => {},
    })
    expect(restored).toHaveLength(0)
    expect(describeLeverOutcome(tuning)).toBe('kept')
  })

  it('does NOT restore when nothing was ever applied', async () => {
    const { restored } = await runLeverWindow({
      applyResult: { applied: false },
      duringValidation: async () => {},
    })
    expect(restored).toHaveLength(0)
  })
})

describe('static tripwires on the shipped agent', () => {
  it('neither file-editing lever replaces its tuning object in the catch', () => {
    const src = AGENT_SRC()
    // The exact pre-fix lines. Either one reappearing silently re-opens the
    // "real work reported as no work" hole.
    expect(src).not.toContain('weightTuning = { change: false, error: err?.message }')
    expect(src).not.toContain('coverageTuning = { change: false, error: err?.message }')
    expect(src).toContain('weightTuning = { ...(weightTuning ?? { change: false }), error: err?.message }')
    expect(src).toContain('coverageTuning = { ...(coverageTuning ?? { change: false }), error: err?.message }')
  })

  it('both file-editing levers guard their revert with a finally', () => {
    const src = AGENT_SRC()
    expect(src).toContain('if (weightAppliedRef?.applied && !weightTuning?.validation)')
    expect(src).toContain('if (coverageAppliedRef?.applied && !coverageTuning?.validation)')
  })

  it('the run summary reports lever state through the honest describer', () => {
    const src = AGENT_SRC()
    expect(src).toContain('weights_tuned: describeLeverOutcome(weightTuning)')
    expect(src).toContain('coverage_tuned: describeLeverOutcome(coverageTuning)')
    // The pre-fix expression could not say "written and still on disk".
    expect(src).not.toContain("weightTuning?.applied?.applied ? 'reverted' : 'none'")
  })
})
