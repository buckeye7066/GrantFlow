/**
 * Fleet coverage-gap scoreboard (owner directive 2026-07-06: agents learn from
 * the Coverage & Evidence dashboard; Amy's tasks come from gaps, not random).
 *
 * Proves:
 *   - gap statements classify into stable (lane, statement-class) keys
 *   - the fleet scan aggregates per-profile gaps, missing lanes, answer_next
 *     fields, and the structural adapter wishlist
 *   - the scoreboard persists to system_kv `coverage_gap_scoreboard` via the
 *     shim-safe UPDATE-then-INSERT upsert (idempotent re-run)
 *   - Amy's synthetic profiles never poison the fleet scan
 *   - staleness detection, the actionable/structural action split, and the
 *     gap-weighted archetype selection (weightCategoriesByGaps +
 *     planVariantCounts weights)
 *   - Amy's training run consumes the scoreboard (weighted cohort + telemetry
 *     events + fleet_gap_learning report block)
 *   - Sam's `coverage.gapScoreboard` registry check (fail-open, stale alert,
 *     dominant-gap alert, healthy green)
 */

import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  KV_KEY,
  GAP_CLASSES,
  STRUCTURAL_GAP_CLASSES,
  STRUCTURAL_MATRIX_LANE,
  classifyGap,
  aggregateGapResults,
  buildStructuralMatrixSection,
  matrixWishlistEntries,
  buildFleetGapScoreboard,
  readGapScoreboard,
  isScoreboardStale,
  deriveAmyGapActions,
  weightCategoriesByGaps,
} from '../services/coverageGapScoreboard.js'
import { CRITICAL_NEEDS, US_STATES } from '../crawler-os/coverageMatrix.js'
import { planVariantCounts } from '../services/amy/syntheticProfileCatalog.js'
import { getCheckById } from '../services/sam/samRegistry.js'
import { runAmyTraining } from '../services/amy/amyAgent.js'

// ── Canned gaps in the exact shapes buildCoverageEvidence emits ─────────────

const GAP_LANE_EXCLUDED = {
  lane: 'private_charities',
  statement: 'None of the 4 known private charities & foundations sources apply to this profile — not applicable to this profile',
  profile_fact: 'applicant_types=individual',
  suggested_action: 'Review the exclusion reasons: either the profile is missing a fact (type, need, location) or the lane needs a broader source.',
}
const GAP_NO_LANE_ADAPTER = {
  lane: 'county_city',
  statement: 'No county & city programs source adapters exist in the source registry yet.',
  profile_fact: 'location=Davidson, TN',
  suggested_action: 'Add a county & city programs source adapter (e.g. for Davidson, TN) to backend/crawler-os/sourceRegistry.js.',
}
const GAP_NO_STATE = {
  lane: 'state_programs',
  statement: 'No TN-specific state-programs source (benefits, scholarship, or agency adapter) exists in the source registry.',
  profile_fact: 'state=TN',
  suggested_action: "Add a TN state benefits/scholarship source to backend/crawler-os/sourceRegistry.js so this profile's state lane is real, not just national sources.",
}
const GAP_NO_DISEASE = {
  lane: 'disease_specific',
  statement: 'No disease-specific source lane exists for "dementia".',
  profile_fact: 'health_condition=dementia',
  suggested_action: 'Add a dementia patient-assistance / support source to the registry (like cancer_care / alzheimers_gov_services).',
}
const GAP_DISEASE_NOT_SELECTED = {
  lane: 'disease_specific',
  statement: 'CancerCare covers "cancer" but was not selected for this profile.',
  profile_fact: 'health_condition=cancer',
  suggested_action: 'Add the matching need category to the profile (or broaden the source coverage) so the disease-specific lane fires.',
}
const GAP_NEED_UNCOVERED = {
  lane: null,
  statement: 'No searched source covers the profile need "beekeeping".',
  profile_fact: 'need=beekeeping',
  suggested_action: 'Add or broaden a source covering this need category, or refine the profile need wording to a covered category.',
}

