import { describe, expect, it, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  getEffectiveWeights,
  getEffectiveMinScore,
  getScoringTuning,
  setScoringTuning,
  resetScoringTuning,
  normalizeWeights,
  persistScoringTuning,
  hydrateScoringTuning,
} from '../config/scoringTuning.js'
import { computeMatchDecision } from '../services/matchEngine.js'

afterEach(() => resetScoringTuning())

describe('live scoring tuning store', () => {
  it('normalizes weights to sum 1.0 and clamps runaway values', () => {
    const w = normalizeWeights({ W_NEED: 0.9, W_ELIGIBILITY: 0.05, W_GEO: 0.05, W_CATEGORY: 0.05 })
    const sum = w.W_NEED + w.W_ELIGIBILITY + w.W_GEO + w.W_CATEGORY
    expect(Math.round(sum * 1000) / 1000).toBe(1) // always sums to 1.0
    for (const k of Object.keys(w)) {
      expect(w[k]).toBeGreaterThan(0)
      expect(w[k]).toBeLessThan(1)
    }
  })

  it('setScoringTuning updates the live effective values; reset restores defaults', () => {
    const defaults = getScoringTuning()
    setScoringTuning({ minScore: 60, weights: { W_NEED: 0.5, W_ELIGIBILITY: 0.2, W_GEO: 0.2, W_CATEGORY: 0.1 } })
    expect(getEffectiveMinScore()).toBe(60)
    expect(getEffectiveWeights().W_NEED).toBeGreaterThan(defaults.weights.W_NEED)
    resetScoringTuning()
    expect(getEffectiveMinScore()).toBe(defaults.minScore)
    expect(getEffectiveWeights()).toEqual(defaults.weights)
  })

  it('persists to system_kv and re-hydrates on boot (survives a restart)', async () => {
    const db = new Database(':memory:')
    try {
      setScoringTuning({ minScore: 55, weights: { W_NEED: 0.4, W_ELIGIBILITY: 0.3, W_GEO: 0.15, W_CATEGORY: 0.15 } })
      const saved = getScoringTuning()
      expect(await persistScoringTuning(db)).toBe(true)

      // Simulate a process restart: wipe the live store, then hydrate from DB.
      resetScoringTuning()
      expect(getEffectiveMinScore()).not.toBe(55)

      const hydrated = await hydrateScoringTuning(db)
      expect(hydrated.minScore).toBe(55)
      expect(getEffectiveMinScore()).toBe(55)
      expect(getEffectiveWeights().W_NEED).toBeCloseTo(saved.weights.W_NEED, 3)
    } finally {
      db.close()
    }
  })

  it('the match engine actually reads the live weights (tuning takes effect)', () => {
    const profile = { primary_type: 'individual', state: 'OH', needs: ['housing', 'utilities'] }
    const opp = {
      title: 'Ohio Emergency Rent and Utility Assistance',
      description: 'Emergency rent, eviction prevention, and utility assistance for Ohio residents.',
      application_url: 'https://ohio.gov/rent-help',
      state: 'OH',
      is_national: 0,
      categories: '["housing","utilities"]',
      keywords: '["rent","eviction","utility assistance"]',
      is_loan: 0,
    }

    const before = computeMatchDecision(profile, opp).score

    // Skew weights hard toward need; the live store must change the engine's score.
    setScoringTuning({ weights: { W_NEED: 0.6, W_ELIGIBILITY: 0.15, W_GEO: 0.15, W_CATEGORY: 0.1 } })
    const afterNeedHeavy = computeMatchDecision(profile, opp).score

    setScoringTuning({ weights: { W_NEED: 0.05, W_ELIGIBILITY: 0.6, W_GEO: 0.3, W_CATEGORY: 0.05 } })
    const afterEligHeavy = computeMatchDecision(profile, opp).score

    // At least one skew must move the score off the default — proves the engine
    // consumes getEffectiveWeights() rather than the cached constants.
    expect(afterNeedHeavy !== before || afterEligHeavy !== before).toBe(true)
  })
})
