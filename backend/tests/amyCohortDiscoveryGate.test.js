/**
 * amyCohortDiscoveryGate.test.js — the CLEAN / ISSUE / UNEVALUATED contract
 * for Amy's synthetic cohort (amy-cohort-1..6 + the metric envelope).
 *
 * PROD FACT this pins (run amy-2026-09-12T11-31-58-550Z-dfd2cbce): 50 planned
 * members, 50 evaluated, 0 clean, finding_types {hyperlocal_recall_miss: 50}.
 * During that run every LLM provider was dead — the open-web lane fetched
 * ~40 pages per profile and EXTRACTED ZERO candidates on every one (search
 * itself was healthy, served from cache). The hyperlocal detector fired on the
 * registry-only recommendations, the flywheel counted every profile as an
 * ISSUE and the approval queue attributed all 50 to webQueries.js. That is a
 * provider outage mislabeled as a query-breadth code defect.
 *
 * The rule: a synthetic profile is CLEAN only when every planned stage ran,
 * provider state was healthy or explicitly classified, the evidence floor was
 * reached (or an evidence-backed no-qualified outcome established), and no
 * silent pipeline loss caused the absence. A run whose web lane was skipped /
 * absent / errored, whose extraction produced nothing on every fetched page,
 * or whose search providers were unavailable is UNEVALUABLE with class
 * `discovery_blocked:<reason>` — never clean, never an issue attributed to the
 * query builder, never silently omitted.
 */

import { describe, expect, it } from 'vitest'
import { evaluateDiscovery } from '../services/amy/amyReport.js'
import { buildRunCohortReceipt, isCleanEvaluation, buildCohortUpdate } from '../services/amy/flywheelCohort.js'
import { classifyProbeOutcome, PROBE_OUTCOME } from '../services/amy/probeCoverageLedger.js'
import { buildApprovalQueue } from '../services/amy/crawlerTuner.js'
import { foldApprovalLedger, PROBE_ITEM_CATEGORY } from '../services/amy/approvalLedger.js'
import { generateScenarios, CATEGORY_IDS, catalogRotationForRun } from '../services/amy/syntheticProfileCatalog.js'
import {
  classifyWebLane,
  evaluationOutcome,
  DISCOVERY_BLOCK_REASON,
  blockedClass,
} from '../services/amy/discoveryGate.js'

const RUN = 'amy-2026-09-12T11-31-58-550Z-dfd2cbce'

const QUERIES = Array.from({ length: 28 }, (_, i) => `query ${i} franklin county grants`)
const provenance = (status = 'ok', n = QUERIES.length) => Array.from({ length: n }, (_, query_index) => ({
  query_index, provider: 'searxng', provenance: 'live', status, provider_mode: 'default', result_count: 8,
}))

/** A healthy open-web lane: search ok, pages fetched, extraction produced candidates. */
const laneHealthy = (extra = {}) => ({
  ok: true, queries: QUERIES, pages: 48, seeded: 0, fetched: 40, extracted: 12, stored: 6, deduped: 2, rejected: 4,
  search_provenance: provenance('ok'), search_provider_counts: { searxng: 28 }, search_cache_hits: 0,
  search_unknown_provenance_count: 0, search_degraded_queries: 0, search_unavailable_queries: 0,
  ...extra,
})
/** The 2026-09-12 prod shape: search healthy, ~40 pages fetched, ZERO extracted. */
const laneDeadExtractor = () => laneHealthy({ extracted: 0, stored: 0, deduped: 0, rejected: 0 })
const laneSkipped = () => ({ skipped: true, reason: 'time_budget_exhausted' })
const laneProvidersDown = () => laneHealthy({
  pages: 0, fetched: 0, extracted: 0, stored: 0, search_provenance: provenance('unavailable'), search_unavailable_queries: 28,
})

const scenario = (id = 'probe-1', category = 'probe:community_center+tribal+technology_equipment') => ({
  scenario_id: id, category, label: `Probe ${id}`, expected: { state: 'OH', county: 'Franklin' },
})
const thesis = (county = 'Franklin') => ({
  applicant_types: ['nonprofit'], needs: ['technology_equipment'], location: { state: 'OH', county }, is_student: false,
})
const rec = (title, i = 0) => ({
  opportunity_id: `opp-${i}`, id: `opp-${i}`, title, sponsor: 'Ohio Department of Development', kind: 'PROGRAM',
  decision: 'ACCEPT', match_decision: 'ACCEPT', match_score: 88, amount_max: 5000, description: 'Statewide technology grant.',
})
const statewide = () => [rec('Ohio Technology Access Grant', 1), rec('Statewide Nonprofit Equipment Fund', 2)]
const countyNamed = () => [rec('Franklin County Community Foundation Technology Grant', 1), rec('Ohio Technology Access Grant', 2)]