describe('classifyGap', () => {
  it('classifies every statement class with the distinguishing detail', () => {
    expect(classifyGap(GAP_NO_LANE_ADAPTER)).toEqual({ gap_class: GAP_CLASSES.NO_LANE_ADAPTER, detail: 'county_city' })
    expect(classifyGap(GAP_LANE_EXCLUDED)).toEqual({ gap_class: GAP_CLASSES.LANE_EXCLUDED, detail: 'private_charities' })
    expect(classifyGap(GAP_NO_STATE)).toEqual({ gap_class: GAP_CLASSES.NO_STATE_SOURCE, detail: 'TN' })
    expect(classifyGap(GAP_NO_DISEASE)).toEqual({ gap_class: GAP_CLASSES.NO_DISEASE_SOURCE, detail: 'dementia' })
    expect(classifyGap(GAP_DISEASE_NOT_SELECTED)).toEqual({ gap_class: GAP_CLASSES.DISEASE_NOT_SELECTED, detail: 'cancer' })
    expect(classifyGap(GAP_NEED_UNCOVERED)).toEqual({ gap_class: GAP_CLASSES.NEED_UNCOVERED, detail: 'beekeeping' })
    expect(classifyGap({ statement: 'something unexpected' }).gap_class).toBe(GAP_CLASSES.OTHER)
  })
})

describe('aggregateGapResults', () => {
  it('aggregates the SAME gap across profiles and keeps different details apart', () => {
    const results = [
      { profile_id: 'p1', gaps: [GAP_NO_STATE, GAP_NO_DISEASE], lanes: [{ lane: 'county_city', status: 'missing' }], answer_next: [{ field: 'income_eligibility', question: 'Income?', blocked_matches: 3 }] },
      { profile_id: 'p2', gaps: [GAP_NO_STATE, GAP_NEED_UNCOVERED], lanes: [{ lane: 'county_city', status: 'missing' }, { lane: 'local_211', status: 'searched' }], answer_next: [{ field: 'income_eligibility', question: 'Income?', blocked_matches: 1 }] },
      { profile_id: 'p3', gaps: [{ ...GAP_NO_STATE, statement: GAP_NO_STATE.statement.replace(/TN/g, 'OH'), profile_fact: 'state=OH' }], lanes: [], answer_next: [] },
    ]
    const out = aggregateGapResults(results)

    const tn = out.gaps.find((g) => g.gap_class === GAP_CLASSES.NO_STATE_SOURCE && g.detail === 'TN')
    expect(tn.count).toBe(2)
    expect(tn.affected_profiles.sort()).toEqual(['p1', 'p2'])
    const oh = out.gaps.find((g) => g.gap_class === GAP_CLASSES.NO_STATE_SOURCE && g.detail === 'OH')
    expect(oh.count).toBe(1)
    // Sorted by affected-profile count.
    expect(out.gaps[0].count).toBeGreaterThanOrEqual(out.gaps[out.gaps.length - 1].count)

    expect(out.top_missing_lanes[0]).toMatchObject({ lane: 'county_city', profiles_missing: 2 })
    expect(out.top_unanswered_fields[0]).toMatchObject({ field: 'income_eligibility', profiles: 2, blocked_matches: 4 })

    // Wishlist carries ONLY structural classes (state + disease, not need_uncovered).
    const wishClasses = new Set(out.adapter_wishlist.map((w) => w.gap_class))
    expect(wishClasses.has(GAP_CLASSES.NO_STATE_SOURCE)).toBe(true)
    expect(wishClasses.has(GAP_CLASSES.NO_DISEASE_SOURCE)).toBe(true)
    expect(wishClasses.has(GAP_CLASSES.NEED_UNCOVERED)).toBe(false)
  })
})

// ── Fleet scan + persistence ────────────────────────────────────────────────

function fleetDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, status TEXT DEFAULT 'active',
      created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return db
}

