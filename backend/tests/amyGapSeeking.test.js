/**
 * amyGapSeeking.test.js — the adversarial planner, the coverage ledger, the
 * convergence verdict and the deletion proof.
 *
 * The claims these tests are here to make checkable:
 *   1. Amy PROBES UNCOVERED SPACE. Every selected cell retires at least one
 *      previously-uncovered pair, and a second night does not repeat the first.
 *   2. She is DETERMINISTIC per run, so a night can be reproduced and audited.
 *   3. Breadth is honest: an errored probe counts as asked, never as clean, and
 *      convergence cannot be claimed on flat breadth.
 *   4. Deletion is PROVEN from row counts, and an unreadable count yields
 *      `unknown` rather than a comfortable `proven`.
 */

import { describe, it, expect } from 'vitest'
import { planGapSeekingProbes, resolveCohortSplit } from '../services/amy/gapSeekingPlanner.js'
import { buildIntersectionScenarios, buildIntersectionScenario } from '../services/amy/intersectionScenario.js'
import {
  foldProbeCoverage,
  summarizeCoverage,
  classifyProbeOutcome,
  gapPressureIndex,
  PROBE_OUTCOME,
} from '../services/amy/probeCoverageLedger.js'
import { cellPairs, isPlausibleCell, reachablePairCount, enumerateReachablePairs, STATE_IDS } from '../services/amy/probeSpace.js'
import { assessConvergence, TREND } from '../services/amy/gapConvergence.js'
import { buildDeletionProof, DELETION_VERDICT } from '../services/amy/amyDeletionProof.js'
import { CATEGORY_IDS } from '../services/amy/syntheticProfileCatalog.js'

const AT = '2026-08-03T04:00:00.000Z'

describe('the planner probes UNCOVERED space, not a catalog', () => {
  it('every chosen cell retires at least one previously-uncovered pair', () => {
    const plan = planGapSeekingProbes({ ledger: null, count: 18, runId: 'run-a' })
    expect(plan.cells).toHaveLength(18)
    const covered = new Set()
    for (const cell of plan.cells) {
      const pairs = cellPairs(cell)
      expect(pairs.some((p) => !covered.has(p)), cell.cell_key).toBe(true)
      for (const p of pairs) covered.add(p)
    }
    expect(plan.pairs_targeted).toBeGreaterThanOrEqual(plan.cells.length)
  })

  it('only ever emits PLAUSIBLE intersections', () => {
    const plan = planGapSeekingProbes({ ledger: null, count: 40, runId: 'run-plaus' })
    for (const cell of plan.cells) expect(isPlausibleCell(cell), cell.cell_key).toBe(true)
  })

  it('is deterministic for a given (ledger, runId) and varies across runs', () => {
    const keys = (runId) => planGapSeekingProbes({ ledger: null, count: 12, runId }).cells.map((c) => c.cell_key)
    expect(keys('same')).toEqual(keys('same'))
    expect(keys('same')).not.toEqual(keys('other'))
  })

  it('does not collapse onto one axis value — the seed-order regression', () => {
    // Before the seeded shuffle, ties were broken by key ASCENDING, so on night
    // one (all pressures 0) every seed began `entity:animal_rescue~…` and all
    // 18 probes were animal rescues. Breadth per night must not depend on the
    // alphabet.
    const plan = planGapSeekingProbes({ ledger: null, count: 18, runId: 'spread' })
    const entities = new Set(plan.cells.map((c) => c.entity))
    const states = new Set(plan.cells.map((c) => c.state))
    expect(entities.size).toBeGreaterThan(6)
    expect(states.size).toBeGreaterThan(6)
  })

  it('night two does not re-ask night one', () => {
    const night1 = planGapSeekingProbes({ ledger: null, count: 18, runId: 'n1' })
    const { ledger } = foldProbeCoverage(null, {
      probes: night1.cells.map((cell) => ({ cell, outcome: PROBE_OUTCOME.CLEAN })),
      runId: 'n1',
      at: AT,
    })
    const night2 = planGapSeekingProbes({ ledger, count: 18, runId: 'n2', now: AT })
    const seen = new Set(night1.cells.map((c) => c.cell_key))
    const repeats = night2.cells.filter((c) => seen.has(c.cell_key))
    expect(repeats).toEqual([])
    expect(night2.uncovered_before).toBeLessThan(night1.uncovered_before)
  })

  it('follows gap PRESSURE when novelty is equal', () => {
    // Explore DOMINATES exploit by design (a fresh axis value retires up to
    // three pairs at W_NEW=1.0, outweighing a fully-gapped value's W_GAP=2.0),
    // so pressure is only visible once novelty is held equal. Give all 51
    // states IDENTICAL coverage and give WV alone a 100% gap rate.
    const base = planGapSeekingProbes({ ledger: null, count: 20, runId: 'base' }).cells
    const probes = []
    for (const state of STATE_IDS) {
      for (const cell of base) {
        probes.push({ cell: { ...cell, state }, outcome: state === 'WV' ? PROBE_OUTCOME.GAP : PROBE_OUTCOME.CLEAN })
      }
    }
    const { ledger } = foldProbeCoverage(null, { probes, runId: 'seed', at: AT })
    expect(gapPressureIndex(ledger)['state:WV']).toBe(1)
    expect(gapPressureIndex(ledger)['state:WY']).toBe(0)

    const plan = planGapSeekingProbes({ ledger, count: 51, runId: 'exploit', now: AT })
    const byState = {}
    for (const c of plan.cells) byState[c.state] = (byState[c.state] || 0) + 1
    const modal = Object.entries(byState).sort((a, b) => b[1] - a[1])[0]
    expect(modal[0]).toBe('WV')
    expect(byState.WV).toBeGreaterThan(byState.WY || 0)
  })

  it('tops up rather than shrinking the night when the pair space runs dry', () => {
    // Returning fewer probes late in convergence would NARROW the search, which
    // is exactly the failure the convergence metric exists to catch. A ledger
    // claiming every reachable pair is covered must still yield a full night.
    const at = AT
    const pairs = {}
    for (const p of enumerateReachablePairs()) pairs[p] = { first_at: at, last_at: at, probes: 1, gaps: 0 }
    const seeded = planGapSeekingProbes({ ledger: null, count: 25, runId: 'dry-seed' }).cells
    const cells = {}
    for (const c of seeded) cells[c.cell_key] = { first_at: at, last_at: at, probes: 1, gaps: 1, last_status: 'gap' }
    const plan = planGapSeekingProbes({ ledger: { pairs, cells, axis: {} }, count: 12, runId: 'dry', now: at })
    expect(plan.exhausted).toBe(true)
    expect(plan.cells).toHaveLength(12)
    for (const c of plan.cells) expect(isPlausibleCell(c)).toBe(true)
    expect(plan.cells.every((c) => c.top_up)).toBe(true)
  })
})