function evaluate({ lane, recommendations = statewide(), county = 'Franklin', sc = scenario(), stored = 6, run = {} } = {}) {
  return evaluateDiscovery(sc, `profile-${sc.scenario_id}`, {
    run: { run_id: 'crawl-1', stored, sources: [{ source_id: 'grants_gov', outcome: 'OK' }], recommendations, web_lane: lane, ...run },
    persisted: { opportunities: stored },
    thesis: thesis(county),
  }, { runId: RUN })
}

function receiptFor(evaluations) {
  return buildRunCohortReceipt({
    runId: RUN, target: evaluations.length, at: '2026-09-12T13:44:44.833Z',
    expectedMembers: evaluations.map((e) => e.cohort_member_id), evaluations,
  })
}

describe('amy-cohort-1 — a blocked web lane is UNEVALUABLE, never an issue attributed to webQueries.js', () => {
  it('web lane SKIPPED for time budget: no hyperlocal finding, class discovery_blocked:budget_truncated', () => {
    const ev = evaluate({ lane: laneSkipped() })
    expect(ev.findings.map((f) => f.type)).not.toContain('hyperlocal_recall_miss')
    expect(ev.discovery_gate.evaluable).toBe(false)
    expect(ev.discovery_gate.class).toBe(blockedClass(DISCOVERY_BLOCK_REASON.BUDGET_TRUNCATED))
    const receipt = receiptFor([ev])
    expect(receipt.outcomes).toMatchObject({ clean: 0, issue: 0, unevaluable: 1 })
    expect(receipt.exception_classes[blockedClass(DISCOVERY_BLOCK_REASON.BUDGET_TRUNCATED)]).toBe(1)
    expect(receipt.members[0].class).toBe(blockedClass(DISCOVERY_BLOCK_REASON.BUDGET_TRUNCATED))
    expect(classifyProbeOutcome(ev)).toBe(PROBE_OUTCOME.UNKNOWN)
  })

  it('PROD 2026-09-12: search healthy, 40 pages fetched, ZERO extracted → discovery_blocked:extraction_failed, llm unavailable, zero code_change items', () => {
    const ev = evaluate({ lane: laneDeadExtractor() })
    expect(ev.findings.map((f) => f.type)).not.toContain('hyperlocal_recall_miss')
    expect(ev.discovery_gate.class).toBe(blockedClass(DISCOVERY_BLOCK_REASON.EXTRACTION_FAILED))
    expect(ev.provider_health.search).toBe('healthy')
    expect(ev.provider_health.llm).toBe('unavailable')
    const receipt = receiptFor([ev])
    expect(receipt.outcomes.unevaluable).toBe(1)
    expect(receipt.outcomes.clean).toBe(0)
    expect(receipt.outcomes.issue).toBe(0)
    expect(isCleanEvaluation(ev)).toBe(false)
    const queue = buildApprovalQueue([ev])
    expect(queue.filter((i) => i.lever === 'query_breadth')).toHaveLength(0)
    expect(queue.filter((i) => i.actionability === 'code_change')).toHaveLength(0)
  })

  it('web lane ABSENT → discovery_blocked:no_crawl; search providers UNAVAILABLE → discovery_blocked:provider_unavailable', () => {
    const absent = evaluate({ lane: undefined })
    expect(absent.discovery_gate.class).toBe(blockedClass(DISCOVERY_BLOCK_REASON.NO_CRAWL))
    expect(evaluationOutcome(absent).outcome).toBe('unevaluable')
    const down = evaluate({ lane: laneProvidersDown() })
    expect(down.discovery_gate.class).toBe(blockedClass(DISCOVERY_BLOCK_REASON.PROVIDER_UNAVAILABLE))
    expect(down.provider_health.search).toBe('unavailable')
    expect(down.findings.map((f) => f.type)).not.toContain('hyperlocal_recall_miss')
  })

  it('lane B primary_attribution wins over the derived reason when present', () => {
    const lane = { ...laneDeadExtractor(), primary_attribution: { reason: 'provider_unavailable', detail: 'llm_pool_exhausted' } }
    const ev = evaluate({ lane })
    expect(ev.discovery_gate.class).toBe(blockedClass(DISCOVERY_BLOCK_REASON.PROVIDER_UNAVAILABLE))
    expect(ev.discovery_gate.detail).toBe('llm_pool_exhausted')
  })

  it('a HEALTHY lane with statewide-only results still fires hyperlocal_recall_miss and counts as an ISSUE (the detector is not weakened)', () => {
    const ev = evaluate({ lane: laneHealthy() })
    expect(ev.discovery_gate.evaluable).toBe(true)
    expect(ev.findings.map((f) => f.type)).toContain('hyperlocal_recall_miss')
    const receipt = receiptFor([ev])
    expect(receipt.outcomes).toMatchObject({ clean: 0, issue: 1, unevaluable: 0 })
    expect(classifyProbeOutcome(ev)).toBe(PROBE_OUTCOME.GAP)
  })

  it('a HEALTHY lane whose candidates name the county is CLEAN', () => {
    const ev = evaluate({ lane: laneHealthy(), recommendations: countyNamed() })
    expect(ev.findings).toHaveLength(0)
    expect(isCleanEvaluation(ev)).toBe(true)
    const receipt = receiptFor([ev])
    expect(receipt.outcomes.clean).toBe(1)
    expect(receipt.all_clean).toBe(true)
    expect(classifyProbeOutcome(ev)).toBe(PROBE_OUTCOME.CLEAN)
  })

  it('a legacy evaluation with NO stage evidence at all is never clean (zero evaluation stages)', () => {
    const legacy = { scenario_id: 's1', cohort_member_id: 's1', cohort_run_id: RUN, status: 'ok', accepted: 1, findings: [],
      opportunity_oracle: { status: 'checked', complete: true, accepted_claims: 1, checked_accepts: 1, unknown_accepts: 0, known_conflicts: 0 } }
    expect(isCleanEvaluation(legacy)).toBe(false)
    const receipt = buildRunCohortReceipt({ runId: RUN, target: 1, expectedMembers: ['s1'], evaluations: [legacy] })
    expect(receipt.outcomes.unevaluable).toBe(1)
    expect(receipt.exception_classes[blockedClass(DISCOVERY_BLOCK_REASON.STAGES_UNKNOWN)]).toBe(1)
  })
})

