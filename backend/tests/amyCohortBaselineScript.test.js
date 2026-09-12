/**
 * amyCohortBaselineScript.test.js — backend/scripts/amy-cohort-baseline.mjs
 * rebuilds a persisted Amy run's planned cohort OFFLINE and lays each member's
 * thesis + tiered query plan beside what production persisted, marking every
 * field the run did not persist as UNKNOWN_not_persisted (issue 2, lane C).
 *
 * The fixture is shaped like the 2026-09-12 prod report
 * (amy-2026-09-12T11-31-58-550Z-dfd2cbce): receipt_version 1 members carrying
 * only member_id / profile_id / outcome / status / oracle_status /
 * finding_types, handoff findings with search_evidence, a per-category
 * approval item, and adopted orphans mixed into summary.scenarios.
 */

import { describe, expect, it } from 'vitest'
import { generateScenarios } from '../services/amy/syntheticProfileCatalog.js'
import { buildIntersectionScenarios } from '../services/amy/intersectionScenario.js'
import { planGapSeekingProbes } from '../services/amy/gapSeekingPlanner.js'
import { cellKey } from '../services/amy/probeSpace.js'
import { UNKNOWN_NOT_PERSISTED } from '../services/amy/amyReport.js'
import { rebuildCohortBaseline, parseArgs, unwrapKv } from '../scripts/amy-cohort-baseline.mjs'

const RUN = 'amy-2026-09-12T11-31-58-550Z-dfd2cbce'
const STARTED = '2026-09-12T11:31:58.550Z'

function fakeProdRun({ target = 8, catalogBuilt = 6 } = {}) {
  const plan = planGapSeekingProbes({ ledger: null, count: target - catalogBuilt, runId: RUN, now: new Date(STARTED) })
  const probes = buildIntersectionScenarios(plan.cells, { runId: RUN })
  // The prod run predates the rotating floor: its catalog was the fixed floor.
  const catalog = generateScenarios({ runId: RUN, targetCount: catalogBuilt, catalogRotation: 0 })
  const scenarios = [...catalog, ...probes]
  const memberIds = scenarios.map((s) => s.scenario_id)
  const members = scenarios.map((s, i) => ({
    member_id: s.scenario_id, profile_id: `p-${i}`, outcome: 'issue', status: 'ok', oracle_status: 'checked', finding_types: ['hyperlocal_recall_miss'],
  }))
  const findings = scenarios.map((s, i) => ({
    type: 'hyperlocal_recall_miss', severity: 'medium', actionability: 'code_investigation', file: 'backend/crawler-os/webQueries.js',
    message: `Measured hyperlocal_recall_miss remains for ${s.category}.`,
    evidence: {
      scenario_id: s.scenario_id, category: s.category, profile_id: `p-${i}`, county: s.expected?.county ?? 'Franklin', results: 7,
      search_evidence: { status: 'healthy', provenance: [{ query_index: 0, provider: 'cache', provenance: 'cache', status: 'ok', result_count: 8 }, { query_index: 1, provider: 'searxng', provenance: 'live', status: 'ok', result_count: 8 }] },
    },
    attribution: { status: 'search_verified' },
  }))
  const report = {
    run_id: RUN, started_at: STARTED, completed_at: '2026-09-12T13:44:44.833Z',
    cohort_request: { run_id: RUN, requested_target: target, planned_members: memberIds.length, member_ids: memberIds, exact_plan: true },
    gap_probes: { enabled: true, catalog_built: catalogBuilt, planned: plan.cells.length, built: probes.length, cells: probes.map((s) => s.probe_cell) },
    fleet_gap_learning: { category_weights: null },
    flywheel_cohort: {
      day: { day: '2026-09-12' },
      receipt: { receipt_version: 1, run_id: RUN, outcomes: { clean: 0, issue: memberIds.length }, finding_types: { hyperlocal_recall_miss: memberIds.length }, exception_classes: {}, members },
    },
    approval_queue: [{ id: 'hyperlocal_recall_miss:business', category: 'business', lever: 'query_breadth', actionability: 'blocked', attribution: { status: 'inconclusive' }, evidence: { subjects: ['Franklin'] }, nights_open: 9 }],
    // The prod defect amy-cohort-7 in miniature: three adopted orphans inside summary.scenarios.
    amy: { summary: { scenarios: memberIds.length + 3, ok: memberIds.length + 3 }, handoff: { findings } },
    adopted_orphans: { adopted: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }] },
    probe_coverage: { probes_folded: probes.length },
  }
  const coverage = {
    pairs: {},
    cells: Object.fromEntries(probes.map((s) => [cellKey(s.probe_cell), { first_at: report.completed_at, last_at: report.completed_at, probes: 1, gaps: 1, last_status: 'gap' }])),
    runs: [RUN],
  }
  const cohort = { days: { '2026-09-12': { day: '2026-09-12', runs: [RUN], run_receipts: [{ run_id: RUN, recorded_at: report.completed_at, members }] } } }
  return { report, coverage, cohort, scenarios, probes, catalog }
}