describe('the catalog FLOOR is never sacrificed to exploration', () => {
  it('gives the catalog at least one slot per category', () => {
    const split = resolveCohortSplit({ targetCount: 50, catalogCategories: CATEGORY_IDS.length })
    expect(split.catalog).toBeGreaterThanOrEqual(CATEGORY_IDS.length)
    expect(split.catalog + split.adversarial).toBe(50)
    expect(split.adversarial).toBeGreaterThan(0)
  })

  it('spends nothing on probes when the target cannot even cover the floor', () => {
    const split = resolveCohortSplit({ targetCount: 20, catalogCategories: 32 })
    expect(split.adversarial).toBe(0)
    expect(split.catalog).toBe(20)
  })

  it('an ABSENT share is the default, not zero (the Number(null) trap)', () => {
    // `Number(null)` is 0 and IS finite. A bare isFinite check read "no share
    // supplied" as "share = 0" and turned the whole adversarial cohort off
    // while reporting success.
    const declared = resolveCohortSplit({ targetCount: 50, catalogCategories: 32, share: null })
    expect(declared.adversarial).toBe(18)
    expect(resolveCohortSplit({ targetCount: 50, catalogCategories: 32, share: 0 }).adversarial).toBe(0)
  })
})

describe('a cell becomes a schema-accurate, obviously-synthetic profile', () => {
  const cell = { entity: 'veteran', identity: 'health:tbi', need: 'business', state: 'WV' }

  it('declares the identity in canonical SECTION FIELDS, not prose', () => {
    const sc = buildIntersectionScenario(cell, { runId: 'r', index: 0 })
    expect(sc.sections.health_medical.conditions[0].name).toBe('tbi')
    expect(sc.sections.basic_information.state).toBe('WV')
    expect(sc.sections.basic_information.county).toBe('Raleigh')
    expect(sc.primary_type).toBe('veteran')
    expect(sc.kind).toBe('individual')
    expect(sc.sections.organization_details).toBeUndefined()
  })

  it('an ORG carrying an identity SERVES it — it never claims to BE it', () => {
    const sc = buildIntersectionScenario(
      { entity: 'mental_health_nonprofit', identity: 'veteran', need: 'health_medical', state: 'OH' },
      { runId: 'r', index: 0 },
    )
    expect(sc.kind).toBe('org')
    expect(sc.sections.military_service).toBeUndefined()
    expect(sc.sections.narrative.target_population).toBe('Veterans & Military')
    expect(sc.sections.financial_information).toBeUndefined()
  })

  it('never emits real-looking contact data', () => {
    const scs = buildIntersectionScenarios(
      planGapSeekingProbes({ ledger: null, count: 10, runId: 'pii' }).cells,
      { runId: 'pii' },
    )
    for (const sc of scs) {
      expect(sc.sections.basic_information.email).toMatch(/@synthetic\.grantflow\.invalid$/)
      expect(sc.sections.basic_information.phone).toMatch(/^555-01\d{2}$/)
      expect(sc.display_name).toMatch(/^Amy Probe — /)
      expect(sc.probe_cell).toBeTruthy()
    }
  })

  it('refuses to build from a cell it cannot resolve', () => {
    expect(buildIntersectionScenario({ entity: 'nope', identity: 'none', need: 'food', state: 'TN' }, {})).toBeNull()
    expect(buildIntersectionScenario({ entity: 'veteran', identity: 'none', need: 'food', state: 'ZZ' }, {})).toBeNull()
  })
})