describe('amy-cohort-4 — the probe ledger agrees with the flywheel outcome', () => {
  it('ok + zero findings WITHOUT an oracle is UNKNOWN for coverage, exactly as the receipt says unevaluable', () => {
    const ev = { status: 'ok', accepted: 1, findings: [], discovery_gate: { evaluable: true, recall_measurable: true, class: null }, opportunity_oracle: { status: 'unknown', unknown_accepts: 1 } }
    expect(classifyProbeOutcome(ev)).toBe(PROBE_OUTCOME.UNKNOWN)
    expect(evaluationOutcome(ev).outcome).toBe('unevaluable')
    expect(evaluationOutcome(ev).class).toBe('oracle_unevaluable')
  })

  it('every evaluation the receipt counts clean/issue/unevaluable maps to CLEAN/GAP/UNKNOWN', () => {
    const evals = [
      evaluate({ lane: laneHealthy(), recommendations: countyNamed(), sc: scenario('probe-1') }),
      evaluate({ lane: laneHealthy(), sc: scenario('probe-2') }),
      evaluate({ lane: laneDeadExtractor(), sc: scenario('probe-3') }),
      evaluate({ lane: laneSkipped(), sc: scenario('probe-4') }),
    ]
    const receipt = receiptFor(evals)
    const map = { clean: PROBE_OUTCOME.CLEAN, issue: PROBE_OUTCOME.GAP, unevaluable: PROBE_OUTCOME.UNKNOWN }
    for (const member of receipt.members) {
      const ev = evals.find((e) => e.cohort_member_id === member.member_id)
      expect(classifyProbeOutcome(ev), member.member_id).toBe(map[member.outcome])
    }
    expect(receipt.outcomes).toMatchObject({ clean: 1, issue: 1, unevaluable: 2 })
  })
})

