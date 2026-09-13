#!/usr/bin/env node
/**
 * amy-cohort-baseline.mjs — rebuild ONE Amy synthetic-cohort run OFFLINE from
 * the persisted system_kv payloads and emit a per-profile baseline.
 *
 * WHY (prod 2026-09-12, run amy-2026-09-12T11-31-58-550Z-dfd2cbce): the report
 * said 50 planned / 50 evaluated / 0 clean / hyperlocal_recall_miss ×50 while
 * every LLM provider was dead. The receipt's members[] persisted only
 * member_id / profile_id / outcome / status / oracle_status / finding_types —
 * no queries, no candidates, no decisions — so nothing could say what each of
 * the 50 profiles actually asked for or what came back. This script rebuilds
 * the EXACT planned cohort from the stored plan (the run id seeds the catalog
 * locations; gap_probes.cells are the probe plan; fleet_gap_learning weights
 * shape the catalog ring), builds every thesis and query plan offline, and
 * lays it beside what the run DID persist. Every field the run did not persist
 * is written as the literal UNKNOWN_not_persisted — never inferred.
 *
 * OFFLINE: no production DB, no network, no LLM. Theses are built through the
 * SAME chain runProfileDiscoveryLive uses (createAmyProfile → loadProfileContext
 * → profileContextToThesisInput → buildThesis) against a throwaway in-memory
 * SQLite, so the offline thesis is the production thesis for that scenario.
 * Query plans use buildWebQueryPlan with seed 0: production seeds the rotating
 * EXTRA queries from Date.now(), so the CORE/ANCHOR tiers reproduce exactly and
 * the rotating extras are reported as `plan_seed: 0` (not the night's set).
 *
 * Usage:
 *   node backend/scripts/amy-cohort-baseline.mjs \
 *     --report   <kv-amy_last_report.json> \
 *     --coverage <kv-amy_probe_coverage.json> \
 *     --cohort   <kv-amy_flywheel_cohort.json> \
 *     --out      <file.json> \
 *     [--web-lane-health <kv-web_lane_health.json>]
 *
 * Exit 0 when every planned member was reconstructed exactly (catalog scenario
 * ids match the persisted member ids in order; probe cells match
 * report.gap_probes.cells); exit 2 otherwise; exit 1 on bad input.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { generateScenarios } from '../services/amy/syntheticProfileCatalog.js'
import { buildIntersectionScenarios } from '../services/amy/intersectionScenario.js'
import { planGapSeekingProbes } from '../services/amy/gapSeekingPlanner.js'
import { cellKey } from '../services/amy/probeSpace.js'
import { createAmyProfile } from '../services/amy/amyProfileStore.js'
import { UNKNOWN_NOT_PERSISTED } from '../services/amy/amyReport.js'
import { isProbeCategory, PROBE_ITEM_CATEGORY } from '../services/amy/approvalLedger.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { profileContextToThesisInput } from '../services/crawlerOsPersistence.js'
import { buildThesis } from '../crawler-os/profileIntelligence.js'
import { buildWebQueryPlan } from '../crawler-os/webQueries.js'

/** Production web-lane query cap when WEB_LANE_MAX_QUERIES is unset (webLane.js). */
const WEB_LANE_MAX_QUERIES_DEFAULT = 28
const PLAN_SEED = 0
const MAX_EXECUTED_PROVENANCE = 40

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value`)
    out[key] = value
    i += 1
  }
  for (const required of ['report', 'coverage', 'cohort', 'out']) {
    if (!out[required]) throw new Error(`--${required} is required`)
  }
  return out
}

/** The baseline dumps are the parsed kv VALUE; tolerate `{key,value}` / `{value:"json"}` wrappers. */
export function unwrapKv(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw && ('key' in raw || 'updated_at' in raw)) {
    const v = raw.value
    if (typeof v === 'string') { try { return JSON.parse(v) } catch { return v } }
    return v
  }
  return raw
}

function readJson(file) {
  return unwrapKv(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function createOfflineDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT, status TEXT DEFAULT 'active',
      tags TEXT DEFAULT '[]', created_by TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL, section_key TEXT NOT NULL, data TEXT NOT NULL,
      updated_by TEXT, created_at TEXT, updated_at TEXT, UNIQUE(profile_id, section_key)
    );
  `)
  return db
}