describe('the coverage ledger measures BREADTH honestly', () => {
  const cell = { entity: 'veteran', identity: 'none', need: 'housing', state: 'WV' }

  it('an errored or skipped probe counts as ASKED but never as clean', () => {
    expect(classifyProbeOutcome({ status: 'error' })).toBe(PROBE_OUTCOME.UNKNOWN)
    expect(classifyProbeOutcome({ status: 'skipped' })).toBe(PROBE_OUTCOME.UNKNOWN)
    expect(classifyProbeOutcome({ status: 'zero' })).toBe(PROBE_OUTCOME.GAP)
    expect(classifyProbeOutcome({ status: 'ok', findings: [] })).toBe(PROBE_OUTCOME.CLEAN)
    // An `ok` run that still carried a finding is a GAP: results came back and
    // they were wrong or incomplete.
    expect(classifyProbeOutcome({ status: 'ok', findings: [{ type: 'amount_recall_miss' }] })).toBe(PROBE_OUTCOME.GAP)

    const { ledger } = foldProbeCoverage(null, {
      probes: [{ cell, outcome: PROBE_OUTCOME.UNKNOWN }],
      runId: 'r1',
      at: AT,
    })
    const s = summarizeCoverage(ledger)
    expect(s.pairs_covered).toBe(6)
    expect(s.recent_cell_gaps).toBe(0)
    expect(s.recent_cell_probes).toBe(1)
  })

  it('re-folding the SAME run does not inflate coverage', () => {
    const first = foldProbeCoverage(null, { probes: [{ cell, outcome: PROBE_OUTCOME.CLEAN }], runId: 'r1', at: AT })
    const again = foldProbeCoverage(first.ledger, { probes: [{ cell, outcome: PROBE_OUTCOME.CLEAN }], runId: 'r1', at: AT })
    expect(again.duplicate).toBe(true)
    expect(summarizeCoverage(again.ledger).pairs_covered).toBe(6)
  })

  it('reports coverage against the REAL reachable denominator', () => {
    const { ledger } = foldProbeCoverage(null, { probes: [{ cell, outcome: PROBE_OUTCOME.GAP }], runId: 'r1', at: AT })
    const s = summarizeCoverage(ledger)
    expect(s.pairs_total).toBe(reachablePairCount())
    expect(s.pairs_covered_pct).toBeCloseTo(Number((6 / s.pairs_total).toFixed(4)), 6)
  })
})