describe('amy-cohort-6 — no_qualified_matches says whether candidates reached the engine', () => {
  const nqmRun = (extra = {}) => evaluateDiscovery(scenario('probe-9', 'probe:x+y+z'), 'p9', {
    run: { run_id: 'c', stored: 12, sources: [], recommendations: [], web_lane: laneHealthy({ extracted: 3, stored: 3 }), ...extra },
    persisted: { opportunities: 12 },
    thesis: thesis(),
  }, { runId: RUN })

  it('without a decision tally, verdicts are UNKNOWN_not_persisted and the message says candidates reached the engine', () => {
    const ev = nqmRun()
    const f = ev.findings.find((x) => x.type === 'no_qualified_matches')
    expect(f).toBeTruthy()
    expect(f.evidence.engine_input).toMatchObject({ stored_candidates: 12, web_extracted: 3, verdicts: 'UNKNOWN_not_persisted' })
    expect(f.evidence.engine_input.distinction).toBe('candidates_reached_engine_verdicts_not_persisted')
    expect(f.message).toMatch(/12 stored candidate\(s\) reached the engine/)
  })

  it('with a decision tally, the finding carries accept/review/reject counts and the top reject reasons', () => {
    const ev = nqmRun({ decision_tally: { accept: 0, review: 0, reject: 12, top_reject_reasons: { stage_of_life: 7, geo_scope: 5 } } })
    const f = ev.findings.find((x) => x.type === 'no_qualified_matches')
    expect(f.evidence.engine_input.verdicts).toEqual({ accept: 0, review: 0, reject: 12 })
    expect(f.evidence.engine_input.top_reject_reasons).toEqual({ stage_of_life: 7, geo_scope: 5 })
    expect(f.evidence.engine_input.distinction).toBe('candidates_below_bands')
    expect(f.message).toMatch(/all 12 were REJECTed by gates/)
  })

  it('when the web lane extracted nothing and the registry stored nothing, the finding names NO candidates reaching the engine', () => {
    const ev = evaluateDiscovery(scenario('probe-9', 'probe:x+y+z'), 'p9', {
      run: { run_id: 'c', stored: 0, sources: [], recommendations: [], web_lane: laneHealthy({ extracted: 0, stored: 0, fetched: 0, pages: 0 }) },
      persisted: { opportunities: 0 },
      thesis: thesis(),
    }, { runId: RUN })
    // stored 0 is the zero_result class, not NQM; but the gate must record the engine input for the baseline.
    expect(ev.member_baseline.qualification_decisions.candidates_reached_engine).toBe(0)
    expect(ev.discovery_gate.evaluable).toBe(true)
  })
})