function tally(list, keyFn) {
  const out = {}
  for (const item of list) {
    const k = String(keyFn(item) ?? 'unknown')
    out[k] = (out[k] || 0) + 1
  }
  return out
}

/** Does at least one planned query name the profile's county (the hyperlocal detector's subject)? */
function namesCounty(plan, county) {
  if (!county || !plan) return null
  const needle = String(county).toLowerCase().replace(/\b(county|parish|borough)\b/g, '').trim()
  return needle.length > 0 && plan.queries.some((q) => String(q).toLowerCase().includes(needle))
}

function thesisSummary(thesis) {
  const loc = thesis?.location || {}
  return {
    applicant_types: Array.isArray(thesis?.applicant_types) ? thesis.applicant_types : [],
    needs: Array.isArray(thesis?.needs) ? thesis.needs.slice(0, 20) : [],
    needs_defaulted: thesis?.needs_defaulted === true,
    is_student: Boolean(thesis?.is_student),
    is_org: thesis?.is_org === true,
    schools: Array.isArray(thesis?.schools) ? thesis.schools.slice(0, 5) : [],
    location: { city: loc.city ?? null, county: loc.county ?? null, state: loc.state ?? null, zip: loc.zip ?? null },
    keywords: Array.isArray(thesis?.keywords) ? thesis.keywords.slice(0, 12) : [],
    interest_terms: Array.isArray(thesis?.interest_terms) ? thesis.interest_terms.slice(0, 8) : [],
  }
}

/** Build the thesis + query plan for one scenario through the production chain. */
export async function buildOfflineThesis(db, scenario, { runId, startedAt }) {
  const { profileId } = await createAmyProfile(db, scenario, {
    runId,
    ttlHours: 48,
    now: startedAt ? new Date(startedAt) : new Date(),
    metadataExtra: scenario.probe_cell ? { probe_cell: scenario.probe_cell, probe_cell_key: scenario.probe_cell_key } : null,
  })
  const ctx = await loadProfileContext(db, profileId, { enrichWebsitePurpose: false })
  const thesis = buildThesis(profileContextToThesisInput(ctx))
  const plan = buildWebQueryPlan(thesis, { max: WEB_LANE_MAX_QUERIES_DEFAULT, seed: PLAN_SEED })
  return { profileId, thesis, plan }
}

function provenanceSummary(searchEvidence) {
  const prov = Array.isArray(searchEvidence?.provenance) ? searchEvidence.provenance : []
  return {
    status: searchEvidence?.status ?? UNKNOWN_NOT_PERSISTED,
    queries_with_provenance: prov.length,
    provenance_truncated: searchEvidence?.provenance_truncated === true,
    by_provider: tally(prov, (p) => p.provider),
    by_status: tally(prov, (p) => p.status),
    by_provenance: tally(prov, (p) => p.provenance),
    result_count_total: prov.reduce((n, p) => n + (Number.isInteger(p?.result_count) ? p.result_count : 0), 0),
    entries: prov.slice(0, MAX_EXECUTED_PROVENANCE).map((p) => ({
      query_index: p.query_index ?? null,
      // The run persisted no query TEXT — only its index + provider + status.
      query: UNKNOWN_NOT_PERSISTED,
      provider: p.provider ?? null,
      provenance: p.provenance ?? null,
      status: p.status ?? null,
      result_count: Number.isInteger(p?.result_count) ? p.result_count : null,
    })),
  }
}