describe('amy-cohort-baseline — rebuild the planned cohort offline and lay it beside what prod persisted', () => {
  it('reconstructs every planned member exactly; each carries a thesis, a tiered query plan, and honest UNKNOWN markers', async () => {
    const { report, coverage, cohort, probes, catalog } = fakeProdRun()
    const out = await rebuildCohortBaseline({ report, coverage, cohort })

    expect(out.run_id).toBe(RUN)
    expect(out.reconstruction.exact).toBe(true)
    expect(out.reconstruction.exact_count).toBe(8)
    expect(out.reconstruction.catalog.ids_matching_in_order).toBe(catalog.length)
    expect(out.reconstruction.catalog.rotation_source).toBe('legacy_fixed_floor_assumed')
    expect(out.reconstruction.probes.cells_matching_report).toBe(probes.length)
    expect(out.members.map((m) => m.member_id)).toEqual(report.cohort_request.member_ids)

    for (const m of out.members) {
      expect(m.thesis.location.state).toMatch(/^[A-Z]{2}$/)
      expect(m.thesis.applicant_types.length).toBeGreaterThan(0)
      expect(m.generated_queries.source).toBe('buildWebQueryPlan')
      expect(m.generated_queries.entries.length).toBeGreaterThan(0)
      for (const e of m.generated_queries.entries) expect(['anchor', 'core', 'breadth']).toContain(e.tier)
      expect(m.generated_queries.by_tier.core).toBeGreaterThan(0)
      // What prod persisted for the member, verbatim.
      expect(m.persisted.receipt_member).toMatchObject({ outcome: 'issue', status: 'ok', oracle_status: 'checked', finding_types: ['hyperlocal_recall_miss'] })
      expect(m.persisted.flywheel_store_member.agrees_with_report).toBe(true)
      expect(m.persisted.findings[0]).toMatchObject({ type: 'hyperlocal_recall_miss', attribution_status: 'search_verified' })
      expect(m.persisted.search_evidence).toMatchObject({ status: 'healthy', queries_with_provenance: 2, by_provider: { cache: 1, searxng: 1 } })
      expect(m.persisted.search_evidence.entries[0].query).toBe(UNKNOWN_NOT_PERSISTED)
      // What prod did NOT persist is named as such, never inferred.
      expect(m.persisted.executed_queries).toBe(UNKNOWN_NOT_PERSISTED)
      expect(m.persisted.provider_health).toEqual({ search: 'healthy', llm: UNKNOWN_NOT_PERSISTED })
      expect(m.persisted.extracted_candidates).toBe(UNKNOWN_NOT_PERSISTED)
      expect(m.persisted.canonical_candidates).toBe(UNKNOWN_NOT_PERSISTED)
      expect(m.persisted.qualification_decisions).toBe(UNKNOWN_NOT_PERSISTED)
      expect(m.persisted.admission_decisions).toBe(UNKNOWN_NOT_PERSISTED)
      expect(m.persisted.final_class).toBe(UNKNOWN_NOT_PERSISTED)
    }
    const probeMembers = out.members.filter((m) => m.scenario.probe_cell)
    expect(probeMembers).toHaveLength(probes.length)
    for (const m of probeMembers) {
      expect(m.thesis.location.county).toBeTruthy()
      expect(m.generated_queries.names_county).toBe(true)
      expect(m.persisted.probe_coverage_cell).toMatchObject({ last_status: 'gap', probes: 1, gaps: 1 })
    }
    const business = out.members.find((m) => m.member_id === 'business-v1')
    expect(business.persisted.approval_items.map((i) => i.id)).toEqual(['hyperlocal_recall_miss:business'])
    expect(business.persisted.probe_coverage_cell).toBe('not_a_probe')

    expect(out.summary.by_persisted_outcome).toEqual({ issue: 8 })
    expect(out.summary.by_search_evidence_status).toEqual({ healthy: 8 })
    expect(out.summary.thesis_errors).toBe(0)
    expect(out.summary.receipt_members_without_baseline).toBe(8)
    // The orphan-mixing defect is visible from the persisted numbers alone.
    expect(out.persisted_run_summary.adopted_orphans).toEqual({ adopted: 3, counted_in_summary_scenarios: true })
    expect(out.persisted_run_summary.metric_envelope).toBe(UNKNOWN_NOT_PERSISTED)
    expect(out.reconstruction.probes.replan.attempted).toBe(true)
  })

  it('quotes a receipt_version-2 member baseline instead of marking it unknown', async () => {
    const { report, coverage, cohort } = fakeProdRun({ target: 4, catalogBuilt: 3 })
    const baseline = {
      executed_queries: [{ query_index: 0, query: 'grants Franklin County, OH', tier: 'core', provider: 'searxng', status: 'ok', result_count: 8 }],
      provider_health: { search: 'healthy', llm: 'unavailable', detail: 'extracted=0' },
      extracted_candidates: { count: 0, titles: [] },
      canonical_candidates: { stored: 0, deduped: 0, rejected: 0, run_stored: 4 },
      qualification_decisions: { accept: 2, review: 0, reject: UNKNOWN_NOT_PERSISTED },
      admission_decisions: { recommendations: 2, titles: ['Ohio Technology Access Grant'] },
      final_class: 'discovery_blocked:extraction_failed',
    }
    report.flywheel_cohort.receipt.receipt_version = 2
    report.flywheel_cohort.receipt.members[0] = { ...report.flywheel_cohort.receipt.members[0], class: 'discovery_blocked:extraction_failed', outcome: 'unevaluable', baseline }
    const out = await rebuildCohortBaseline({ report, coverage, cohort })
    const first = out.members[0].persisted
    expect(first.executed_queries).toEqual(baseline.executed_queries)
    expect(first.provider_health).toEqual(baseline.provider_health)
    expect(first.final_class).toBe('discovery_blocked:extraction_failed')
    expect(first.receipt_member.class).toBe('discovery_blocked:extraction_failed')
    expect(out.members[1].persisted.executed_queries).toBe(UNKNOWN_NOT_PERSISTED)
  })

  it('a stored plan that the run id no longer reproduces is reported INEXACT, never patched to fit', async () => {
    const { report, coverage, cohort } = fakeProdRun({ target: 4, catalogBuilt: 3 })
    // Pretend the persisted member list came from a different catalog order.
    const ids = report.cohort_request.member_ids
    ;[ids[0], ids[1]] = [ids[1], ids[0]]
    const out = await rebuildCohortBaseline({ report, coverage, cohort })
    expect(out.reconstruction.exact).toBe(false)
    expect(out.reconstruction.catalog.ids_matching_in_order).toBe(1)
    expect(out.reconstruction.exact_count).toBeLessThan(4)
    // The rebuilt scenarios are still what the run id produces; nothing was re-ordered to match.
    expect(out.reconstruction.catalog.rebuilt_ids).toEqual(generateScenarios({ runId: RUN, targetCount: 3, catalogRotation: 0 }).map((s) => s.scenario_id))
  })

  it('CLI arguments: the four inputs are required and kv wrappers are unwrapped', () => {
    expect(() => parseArgs(['--report', 'r.json'])).toThrow(/--coverage is required/)
    expect(() => parseArgs(['--report'])).toThrow(/requires a value/)
    expect(parseArgs(['--report', 'r', '--coverage', 'c', '--cohort', 'h', '--out', 'o'])).toEqual({ report: 'r', coverage: 'c', cohort: 'h', out: 'o' })
    expect(unwrapKv({ key: 'amy_last_report', value: '{"run_id":"x"}', updated_at: 't' })).toEqual({ run_id: 'x' })
    expect(unwrapKv({ run_id: 'x', value: 3 })).toEqual({ run_id: 'x', value: 3 })
  })
})
