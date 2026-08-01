/**
 * Guard tests for backend/config/individualAwardCeiling.js.
 *
 * The bar exists twice by necessity: `enforceIndividualAmountCeiling()` applies
 * it to an individual's PIPELINE (grants), and the match store / match engine
 * apply it to what is SURFACED. Two literals that must agree is exactly the
 * drift shape CLAUDE.md names (the CONDITION_COVERAGE_KV_KEY precedent), so a
 * static tripwire asserts they are the same number and the same env var.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  INDIVIDUAL_AWARD_CEILING_DEFAULT,
  INDIVIDUAL_AWARD_CEILING_ENV,
  resolveIndividualAwardCeiling,
  statedAwardCeiling,
  exceedsIndividualAwardCeiling,
} from '../config/individualAwardCeiling.js'
import { resolveIndividualAmountCeiling, __testables } from '../startup/enforceInvariants.js'

afterEach(() => {
  delete process.env[INDIVIDUAL_AWARD_CEILING_ENV]
})

describe('individualAwardCeiling — static drift tripwire', () => {
  it('is the SAME default the pipeline sweep enforces', () => {
    expect(INDIVIDUAL_AWARD_CEILING_DEFAULT).toBe(__testables.INDIVIDUAL_AMOUNT_CEILING_DEFAULT)
  })

  it('honours the SAME env override the pipeline sweep honours (one bar, not two)', () => {
    expect(INDIVIDUAL_AWARD_CEILING_ENV).toBe('INDIVIDUAL_PIPELINE_AMOUNT_CEILING')
    process.env[INDIVIDUAL_AWARD_CEILING_ENV] = '250000'
    expect(resolveIndividualAwardCeiling()).toBe(250000)
    expect(resolveIndividualAmountCeiling()).toBe(resolveIndividualAwardCeiling())
  })

  it('falls back to the default on a junk / non-positive override', () => {
    process.env[INDIVIDUAL_AWARD_CEILING_ENV] = 'lots'
    expect(resolveIndividualAwardCeiling()).toBe(INDIVIDUAL_AWARD_CEILING_DEFAULT)
    process.env[INDIVIDUAL_AWARD_CEILING_ENV] = '0'
    expect(resolveIndividualAwardCeiling()).toBe(INDIVIDUAL_AWARD_CEILING_DEFAULT)
  })
})

describe('individualAwardCeiling — silence is never a violation', () => {
  it('a row that states NO amount is exempt', () => {
    expect(statedAwardCeiling({})).toBe(null)
    expect(statedAwardCeiling({ amount_min: null, amount_max: null })).toBe(null)
    expect(statedAwardCeiling({ amount_max: 0 })).toBe(null)
    expect(exceedsIndividualAwardCeiling({ amount_max: null })).toBe(false)
    expect(exceedsIndividualAwardCeiling(null)).toBe(false)
  })

  it('reads the LARGEST stated figure (a floor above the bar also disqualifies)', () => {
    expect(statedAwardCeiling({ amount_min: 5000, amount_max: 47500000 })).toBe(47500000)
    expect(statedAwardCeiling({ amount_min: 250000, amount_max: null })).toBe(250000)
    expect(exceedsIndividualAwardCeiling({ amount_min: 250000 })).toBe(true)
  })

  it('flags the real prod rows that reached person-type profiles, and spares real individual aid', () => {
    // Live prod rows matched to individual/senior/student profiles on 2026-08-01.
    expect(exceedsIndividualAwardCeiling({ amount_min: 0, amount_max: 1250000 })).toBe(true) // HUD FHIP
    expect(exceedsIndividualAwardCeiling({ amount_min: 5000000, amount_max: 10000000 })).toBe(true) // HUD PRO Housing
    expect(exceedsIndividualAwardCeiling({ amount_min: 200000, amount_max: 22000000 })).toBe(true) // Title X
    // Real individual assistance is nowhere near the bar.
    expect(exceedsIndividualAwardCeiling({ amount_max: 10000 })).toBe(false)
    expect(exceedsIndividualAwardCeiling({ amount_min: 500, amount_max: 25000 })).toBe(false)
    expect(exceedsIndividualAwardCeiling({ amount_max: 100000 })).toBe(false) // AT the bar is fine
  })
})