/** What the PRODUCTION run persisted about this member, and nothing more. */
function persistedForMember({ report, coverage, cohort, memberId, scenario }) {
  const receipt = report?.flywheel_cohort?.receipt || null
  const member = (receipt?.members || []).find((m) => m.member_id === memberId) || null
  const findings = (report?.amy?.handoff?.findings || []).filter((f) => f?.evidence?.scenario_id === memberId)
  const searchEvidence = findings.map((f) => f?.evidence?.search_evidence).find(Boolean) || null
  const queue = Array.isArray(report?.approval_queue) ? report.approval_queue : []
  const items = queue.filter((it) => it?.category === scenario.category
    || (it?.category === PROBE_ITEM_CATEGORY && isProbeCategory(scenario.category)))
  const day = report?.flywheel_cohort?.day || null
  const dayKey = day?.day || null
  const storeDay = dayKey && cohort?.days?.[dayKey] ? cohort.days[dayKey] : null
  const storeReceipt = (storeDay?.run_receipts || []).find((r) => r.run_id === report?.run_id) || null
  const storeMember = (storeReceipt?.members || []).find((m) => m.member_id === memberId) || null
  const cellEntry = scenario.probe_cell ? (coverage?.cells?.[cellKey(scenario.probe_cell)] || null) : null
  const baseline = member?.baseline && typeof member.baseline === 'object' ? member.baseline : null

  return {
    receipt_member: member ? {
      profile_id: member.profile_id ?? null,
      outcome: member.outcome ?? null,
      class: member.class ?? UNKNOWN_NOT_PERSISTED,
      status: member.status ?? null,
      oracle_status: member.oracle_status ?? null,
      finding_types: Array.isArray(member.finding_types) ? member.finding_types : [],
      provider_health: member.provider_health ?? UNKNOWN_NOT_PERSISTED,
    } : null,
    flywheel_store_member: storeMember ? { outcome: storeMember.outcome ?? null, status: storeMember.status ?? null, agrees_with_report: storeMember.outcome === member?.outcome } : null,
    findings: findings.map((f) => ({
      type: f.type,
      severity: f.severity ?? null,
      actionability: f.actionability ?? null,
      file: f.file ?? null,
      message: f.message ?? null,
      county: f?.evidence?.county ?? null,
      results: f?.evidence?.results ?? null,
      attribution_status: f?.attribution?.status ?? null,
    })),
    search_evidence: searchEvidence ? provenanceSummary(searchEvidence) : { status: UNKNOWN_NOT_PERSISTED },
    approval_items: items.map((it) => ({
      id: it.id,
      lever: it.lever ?? null,
      actionability: it.actionability ?? null,
      attribution_status: it?.attribution?.status ?? null,
      subjects: Array.isArray(it?.evidence?.subjects) ? it.evidence.subjects.slice(0, 10) : [],
      nights_open: it.nights_open ?? null,
    })),
    probe_coverage_cell: cellEntry ? { last_status: cellEntry.last_status ?? null, probes: cellEntry.probes ?? null, gaps: cellEntry.gaps ?? null, last_at: cellEntry.last_at ?? null } : (scenario.probe_cell ? null : 'not_a_probe'),
    // Everything below did not exist on the persisted member before receipt
    // version 2. When a newer report carries member.baseline it is quoted.
    executed_queries: baseline?.executed_queries ?? UNKNOWN_NOT_PERSISTED,
    provider_health: baseline?.provider_health ?? {
      search: searchEvidence?.status ?? UNKNOWN_NOT_PERSISTED,
      llm: UNKNOWN_NOT_PERSISTED,
    },
    extracted_candidates: baseline?.extracted_candidates ?? UNKNOWN_NOT_PERSISTED,
    canonical_candidates: baseline?.canonical_candidates ?? UNKNOWN_NOT_PERSISTED,
    qualification_decisions: baseline?.qualification_decisions ?? UNKNOWN_NOT_PERSISTED,
    admission_decisions: baseline?.admission_decisions ?? UNKNOWN_NOT_PERSISTED,
    final_class: baseline?.final_class ?? member?.class ?? UNKNOWN_NOT_PERSISTED,
  }
}