describe('amy-cohort-5 — every member carries a durable per-profile baseline', () => {
  it('generated queries, executed queries, provider health, extracted/canonical candidates, decisions, admissions, final class', () => {
    const lane = laneHealthy({ extracted_titles: ['Franklin County Foundation Grant', 'Ohio Tech Fund'] })
    const ev = evaluate({ lane, recommendations: countyNamed() })
    const b = ev.member_baseline
    expect(b.generated_queries).toHaveLength(28)
    expect(b.generated_queries[0]).toEqual({ query: QUERIES[0], tier: 'UNKNOWN' })
    expect(b.executed_queries).toHaveLength(28)
    expect(b.executed_queries[0]).toMatchObject({ query_index: 0, query: QUERIES[0], provider: 'searxng', status: 'ok', result_count: 8 })
    expect(b.provider_health).toEqual({ search: 'healthy', llm: 'healthy', detail: expect.any(String) })
    expect(b.extracted_candidates).toEqual({ count: 12, titles: ['Franklin County Foundation Grant', 'Ohio Tech Fund'] })
    expect(b.canonical_candidates).toEqual({ stored: 6, deduped: 2, rejected: 4, run_stored: 6 })
    expect(b.qualification_decisions).toMatchObject({ accept: 2, review: 0, reject: 'UNKNOWN_not_persisted', candidates_reached_engine: 6 })
    expect(b.admission_decisions).toEqual({ recommendations: 2, titles: countyNamed().map((r) => r.title) })
    expect(b.final_class).toBe('clean')
    const receipt = receiptFor([ev])
    expect(receipt.members[0].baseline.generated_queries).toHaveLength(28)
    expect(receipt.members[0].class).toBe('clean')
  })

  it('prefers lane B\'s query ledger (with tiers) when it is present', () => {
    const lane = laneHealthy({ query_ledger: { planned: [{ query: 'a', tier: 'core' }, { query: 'b', tier: 'extra' }], executed: [{ query: 'a', tier: 'core', provider: 'brave', status: 'ok', result_count: 3 }] } })
    const ev = evaluate({ lane, recommendations: countyNamed() })
    expect(ev.member_baseline.generated_queries).toEqual([{ query: 'a', tier: 'core' }, { query: 'b', tier: 'extra' }])
    expect(ev.member_baseline.executed_queries[0]).toMatchObject({ query: 'a', tier: 'core', provider: 'brave' })
  })

  it('a dead-extractor member records the blocked class and UNKNOWN candidate titles rather than inventing them', () => {
    const ev = evaluate({ lane: laneDeadExtractor() })
    expect(ev.member_baseline.final_class).toBe(blockedClass(DISCOVERY_BLOCK_REASON.EXTRACTION_FAILED))
    expect(ev.member_baseline.extracted_candidates).toEqual({ count: 0, titles: [] })
    expect(ev.member_baseline.provider_health.llm).toBe('unavailable')
  })

  it('the receipt carries a metric envelope: window=run, population=planned synthetic cohort, evaluated/unevaluated, provider health', () => {
    const evals = [
      evaluate({ lane: laneHealthy(), recommendations: countyNamed(), sc: scenario('probe-1') }),
      evaluate({ lane: laneDeadExtractor(), sc: scenario('probe-2') }),
    ]
    const receipt = receiptFor(evals)
    expect(receipt.metric_envelope).toMatchObject({
      metric_envelope_version: 1,
      measurement_window: { kind: 'run', label: RUN },
      evaluated_population: { kind: 'amy_planned_synthetic_cohort' },
      evaluated_count: 1,
      unevaluated_count: 1,
      sample_size: 2,
      freshness_at: '2026-09-12T13:44:44.833Z',
    })
    expect(receipt.metric_envelope.evaluated_population.description).toMatch(/target 2/)
    expect(receipt.metric_envelope.provider_health).toMatchObject({ search: 'healthy', llm: 'degraded' })
    expect(receipt.metric_envelope.provider_health.detail).toMatchObject({ llm: { healthy: 1, unavailable: 1 } })
    expect(receipt.metric_envelope.code_version).toHaveProperty('commit_sha')
  })

  it('bounds the persisted size: 50 fat members stay under the report budget and the day store keeps baselines only on the latest receipt', () => {
    const fat = Array.from({ length: 50 }, (_, i) => evaluate({
      lane: laneHealthy({ queries: Array.from({ length: 60 }, (_, q) => `${'x'.repeat(200)} ${q}`), extracted_titles: Array.from({ length: 40 }, (_, t) => 'T'.repeat(200) + t) }),
      recommendations: Array.from({ length: 30 }, (_, r) => rec(`Franklin County ${'R'.repeat(200)}${r}`, r)),
      sc: scenario(`probe-${i + 1}`),
    }))
    const receipt = receiptFor(fat)
    const bytes = Buffer.byteLength(JSON.stringify(receipt.members), 'utf8')
    expect(bytes).toBeLessThan(900_000)
    expect(receipt.members[0].baseline.generated_queries.length).toBeLessThanOrEqual(30)
    expect(receipt.members[0].baseline.admission_decisions.titles.length).toBeLessThanOrEqual(10)
    expect(receipt.members[0].baseline.extracted_candidates.titles.length).toBeLessThanOrEqual(20)
    const r1 = buildCohortUpdate(null, { dayKey: '2026-09-12', target: 50, runId: 'run-a', at: 't1', evaluations: fat.map((e) => ({ ...e, cohort_run_id: 'run-a' })), expectedMembers: fat.map((e) => e.cohort_member_id) })
    const r2 = buildCohortUpdate(r1.store, { dayKey: '2026-09-12', target: 50, runId: 'run-b', at: 't2', evaluations: fat.map((e) => ({ ...e, cohort_run_id: 'run-b' })), expectedMembers: fat.map((e) => e.cohort_member_id) })
    const [older, latest] = r2.day.run_receipts
    expect(older.members[0].baseline).toBeUndefined()
    expect(older.members[0].class).toBe('clean')
    expect(latest.members[0].baseline).toBeTruthy()
  })
})