describe('convergence distinguishes "no gaps" from "we stopped looking"', () => {
  const flywheelFalling = {
    days: {
      '2026-07-20': { clean: 10, issues: 40 }, '2026-07-21': { clean: 10, issues: 40 },
      '2026-07-22': { clean: 10, issues: 40 }, '2026-07-23': { clean: 10, issues: 40 },
      '2026-07-24': { clean: 10, issues: 40 },
      '2026-07-25': { clean: 45, issues: 5 }, '2026-07-26': { clean: 45, issues: 5 },
      '2026-07-27': { clean: 45, issues: 5 }, '2026-07-28': { clean: 45, issues: 5 },
      '2026-07-29': { clean: 45, issues: 5 },
    },
  }

  it('CONVERGING only when gaps fell AND breadth rose', () => {
    const v = assessConvergence({
      flywheel: flywheelFalling,
      coverage: { pairs_covered: 900, pairs_total: 9000, pairs_covered_delta: 108, pairs_covered_pct: 0.1 },
      approvalQueue: [],
    })
    expect(v.trend).toBe(TREND.CONVERGING)
    expect(v.breadth.nights_to_full_coverage).toBe(75)
  })

  it('NARROWED when gaps fell on flat breadth — the failure mode, named', () => {
    const v = assessConvergence({
      flywheel: flywheelFalling,
      coverage: { pairs_covered: 900, pairs_total: 9000, pairs_covered_delta: 0, pairs_covered_pct: 0.1 },
      approvalQueue: [],
    })
    expect(v.trend).toBe(TREND.NARROWED)
    expect(v.statement).toMatch(/NOT convergence/)
  })

  it('NARROWED when there is no coverage ledger at all — absence is not breadth', () => {
    const v = assessConvergence({ flywheel: flywheelFalling, coverage: null, approvalQueue: [] })
    expect(v.trend).toBe(TREND.NARROWED)
    expect(v.breadth).toBeNull()
  })

  it('EXPLORING when new space is turning up new holes', () => {
    const rising = { days: Object.fromEntries(Object.entries(flywheelFalling.days).reverse().map(([, v], i) => [`2026-07-${String(20 + i).padStart(2, '0')}`, v])) }
    const v = assessConvergence({
      flywheel: rising,
      coverage: { pairs_covered: 900, pairs_total: 9000, pairs_covered_delta: 120, pairs_covered_pct: 0.1 },
      approvalQueue: [],
    })
    expect(v.trend).toBe(TREND.EXPLORING)
  })

  it('names the classes no lever can close, with the human action', () => {
    const v = assessConvergence({
      flywheel: flywheelFalling,
      coverage: { pairs_covered: 900, pairs_total: 9000, pairs_covered_delta: 10, pairs_covered_pct: 0.1 },
      approvalQueue: [
        { finding_type: 'amount_recall_miss', category: 'probe_cat', lever: 'amount_adapter', nights_open: 21, target_file: 'backend/services/awardAmountExtractor.js' },
        { finding_type: 'zero_result', category: 'x', lever: 'source_keyword_coverage', nights_open: 30 },
        { finding_type: 'false_positive', category: 'y', lever: 'relevance_precision', nights_open: 30 },
      ],
    })
    expect(v.goal_reachable).toBe(false)
    expect(v.unclosable_by_any_lever).toHaveLength(1)
    expect(v.unclosable_by_any_lever[0]).toMatchObject({
      finding_type: 'amount_recall_miss',
      file: 'backend/services/awardAmountExtractor.js',
    })
    // An AUTO lever (Amy's own work) and an OWNER_API lever (a click exists) are
    // NOT "unclosable" — listing them would be the fake ask #1085 removed.
  })

  it('says INSUFFICIENT_HISTORY rather than guessing', () => {
    expect(assessConvergence({ flywheel: { days: { '2026-08-01': { clean: 1, issues: 1 } } }, coverage: null }).trend)
      .toBe(TREND.INSUFFICIENT_HISTORY)
  })
})

describe('deletion is PROVEN from row counts, or it is unknown', () => {
  it('proves a clean sweep', () => {
    const p = buildDeletionProof({
      before: 55, after: 5, created: 50,
      runCleanup: { deleted: 48 }, expiredSweep: { deleted: 2 },
      survivors: [],
    })
    expect(p.verdict).toBe(DELETION_VERDICT.PROVEN)
    expect(p.observed_deleted).toBe(50)
    expect(p.reported_deleted).toBe(50)
    expect(p.live_within_ttl).toBe(5)
  })

  it('LEAKS when a row outlived its TTL', () => {
    const p = buildDeletionProof({
      before: 55, after: 6, created: 50,
      runCleanup: { deleted: 49 }, expiredSweep: { deleted: 0 },
      survivors: [{ id: 'p1', expires_at: '2026-07-30T00:00:00Z' }],
    })
    expect(p.verdict).toBe(DELETION_VERDICT.LEAKED)
    expect(p.expired_survivor_count).toBe(1)
  })

  it('is UNKNOWN — never proven — when a count could not be read', () => {
    for (const args of [
      { before: null, after: 5, survivors: [] },
      { before: 55, after: null, survivors: [] },
      { before: 55, after: 5, survivors: null },
    ]) {
      const p = buildDeletionProof({ ...args, runCleanup: { deleted: 50 }, expiredSweep: { deleted: 0 } })
      expect(p.verdict).toBe(DELETION_VERDICT.UNKNOWN)
      expect(p.reasons.join(' ')).toMatch(/NOT verified/)
    }
  })

  it('states a discrepancy out loud rather than hiding it', () => {
    const p = buildDeletionProof({
      before: 55, after: 3, created: 50,
      runCleanup: { deleted: 48 }, expiredSweep: { deleted: 0 },
      survivors: [],
    })
    expect(p.verdict).toBe(DELETION_VERDICT.PROVEN)
    expect(p.reasons.join(' ')).toMatch(/sweeps reported 48 deleted; the row count moved by 52/)
  })
})