function webLaneHealthContext(webLaneHealth, memberProfileIds) {
  if (!webLaneHealth || typeof webLaneHealth !== 'object') return null
  const recent = Array.isArray(webLaneHealth.recent) ? webLaneHealth.recent : []
  const ids = new Set(memberProfileIds.filter(Boolean))
  const matching = recent.filter((r) => ids.has(r?.profile_id))
  return {
    updated_at: webLaneHealth.updated_at ?? null,
    recent_entries: recent.length,
    recent_matching_this_run: matching.length,
    recent_extracted_zero: recent.filter((r) => Number(r?.extracted) === 0 && Number(r?.fetched) > 0).length,
    recent_window: recent.length ? { from: recent[0]?.at ?? null, to: recent[recent.length - 1]?.at ?? null } : null,
    note: 'web_lane_health.recent is a 30-entry ring keyed by profile id; it is context about the lane around the run, not per-member evidence unless recent_matching_this_run > 0.',
  }
}

/**
 * Rebuild the planned cohort of `report` and lay each member's offline thesis
 * + query plan beside what production persisted for it.
 */
export async function rebuildCohortBaseline({ report, coverage = null, cohort = null, webLaneHealth = null, db = null } = {}) {
  if (!report?.run_id) throw new Error('report.run_id is required')
  const runId = report.run_id
  const startedAt = report.started_at || null
  const memberIds = Array.isArray(report?.cohort_request?.member_ids) ? report.cohort_request.member_ids : []
  const probes = report?.gap_probes || {}
  const cells = Array.isArray(probes.cells) ? probes.cells : []
  const catalogBuilt = Number.isInteger(probes.catalog_built) ? probes.catalog_built : Math.max(0, memberIds.length - cells.length)
  const categoryWeights = report?.fleet_gap_learning?.category_weights ?? null
  // A run planned before amy-cohort-2 shipped used the fixed floor (offset 0);
  // a newer report names its rotation.
  const catalogRotation = Number.isInteger(probes.catalog_rotation) ? probes.catalog_rotation : 0

  const catalogScenarios = catalogBuilt > 0
    ? generateScenarios({ runId, targetCount: catalogBuilt, categoryWeights, catalogRotation })
    : []
  const probeScenarios = buildIntersectionScenarios(cells, { runId })
  const scenarios = [...catalogScenarios, ...probeScenarios]

  const expectedCatalogIds = memberIds.slice(0, catalogBuilt)
  const rebuiltCatalogIds = catalogScenarios.map((s) => s.scenario_id)
  const catalogMatch = rebuiltCatalogIds.filter((id, i) => id === expectedCatalogIds[i]).length
  const expectedProbeIds = memberIds.slice(catalogBuilt)
  const rebuiltProbeIds = probeScenarios.map((s) => s.scenario_id)
  const probeIdMatch = rebuiltProbeIds.filter((id, i) => id === expectedProbeIds[i]).length
  const probeCellMatch = probeScenarios.filter((s, i) => cells[i] && cellKey(s.probe_cell) === cellKey(cells[i])).length

  // Secondary check: re-planning from the coverage ledger as it is NOW. The
  // stored ledger already contains this run's fold, so a mismatch here is
  // expected and is reported, never used to "correct" the plan.
  let replan = null
  if (coverage && cells.length > 0) {
    try {
      const planned = planGapSeekingProbes({ ledger: coverage, count: cells.length, runId, now: startedAt ? new Date(startedAt) : new Date() })
      const want = new Set(cells.map(cellKey))
      const got = planned.cells.map(cellKey)
      replan = {
        attempted: true,
        cells_planned: got.length,
        cells_matching_report: got.filter((k) => want.has(k)).length,
        ledger_includes_this_run: Array.isArray(coverage.runs) && coverage.runs.includes(runId),
        note: 'The ledger snapshot post-dates the run (its own fold is inside it), so the planner cannot be expected to reproduce the cells; report.gap_probes.cells is the authoritative plan.',
      }
    } catch (err) {
      replan = { attempted: true, error: String(err?.message || err) }
    }
  }

  const ownDb = !db
  const database = db || createOfflineDb()
  const members = []
  try {
    for (const scenario of scenarios) {
      const memberId = scenario.scenario_id
      let offline
      let thesisError = null
      try {
        offline = await buildOfflineThesis(database, scenario, { runId, startedAt })
      } catch (err) {
        thesisError = String(err?.message || err)
      }
      const plan = offline?.plan || null
      members.push({
        member_id: memberId,
        planned_index: memberIds.indexOf(memberId),
        in_persisted_plan: memberIds.includes(memberId),
        scenario: {
          scenario_id: memberId,
          category: scenario.category,
          label: scenario.label,
          primary_type: scenario.primary_type ?? null,
          kind: scenario.kind ?? null,
          probe_cell: scenario.probe_cell ?? null,
          probe_cell_key: scenario.probe_cell_key ?? null,
          expected: scenario.expected ?? null,
        },
        thesis: offline ? thesisSummary(offline.thesis) : { error: thesisError },
        generated_queries: plan
          ? {
              source: 'buildWebQueryPlan',
              plan_seed: PLAN_SEED,
              plan_seed_note: 'production seeds the rotating EXTRA queries from Date.now(); CORE/ANCHOR tiers are exact, breadth rotation is not the night\'s set',
              max: WEB_LANE_MAX_QUERIES_DEFAULT,
              planned_total: plan.planned_total,
              emitted: plan.queries.length,
              shortfall: plan.shortfall,
              entries: plan.entries.map((e) => ({ query: e.query, tier: e.tier ?? 'UNKNOWN', family: e.family ?? null, need: e.need ?? null, gap_class: e.gap_class ?? null })),
              dropped_by_budget: plan.dropped_by_budget.length,
              by_tier: tally(plan.entries, (e) => e.tier ?? 'UNKNOWN'),
              names_county: namesCounty(plan, offline?.thesis?.location?.county ?? scenario.expected?.county ?? null),
            }
          : { error: thesisError },
        persisted: persistedForMember({ report, coverage, cohort, memberId, scenario }),
      })
    }
  } finally {
    if (ownDb) database.close()
  }

  const exactCount = members.filter((m) => m.in_persisted_plan
    && (m.scenario.probe_cell ? probeScenarios.findIndex((s) => s.scenario_id === m.member_id) >= 0 : true)).length
  const catalogExact = catalogMatch === expectedCatalogIds.length && rebuiltCatalogIds.length === expectedCatalogIds.length
  const probesExact = probeCellMatch === cells.length && probeIdMatch === expectedProbeIds.length
  const receiptMembers = report?.flywheel_cohort?.receipt?.members || []

  return {
    generated_at: new Date().toISOString(),
    run_id: runId,
    started_at: startedAt,
    completed_at: report.completed_at ?? null,
    reconstruction: {
      planned_members: memberIds.length,
      rebuilt_members: scenarios.length,
      exact: catalogExact && probesExact && scenarios.length === memberIds.length,
      exact_count: catalogExact && probesExact ? Math.min(scenarios.length, memberIds.length) : catalogMatch + Math.min(probeIdMatch, probeCellMatch),
      catalog: {
        built: catalogBuilt,
        rotation_used: catalogRotation,
        rotation_source: Number.isInteger(probes.catalog_rotation) ? 'report.gap_probes.catalog_rotation' : 'legacy_fixed_floor_assumed',
        category_weights_present: Boolean(categoryWeights),
        expected_ids: expectedCatalogIds,
        rebuilt_ids: rebuiltCatalogIds,
        ids_matching_in_order: catalogMatch,
        rebuilt_categories: catalogScenarios.map((s) => s.category),
      },
      probes: {
        expected: cells.length,
        rebuilt: probeScenarios.length,
        cells_matching_report: probeCellMatch,
        ids_matching_in_order: probeIdMatch,
        replan,
      },
      exact_count_note: 'exact_count counts members whose scenario id AND (for probes) cell match report.cohort_request.member_ids / report.gap_probes.cells; the run id seeds every catalog location pick and probe tie-break, so a match here is the same scenario production built.',
    },
    persisted_run_summary: {
      receipt_version: report?.flywheel_cohort?.receipt?.receipt_version ?? null,
      outcomes: report?.flywheel_cohort?.receipt?.outcomes ?? null,
      finding_types: report?.flywheel_cohort?.receipt?.finding_types ?? null,
      exception_classes: report?.flywheel_cohort?.receipt?.exception_classes ?? null,
      metric_envelope: report?.metric_envelope ?? report?.flywheel_cohort?.receipt?.metric_envelope ?? UNKNOWN_NOT_PERSISTED,
      summary: report?.amy?.summary ?? null,
      adopted_orphans: {
        adopted: Array.isArray(report?.adopted_orphans?.adopted) ? report.adopted_orphans.adopted.length : 0,
        counted_in_summary_scenarios: Number(report?.amy?.summary?.scenarios) > memberIds.length,
      },
      approval_queue_size: Array.isArray(report?.approval_queue) ? report.approval_queue.length : 0,
      approval_queue_by_actionability: tally(Array.isArray(report?.approval_queue) ? report.approval_queue : [], (it) => it.actionability),
      probe_coverage: report?.probe_coverage ?? null,
    },
    members,
    summary: {
      by_persisted_outcome: tally(members, (m) => m.persisted.receipt_member?.outcome),
      by_persisted_status: tally(members, (m) => m.persisted.receipt_member?.status),
      by_search_evidence_status: tally(members, (m) => m.persisted.search_evidence?.status),
      members_with_findings: members.filter((m) => m.persisted.findings.length > 0).length,
      finding_types: tally(members.flatMap((m) => m.persisted.findings), (f) => f.type),
      queries_naming_county: members.filter((m) => m.generated_queries?.names_county === true).length,
      members_with_county: members.filter((m) => m.scenario.expected?.county).length,
      thesis_errors: members.filter((m) => m.thesis?.error).length,
      receipt_members_without_baseline: receiptMembers.filter((m) => !m.baseline).length,
      unknown_not_persisted_fields: ['executed_queries (query text)', 'provider_health.llm', 'extracted_candidates', 'canonical_candidates', 'qualification_decisions', 'admission_decisions', 'final_class (receipt_version 1)'],
    },
    web_lane_health_context: webLaneHealthContext(webLaneHealth, receiptMembers.map((m) => m.profile_id)),
    limitations: [
      'Theses are rebuilt offline through the production chain against an in-memory SQLite; no live DB or network was touched.',
      'Query plans are built with seed 0. Production rotates the EXTRA queries with Date.now(); CORE/ANCHOR tiers reproduce exactly.',
      'Learned archetype gaps (attachLearnedGaps) and gap-seed pages were not applied: they are read from the live store at crawl time and were not persisted per member.',
      `Every field the run did not persist is the literal ${UNKNOWN_NOT_PERSISTED}; nothing here infers what a stage produced.`,
    ],
  }
}

