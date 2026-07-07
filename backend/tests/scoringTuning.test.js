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
import {
  DEFAULT_MIN_SCORE,
  DISCOVERY_MIN_SCORE_FLOOR,
  SCORE_SCALE_ID,
} from '../config/matchThresholds.js'

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
    setScoringTuning({ minScore: 80, weights: { W_NEED: 0.5, W_ELIGIBILITY: 0.2, W_GEO: 0.2, W_CATEGORY: 0.1 } })
    expect(getEffectiveMinScore()).toBe(80)
    expect(getEffectiveWeights().W_NEED).toBeGreaterThan(defaults.weights.W_NEED)
    resetScoringTuning()
    expect(getEffectiveMinScore()).toBe(defaults.minScore)
    expect(getEffectiveWeights()).toEqual(defaults.weights)
  })

  it('SAFETY: the effective min score can never drop below the documented pipeline bar (data-point scale)', () => {
    // Loosening attempts (Amy floor sweep, admin call, stale hydrated value)
    // are clamped UP to DISCOVERY_MIN_SCORE_FLOOR; tightening is allowed.
    setScoringTuning({ minScore: DISCOVERY_MIN_SCORE_FLOOR - 1 })
    expect(getEffectiveMinScore()).toBe(DISCOVERY_MIN_SCORE_FLOOR)
    setScoringTuning({ minScore: 0 })
    expect(getEffectiveMinScore()).toBe(DISCOVERY_MIN_SCORE_FLOOR)
    setScoringTuning({ minScore: 50 })
    expect(getEffectiveMinScore()).toBe(50)
    setScoringTuning({ minScore: 200 })
    expect(getEffectiveMinScore()).toBe(100)
  })

  it('persists to system_kv and re-hydrates on boot (survives a restart)', async () => {
    const db = new Database(':memory:')
    try {
      setScoringTuning({ minScore: 80, weights: { W_NEED: 0.4, W_ELIGIBILITY: 0.3, W_GEO: 0.15, W_CATEGORY: 0.15 } })
      const saved = getScoringTuning()
      expect(await persistScoringTuning(db)).toBe(true)

      // Simulate a process restart: wipe the live store, then hydrate from DB.
      resetScoringTuning()
      expect(getEffectiveMinScore()).not.toBe(80)

      const hydrated = await hydrateScoringTuning(db)
      expect(hydrated.minScore).toBe(80)
      expect(getEffectiveMinScore()).toBe(80)
      expect(getEffectiveWeights().W_NEED).toBeCloseTo(saved.weights.W_NEED, 3)
    } finally {
      db.close()
    }
  })

  it('SCALE GUARD: an UNSTAMPED persisted minScore is ignored on hydrate (weights still hydrate); a stamped sub-floor minScore is clamped up', async () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
      const insert = db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
      const update = db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?')

      // A payload persisted BEFORE the data-point cutover carries no scale
      // stamp — its minScore (need-anchored numbers) must be IGNORED entirely,
      // not reinterpreted; only the scale-agnostic weights hydrate.
      const unstampedWeights = normalizeWeights({ W_NEED: 0.5, W_ELIGIBILITY: 0.2, W_GEO: 0.2, W_CATEGORY: 0.1 })
      insert.run(
        'crawler_scoring_tuning',
        JSON.stringify({ minScore: 20, weights: unstampedWeights }),
        new Date().toISOString(),
      )
      const hydrated = await hydrateScoringTuning(db)
      expect(hydrated.minScore).toBe(DEFAULT_MIN_SCORE)
      expect(getEffectiveMinScore()).toBe(DEFAULT_MIN_SCORE)
      expect(getEffectiveWeights().W_NEED).toBeCloseTo(unstampedWeights.W_NEED, 3)

      // A payload stamped with the CURRENT scale but a sub-floor minScore is
      // healed up to DISCOVERY_MIN_SCORE_FLOOR on hydrate.
      resetScoringTuning()
      update.run(
        JSON.stringify({
          minScore: DISCOVERY_MIN_SCORE_FLOOR - 3,
          weights: getScoringTuning().weights,
          scale: SCORE_SCALE_ID,
        }),
        new Date().toISOString(),
        'crawler_scoring_tuning',
      )
      const rehydrated = await hydrateScoringTuning(db)
      expect(rehydrated.minScore).toBe(DISCOVERY_MIN_SCORE_FLOOR)
      expect(getEffectiveMinScore()).toBe(DISCOVERY_MIN_SCORE_FLOOR)
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

    // NEED-ANCHORED SPLIT (owner directive 2026-07-06): the FINAL score is
    // need-coverage × eligibility/geo gates and does NOT move with weight
    // changes — the W_* weights act only inside the legacy weighted-evidence
    // blend, surfaced as scoreBreakdown.topical_evidence. So the "tuning takes
    // effect" proof reads the topical subscale, where weights still act.
    const topicalOf = (d) => Number(d.match_explain?.scoreBreakdown?.topical_evidence)

    const before = topicalOf(computeMatchDecision(profile, opp))
    expect(Number.isFinite(before)).toBe(true)

    // Skew weights hard toward need; the live store must change the engine's blend.
    setScoringTuning({ weights: { W_NEED: 0.6, W_ELIGIBILITY: 0.15, W_GEO: 0.15, W_CATEGORY: 0.1 } })
    const afterNeedHeavy = topicalOf(computeMatchDecision(profile, opp))

    setScoringTuning({ weights: { W_NEED: 0.05, W_ELIGIBILITY: 0.6, W_GEO: 0.3, W_CATEGORY: 0.05 } })
    const afterEligHeavy = topicalOf(computeMatchDecision(profile, opp))

    // At least one skew must move the topical blend off the default — proves the
    // engine consumes getEffectiveWeights() rather than the cached constants.
    expect(afterNeedHeavy !== before || afterEligHeavy !== before).toBe(true)
  })
})