describe('amy-cohort-2 — the catalog floor ROTATES so six slots cycle through every category', () => {
  const dayRun = (d) => `amy-2026-09-${String(d).padStart(2, '0')}T11-31-58-550Z-dfd2cbce`

  it('six consecutive nights cover every catalog category; two nights differ; a night is deterministic', () => {
    const nights = [12, 13, 14, 15, 16, 17].map((d) => generateScenarios({ runId: dayRun(d), targetCount: 6 }).map((s) => s.category))
    expect(new Set(nights.flat()).size).toBe(CATEGORY_IDS.length)
    expect(nights[0]).not.toEqual(nights[1])
    expect(generateScenarios({ runId: dayRun(12), targetCount: 6 }).map((s) => s.category)).toEqual(nights[0])
    for (const night of nights) expect(night).toHaveLength(6)
  })

  it('an explicit catalogRotation of 0 reproduces the legacy fixed floor (needed to rebuild the 2026-09-12 cohort)', () => {
    const legacy = generateScenarios({ runId: RUN, targetCount: 6, catalogRotation: 0 }).map((s) => s.scenario_id)
    expect(legacy).toEqual(['business-v1', 'nonprofit-v1', 'school_district-v1', 'college_university-v1', 'high_school_student-v1', 'college_student-v1'])
    expect(catalogRotationForRun({ runId: dayRun(12), slots: 6, ringLength: 36 })).not.toBe(catalogRotationForRun({ runId: dayRun(13), slots: 6, ringLength: 36 }))
  })
})

describe('amy-cohort-3 — probe recall items are keyed by lever+finding type, not per cell', () => {
  const probeEval = (cell, county, lane = laneHealthy()) => evaluate({ lane, county, sc: scenario(`probe-${cell}`, `probe:entity_${cell}+none+housing`) })

  it('two probe cells with hyperlocal misses collapse into ONE item with both subjects and both cells', () => {
    const items = buildApprovalQueue([probeEval('a', 'Polk'), probeEval('b', 'Hampden')]).filter((i) => i.lever === 'query_breadth')
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(`hyperlocal_recall_miss:${PROBE_ITEM_CATEGORY}`)
    expect(items[0].category).toBe(PROBE_ITEM_CATEGORY)
    expect(items[0].evidence.subjects).toEqual(expect.arrayContaining(['Polk', 'Hampden']))
    expect(items[0].evidence.cells).toEqual(expect.arrayContaining(['probe:entity_a+none+housing', 'probe:entity_b+none+housing']))
    expect(items[0].evidence.profiles).toBe(2)
    expect(items[0].actionability).toBe('code_change')
  })

  it('a healthy probe night for an UNRELATED subject never closes another subject\'s gap; a dead-extractor night also holds it open as blocked', () => {
    const night1 = foldApprovalLedger(null, { items: buildApprovalQueue([probeEval('a', 'Polk')]), evaluations: [probeEval('a', 'Polk')], runId: 'r1', at: '2026-09-12T12:00:00Z' })
    expect(Object.values(night1.ledger.entries).filter((e) => !e.resolved_at)).toHaveLength(1)

    const dead = probeEval('c', 'Lee', laneDeadExtractor())
    const night2 = foldApprovalLedger(night1.ledger, { items: buildApprovalQueue([dead]), evaluations: [dead], runId: 'r2', at: '2026-09-13T12:00:00Z' })
    expect(night2.closed).toHaveLength(0)
    const held = night2.decorated.find((i) => i.id === `hyperlocal_recall_miss:${PROBE_ITEM_CATEGORY}`)
    expect(held.actionability).toBe('blocked')
    expect(held.evidence.subjects).toEqual(['Polk'])

    // amy-cohort-3 BLOCKER fix (2026-09-12): a DIFFERENT probe cell (entity_d,
    // county Fresno) running healthy with no miss of its own must NOT close
    // the Polk item — Polk itself was never re-probed. Before the fix,
    // `healthyProbeClassCoverage` treated ANY healthy probe of the finding
    // type as proof the class had "stopped reproducing" and closed it here.
    const healthyUnrelated = evaluate({ lane: laneHealthy(), county: 'Fresno', recommendations: [rec('Fresno County Housing Trust Grant', 1)], sc: scenario('probe-d', 'probe:entity_d+none+housing') })
    const night3 = foldApprovalLedger(night2.ledger, { items: buildApprovalQueue([healthyUnrelated]), evaluations: [healthyUnrelated], runId: 'r3', at: '2026-09-14T12:00:00Z' })
    expect(night3.closed.map((c) => c.id)).not.toContain(`hyperlocal_recall_miss:${PROBE_ITEM_CATEGORY}`)
    const stillHeld = night3.decorated.find((i) => i.id === `hyperlocal_recall_miss:${PROBE_ITEM_CATEGORY}`)
    expect(stillHeld).toBeTruthy()
    expect(stillHeld.evidence.subjects).toEqual(['Polk'])
    expect(Object.values(night3.ledger.entries).filter((e) => !e.resolved_at && e.lever === 'query_breadth')).toHaveLength(1)

    // Only when a healthy probe SPECIFICALLY re-tests Polk and finds it covered
    // does the class item close — a real re-probe, not a coincidence elsewhere.
    const healthyPolkRetest = evaluate({ lane: laneHealthy(), county: 'Polk', recommendations: [rec('Polk County Housing Trust Grant', 1)], sc: scenario('probe-e', 'probe:entity_e+none+housing') })
    const night4 = foldApprovalLedger(night3.ledger, { items: buildApprovalQueue([healthyPolkRetest]), evaluations: [healthyPolkRetest], runId: 'r4', at: '2026-09-15T12:00:00Z' })
    expect(night4.closed.map((c) => c.id)).toContain(`hyperlocal_recall_miss:${PROBE_ITEM_CATEGORY}`)
    expect(Object.values(night4.ledger.entries).filter((e) => !e.resolved_at && e.lever === 'query_breadth')).toHaveLength(0)
  })

  it('a present probe item carries only the subjects measured THIS run (never an ever-growing union of untested counties)', () => {
    const night1 = foldApprovalLedger(null, { items: buildApprovalQueue([probeEval('a', 'Polk')]), evaluations: [probeEval('a', 'Polk')], runId: 'r1', at: '2026-09-12T12:00:00Z' })
    const night2 = foldApprovalLedger(night1.ledger, { items: buildApprovalQueue([probeEval('b', 'Hampden')]), evaluations: [probeEval('b', 'Hampden')], runId: 'r2', at: '2026-09-13T12:00:00Z' })
    const item = night2.decorated.find((i) => i.id === `hyperlocal_recall_miss:${PROBE_ITEM_CATEGORY}`)
    expect(item.evidence.subjects).toEqual(['Hampden'])
    expect(item.nights_open).toBe(2)
    expect(item.actionability).toBe('code_change')
  })

  it('catalog-category items keep their per-category key', () => {
    const items = buildApprovalQueue([evaluate({ lane: laneHealthy(), sc: scenario('business-v1', 'business') })]).filter((i) => i.lever === 'query_breadth')
    expect(items.map((i) => i.id)).toEqual(['hyperlocal_recall_miss:business'])
  })
})