async function main() {
  let args
  try {
    args = parseArgs()
  } catch (err) {
    console.error(`amy-cohort-baseline: ${err.message}`)
    console.error('usage: --report <kv-amy_last_report.json> --coverage <kv-amy_probe_coverage.json> --cohort <kv-amy_flywheel_cohort.json> --out <file> [--web-lane-health <file>]')
    process.exit(1)
  }
  const report = readJson(args.report)
  const coverage = readJson(args.coverage)
  const cohort = readJson(args.cohort)
  const webLaneHealth = args['web-lane-health'] ? readJson(args['web-lane-health']) : null
  const result = await rebuildCohortBaseline({ report, coverage, cohort, webLaneHealth })
  result.inputs = {
    report: path.resolve(args.report),
    coverage: path.resolve(args.coverage),
    cohort: path.resolve(args.cohort),
    web_lane_health: args['web-lane-health'] ? path.resolve(args['web-lane-health']) : null,
  }
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
  fs.writeFileSync(args.out, JSON.stringify(result, null, 2))
  const r = result.reconstruction
  console.log(`amy-cohort-baseline ${result.run_id}: reconstructed ${r.exact_count}/${r.planned_members} planned members exactly (catalog ${r.catalog.ids_matching_in_order}/${r.catalog.expected_ids.length}, probes ${r.probes.cells_matching_report}/${r.probes.expected}); wrote ${path.resolve(args.out)}`)
  process.exit(r.exact ? 0 : 2)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`amy-cohort-baseline failed: ${err?.stack || err}`)
    process.exit(1)
  })
}
