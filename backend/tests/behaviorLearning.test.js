/**
 * behaviorLearning.test.js
 *
 * User-behavior learning as SOFT preference signals (architecture P2 + #12).
 *
 * Asserts:
 *   1. recordBehaviorEvent persists events; getProfilePreferenceSignals
 *      aggregates them into a SMALL bounded soft-preference vector.
 *   2. The per-opportunity nudge is BOUNDED (clamped to ±BEHAVIOR_NUDGE_MAX)
 *      and signed (positive for saved/applied categories, negative for
 *      dismissed/loan-like sources).
 *   3. HARD REQUIREMENT — NO REGRESSION: scoreOpportunity with NO preference
 *      signals (or an empty vector, or the feature disabled) produces a score
 *      IDENTICAL to the baseline. SOFT learning is never a hard filter.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  recordBehaviorEvent,
  getProfilePreferenceSignals,
  computePreferenceNudge,
  emptyPreferenceSignals,
  isBehaviorLearningEnabled,
} from '../services/behaviorLearning.js'
import { scoreOpportunity } from '../services/matchEngine.js'
import { BEHAVIOR_NUDGE_MAX, BEHAVIOR_SIGNAL_MAX } from '../config/matchThresholds.js'

function makeDb() {
  // Plain better-sqlite3: no `.dialect`, so the service takes the SQLite branch.
  // The service uses `await db.prepare(sql).run()`; awaiting a sync return value
  // resolves to it, so the same instance works for both code paths.
  return new Database(':memory:')
}

const PROFILE_ID = 'profile-test-1'

const housingOpp = {
  id: 'opp-housing',
  title: 'Emergency Rental Assistance Program',
  description: 'Help paying rent and avoiding eviction.',
  source: 'curated_benefits',
  categories: ['housing'],
  need_types_supported: ['housing'],
  state: 'TN',
  is_national: false,
}

const loanOpp = {
  id: 'opp-loan',
  title: 'Small Business Microloan',
  description: 'A microloan for entrepreneurs.',
  source: 'curated_program',
  categories: ['business'],
  need_types_supported: ['business'],
  is_loan: true,
  is_national: true,
}

describe('behaviorLearning — schema, recording, aggregation', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('feature is enabled by default (no env flag)', () => {
    delete process.env.BEHAVIOR_LEARNING_ENABLED
    expect(isBehaviorLearningEnabled()).toBe(true)
  })

  it('records events and aggregates them into a bounded preference vector', async () => {
    // Save several housing opportunities → ↑ housing.
    for (let i = 0; i < 5; i++) {
      const r = await recordBehaviorEvent(db, {
        profileId: PROFILE_ID,
        action: 'saved',
        opportunity: housingOpp,
      })
      expect(r.recorded).toBe(true)
    }
    // Dismiss a loan → ↓ loan-like sources.
    await recordBehaviorEvent(db, {
      profileId: PROFILE_ID,
      action: 'dismissed',
      opportunity: loanOpp,
    })

    const signals = await getProfilePreferenceSignals(db, PROFILE_ID)
    expect(signals.eventCount).toBe(6)

    // Housing category nudges UP, bounded to ±BEHAVIOR_SIGNAL_MAX.
    expect(signals.categories.housing).toBeGreaterThan(0)
    expect(signals.categories.housing).toBeLessThanOrEqual(BEHAVIOR_SIGNAL_MAX)
    expect(signals.needs.housing).toBeGreaterThan(0)

    // Loan source nudges DOWN (dismissed a loan), bounded.
    expect(signals.sources.loan).toBeLessThan(0)
    expect(signals.sources.loan).toBeGreaterThanOrEqual(-BEHAVIOR_SIGNAL_MAX)

    // Locality lean is positive (saved local housing) and bounded.
    expect(signals.locality).toBeGreaterThan(0)
    expect(signals.locality).toBeLessThanOrEqual(BEHAVIOR_SIGNAL_MAX)
  })

  it('every per-signal magnitude is clamped to ±BEHAVIOR_SIGNAL_MAX even after many events', async () => {
    for (let i = 0; i < 100; i++) {
      await recordBehaviorEvent(db, {
        profileId: PROFILE_ID,
        action: 'applied',
        opportunity: housingOpp,
      })
    }
    const signals = await getProfilePreferenceSignals(db, PROFILE_ID)
    for (const bag of [signals.categories, signals.needs, signals.sources]) {
      for (const v of Object.values(bag)) {
        expect(Math.abs(v)).toBeLessThanOrEqual(BEHAVIOR_SIGNAL_MAX)
      }
    }
    expect(Math.abs(signals.locality)).toBeLessThanOrEqual(BEHAVIOR_SIGNAL_MAX)
  })

  it('no events → empty (no-op) vector', async () => {
    const signals = await getProfilePreferenceSignals(db, 'nobody')
    expect(signals).toEqual(emptyPreferenceSignals())
  })

  it('recordBehaviorEvent is best-effort: bad inputs never throw', async () => {
    await expect(recordBehaviorEvent(null, {})).resolves.toMatchObject({ recorded: false })
    await expect(
      recordBehaviorEvent(db, { profileId: PROFILE_ID, action: 'bogus', opportunity: housingOpp }),
    ).resolves.toMatchObject({ recorded: false, reason: 'bad_action' })
  })
})

describe('computePreferenceNudge — bounded additive nudge', () => {
  it('positive nudge for a category the user saves; clamped to ±BEHAVIOR_NUDGE_MAX', () => {
    const signals = {
      categories: { housing: BEHAVIOR_SIGNAL_MAX },
      needs: { housing: BEHAVIOR_SIGNAL_MAX },
      sources: { local: BEHAVIOR_SIGNAL_MAX, curated_benefits: BEHAVIOR_SIGNAL_MAX },
      locality: BEHAVIOR_SIGNAL_MAX,
      eventCount: 50,
    }
    const { nudge, reason } = computePreferenceNudge(signals, housingOpp)
    expect(nudge).toBeGreaterThan(0)
    expect(nudge).toBeLessThanOrEqual(BEHAVIOR_NUDGE_MAX)
    expect(reason).toMatch(/Your activity: \+\d+/)
  })

  it('negative nudge for a source the user rejects (loan)', () => {
    const signals = {
      categories: {},
      needs: {},
      sources: { loan: -BEHAVIOR_SIGNAL_MAX },
      locality: 0,
      eventCount: 10,
    }
    const { nudge } = computePreferenceNudge(signals, loanOpp)
    expect(nudge).toBeLessThan(0)
    expect(nudge).toBeGreaterThanOrEqual(-BEHAVIOR_NUDGE_MAX)
  })

  it('empty / absent vector → ZERO nudge, no reason (no-op)', () => {
    expect(computePreferenceNudge(emptyPreferenceSignals(), housingOpp)).toMatchObject({
      nudge: 0,
      reason: null,
    })
    expect(computePreferenceNudge(null, housingOpp)).toMatchObject({ nudge: 0, reason: null })
  })
})

describe('scoreOpportunity — SOFT nudge, NO REGRESSION when no behavior data', () => {
  const profile = {
    primary_type: 'individual',
    state: 'TN',
    needs: ['housing'],
    keywords: ['rent', 'eviction'],
  }

  it('no preferenceSignals → identical score to baseline', () => {
    const baseline = scoreOpportunity(profile, housingOpp)
    const noSignals = scoreOpportunity(profile, housingOpp, {})
    const undefinedOpts = scoreOpportunity(profile, housingOpp, undefined)
    expect(noSignals.score).toBe(baseline.score)
    expect(undefinedOpts.score).toBe(baseline.score)
  })

  it('EMPTY preference vector → identical score to baseline (zero-default)', () => {
    const baseline = scoreOpportunity(profile, housingOpp)
    const empty = scoreOpportunity(profile, housingOpp, {
      preferenceSignals: emptyPreferenceSignals(),
    })
    expect(empty.score).toBe(baseline.score)
    expect(empty.match_explain.behaviorNudge).toBeUndefined()
  })

  it('non-empty matching vector applies a bounded nudge and surfaces a reason', () => {
    const baseline = scoreOpportunity(profile, housingOpp)
    const signals = {
      categories: { housing: BEHAVIOR_SIGNAL_MAX },
      needs: { housing: BEHAVIOR_SIGNAL_MAX },
      sources: {},
      locality: 0,
      eventCount: 20,
    }
    const nudged = scoreOpportunity(profile, housingOpp, { preferenceSignals: signals })
    // Score moved, but only within the bounded nudge range, never beyond 100.
    expect(nudged.score).toBeGreaterThanOrEqual(baseline.score)
    expect(nudged.score - baseline.score).toBeLessThanOrEqual(BEHAVIOR_NUDGE_MAX)
    expect(nudged.score).toBeLessThanOrEqual(100)
    if (nudged.score > baseline.score) {
      expect(nudged.match_explain.behaviorNudge).toMatch(/Your activity/)
    }
  })

  it('vector that does not match this opportunity → no change', () => {
    const baseline = scoreOpportunity(profile, housingOpp)
    const unrelated = {
      categories: { education: BEHAVIOR_SIGNAL_MAX },
      needs: { education: BEHAVIOR_SIGNAL_MAX },
      sources: { university: BEHAVIOR_SIGNAL_MAX },
      locality: 0,
      eventCount: 20,
    }
    const scored = scoreOpportunity(profile, housingOpp, { preferenceSignals: unrelated })
    expect(scored.score).toBe(baseline.score)
  })

  it('end-to-end: recorded events → computed vector → bounded nudge applied', async () => {
    const db = makeDb()
    for (let i = 0; i < 6; i++) {
      await recordBehaviorEvent(db, { profileId: PROFILE_ID, action: 'saved', opportunity: housingOpp })
    }
    const signals = await getProfilePreferenceSignals(db, PROFILE_ID)
    expect(signals.eventCount).toBe(6)

    const baseline = scoreOpportunity(profile, housingOpp)
    const nudged = scoreOpportunity(profile, housingOpp, { preferenceSignals: signals })
    expect(nudged.score).toBeGreaterThanOrEqual(baseline.score)
    expect(nudged.score - baseline.score).toBeLessThanOrEqual(BEHAVIOR_NUDGE_MAX)
  })
})