describe('buildFleetGapScoreboard', () => {
  const evidenceByProfile = {
    real1: { profile_id: 'real1', gaps: [GAP_NO_STATE, GAP_LANE_EXCLUDED], lanes: [{ lane: 'county_city', status: 'missing' }], answer_next: [{ field: 'age', question: 'Age?', blocked_matches: 2 }] },
    real2: { profile_id: 'real2', gaps: [GAP_NO_STATE], lanes: [], answer_next: [] },
  }
  const buildEvidence = async (_db, id) => evidenceByProfile[id] || { profile_id: id, error: 'profile_not_found' }

  it('scans active profiles, EXCLUDES Amy synthetics, aggregates, and persists to system_kv', async () => {
    const db = fleetDb()
    try {
      db.prepare("INSERT INTO profiles (id, display_name, status, created_by) VALUES ('real1', 'Jane Doe', 'active', 'admin')").run()
      db.prepare("INSERT INTO profiles (id, display_name, status, created_by) VALUES ('real2', 'VFD Station 4', NULL, NULL)").run()
      db.prepare("INSERT INTO profiles (id, display_name, status, created_by) VALUES ('synth1', 'Amy Synthetic — Veteran #1', 'active', 'agent:amy')").run()

      const spy = vi.fn(buildEvidence)
      const board = await buildFleetGapScoreboard(db, { limit: 50, buildEvidence: spy, now: new Date('2026-07-06T12:00:00Z') })

      expect(board.profiles_scanned).toBe(2)
      expect(spy.mock.calls.map((c) => c[1])).not.toContain('synth1')
      const tn = board.gaps.find((g) => g.gap_class === GAP_CLASSES.NO_STATE_SOURCE)
      expect(tn.count).toBe(2)
      expect(board.generated_at).toBe('2026-07-06T12:00:00.000Z')

      // Persisted + readable.
      const stored = await readGapScoreboard(db)
      expect(stored.profiles_scanned).toBe(2)
      expect(stored.gaps.length).toBe(board.gaps.length)

      // Idempotent upsert: a second build overwrites the SAME row.
      await buildFleetGapScoreboard(db, { limit: 50, buildEvidence: spy, now: new Date('2026-07-06T13:00:00Z') })
      const rows = db.prepare('SELECT COUNT(*) AS n FROM system_kv WHERE key = ?').get(KV_KEY)
      expect(rows.n).toBe(1)
      expect((await readGapScoreboard(db)).generated_at).toBe('2026-07-06T13:00:00.000Z')
    } finally { db.close() }
  })

  it('skips profiles whose evidence errors and survives an older schema without created_by', async () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`)
    try {
      db.prepare("INSERT INTO profiles (id, display_name, status) VALUES ('real1', 'Jane', 'active')").run()
      db.prepare("INSERT INTO profiles (id, display_name, status) VALUES ('ghost', 'Ghost', 'active')").run()
      db.prepare("INSERT INTO profiles (id, display_name, status) VALUES ('synth', 'Amy Synthetic — X #1', 'active')").run()
      const board = await buildFleetGapScoreboard(db, {
        buildEvidence: async (_db, id) => (id === 'real1'
          ? { profile_id: id, gaps: [GAP_NEED_UNCOVERED], lanes: [], answer_next: [] }
          : { profile_id: id, error: 'profile_not_found' }),
      })
      expect(board.profiles_scanned).toBe(1) // ghost errored out, synth name-filtered
      expect(board.gaps[0].gap_class).toBe(GAP_CLASSES.NEED_UNCOVERED)
    } finally { db.close() }
  })
})

// ── Structural matrix section (fleet-independent registry holes) ────────────

describe('structural_matrix scoreboard section', () => {
  it('buildStructuralMatrixSection reflects the real registry: full critical coverage today', () => {
    const section = buildStructuralMatrixSection()
    expect(section.states_checked).toBe(US_STATES.length)
    expect(section.needs_checked).toBeGreaterThan(50)
    expect(section.total_cells).toBe(section.needs_checked * section.states_checked)
    expect(section.critical_needs).toEqual([...CRITICAL_NEEDS])
    // The coverageMatrix guard test (crawler-os) fails the build before these
    // could ever be non-empty; the scoreboard must agree.
    expect(section.uncovered_critical_cells).toEqual([])
    expect(section.undocumented_gap_cells).toEqual([])
    expect(section.uncovered_cells).toBe(0)
  })

  it('matrixWishlistEntries maps uncovered critical cells to structural wishlist entries', () => {
    const entries = matrixWishlistEntries({ uncovered_critical_cells: [{ need: 'disability', state: 'TN' }] })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      lane: STRUCTURAL_MATRIX_LANE,
      gap_class: GAP_CLASSES.MATRIX_UNCOVERED_CRITICAL,
      detail: 'disability×TN',
      affected_profiles_count: 0,
    })
    expect(entries[0].statement).toMatch(/critical need 'disability' × TN has NO dedicated source/)
    expect(entries[0].suggested_action).toMatch(/sourceRegistry\.js/)
    expect(STRUCTURAL_GAP_CLASSES.has(GAP_CLASSES.MATRIX_UNCOVERED_CRITICAL)).toBe(true)
    // Degrades to no entries on a missing/null section.
    expect(matrixWishlistEntries(null)).toEqual([])
  })

  it('the fleet scoreboard carries the section, and a critical hole LEADS the adapter wishlist even with zero affected profiles', async () => {
    const db = fleetDb()
    try {
      db.prepare("INSERT INTO profiles (id, display_name, status, created_by) VALUES ('real1', 'Jane Doe', 'active', 'admin')").run()
      const fakeSection = {
        needs_checked: 67, states_checked: 51, total_cells: 3417, uncovered_cells: 0,
        critical_needs: [...CRITICAL_NEEDS],
        uncovered_critical_cells: [{ need: 'disability', state: 'TN' }],
        documented_gaps: 0, undocumented_gap_cells: [],
      }
      const board = await buildFleetGapScoreboard(db, {
        buildEvidence: async (_db, id) => ({ profile_id: id, gaps: [GAP_NO_STATE], lanes: [], answer_next: [] }),
        buildMatrixSection: () => fakeSection,
        now: new Date('2026-07-07T12:00:00Z'),
      })

      expect(board.structural_matrix).toEqual(fakeSection)
      // Matrix hole is FIRST on the wishlist, ahead of the profile-derived
      // no_state_source entry (which has a real affected-profile count).
      expect(board.adapter_wishlist[0]).toMatchObject({
        lane: STRUCTURAL_MATRIX_LANE,
        gap_class: GAP_CLASSES.MATRIX_UNCOVERED_CRITICAL,
        detail: 'disability×TN',
        affected_profiles_count: 0,
      })
      expect(board.adapter_wishlist.some((w) => w.gap_class === GAP_CLASSES.NO_STATE_SOURCE)).toBe(true)

      // Persisted section round-trips through system_kv.
      const stored = await readGapScoreboard(db)
      expect(stored.structural_matrix.uncovered_critical_cells).toEqual([{ need: 'disability', state: 'TN' }])

      // Amy's structural wishlist includes the registry hole (highest priority).
      const actions = deriveAmyGapActions(board)
      expect(actions.structural[0]).toMatchObject({
        gap_class: GAP_CLASSES.MATRIX_UNCOVERED_CRITICAL,
        detail: 'disability×TN',
        lever: 'adapter_wishlist',
      })
      expect(actions.structural.some((s) => s.gap_class === GAP_CLASSES.NO_STATE_SOURCE)).toBe(true)
    } finally { db.close() }
  })

  it('a matrix-section failure degrades to structural_matrix:null and never blocks the scoreboard', async () => {
    const db = fleetDb()
    try {
      db.prepare("INSERT INTO profiles (id, display_name, status, created_by) VALUES ('real1', 'Jane Doe', 'active', 'admin')").run()
      const board = await buildFleetGapScoreboard(db, {
        buildEvidence: async (_db, id) => ({ profile_id: id, gaps: [GAP_NO_STATE], lanes: [], answer_next: [] }),
        buildMatrixSection: () => { throw new Error('matrix exploded') },
      })
      expect(board.structural_matrix).toBeNull()
      expect(board.gaps.length).toBe(1)
      // No matrix entries; profile-derived wishlist still present.
      expect(board.adapter_wishlist.every((w) => w.lane !== STRUCTURAL_MATRIX_LANE)).toBe(true)
    } finally { db.close() }
  })

  it('the REAL registry produces a clean wishlist (no matrix entries) on a default build', async () => {
    const db = fleetDb()
    try {
      db.prepare("INSERT INTO profiles (id, display_name, status, created_by) VALUES ('real1', 'Jane Doe', 'active', 'admin')").run()
      const board = await buildFleetGapScoreboard(db, {
        buildEvidence: async (_db, id) => ({ profile_id: id, gaps: [], lanes: [], answer_next: [] }),
      })
      expect(board.structural_matrix.uncovered_critical_cells).toEqual([])
      expect(board.adapter_wishlist).toEqual([])
    } finally { db.close() }
  })
})

describe('isScoreboardStale', () => {
  it('is stale when undated or older than 48h; fresh otherwise', () => {
    const now = Date.parse('2026-07-06T12:00:00Z')
    expect(isScoreboardStale(null, { now })).toBe(true)
    expect(isScoreboardStale({}, { now })).toBe(true)
    expect(isScoreboardStale({ generated_at: '2026-07-03T12:00:00Z' }, { now })).toBe(true)
    expect(isScoreboardStale({ generated_at: '2026-07-05T13:00:00Z' }, { now })).toBe(false)
  })
})

describe('deriveAmyGapActions', () => {
  it('splits Amy-actionable gaps from the structural adapter wishlist', () => {
    const board = aggregateGapResults([
      { profile_id: 'p1', gaps: [GAP_NO_STATE, GAP_LANE_EXCLUDED, GAP_NEED_UNCOVERED, GAP_DISEASE_NOT_SELECTED] },
    ])
    const actions = deriveAmyGapActions({ ...board, profiles_scanned: 1 })

    const actionableClasses = actions.actionable.map((a) => a.gap_class).sort()
    expect(actionableClasses).toEqual([GAP_CLASSES.DISEASE_NOT_SELECTED, GAP_CLASSES.LANE_EXCLUDED, GAP_CLASSES.NEED_UNCOVERED].sort())
    for (const a of actions.actionable) expect(a.enqueued).toBe(true)
    expect(actions.actionable.find((a) => a.gap_class === GAP_CLASSES.NEED_UNCOVERED).lever).toBe('additive_coverage')

    expect(actions.structural.length).toBe(1)
    expect(actions.structural[0]).toMatchObject({ gap_class: GAP_CLASSES.NO_STATE_SOURCE, lever: 'adapter_wishlist' })
    // Empty/null scoreboard degrades to no actions.
    expect(deriveAmyGapActions(null)).toEqual({ actionable: [], structural: [] })
  })
})

describe('gap-weighted archetype selection', () => {
  const diseaseHeavyBoard = {
    profiles_scanned: 10,
    gaps: [
      { lane: 'disease_specific', gap_class: GAP_CLASSES.NO_DISEASE_SOURCE, detail: 'dementia', statement: 'x', suggested_action: 'y', count: 8 },
    ],
  }

  it('weights disease-lane categories up and leaves unrelated categories at 1', () => {
    const weights = weightCategoriesByGaps(diseaseHeavyBoard, ['cancer_patient', 'business', 'college_student'])
    expect(weights.cancer_patient).toBeGreaterThan(1)
    expect(weights.cancer_patient).toBeLessThanOrEqual(4)
    expect(weights.business).toBe(1)
    expect(weights.college_student).toBe(1)
  })

  it('caps accumulated pressure at the max weight', () => {
    const board = {
      profiles_scanned: 10,
      gaps: Array.from({ length: 6 }, (_, i) => ({ lane: 'disease_specific', gap_class: GAP_CLASSES.NO_DISEASE_SOURCE, detail: `d${i}`, count: 10 })),
    }
    const weights = weightCategoriesByGaps(board, ['cancer_patient'])
    expect(weights.cancer_patient).toBe(4)
  })

  it('planVariantCounts distributes the target proportionally to weights (floor 1 keeps breadth)', () => {
    const counts = planVariantCounts({ categories: ['cancer_patient', 'business'], targetCount: 8, weights: { cancer_patient: 3 } })
    expect(counts.cancer_patient).toBe(6)
    expect(counts.business).toBe(2)
    // No weights → unchanged even split.
    const even = planVariantCounts({ categories: ['cancer_patient', 'business'], targetCount: 8 })
    expect(even).toEqual({ cancer_patient: 4, business: 4 })
  })
})

// ── Amy consumes the scoreboard ─────────────────────────────────────────────

function amyDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT,
      status TEXT DEFAULT 'active', tags TEXT DEFAULT '[]',
      created_by TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL, section_key TEXT NOT NULL, data TEXT NOT NULL,
      updated_by TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(profile_id, section_key)
    );
  `)
  return db
}

const fakeDiscovery = async () => ({
  run: {
    run_id: 'fake',
    stored: 2,
    sources: [{ source_id: 'grants_gov', outcome: 'OK', fetched: 5, parsed: 3, stored: 2 }],
    recommendations: [{ title: 'A', match_score: 88, decision: 'ACCEPT' }],
    zero_result: null,
  },
  persisted: { opportunities: 2, dry_run: true },
  thesis: { applicant_types: ['individual'], needs: ['funding'], location: { state: 'TN' } },
})

describe('Amy derives her cohort + task queue from the fleet gap scoreboard', () => {
  it('weights the cohort by gap classes, records telemetry, and reports the wishlist', async () => {
    const db = amyDb()
    try {
      const board = {
        generated_at: '2026-07-06T05:00:00.000Z',
        profiles_scanned: 10,
        gaps: [
          { lane: 'disease_specific', gap_class: GAP_CLASSES.NO_DISEASE_SOURCE, detail: 'dementia', statement: 'No disease-specific source lane exists for "dementia".', suggested_action: 'Add a dementia source.', count: 8, affected_profiles: [] },
          { lane: 'private_charities', gap_class: GAP_CLASSES.LANE_EXCLUDED, detail: 'private_charities', statement: 'None of the 4 known private charities sources apply.', suggested_action: 'Review exclusions.', count: 4, affected_profiles: [] },
        ],
        top_missing_lanes: [],
        top_unanswered_fields: [],
        adapter_wishlist: [{ lane: 'disease_specific', gap_class: GAP_CLASSES.NO_DISEASE_SOURCE, detail: 'dementia', statement: 'No disease-specific source lane exists for "dementia".', affected_profiles_count: 8, suggested_action: 'Add a dementia source.' }],
      }
      const refreshScoreboard = vi.fn().mockResolvedValue(board)
      const recordActivity = vi.fn().mockResolvedValue(1)

      const out = await runAmyTraining({
        db,
        categories: ['cancer_patient', 'business'],
        targetCount: 8,
        dryRunDiscovery: true,
        runDiscovery: fakeDiscovery,
        refreshScoreboard,
        recordActivity,
        clock: () => new Date('2026-07-06T12:00:00Z'),
        saveReport: false,
      })

      expect(refreshScoreboard).toHaveBeenCalledWith(db, expect.objectContaining({ limit: 100 }))

      // The report carries the fleet-gap block (weights + actions + wishlist).
      const fgl = out.combined.fleet_gap_learning
      expect(fgl.scoreboard.profiles_scanned).toBe(10)
      expect(fgl.category_weights.cancer_patient).toBeGreaterThan(1)
      expect(fgl.category_weights.business).toBe(1)
      expect(fgl.actions.structural.length).toBe(1)
      expect(fgl.actions.actionable.some((a) => a.gap_class === GAP_CLASSES.LANE_EXCLUDED)).toBe(true)

      // The cohort itself is gap-weighted: cancer_patient sits on BOTH gap
      // lanes (disease_specific 8/10 + private_charities 4/10 → weight capped
      // at 4) so it takes the whole gap-weighted ring; business keeps its floor.
      //
      // 2026-08-02: the nightly target is now SPLIT between the catalog floor
      // and adversarial gap-probes (resolveCohortSplit), so the CATALOG share of
      // an 8-profile target is 5 — cancer_patient 4, business 1 — and the other
      // 3 are intersection probes. The weighting is unchanged; only the size of
      // the ring it fills is. The TOTAL is still exactly the target, which is
      // the property that matters: a cohort that silently shrank would be the
      // "we stopped looking" failure the convergence metric exists to catch.
      const byCategory = out.report.amy_summary.by_category
      expect(byCategory.cancer_patient).toBe(4)
      expect(byCategory.business).toBe(1)
      expect(out.combined.gap_probes.built).toBe(3)
      expect(out.summary.scenarios).toBe(8)

      // Observability: scoreboard-refresh + adapter-wishlist events emitted as agent 'amy'.
      const eventTypes = recordActivity.mock.calls.map((c) => c[1].event_type)
      expect(eventTypes).toContain('amy.gap_scoreboard.refreshed')
      expect(eventTypes).toContain('amy.adapter_wishlist')
      for (const [, ev] of recordActivity.mock.calls) expect(ev.agent_name).toBe('amy')
      const wishlistEvent = recordActivity.mock.calls.find((c) => c[1].event_type === 'amy.adapter_wishlist')[1]
      expect(wishlistEvent.status).toBe('blocked') // Amy cannot fix code — needs the owner
    } finally { db.close() }
  })

  it('a scoreboard refresh failure degrades to the uniform cohort (never blocks training)', async () => {
    const db = amyDb()
    try {
      const out = await runAmyTraining({
        db,
        categories: ['business'],
        perCategory: 1,
        dryRunDiscovery: true,
        runDiscovery: fakeDiscovery,
        refreshScoreboard: vi.fn().mockRejectedValue(new Error('scan died')),
        recordActivity: vi.fn(),
        clock: () => new Date('2026-07-06T12:00:00Z'),
        saveReport: false,
      })
      expect(out.summary.scenarios).toBe(1)
      expect(out.combined.fleet_gap_learning.scoreboard).toBeNull()
      expect(out.combined.fleet_gap_learning.category_weights).toBeNull()
    } finally { db.close() }
  })
})

// ── Sam check: coverage.gapScoreboard ───────────────────────────────────────

describe('sam check coverage.gapScoreboard', () => {
  const check = getCheckById('coverage.gapScoreboard')

  function kvDb() {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    return db
  }
  const put = (db, payload, updatedAt = new Date().toISOString()) =>
    db.prepare('INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
      .run(KV_KEY, JSON.stringify(payload), updatedAt)
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString()

  it('is registered as a non-heavy internal check with medium severity', () => {
    expect(check).toBeTruthy()
    expect(check.kind).toBe('internal')
    expect(check.heavy).toBeFalsy()
    expect(check.severityOnFailure).toBe('medium')
  })

  it('fails open when db / system_kv is unavailable, and is green when no scoreboard exists yet', async () => {
    expect((await check.run({})).ok).toBe(true)
    const noKv = new Database(':memory:')
    try {
      const res = await check.run({ db: noKv })
      expect(res.ok).toBe(true)
      expect(res.skipped).toBe(true)
    } finally { noKv.close() }
    const db = kvDb()
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      expect(res.summary).toMatch(/no fleet gap scoreboard yet/i)
    } finally { db.close() }
  })

  it('flags a STALE scoreboard (>48h) with a recommended fix', async () => {
    const db = kvDb()
    try {
      put(db, { generated_at: hoursAgo(60), profiles_scanned: 12, gaps: [], adapter_wishlist: [] }, hoursAgo(60))
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/stale/i)
      expect(res.recommended_fix).toMatch(/AMY_GAP_LEARNING|AMY_ENABLED/)
    } finally { db.close() }
  })

  it('flags a dominant top gap (large share of scanned profiles) and surfaces its suggested_action', async () => {
    const db = kvDb()
    try {
      put(db, {
        generated_at: hoursAgo(2),
        profiles_scanned: 10,
        gaps: [
          { lane: 'state_programs', gap_class: 'no_state_source', detail: 'TN', statement: 'No TN-specific state-programs source exists.', suggested_action: 'Add a TN state source to sourceRegistry.js.', count: 7 },
          { lane: null, gap_class: 'need_uncovered', detail: 'beekeeping', statement: 'x', suggested_action: 'y', count: 1 },
        ],
        adapter_wishlist: [{ lane: 'state_programs', detail: 'TN', statement: 'No TN source', affected_profiles_count: 7, suggested_action: 'Add a TN state source to sourceRegistry.js.' }],
      }, hoursAgo(2))
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/70%/)
      expect(res.recommended_fix).toBe('Add a TN state source to sourceRegistry.js.')
      expect(res.evidence.top_gaps.length).toBe(2)
      expect(res.evidence.adapter_wishlist.length).toBe(1)
    } finally { db.close() }
  })

  it('stays green for a fresh scoreboard whose top gap is a small share (or a thin sample)', async () => {
    const db = kvDb()
    try {
      put(db, {
        generated_at: hoursAgo(1),
        profiles_scanned: 10,
        gaps: [{ lane: null, gap_class: 'need_uncovered', detail: 'beekeeping', statement: 'x', suggested_action: 'y', count: 2 }],
        adapter_wishlist: [],
      }, hoursAgo(1))
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      expect(res.summary).toMatch(/1 gap class/)

      // A dominant share over a TINY sample (< 5 scanned) is not a systemic alert.
      put(db, { generated_at: hoursAgo(1), profiles_scanned: 2, gaps: [{ statement: 'x', suggested_action: 'y', count: 2 }], adapter_wishlist: [] }, hoursAgo(1))
      expect((await check.run({ db })).ok).toBe(true)
    } finally { db.close() }
  })

  it('flags unparseable scoreboard JSON', async () => {
    const db = kvDb()
    try {
      db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(KV_KEY, '{nope', new Date().toISOString())
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/unparseable/i)
    } finally { db.close() }
  })
})