describe('classifyWebLane — the one choke point', () => {
  it('classifies the four derived reasons from lane counters', () => {
    expect(classifyWebLane(null).reason).toBe(DISCOVERY_BLOCK_REASON.NO_CRAWL)
    expect(classifyWebLane({ ok: false, error: 'boom' }).reason).toBe(DISCOVERY_BLOCK_REASON.NO_CRAWL)
    expect(classifyWebLane(laneSkipped()).reason).toBe(DISCOVERY_BLOCK_REASON.BUDGET_TRUNCATED)
    expect(classifyWebLane({ skipped: true, reason: 'disabled' }).reason).toBe(DISCOVERY_BLOCK_REASON.NO_CRAWL)
    expect(classifyWebLane(laneProvidersDown()).reason).toBe(DISCOVERY_BLOCK_REASON.PROVIDER_UNAVAILABLE)
    expect(classifyWebLane(laneDeadExtractor()).reason).toBe(DISCOVERY_BLOCK_REASON.EXTRACTION_FAILED)
    expect(classifyWebLane(laneHealthy())).toMatchObject({ evaluable: true, recall_measurable: true, reason: null, class: null })
  })

  it('legacy telemetry without counters is UNKNOWN, not failed — the detector keeps firing (amySearchAttribution contract)', () => {
    const legacy = classifyWebLane({ queries: ['a'], search_provenance: provenance('ok', 1) })
    expect(legacy.evaluable).toBe(true)
    expect(legacy.extraction).toBe('unknown')
    expect(legacy.llm).toBe('unknown')
    const degraded = classifyWebLane({ queries: ['a'], search_provenance: provenance('degraded_results', 1) })
    expect(degraded.evaluable).toBe(true)
    expect(degraded.recall_measurable).toBe(false)
    expect(degraded.class).toBe(blockedClass(DISCOVERY_BLOCK_REASON.PROVIDER_DEGRADED))
  })
})
