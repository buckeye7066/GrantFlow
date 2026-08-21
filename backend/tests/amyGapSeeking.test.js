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
import Database from 'better-sqlite3'
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
import {
  buildDeletionProof,
  classifySurvivorHold,
  findExpiredSurvivors,
  DELETION_VERDICT,
  SURVIVOR_HOLD,
} from '../services/amy/amyDeletionProof.js'
import { CATEGORY_IDS } from '../services/amy/syntheticProfileCatalog.js'
import { ORIGIN_CREATED_BY } from '../services/amy/amyConstants.js'

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

  describe('a past-TTL row the sweep is DELIBERATELY holding is GRACE_HELD, not LEAKED (2026-08-03)', () => {
    // The real prod pair behind the 2026-08-03 owner-report alarm: both rows
    // were skipped by the expired sweep with its OWN telemetry reason
    // `crawled_too_recently` (amy_last_report.cleanup_expired.skipped_ids) —
    // markers intact, freshly re-discovered, inside the documented 6h grace —
    // yet verifyAmyDeletion reported them as LEAKED.
    const NOW = new Date('2026-08-03T15:28:00.000Z')
    const prodSurvivorB9 = {
      id: 'b9ca2567-c124-4a09-8b3a-208f86de9782',
      expires_at: '2026-08-02T21:58:19.925Z',
      created_at: '2026-07-31T21:58:19.925Z',
      crawled_signal_at: '2026-08-03T14:21:53.619Z', // 1.1h before NOW — inside the 6h grace
      allow_sam_cleanup: true,
      synthetic: true,
    }

    it('classifies the real prod survivor as CRAWL_GRACE', () => {
      expect(classifySurvivorHold(prodSurvivorB9, { now: NOW })).toBe(SURVIVOR_HOLD.CRAWL_GRACE)
    })

    it('verdict is GRACE_HELD (non-alarming) when every survivor is guard-held', () => {
      const held = { ...prodSurvivorB9, hold: SURVIVOR_HOLD.CRAWL_GRACE }
      const p = buildDeletionProof({
        before: 71, after: 21, created: 50,
        runCleanup: { deleted: 50 }, expiredSweep: { deleted: 0 },
        survivors: [held],
      })
      expect(p.verdict).toBe(DELETION_VERDICT.GRACE_HELD)
      expect(p.grace_held_count).toBe(1)
      expect(p.leaked_survivor_count).toBe(0)
      expect(p.expired_survivor_count).toBe(1) // meaning unchanged: ALL past-TTL rows
      expect(p.reasons.join(' ')).toMatch(/documented grace/)
    })

    it('one unexplained survivor keeps the verdict LEAKED even beside a grace-held one', () => {
      const p = buildDeletionProof({
        before: 71, after: 21, created: 50,
        runCleanup: { deleted: 50 }, expiredSweep: { deleted: 0 },
        survivors: [
          { ...prodSurvivorB9, hold: SURVIVOR_HOLD.CRAWL_GRACE },
          { id: 'p-bad', expires_at: '2026-07-30T00:00:00Z', hold: null },
        ],
      })
      expect(p.verdict).toBe(DELETION_VERDICT.LEAKED)
      expect(p.leaked_survivor_count).toBe(1)
      expect(p.grace_held_count).toBe(1)
    })

    it('an old-shape survivor with NO hold key fails TOWARD the alarm (LEAKED)', () => {
      const p = buildDeletionProof({
        before: 55, after: 6, created: 50,
        runCleanup: { deleted: 49 }, expiredSweep: { deleted: 0 },
        survivors: [{ id: 'p1', expires_at: '2026-07-30T00:00:00Z' }],
      })
      expect(p.verdict).toBe(DELETION_VERDICT.LEAKED)
    })

    it('a STALE crawl signal is NOT a hold — the sweep should have reaped it', () => {
      expect(classifySurvivorHold(
        { ...prodSurvivorB9, crawled_signal_at: '2026-08-03T02:00:00.000Z' }, // 13.5h > 6h grace
        { now: NOW },
      )).toBeNull()
    })

    it('marker drift is NOT a hold even inside the grace (the sweep can never reap it)', () => {
      expect(classifySurvivorHold({ ...prodSurvivorB9, allow_sam_cleanup: false }, { now: NOW })).toBeNull()
      expect(classifySurvivorHold({ ...prodSurvivorB9, synthetic: false }, { now: NOW })).toBeNull()
    })

    it('perpetual grace-riding ESCALATES: past the never-crawled bound (96h) a fresh crawl no longer holds it', () => {
      // A synthetic still riding 6h graces 4+ days after creation is being
      // starved by perpetual re-discovery, not protected mid-flight.
      expect(classifySurvivorHold(
        { ...prodSurvivorB9, created_at: '2026-07-29T15:00:00.000Z', crawled_signal_at: '2026-08-03T15:00:00.000Z' },
        { now: NOW },
      )).toBeNull()
    })

    it('a never-crawled survivor is held INSIDE the bounded window and a leak past it', () => {
      const neverCrawled = { ...prodSurvivorB9, crawled_signal_at: null }
      expect(classifySurvivorHold(neverCrawled, { now: NOW })).toBe(SURVIVOR_HOLD.NEVER_CRAWLED_WINDOW)
      expect(classifySurvivorHold(
        { ...neverCrawled, created_at: '2026-07-29T15:00:00.000Z' },
        { now: NOW },
      )).toBeNull()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A TRUNCATED SURVIVOR SCAN CANNOT SAY "PROVEN" (2026-08-21)
//
// `cleanupExpiredAmyProfiles` (the DELETER) loads Amy's profiles with NO limit
// at all — `listAmyProfiles` is a bare `SELECT ... WHERE created_by = ?`. Its
// PROOF, `findExpiredSurvivors`, reads the same rows under `LIMIT 200` and then
// decides expiry in JavaScript, on the rows that came back.
//
// That asymmetry is the #944/#1080 shape pointed at the honesty layer instead
// of at a repair: with more than 200 Amy rows alive (the design target is ~50 a
// night and prod has held 55 from one run plus leftovers, so three skipped
// nights reach it), rows past the bound are never examined — and
// `buildDeletionProof` treats the truncated array as the COMPLETE leak set. It
// computes `live_within_ttl = after - survivors.length` from it and can return
// `proven` while unscanned rows sit past their TTL.
//
// The rule this repo already applies to counts applies here: an unreadable —
// or partially-read — world proves nothing. A truncated scan is `unknown`,
// unless leaks were ALREADY found in the part that was read, in which case the
// alarm wins.
// ─────────────────────────────────────────────────────────────────────────────
describe('a truncated survivor scan is UNKNOWN, never PROVEN', () => {
  const CLEAN = { before: 260, after: 250, created: 250, runCleanup: { deleted: 10 }, expiredSweep: { deleted: 0 } }

  it('refuses `proven` when the survivor scan hit its bound', () => {
    const survivors = []
    survivors.truncated = true
    const p = buildDeletionProof({ ...CLEAN, survivors })
    expect(p.verdict).toBe(DELETION_VERDICT.UNKNOWN)
    expect(p.reasons.join(' ')).toMatch(/bound|truncat/i)
    expect(p.survivor_scan_truncated).toBe(true)
  })

  it('accepts an explicit scanTruncated flag from the caller', () => {
    const p = buildDeletionProof({ ...CLEAN, survivors: [], scanTruncated: true })
    expect(p.verdict).toBe(DELETION_VERDICT.UNKNOWN)
    expect(p.survivor_scan_truncated).toBe(true)
  })

  it('a leak found in the part that WAS read still wins over unknown', () => {
    const survivors = [{ id: 'p-leak', expires_at: '2026-07-30T00:00:00Z', hold: null }]
    survivors.truncated = true
    const p = buildDeletionProof({ ...CLEAN, survivors })
    expect(p.verdict).toBe(DELETION_VERDICT.LEAKED)
    expect(p.survivor_scan_truncated).toBe(true)
  })

  it('an untruncated scan is unaffected — still PROVEN', () => {
    const p = buildDeletionProof({ ...CLEAN, survivors: [] })
    expect(p.verdict).toBe(DELETION_VERDICT.PROVEN)
    expect(p.survivor_scan_truncated).toBe(false)
  })
})

describe('findExpiredSurvivors reads PAST the old 200-row bound', () => {
  function amyDb() {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY, display_name TEXT, created_by TEXT,
        created_at TEXT, last_discovery_at TEXT
      );
      CREATE TABLE profile_sections (
        profile_id TEXT NOT NULL, section_key TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(profile_id, section_key)
      );
    `)
    return db
  }

  /** `n` Amy rows; the LAST one is the only expired row, so a single-page scan misses it. */
  function seedAmyRows(db, n, { expiredIndex = n - 1 } = {}) {
    for (let i = 0; i < n; i += 1) {
      // Zero-padded ids so `ORDER BY p.id` matches insertion order.
      const id = `amy-${String(i).padStart(5, '0')}`
      db.prepare('INSERT INTO profiles (id, display_name, created_by, created_at) VALUES (?, ?, ?, ?)')
        .run(id, `Synthetic ${i}`, ORIGIN_CREATED_BY, '2026-08-20T00:00:00.000Z')
      db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)').run(
        id,
        'amy_metadata',
        JSON.stringify({
          synthetic: true,
          allow_sam_cleanup: true,
          // Everything but the marked row is still well inside its TTL.
          expires_at: i === expiredIndex ? '2026-08-20T01:00:00.000Z' : '2026-08-30T00:00:00.000Z',
        }),
      )
    }
  }

  const NOW = new Date('2026-08-21T00:00:00.000Z')

  it('finds an expired row sitting at position 250 (the old bound hid it)', async () => {
    const db = amyDb()
    seedAmyRows(db, 260)
    const survivors = await findExpiredSurvivors(db, { now: NOW })
    expect(survivors).toHaveLength(1)
    expect(survivors[0].id).toBe('amy-00259')
    expect(survivors.truncated).toBe(false)
  })

  it('marks the scan truncated when it stops at maxScan, and the proof refuses `proven`', async () => {
    const db = amyDb()
    seedAmyRows(db, 260)
    const survivors = await findExpiredSurvivors(db, { now: NOW, limit: 50, maxScan: 100 })
    expect(survivors.truncated).toBe(true)
    expect(survivors).toHaveLength(0) // the expired row is past the cap
    const proof = buildDeletionProof({
      before: 270, after: 260, created: 260,
      runCleanup: { deleted: 10 }, expiredSweep: { deleted: 0 },
      survivors,
    })
    expect(proof.verdict).toBe(DELETION_VERDICT.UNKNOWN)
    expect(proof.survivor_scan_truncated).toBe(true)
  })

  it('degrades to the no-last_discovery_at schema without losing paging', async () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, created_by TEXT, created_at TEXT);
      CREATE TABLE profile_sections (
        profile_id TEXT NOT NULL, section_key TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(profile_id, section_key)
      );
    `)
    seedAmyRows(db, 260)
    const survivors = await findExpiredSurvivors(db, { now: NOW })
    expect(survivors).toHaveLength(1)
    expect(survivors[0].id).toBe('amy-00259')
    expect(survivors[0].crawled_signal_at).toBeNull()
  })
})
