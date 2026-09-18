/**
 * Recall scorecard (result-quality PR4, 2026-09-17).
 *
 * Every lane record here mirrors a shape measured read-only on prod the day
 * this shipped: three real profiles each planned 28 web queries and executed
 * 7 (21 skipped for budget); one extracted 24 candidates and admitted 0 (9
 * refused at apply target, 5 at eligibility, 3 at reality, 6 held for review);
 * one extracted 0 because the LLM was over quota; one lost 9 at eligibility.
 * Nothing on the product named the stage that bound any of them.
 *
 * Proves:
 *   - the blocker classifier names ONE stage, in funnel order, and reads the
 *     coverage audit before the lane (met target / unconfigured first)
 *   - the skipped-query carry-over is bounded, deduped, and EMPTY after a run
 *     whose extraction was dead (those queries were never evaluated)
 *   - one profile's card reads the real lane store, the match store, the
 *     pipeline and applications tables, and reports UNKNOWN (null), not 0,
 *     when a table is absent
 *   - the fleet roll-up excludes Amy synthetics and persists a bounded history
 *   - Sam's `recall.scorecard` check fails open, flags stale, and reds the
 *     "extracts but admits nothing" fleet state
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  RECALL_BLOCKER,
  CARRY_OVER_LIMIT,
  RECALL_SCORECARD_KV_KEY,
  RECALL_SCORECARD_HISTORY_KV_KEY,
  RECALL_SCORECARD_HISTORY_CAP,
  stageCountsFromLane,
  classifyRecallBlocker,
  carryOverSkippedQueries,
  buildProfileRecallScorecard,
  buildFleetRecallScorecard,
  recordRecallScorecard,
  getLastRecallScorecard,
  getRecallScorecardHistory,
} from '../services/coverageAudit/recallScorecard.js'
import { recordWebLaneRun } from '../services/coverageAudit/webLaneHealth.js'
import { getCheckById } from '../services/sam/samRegistry.js'
import { verifiedFourTruthExplain } from './helpers/fourTruthFixture.js'

// ── prod-shaped lane records ──────────────────────────────────────────────────

const PLANNED = Array.from({ length: 28 }, (_, i) => `query ${i + 1} scholarship tennessee`)

function laneRecord(over = {}) {
  const executed = PLANNED.slice(0, 7)
  const skipped = PLANNED.slice(7)
  return {
    ok: true,
    skipped: false,
    at: '2026-09-17T03:00:00.000Z',
    trigger: 'nightly',
    queries: executed,
    queries_executed: 7,
    queries_planned: 28,
    query_ledger: { planned: PLANNED.map((q) => ({ query: q })), executed: executed.map((q) => ({ query: q })), skipped_budget: skipped.map((q) => ({ query: q, tier: 'extra' })), skipped_duplicate: [] },
    stage_ledger: {
      query_generated: 28, query_skipped_budget: 21, provider_attempted: 7, response_received: 44,
      candidates_extracted: 24, extraction_failed: 0, extraction_failed_by_class: {},
      reality_rejected: 3, eligibility_rejected: 5, need_match_rejected: 0, apply_target_rejected: 9,
      review_held: 6, catalog_refused: 0, qualified_admitted: 0,
    },
    fetched: 44,
    extracted: 24,
    stored: 0,
    provider_health: { search: 'healthy', llm: 'healthy' },
    primary_attribution: 'apply_target_rejected',
    extraction_available: true,
    ...over,
  }
}

const STUDENT = laneRecord()
const SENIOR_LLM_QUOTA = laneRecord({
  stage_ledger: {
    query_generated: 28, query_skipped_budget: 21, provider_attempted: 7, response_received: 31,
    candidates_extracted: 0, extraction_failed: 31, extraction_failed_by_class: { llm_quota: 31 },
    reality_rejected: 0, eligibility_rejected: 0, need_match_rejected: 0, apply_target_rejected: 0,
    review_held: 0, catalog_refused: 0, qualified_admitted: 0,
  },
  extracted: 0,
  fetched: 31,
  provider_health: { search: 'healthy', llm: 'unavailable' },
  primary_attribution: 'extraction_failed:llm_quota',
  extraction_available: false,
})
const INDIVIDUAL_ELIGIBILITY = laneRecord({
  stage_ledger: {
    ...STUDENT.stage_ledger,
    candidates_extracted: 11, reality_rejected: 1, eligibility_rejected: 9, apply_target_rejected: 1, review_held: 0, qualified_admitted: 0,
  },
  extracted: 11,
  primary_attribution: 'eligibility_rejected',
})

const BELOW = { profile_id: 'p', surfaced_awardable: 2, result_target: 10, below_result_target: true, unconfigured: false, gaps: [] }
const MET = { profile_id: 'p', surfaced_awardable: 12, result_target: 10, below_result_target: false, below_applyable_floor: false, unconfigured: false, gaps: [] }

describe('classifyRecallBlocker — one stage, funnel order', () => {
  it('names the APPLY TARGET gate for the prod student shape (24 extracted → 0 admitted, 9 apply_target)', () => {
    const r = classifyRecallBlocker({ lane: STUDENT, audit: BELOW })
    expect(r.blocker).toBe(RECALL_BLOCKER.GATED_AT_APPLY_TARGET)
    expect(r.detail).toMatchObject({ rejected: 9, of_extracted: 24, review_held: 6 })
  })

  it('names EXTRACTION DEAD for the prod senior shape (llm_quota, 0 extracted) — before any budget claim', () => {
    const r = classifyRecallBlocker({ lane: SENIOR_LLM_QUOTA, audit: BELOW })
    expect(r.blocker).toBe(RECALL_BLOCKER.EXTRACTION_DEAD)
    expect(r.detail).toEqual({ llm_quota: 31 })
  })

  it('names the ELIGIBILITY gate for the prod individual shape (9 of 11 refused at eligibility)', () => {
    expect(classifyRecallBlocker({ lane: INDIVIDUAL_ELIGIBILITY, audit: BELOW }).blocker).toBe(RECALL_BLOCKER.GATED_AT_ELIGIBILITY)
  })

  it('BUDGET STARVED only when the run could extract, extracted nothing, and skipped ≥ half its plan', () => {
    const lane = laneRecord({
      stage_ledger: { ...STUDENT.stage_ledger, candidates_extracted: 0, extraction_failed: 0, reality_rejected: 0, eligibility_rejected: 0, apply_target_rejected: 0, review_held: 0 },
      extracted: 0, fetched: 3, primary_attribution: null,
    })
    expect(classifyRecallBlocker({ lane, audit: BELOW }).blocker).toBe(RECALL_BLOCKER.BUDGET_STARVED)
    // The same run with the plan fully executed is UNKNOWN, never a false budget claim.
    const full = laneRecord({ ...lane, query_ledger: { ...lane.query_ledger, skipped_budget: [] }, stage_ledger: { ...lane.stage_ledger, query_skipped_budget: 0, provider_attempted: 28 } })
    expect(classifyRecallBlocker({ lane: full, audit: BELOW }).blocker).toBe(RECALL_BLOCKER.UNKNOWN)
  })

  it('HELD FOR REVIEW when review holds outnumber every gate', () => {
    const lane = laneRecord({ stage_ledger: { ...STUDENT.stage_ledger, reality_rejected: 1, eligibility_rejected: 1, apply_target_rejected: 2, review_held: 20 } })
    expect(classifyRecallBlocker({ lane, audit: BELOW }).blocker).toBe(RECALL_BLOCKER.HELD_FOR_REVIEW)
  })

  it('ADMITTED BELOW TARGET when candidates were admitted and the profile is still short', () => {
    const lane = laneRecord({ stage_ledger: { ...STUDENT.stage_ledger, qualified_admitted: 2 } })
    const r = classifyRecallBlocker({ lane, audit: BELOW })
    expect(r.blocker).toBe(RECALL_BLOCKER.ADMITTED_BELOW_TARGET)
    expect(r.detail).toMatchObject({ admitted: 2, awardable: 2, target: 10 })
  })

  it('the coverage audit is read FIRST: met target wins over any lane shape; unconfigured is not a recall problem', () => {
    expect(classifyRecallBlocker({ lane: SENIOR_LLM_QUOTA, audit: MET }).blocker).toBe(RECALL_BLOCKER.MET_TARGET)
    expect(classifyRecallBlocker({ lane: STUDENT, audit: { ...BELOW, unconfigured: true, missing_prerequisites: ['address'] } }))
      .toMatchObject({ blocker: RECALL_BLOCKER.UNCONFIGURED, detail: ['address'] })
  })

  it('NO RUN for a missing / skipped / failed lane; SEARCH UNAVAILABLE before any gate', () => {
    expect(classifyRecallBlocker({ lane: null, audit: BELOW }).blocker).toBe(RECALL_BLOCKER.NO_RUN)
    expect(classifyRecallBlocker({ lane: { ok: true, skipped: true, reason: 'profile_unconfigured' }, audit: BELOW })).toMatchObject({ blocker: RECALL_BLOCKER.NO_RUN, detail: 'profile_unconfigured' })
    expect(classifyRecallBlocker({ lane: laneRecord({ provider_health: { search: 'unavailable', llm: 'healthy' } }), audit: BELOW }).blocker).toBe(RECALL_BLOCKER.SEARCH_UNAVAILABLE)
  })
})

describe('stageCountsFromLane', () => {
  it('normalizes the prod record and computes the budget-skipped share', () => {
    const s = stageCountsFromLane(STUDENT)
    expect(s).toMatchObject({ queries_generated: 28, queries_executed: 7, queries_skipped_budget: 21, budget_skipped_share: 0.75, pages_fetched: 44, candidates_extracted: 24, qualified_admitted: 0 })
    expect(s.gate_rejected).toEqual({ reality: 3, eligibility: 5, need: 0, apply_target: 9 })
  })
  it('a missing record is all zeros with a null share — never a fabricated denominator', () => {
    const s = stageCountsFromLane(null)
    expect(s.queries_generated).toBe(0)
    expect(s.budget_skipped_share).toBeNull()
  })
})

describe('carryOverSkippedQueries — bounded, deduped, never after a dead extraction', () => {
  it(`carries the first ${CARRY_OVER_LIMIT} budget-skipped queries, in plan order`, () => {
    const out = carryOverSkippedQueries(STUDENT)
    expect(out).toEqual(PLANNED.slice(7, 7 + CARRY_OVER_LIMIT))
    expect(out.length).toBe(CARRY_OVER_LIMIT)
  })
  it('dedupes by normalized text and drops seed pseudo-queries; honors a custom limit', () => {
    const lane = laneRecord({ query_ledger: { ...STUDENT.query_ledger, skipped_budget: [{ query: '  Pell  grant TN ' }, { query: 'pell grant tn' }, { query: 'seed:https://x' }, 'hope scholarship', { query: '' }] } })
    expect(carryOverSkippedQueries(lane, { limit: 8 })).toEqual(['Pell grant TN', 'hope scholarship'])
    expect(carryOverSkippedQueries(lane, { limit: 1 })).toEqual(['Pell grant TN'])
  })
  it('carries NOTHING from a run whose extraction was dead, whose search was down, or that did not run', () => {
    expect(carryOverSkippedQueries(SENIOR_LLM_QUOTA)).toEqual([])
    expect(carryOverSkippedQueries(laneRecord({ provider_health: { search: 'unavailable', llm: 'healthy' } }))).toEqual([])
    expect(carryOverSkippedQueries(laneRecord({ ok: false }))).toEqual([])
    expect(carryOverSkippedQueries({ skipped: true })).toEqual([])
    expect(carryOverSkippedQueries(null)).toEqual([])
  })
})

// ── integration over a real sqlite store ─────────────────────────────────────

function makeDb({ withPipeline = true } = {}) {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT, status TEXT DEFAULT 'active',
      deleted_at TEXT, created_by TEXT, last_discovery_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT, updated_at TEXT);
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT, opportunity_id TEXT, match_score INTEGER,
      match_decision TEXT, matcher_version TEXT, match_explain_json TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT, categories TEXT,
      opportunity_kind TEXT, deadline TEXT, deadline_at TEXT, deadline_type TEXT, is_active INTEGER
    );
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `)
  if (withPipeline) {
    db.exec(`
      CREATE TABLE grants (id TEXT PRIMARY KEY, profile_id TEXT, status TEXT);
      CREATE TABLE vnext_applications (id TEXT PRIMARY KEY, profile_id TEXT, state TEXT);
    `)
  }
  return db
}

function seedProfile(db, id, { name = id, type = 'college_student', createdBy = null } = {}) {
  db.prepare('INSERT INTO profiles (id, display_name, primary_type, created_by) VALUES (?,?,?,?)').run(id, name, type, createdBy)
}

function seedMatches(db, pid, { accepts = 0, reviews = 0, rejects = 0, unsurfaced = 0 } = {}) {
  let i = 0
  const put = (decision, lane, proof) => {
    const oid = `${pid}-o${i++}`
    db.prepare('INSERT INTO funding_opportunities (id, title, opportunity_kind, is_active) VALUES (?,?,?,1)').run(oid, `t ${i}`, 'direct_grant')
    db.prepare('INSERT INTO profile_opportunity_matches VALUES (?,?,?,?,?,?)').run(pid, oid, 40, decision, lane, proof)
  }
  for (let k = 0; k < accepts; k++) put('accept', 'crawler-os', verifiedFourTruthExplain())
  for (let k = 0; k < reviews; k++) put('review', 'crawler-os', null)
  for (let k = 0; k < rejects; k++) put('reject', 'crawler-os', null)
  for (let k = 0; k < unsurfaced; k++) put('accept', 'some-unsurfaced-lane', null)
}

describe('buildProfileRecallScorecard — one card, every source read', () => {
  it('reads the lane store, the match store, the pipeline and applications, and names the blocker', async () => {
    const db = makeDb()
    try {
      seedProfile(db, 'stu')
      seedMatches(db, 'stu', { accepts: 2, reviews: 5, rejects: 3, unsurfaced: 1 })
      db.prepare("INSERT INTO grants VALUES ('g1','stu','discovered'),('g2','stu','discovered'),('g3','stu','submitted')").run()
      db.prepare("INSERT INTO vnext_applications VALUES ('a1','stu','drafting')").run()
      await recordWebLaneRun(db, { profileId: 'stu', telemetry: STUDENT, trigger: 'nightly' })

      const card = await buildProfileRecallScorecard(db, 'stu', { audit: { ...BELOW, profile_id: 'stu', surfaced_qualifying: 7, surfaced_actionable: 7, surfaced_applyable_typed: 1 } })
      expect(card.profile_id).toBe('stu')
      expect(card.lane).toMatchObject({ ok: true, skipped: false, provider_health: { search: 'healthy', llm: 'healthy' }, primary_attribution: 'apply_target_rejected' })
      expect(card.stages).toMatchObject({ queries_generated: 28, queries_executed: 7, queries_skipped_budget: 21, candidates_extracted: 24, qualified_admitted: 0 })
      expect(card.catalog).toEqual({ surfaced_lanes: { accept: 2, review: 5, reject: 3, other: 0 }, unsurfaced_lanes: 1, proven_direct_accepts: 2 })
      expect(card.surfaced).toMatchObject({ awardable: 2, result_target: 10, below_result_target: true, applyable_typed: 1 })
      expect(card.pipeline).toMatchObject({ by_status: { discovered: 2, submitted: 1 }, total: 3, submitted_internal: 1, verified_external_submissions: null })
      expect(card.applications).toEqual({ by_state: { drafting: 1 }, total: 1 })
      expect(card.carry_over_queries).toBe(CARRY_OVER_LIMIT)
      expect(card.binding_constraint.blocker).toBe(RECALL_BLOCKER.GATED_AT_APPLY_TARGET)
    } finally { db.close() }
  })

  it('an ABSENT pipeline table reads as UNKNOWN (null), never as 0; a missing lane record is a null lane + no_run', async () => {
    const db = makeDb({ withPipeline: false })
    try {
      seedProfile(db, 'p')
      const card = await buildProfileRecallScorecard(db, 'p', { audit: { ...BELOW, profile_id: 'p' } })
      expect(card.pipeline.by_status).toBeNull()
      expect(card.pipeline.total).toBeNull()
      expect(card.pipeline.submitted_internal).toBeNull()
      expect(card.applications.total).toBeNull()
      expect(card.lane).toBeNull()
      expect(card.stages.queries_generated).toBe(0)
      expect(card.binding_constraint.blocker).toBe(RECALL_BLOCKER.NO_RUN)
    } finally { db.close() }
  })

  it('an ABSENT match store reads as UNKNOWN catalog (null), and the fleet still measures the profile', async () => {
    const db = makeDb()
    try {
      db.exec('DROP TABLE profile_opportunity_matches')
      seedProfile(db, 'p')
      const card = await buildProfileRecallScorecard(db, 'p', { audit: { ...BELOW, profile_id: 'p' } })
      expect(card.catalog).toBeNull()
      const fleet = await buildFleetRecallScorecard(db, { audits: [{ ...BELOW, profile_id: 'p' }] })
      expect(fleet.profiles_measured).toBe(1)
      expect(fleet.rows[0].proven_direct_accepts).toBeNull()
      expect(fleet.totals.proven_direct_accepts).toBe(0)
    } finally { db.close() }
  })

  it('requires a db and a profile id', async () => {
    await expect(buildProfileRecallScorecard(null, 'p')).rejects.toThrow(/required/)
    await expect(buildProfileRecallScorecard(makeDb(), '')).rejects.toThrow(/required/)
  })
})

describe('buildFleetRecallScorecard + persistence', () => {
  it('rolls up real active profiles only (Amy synthetics excluded), with shares, blockers and an envelope', async () => {
    const db = makeDb()
    try {
      seedProfile(db, 'stu', { type: 'college_student' })
      seedProfile(db, 'sen', { type: 'senior' })
      seedProfile(db, 'ind', { type: 'individual' })
      seedProfile(db, 'amy1', { name: 'Amy Synthetic — veteran entrepreneur', createdBy: 'agent:amy' })
      seedMatches(db, 'stu', { accepts: 2 })
      await recordWebLaneRun(db, { profileId: 'stu', telemetry: STUDENT })
      await recordWebLaneRun(db, { profileId: 'sen', telemetry: SENIOR_LLM_QUOTA })
      await recordWebLaneRun(db, { profileId: 'ind', telemetry: INDIVIDUAL_ELIGIBILITY })
      await recordWebLaneRun(db, { profileId: 'amy1', telemetry: STUDENT })

      const audits = [
        { ...BELOW, profile_id: 'stu' },
        { ...BELOW, profile_id: 'sen', surfaced_awardable: 0 },
        { ...BELOW, profile_id: 'ind', surfaced_awardable: 1 },
      ]
      const fleet = await buildFleetRecallScorecard(db, { limit: 50, audits })
      expect(fleet.profiles_scanned).toBe(3)
      expect(fleet.profiles_measured).toBe(3)
      expect(fleet.rows.map((r) => r.profile_id).sort()).toEqual(['ind', 'sen', 'stu'])
      expect(fleet.totals).toMatchObject({ queries_executed: 21, queries_skipped_budget: 63, candidates_extracted: 35, qualified_admitted: 0, awardable: 3 })
      expect(fleet.blockers).toEqual({
        [RECALL_BLOCKER.GATED_AT_APPLY_TARGET]: 1,
        [RECALL_BLOCKER.EXTRACTION_DEAD]: 1,
        [RECALL_BLOCKER.GATED_AT_ELIGIBILITY]: 1,
      })
      // Two of three runs extracted (llm alive); both admitted zero.
      expect(fleet.shares.extraction_alive).toBe(0.667)
      expect(fleet.shares.admitted_zero_while_alive).toBe(1)
      expect(fleet.shares.budget_starved).toBe(1)
      expect(fleet.metric_envelope.evaluated_count).toBe(3)
      expect(fleet.metric_envelope.measurement_window.kind).toBe('point_in_time')
      expect(fleet.metric_envelope.provider_health).toMatchObject({ extraction_alive_runs: 2 })
      expect(fleet.metric_envelope.context.definition_of_better).toMatch(/awardable/)
    } finally { db.close() }
  })

  it('persists the last snapshot and a bounded history; the reader round-trips it', async () => {
    const db = makeDb()
    try {
      seedProfile(db, 'p')
      const fleet = await buildFleetRecallScorecard(db, { audits: [{ ...BELOW, profile_id: 'p' }] })
      for (let i = 0; i < RECALL_SCORECARD_HISTORY_CAP + 3; i++) {
        const res = await recordRecallScorecard(db, { ...fleet, generated_at: `2026-09-${String(1 + i).padStart(2, '0')}T00:00:00.000Z` })
        expect(res.ok).toBe(true)
      }
      const last = await getLastRecallScorecard(db)
      expect(last.generated_at).toBe(`2026-09-${RECALL_SCORECARD_HISTORY_CAP + 3}T00:00:00.000Z`)
      expect(last.profiles_measured).toBe(1)
      const history = await getRecallScorecardHistory(db)
      expect(history).toHaveLength(RECALL_SCORECARD_HISTORY_CAP)
      expect(history[0].generated_at).toBe(last.generated_at)
      expect(history[0].rows[0]).toMatchObject({ profile_id: 'p', blocker: RECALL_BLOCKER.NO_RUN })
      expect(db.prepare('SELECT COUNT(*) c FROM system_kv WHERE key IN (?, ?)').get(RECALL_SCORECARD_KV_KEY, RECALL_SCORECARD_HISTORY_KV_KEY).c).toBe(2)
    } finally { db.close() }
  })

  it('recordRecallScorecard never throws and reports skipped on bad input; readers return null/[] on an empty store', async () => {
    const db = makeDb()
    try {
      expect(await recordRecallScorecard(db, null)).toMatchObject({ ok: false, skipped: true })
      expect(await getLastRecallScorecard(db)).toBeNull()
      expect(await getRecallScorecardHistory(db)).toEqual([])
    } finally { db.close() }
  })
})

describe("Sam check `recall.scorecard`", () => {
  const check = getCheckById('recall.scorecard')

  function kvDb(value, updatedAt = new Date().toISOString()) {
    const db = makeDb()
    if (value !== undefined) db.prepare('INSERT INTO system_kv VALUES (?,?,?)').run(RECALL_SCORECARD_KV_KEY, value, updatedAt)
    return db
  }

  it('is registered as an INTERNAL check', () => {
    expect(check).toBeTruthy()
    expect(check.kind).toBe('internal')
    expect(typeof check.run).toBe('function')
  })

  it('fails OPEN with no db, no system_kv, or no snapshot yet', async () => {
    expect((await check.run({})).ok).toBe(true)
    const noKv = new Database(':memory:')
    try { expect(await check.run({ db: noKv })).toMatchObject({ ok: true, skipped: true }) } finally { noKv.close() }
    const empty = kvDb(undefined)
    try { expect((await check.run({ db: empty })).ok).toBe(true) } finally { empty.close() }
  })

  it('reds a STALE snapshot and an unparseable one', async () => {
    const stale = kvDb(JSON.stringify({ generated_at: '2026-09-01T00:00:00.000Z', profiles_measured: 3 }), '2026-09-01T00:00:00.000Z')
    try {
      const r = await check.run({ db: stale })
      expect(r.ok).toBe(false)
      expect(r.summary).toMatch(/STALE/)
    } finally { stale.close() }
    const bad = kvDb('{not json')
    try { expect((await check.run({ db: bad })).ok).toBe(false) } finally { bad.close() }
  })

  it('reds the prod fleet state — extraction alive on ≥3 profiles, none admitting a qualified candidate', async () => {
    const db = kvDb(JSON.stringify({
      generated_at: new Date().toISOString(),
      profiles_measured: 4,
      totals: { candidates_extracted: 60, qualified_admitted: 0, awardable: 3 },
      shares: { admitted_zero_while_alive: 1, extraction_alive: 0.75 },
      blockers: { gated_at_apply_target: 2, gated_at_eligibility: 1, extraction_dead: 1 },
      metric_envelope: { provider_health: { extraction_alive_runs: 3 }, context: { definition_of_better: 'surfaced.awardable' } },
    }))
    try {
      const r = await check.run({ db })
      expect(r.ok).toBe(false)
      expect(r.summary).toMatch(/DEAD BELOW EXTRACTION/)
      expect(r.summary).toMatch(/gated_at_apply_target ×2/)
      expect(r.evidence.totals.qualified_admitted).toBe(0)
      expect(r.evidence.definition_of_better).toBe('surfaced.awardable')
      expect(r.recommended_fix).toMatch(/recall-scorecard\/:profileId/)
    } finally { db.close() }
  })

  it('is GREEN when candidates are being admitted, and stays green below the minimum alive sample', async () => {
    const green = kvDb(JSON.stringify({
      generated_at: new Date().toISOString(), profiles_measured: 4,
      totals: { candidates_extracted: 60, qualified_admitted: 12, awardable: 30 },
      shares: { admitted_zero_while_alive: 0.25 }, blockers: { met_target: 3, admitted_below_target: 1 },
      metric_envelope: { provider_health: { extraction_alive_runs: 4 } },
    }))
    try {
      const r = await check.run({ db: green })
      expect(r.ok).toBe(true)
      expect(r.summary).toMatch(/60 extracted → 12 admitted → 30 awardable/)
    } finally { green.close() }
    const thin = kvDb(JSON.stringify({
      generated_at: new Date().toISOString(), profiles_measured: 2,
      totals: { candidates_extracted: 10, qualified_admitted: 0 }, shares: { admitted_zero_while_alive: 1 },
      blockers: {}, metric_envelope: { provider_health: { extraction_alive_runs: 2 } },
    }))
    try { expect((await check.run({ db: thin })).ok).toBe(true) } finally { thin.close() }
  })
})


describe('degraded extraction is not evidence of an admission-gate defect', () => {
  const partial = laneRecord({ extracted: 1, provider_health: { search: 'healthy', llm: 'degraded' }, stage_ledger: { ...STUDENT.stage_ledger, candidates_extracted: 1, extraction_failed: 3, extraction_failed_by_class: { llm_quota: 3 }, qualified_admitted: 0 } })
  it('classifies provider degradation before gate and query-budget claims', () => {
    const result = classifyRecallBlocker({ lane: partial, audit: BELOW })
    expect(result.blocker).toBe('extraction_degraded')
    expect(result.detail).toMatchObject({ llm_quota: 3 })
    expect(classifyRecallBlocker({ lane: partial, audit: MET }).blocker).toBe(RECALL_BLOCKER.MET_TARGET)
  })
  it.each(['degraded', 'unavailable'])('retains all counts but excludes %s runs from the healthy-extraction alarm denominator', async (llm) => {
    const db = makeDb()
    try {
      const audits = []
      for (let i = 0; i < 3; i++) {
        const id = 'partial-' + i
        seedProfile(db, id)
        await recordWebLaneRun(db, { profileId: id, telemetry: { ...partial, provider_health: { search: 'healthy', llm } } })
        audits.push({ ...BELOW, profile_id: id })
      }
      const fleet = await buildFleetRecallScorecard(db, { audits })
      expect(fleet.totals.candidates_extracted).toBe(3)
      expect(fleet.rows).toHaveLength(3)
      expect(fleet.metric_envelope.provider_health.extraction_alive_runs).toBe(0)
      expect(fleet.shares.admitted_zero_while_alive).toBeNull()
      await recordRecallScorecard(db, fleet)
      const result = await getCheckById('recall.scorecard').run({ db })
      expect(result.summary).not.toMatch(/DEAD BELOW EXTRACTION/)
      expect(result.recommended_fix ?? '').not.toMatch(/gate|eligibility evidence/i)
    } finally { db.close() }
  })
})
