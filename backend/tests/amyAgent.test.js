import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runAmyTraining } from '../services/amy/amyAgent.js'
import os from 'node:os'
import fsp from 'node:fs/promises'
import nodePath from 'node:path'
import {
  createAmyProfile,
  cleanupAmyProfiles,
  cleanupExpiredAmyProfiles,
  listAmyProfiles,
  markProfileCrawled,
  markProfilesTaught,
  hasRequiredTeachingReceipt,
  REQUIRED_TEACHING_AGENTS,
} from '../services/amy/amyProfileStore.js'
import { buildAmyMetadata } from '../services/amy/amyMetadata.js'
import { DESIGNATED_PROFILES } from '../config/designatedProfiles.js'
import { cohortMetricsAtFloor, sweepFloors } from '../services/amy/crawlerMetrics.js'
import { decideFloorChange, decideWeightChange, proposeCoverageOverrides, buildApprovalQueue } from '../services/amy/crawlerTuner.js'
import { readCurrentMinScore, applyMinScore, restoreFromBackup, readCurrentWeights, applyWeights, normalizeWeights } from '../services/amy/matchThresholdEditor.js'
import { allSources } from '../crawler-os/sourceRegistry.js'
import { setCoverageOverrides, getCoverageOverrides } from '../crawler-os/coverageOverrides.js'
import { runAmyAnyaSamPipeline } from '../services/amy/amyPipeline.js'
import { saveAmyReport, readLatestAmyReport, readAmyHistory } from '../services/amy/amyReportStore.js'
import { generateScenarios, planVariantCounts, CATEGORY_IDS } from '../services/amy/syntheticProfileCatalog.js'
import { evaluateDiscovery, buildAnyaHandoff } from '../services/amy/amyReport.js'
import { ORIGIN_CREATED_BY, METADATA_SECTION_KEY } from '../services/amy/amyConstants.js'
import { startAmyScheduler, stopAmyScheduler, getAmyConfig } from '../services/amy/amyScheduler.js'
import { ACCEPT_SCORE, DISCOVERY_MIN_SCORE_FLOOR, REVIEW_SCORE } from '../config/matchThresholds.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT,
      status TEXT DEFAULT 'active',
      tags TEXT DEFAULT '[]',
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_by TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(profile_id, section_key)
    );
  `)
  return db
}

// Offline fake of runProfileDiscoveryLive — cycles ok/weak/zero/source-fail
// outcomes so the evaluator + report are exercised without the network.
function makeFakeDiscovery(db) {
  let i = 0
  return async ({ profileId }) => {
    const row = db.prepare('SELECT primary_type FROM profiles WHERE id = ?').get(profileId)
    const thesis = {
      applicant_types: [row?.primary_type || 'x'],
      needs: ['funding'],
      location: { state: 'TN', zip: '37203' },
      min_match_score: 75,
    }
    i += 1
    const mod = i % 4
    if (mod === 1) {
      return {
        run: {
          run_id: `fake-${i}`,
          stored: 3,
          rejected: 0,
          sources: [{ source_id: 'grants_gov', outcome: 'OK', fetched: 10, parsed: 8, stored: 3, rejected: 0 }],
          recommendations: [
            { title: 'A', match_score: 88, decision: 'ACCEPT' },
            { title: 'B', match_score: 80, decision: 'ACCEPT' },
          ],
          zero_result: null,
        },
        persisted: { opportunities: 3, matches: 3, dry_run: true },
        thesis,
      }
    }
    if (mod === 2) {
      return {
        run: {
          run_id: `fake-${i}`,
          stored: 2,
          sources: [{ source_id: 'sam_gov', outcome: 'OK', fetched: 5, parsed: 2, stored: 2 }],
          recommendations: [{ title: 'C', match_score: 55, decision: 'REVIEW' }],
          zero_result: null,
        },
        persisted: { opportunities: 2, dry_run: true },
        thesis,
      }
    }
    if (mod === 3) {
      return {
        run: {
          run_id: `fake-${i}`,
          stored: 0,
          sources: [{ source_id: 'state_portal', outcome: 'EMPTY', fetched: 0 }],
          recommendations: [],
          zero_result: { zero_result_reason: 'no_sources_matched', missing_profile_fields: ['narrative.primary_goal'] },
        },
        persisted: { opportunities: 0, dry_run: true },
        thesis,
      }
    }
    return {
      run: {
        run_id: `fake-${i}`,
        stored: 1,
        sources: [{ source_id: 'flaky', outcome: 'ERROR', reason: 'timeout 504', fetched: 0 }],
        recommendations: [{ title: 'D', match_score: 40, decision: 'REVIEW' }],
        zero_result: null,
      },
      persisted: { opportunities: 1, dry_run: true },
      thesis,
    }
  }
}

describe('Amy synthetic profile catalog', () => {
  it('distributes an exact daily target (100) across categories', () => {
    const counts = planVariantCounts({ targetCount: 100 })
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    expect(total).toBe(100)
    // Round-robin: every count differs by at most 1 (evenly spread).
    const vals = Object.values(counts)
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1)

    const scenarios = generateScenarios({ runId: 'amy-100', targetCount: 100 })
    expect(scenarios.length).toBe(100)
    // Scenario ids are unique.
    expect(new Set(scenarios.map((s) => s.scenario_id)).size).toBe(100)
  })

  it('generates scenarios for every category with no real PII', () => {
    const scenarios = generateScenarios({ runId: 'amy-test', perCategory: 1 })
    expect(scenarios.length).toBe(CATEGORY_IDS.length)
    for (const s of scenarios) {
      expect(s.scenario_id).toBeTruthy()
      expect(s.display_name).toMatch(/^Amy Synthetic — /)
      // Synthetic-only contact data: emails use the reserved .invalid TLD.
      expect(s.sections.basic_information.email).toMatch(/@synthetic\.grantflow\.invalid$/)
      expect(s.sections.basic_information.state).toMatch(/^[A-Z]{2}$/)
      expect(s.sections.basic_information.profile_category).toBeTruthy()
    }
  })
})

describe('amount_recall_miss counts only amounts that were KNOWABLE', () => {
  const scenario = { scenario_id: 'senior-v1', category: 'senior', label: 'Senior', expected: { state: 'TN' } }
  const run = (recommendations) =>
    evaluateDiscovery(scenario, 'p-amt', {
      run: { run_id: 'r', stored: recommendations.length, sources: [], recommendations },
      persisted: { opportunities: recommendations.length },
      thesis: { applicant_types: ['individual'], needs: ['food'], location: { state: 'TN' } },
    })
  const fired = (ev) => ev.findings.some((f) => f.type === 'amount_recall_miss')
  const rec = (i, extra) => ({
    title: `Program ${i}`, sponsor: 'Agency', match_score: 40, decision: 'REVIEW', kind: 'PROGRAM', ...extra,
  })

  it('does NOT fire when every funder was READ and publishes no per-award figure', () => {
    // THE 28-OF-50 CASE (prod 2026-07-16). Amy's cohort reported
    // amount_recall_miss ×28 against profiles matched to benefit programs, food
    // banks and SSI — funders that genuinely publish no per-award amount. Amy
    // could not know that: the sweep READ those pages, learned the answer, and
    // threw it away (only a status that was NOT 'not_listed' was ever persisted,
    // and 'not_listed' is exactly what a read-with-no-figure returns).
    //
    // So the finding was unfalsifiable: the cohort could never come back clean,
    // and the owner's standing "50/50 clean → notify me once" goal was
    // unreachable BY CONSTRUCTION, not by crawler quality.
    const ev = run(Array.from({ length: 8 }, (_, i) => rec(i, { amount_status: 'none_published' })))
    expect(fired(ev), 'a funder that publishes nothing is not a recall miss').toBe(false)
  })

  it('STILL fires when the amount was knowable and we missed it', () => {
    // The finding must keep its teeth. 'not_listed' is SILENCE — nobody looked,
    // or the answer was never written down — and that is exactly where a real
    // extraction gap hides. Do not let it into the unknowable set.
    const ev = run(Array.from({ length: 8 }, (_, i) => rec(i, { amount_status: 'not_listed' })))
    expect(fired(ev), 'silence is not a denial — a real miss must still fire').toBe(true)
  })

  it('fires on a MIXED cohort where the readable rows all missed', () => {
    // 5 knowable misses + 3 honest denials: the denials are excluded, the 5
    // remain measurable, and the finding fires on them.
    const ev = run([
      ...Array.from({ length: 5 }, (_, i) => rec(i, { amount_status: 'not_listed' })),
      ...Array.from({ length: 3 }, (_, i) => rec(i + 5, { amount_status: 'none_published' })),
    ])
    expect(fired(ev)).toBe(true)
  })

  it('does NOT fire on BENEFIT-kind results (their stated amount semantic is "varies by applicant")', () => {
    // The 2026-07-21 cohort's amount_recall_miss ×22 was dominated by profiles
    // whose recommendations were federal/state BENEFIT programs (SSI, Pell,
    // LIHEAP — the ssa.gov/studentaid.gov class the locator classifier now
    // stamps kind='benefit'). A benefit program has no fixed per-award figure
    // BY DESIGN — the same doctrine that already excludes DIRECTORY locators —
    // so a benefit rec without a dollar amount measures the program's design,
    // not our extraction.
    const ev = run(Array.from({ length: 8 }, (_, i) => rec(i, { kind: 'benefit' })))
    expect(fired(ev), 'a benefit program without a figure is not a recall miss').toBe(false)
  })

  it('STILL fires when non-benefit rows missed alongside benefit rows', () => {
    // Benefit rows leave the denominator; the 5 silent PROGRAM rows remain
    // measurable and keep the finding's teeth.
    const ev = run([
      ...Array.from({ length: 5 }, (_, i) => rec(i, { amount_status: 'not_listed' })),
      ...Array.from({ length: 3 }, (_, i) => rec(i + 5, { kind: 'BENEFIT' })),
    ])
    expect(fired(ev)).toBe(true)
  })

  it('the finding NAMES the measurable candidates under the canonical `subjects` key (never a count)', () => {
    // PROD DEFECT (amy_approval_queue, run amy-2026-08-03T09-20): the code
    // brief for amount_recall_miss:high_school_student read
    // "Concrete subject(s): 8." — the registry's evidence_key pointed at
    // `grant_shaped`, a NUMBER, so collectEvidenceSubjects turned the count
    // into the only "subject" and no candidate was ever named. Same canonical
    // key defect as the institution_recall_miss `missed_subjects` incident:
    // the brief's consumer reads `evidence.subjects` and nothing else.
    const ev = run([
      rec(0, { title: 'New Mexico Lottery Scholarship', amount_status: 'not_listed' }),
      rec(1, { title: 'TheDream.US Scholarship', amount_status: 'not_listed' }),
      rec(2, { title: 'UAlbany Alumni Association Scholarships', amount_status: 'not_listed' }),
      rec(3, { title: 'Legislative Lottery Scholarship', amount_status: 'not_listed' }),
      rec(4, { title: 'Opportunity Scholarship', amount_status: 'not_listed' }),
      // An unknowable row must NOT be named — it is not a miss.
      rec(5, { title: 'NM Opportunity Scholarship (tuition varies)', amount_status: 'varies' }),
    ])
    const finding = ev.findings.find((f) => f.type === 'amount_recall_miss')
    expect(finding).toBeTruthy()
    expect(finding.evidence.subjects).toContain('New Mexico Lottery Scholarship')
    expect(finding.evidence.subjects).toContain('UAlbany Alumni Association Scholarships')
    expect(finding.evidence.subjects).not.toContain('NM Opportunity Scholarship (tuition varies)')
    expect(finding.evidence.subjects.every((s) => typeof s === 'string' && /[a-z]/i.test(s))).toBe(true)
  })
})

describe('Amy evaluation + Anya handoff', () => {
  it('flags zero-result and builds an Anya-compatible report', () => {
    const scenario = { scenario_id: 'veteran-v1', category: 'veteran', label: 'Veteran', expected: { state: 'TN', needs: ['veteran housing'] } }
    const ev = evaluateDiscovery(scenario, 'p1', {
      run: { run_id: 'r', stored: 0, sources: [], recommendations: [], zero_result: { zero_result_reason: 'no_sources_matched', missing_profile_fields: [] } },
      persisted: { opportunities: 0 },
      thesis: { applicant_types: ['veteran'], needs: ['housing'], location: { state: 'TN' } },
    })
    expect(ev.status).toBe('zero')
    expect(ev.findings.some((f) => f.type === 'zero_result')).toBe(true)

    const report = buildAnyaHandoff({ runId: 'amy-test', evaluations: [ev], meta: { dryRun: true } })
    expect(report.handoff_from).toBe('amy')
    expect(Array.isArray(report.findings)).toBe(true)
    expect(report.findings_total).toBe(report.findings.length)
    expect(report.search_kind_breakdown.amy_synthetic_training).toBe(report.findings.length)
    // Every finding points at a real repo file target for Anya.
    for (const f of report.findings) {
      expect(typeof f.file).toBe('string')
      expect(f.file.length).toBeGreaterThan(0)
      expect(f.search_kind).toBe('amy_synthetic_training')
    }
    expect(report.amy_summary.scenarios_total).toBe(1)
  })

  it('flags an INELIGIBLE_MATCH when a non-student profile ACCEPTS enrolled-student aid', () => {
    const scenario = { scenario_id: 'senior-v1', category: 'individual', label: 'Senior Individual', expected: { state: 'TN', needs: ['medical'] } }
    const ev = evaluateDiscovery(scenario, 'p-senior', {
      run: {
        run_id: 'r', stored: 3, sources: [],
        recommendations: [
          { title: 'Tennessee HOPE Scholarship', sponsor: 'TSAC', match_score: 81, decision: 'ACCEPT' },
          { title: 'Cleveland Emergency Food Assistance', sponsor: 'Food Bank', match_score: 82, decision: 'ACCEPT' },
        ],
      },
      persisted: { opportunities: 3 },
      // Non-student individual: is_student false, no student-aid need.
      thesis: { applicant_types: ['individual'], needs: ['medical', 'food'], is_student: false, location: { state: 'TN' } },
    })
    expect(ev.ineligible_accepts).toBe(1)
    expect(ev.findings.some((f) => f.type === 'ineligible_match')).toBe(true)
    const f = ev.findings.find((x) => x.type === 'ineligible_match')
    expect(f.file).toBe('backend/services/matchEngine.js')
    expect(f.evidence.ineligible_titles).toContain('Tennessee HOPE Scholarship')
  })

  it('does NOT flag INELIGIBLE_MATCH for a real student accepting student aid', () => {
    const scenario = { scenario_id: 'student-v1', category: 'student', label: 'College Student', expected: { state: 'TN' } }
    const ev = evaluateDiscovery(scenario, 'p-student', {
      run: { run_id: 'r', stored: 2, sources: [], recommendations: [{ title: 'Tennessee HOPE Scholarship', sponsor: 'TSAC', match_score: 84, decision: 'ACCEPT' }] },
      persisted: { opportunities: 2 },
      thesis: { applicant_types: ['student'], needs: ['scholarship'], is_student: true, location: { state: 'TN' } },
    })
    expect(ev.ineligible_accepts).toBe(0)
    expect(ev.findings.some((f) => f.type === 'ineligible_match')).toBe(false)
  })
})

describe('Amy profile store cleanup safety', () => {
  it('never deletes non-Amy profiles, deletes Amy profiles', async () => {
    const db = createDb()
    try {
      // A real (non-Amy) profile that must survive cleanup.
      db.prepare(
        `INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by, created_at, updated_at)
         VALUES ('real-1', 'Real Org', 'nonprofit', 'active', '[]', 'real-user', '2026-01-01', '2026-01-01')`,
      ).run()
      db.prepare(
        `INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('real-1', 'basic_information', '{}')`,
      ).run()

      // An Amy synthetic profile.
      const { profileId } = await createAmyProfile(db, generateScenarios({ runId: 'amy-test' })[0], { runId: 'amy-test', ttlHours: 48 })

      const result = await cleanupAmyProfiles(db, { force: true })
      expect(result.deleted).toBe(1)
      expect(result.ids).toContain(profileId)

      const realStill = db.prepare(`SELECT id FROM profiles WHERE id = 'real-1'`).get()
      expect(realStill).toBeTruthy()
      const amyGone = db.prepare(`SELECT id FROM profiles WHERE id = ?`).get(profileId)
      expect(amyGone).toBeUndefined()
    } finally {
      db.close()
    }
  })
})

describe('Amy training run (end-to-end, offline discovery)', () => {
  const categories = CATEGORY_IDS.slice(0, 8)

  it('generates, evaluates, reports, and cleans up by default', async () => {
    const db = createDb()
    const artifacts = {}
    const writeArtifact = async (name, json) => {
      artifacts[name] = json
      return `audit-reports/${name}`
    }
    try {
      const out = await runAmyTraining({
        db,
        categories,
        perCategory: 1,
        dryRunDiscovery: true,
        runDiscovery: makeFakeDiscovery(db),
        writeArtifact,
        clock: () => new Date('2026-06-28T12:00:00Z'),
      })

      expect(out.summary.scenarios).toBe(categories.length)
      // Across the cycling fake we should see a mix of outcomes.
      expect(out.summary.ok + out.summary.weak + out.summary.zero).toBe(categories.length)
      expect(out.summary.total_findings).toBeGreaterThan(0)
      expect(out.report.handoff_from).toBe('amy')
      expect(out.artifacts.handoffPath).toBe(`audit-reports/amy-to-anya-handoff-${out.run_id}.json`)
      expect(Object.keys(artifacts).length).toBe(2)
      expect(out.combined.agent_mesh.teaching_complete).toBe(true)
      expect(out.combined.agent_mesh.notified.map((m) => m.to)).toEqual(expect.arrayContaining(['sam', 'anya', 'robert']))
      expect(out.combined.agent_mesh.taught_profiles).toBe(out.crawled_profile_ids.length)

      // Default cleanup removed all synthetic profiles.
      expect(out.cleanup.deleted).toBe(out.created_profile_ids.length)
      const remaining = await listAmyProfiles(db)
      expect(remaining.length).toBe(0)
    } finally {
      db.close()
    }
  })

  it('the PERSISTED admin report carries the flywheel cohort result (recorded before save)', async () => {
    const db = createDb()
    try {
      const out = await runAmyTraining({
        db,
        categories,
        perCategory: 1,
        // Live (non-dry-run) discovery is the flywheel-recording path; the
        // injected fake keeps it offline.
        dryRunDiscovery: false,
        runDiscovery: makeFakeDiscovery(db),
        clock: () => new Date('2026-06-28T12:00:00Z'),
      })

      // The in-memory report has the flywheel record and no swallowed failure.
      expect(out.combined.flywheel_cohort?.ok).toBe(true)
      expect(out.combined.flywheel_record_error).toBeUndefined()
      expect(out.combined.report_persistence_error).toBeUndefined()

      // Regression (order-of-operations): saveAmyReport used to run BEFORE
      // flywheel_cohort was attached, so the STORED report never carried it.
      const persisted = await readLatestAmyReport(db)
      expect(persisted).toBeTruthy()
      expect(persisted.run_id).toBe(out.run_id)
      expect(persisted.flywheel_cohort?.ok).toBe(true)
      expect(persisted.cohort_request).toMatchObject({
        run_id: out.run_id,
        requested_target: categories.length,
        planned_members: categories.length,
        exact_plan: true,
      })
      const receipt = persisted.flywheel_cohort?.day?.run_receipts?.at(-1)
      expect(receipt?.run_id).toBe(out.run_id)
      expect(receipt?.evaluation_rows).toBe(categories.length)
      expect(receipt?.planned_members).toBe(categories.length)
      expect(receipt?.reconciliation?.membership_total).toBe(categories.length)
      // The offline fixture omits opportunity kinds. Those otherwise-ok rows
      // are honestly unevaluable by the bounded oracle, not counted clean.
      expect(receipt?.outcomes?.unevaluable).toBeGreaterThan(0)
      expect(receipt?.all_clean).toBe(false)
      expect(receipt?.qualification_proven).toBe(false)
    } finally {
      db.close()
    }
  })

  it('AMY_RUN_ON_STARTUP defaults FALSE (boot uses the overdue catch-up); explicit true still forces boot runs', () => {
    const prev = { ...process.env }
    try {
      delete process.env.AMY_RUN_ON_STARTUP
      // Default: no unconditional run on every deploy — the startup catch-up
      // branch (runStartupCatchUpIfOverdue) is the default boot path.
      expect(getAmyConfig().runOnStartup).toBe(false)

      process.env.AMY_RUN_ON_STARTUP = 'true'
      expect(getAmyConfig().runOnStartup).toBe(true)

      process.env.AMY_RUN_ON_STARTUP = 'false'
      expect(getAmyConfig().runOnStartup).toBe(false)
    } finally {
      process.env = prev
    }
  })

  it('scheduler is ON by default (owner directive) and targets 100/day; opt out with AMY_ENABLED=false', () => {
    const prev = { ...process.env }
    try {
      // Default (no env): enabled, scheduled runner starts, 100/day.
      delete process.env.AMY_ENABLED
      delete process.env.AMY_RUN_ON_SCHEDULE
      delete process.env.AMY_RUN_ON_STARTUP
      delete process.env.AMY_DAILY_PROFILE_TARGET
      expect(getAmyConfig().enabled).toBe(true)
      expect(getAmyConfig().dailyTarget).toBe(100)
      const onByDefault = startAmyScheduler({ db: null, logger: { info() {}, error() {} } })
      expect(onByDefault.started).toBe(true)
      expect(onByDefault.daily_target).toBe(100)
      stopAmyScheduler()

      // Explicit opt-out still works.
      process.env.AMY_ENABLED = 'false'
      expect(getAmyConfig().enabled).toBe(false)
      expect(startAmyScheduler({ db: null }).started).toBe(false)
    } finally {
      stopAmyScheduler()
      process.env = prev
    }
  })

  it('keepProfiles leaves traceable, Sam-cleanable profiles', async () => {
    const db = createDb()
    try {
      const out = await runAmyTraining({
        db,
        categories: ['veteran', 'nonprofit'],
        perCategory: 1,
        dryRunDiscovery: true,
        keepProfiles: true,
        runDiscovery: makeFakeDiscovery(db),
        clock: () => new Date('2026-06-28T12:00:00Z'),
      })

      expect(out.kept_profiles).toBe(true)
      const kept = await listAmyProfiles(db)
      expect(kept.length).toBe(2)

      const sample = kept[0]
      expect(sample.created_by).toBe(ORIGIN_CREATED_BY)
      const tags = JSON.parse(sample.tags)
      expect(tags).toContain('synthetic')
      expect(tags).toContain('allow_sam_cleanup')

      // Authoritative metadata block present + correct.
      const metaRow = db.prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?').get(sample.id, METADATA_SECTION_KEY)
      const meta = JSON.parse(metaRow.data)
      expect(meta.synthetic).toBe(true)
      expect(meta.origin_agent).toBe('Amy')
      expect(meta.pipeline).toBe('amy_crawler_training')
      expect(meta.allow_sam_cleanup).toBe(true)
      expect(meta.created_for).toBe('crawler_training')
      expect(meta.amy_run_id).toBe(out.run_id)
      expect(meta.expires_at).toBeTruthy()
      expect(Date.parse(meta.expires_at)).toBeGreaterThan(Date.parse(meta.created_at))
    } finally {
      db.close()
    }
  })
})

// ── Crawler-improvement engine ────────────────────────────────────────────

function evalFix({ category = 'veteran', status = 'ok', scores = [], generics = [], sourcesFailed = 0 } = {}) {
  const candidates = scores.map((s, i) => ({
    score: s,
    decision: s >= ACCEPT_SCORE ? 'ACCEPT' : s >= REVIEW_SCORE ? 'REVIEW' : 'REJECT',
    title: generics[i] ? 'Resource Directory' : 'Specific Grant',
    generic: Boolean(generics[i]),
    genericOnly: Boolean(generics[i]),
    locator: false,
  }))
  const false_positives = candidates.filter(
    (c) => c.genericOnly && !c.locator && c.decision === 'ACCEPT',
  ).length
  return { scenario_id: `${category}-v1`, category, status, candidates, false_positives, sources_failed: sourcesFailed, findings: [] }
}

describe('crawlerMetrics', () => {
  it('computes coverage at a floor and finds the best floor by quality', () => {
    const evals = [
      evalFix({ scores: [80, 60] }),
      evalFix({ category: 'nonprofit', scores: [40] }),
    ]
    expect(cohortMetricsAtFloor(evals, 75).covered_rate).toBe(0.5)
    expect(cohortMetricsAtFloor(evals, 40).covered_rate).toBe(1)
    const { best } = sweepFloors(evals, { min: 35, max: 90, step: 5 })
    expect(best.quality_score).toBe(1)
    expect(best.floor).toBe(40) // tie-break favors the higher floor that still covers all
  })

  it('penalizes false positives in the quality score', () => {
    const clean = [evalFix({ scores: [80] })]
    const fp = [evalFix({ scores: [80], generics: [true] })]
    expect(cohortMetricsAtFloor(fp, 75).false_positive_rate).toBe(1)
    expect(cohortMetricsAtFloor(clean, 75).quality_score).toBeGreaterThan(cohortMetricsAtFloor(fp, 75).quality_score)
  })
})

describe('crawlerTuner', () => {
  it('proposes a bounded floor RAISE when the cohort proves it cuts false positives', () => {
    // Every profile has a real 12 match plus a generic-only 11 ACCEPT.
    // Raising the data-point floor from 8 to 12 keeps coverage and removes junk.
    const evals = Array.from({ length: 16 }, () => evalFix({ scores: [12, 11], generics: [false, true] }))
    const current = cohortMetricsAtFloor(evals, DISCOVERY_MIN_SCORE_FLOOR)
    const { best } = sweepFloors(evals)
    const decision = decideFloorChange({
      currentFloor: DISCOVERY_MIN_SCORE_FLOOR,
      best,
      currentMetrics: current,
    })
    expect(decision.change).toBe(true)
    expect(decision.to).toBe(12)
  })

  it('SAFETY: never proposes dropping the floor below the documented pipeline bar (data-point scale)', () => {
    // A cohort whose candidates all sit just below the bar would "prove" a
    // lower floor, but the display floor (DISCOVERY_MIN_SCORE_FLOOR) is a hard
    // product standard — the tuner must refuse, even when a caller passes
    // looser bounds.
    const BAR = DISCOVERY_MIN_SCORE_FLOOR
    const evals = Array.from({ length: 16 }, () => evalFix({ scores: [BAR - 3] }))
    const current = cohortMetricsAtFloor(evals, BAR)
    const { best } = sweepFloors(evals, { min: 2, max: 20, step: 1 })
    expect(best.floor).toBeLessThan(BAR) // the sweep itself would go lower…
    const decision = decideFloorChange({ currentFloor: BAR, best, currentMetrics: current })
    expect(decision.change).toBe(false) // …but the tuner clamps to >= the bar
    const loose = decideFloorChange({ currentFloor: BAR, best, currentMetrics: current, opts: { bounds: [2, 20] } })
    expect(loose.change).toBe(false)
    expect(loose.to).toBe(BAR)
  })

  it('refuses to tune on too-small a cohort', () => {
    const evals = [evalFix({ scores: [55] })]
    const decision = decideFloorChange({ currentFloor: 75, best: sweepFloors(evals).best, currentMetrics: cohortMetricsAtFloor(evals, 75) })
    expect(decision.change).toBe(false)
    expect(decision.reason).toMatch(/cohort_too_small/)
  })

  it('builds an approval queue from systematic weaknesses', () => {
    const evals = [
      evalFix({ category: 'veteran', status: 'zero', scores: [] }),
      evalFix({ category: 'tribal_org', status: 'weak', scores: [50] }),
      evalFix({ category: 'nonprofit', scores: [85], generics: [true] }),
    ]
    const queue = buildApprovalQueue(evals)
    expect(queue.some((q) => q.id === 'coverage:veteran')).toBe(true)
    expect(queue.some((q) => q.lever === 'relevance_precision')).toBe(true)
    expect(queue.some((q) => q.lever === 'scoring_weights')).toBe(true)
  })
})

describe('matchThresholdEditor (surgical, reversible)', () => {
  it('reads, applies, and reverts DEFAULT_MIN_SCORE on an isolated file', async () => {
    const tmp = nodePath.join(os.tmpdir(), `amy-mt-${Date.now()}.js`)
    await fsp.writeFile(tmp, 'export const DEFAULT_MIN_SCORE = 75\nexport const OTHER = 1\n', 'utf8')
    try {
      expect(await readCurrentMinScore(tmp)).toBe(75)
      const applied = await applyMinScore(80, { filePath: tmp })
      expect(applied.applied).toBe(true)
      expect(applied.from).toBe(75)
      expect(applied.to).toBe(80)
      expect(await readCurrentMinScore(tmp)).toBe(80)
      expect(applied.backup_path).toBeTruthy()
      await restoreFromBackup(applied.backup_path, tmp)
      expect(await readCurrentMinScore(tmp)).toBe(75)
    } finally {
      await fsp.unlink(tmp).catch(() => {})
    }
  })

  it('SAFETY: clamps any attempt to write a floor below the documented pipeline bar (data-point scale)', async () => {
    const BAR = DISCOVERY_MIN_SCORE_FLOOR
    const tmp = nodePath.join(os.tmpdir(), `amy-mt-clamp-${Date.now()}.js`)
    await fsp.writeFile(tmp, `export const DEFAULT_MIN_SCORE = ${BAR}\n`, 'utf8')
    try {
      // A sub-bar write clamps to the bar == current → refused as a no-op; the
      // file never drops.
      const refused = await applyMinScore(BAR - 5, { filePath: tmp })
      expect(refused.applied).toBe(false)
      expect(refused.reason).toBe('no_change')
      expect(await readCurrentMinScore(tmp)).toBe(BAR)

      // From a tightened floor (40), a "lower below the bar" lands AT the bar.
      await fsp.writeFile(tmp, 'export const DEFAULT_MIN_SCORE = 40\n', 'utf8')
      const clamped = await applyMinScore(BAR - 5, { filePath: tmp })
      expect(clamped.applied).toBe(true)
      expect(clamped.to).toBe(BAR)
      expect(await readCurrentMinScore(tmp)).toBe(BAR)
    } finally {
      await fsp.unlink(tmp).catch(() => {})
    }
  })
})

describe('amyPipeline (Anya + Sam, injected)', () => {
  it('analyzes flagged files and runs Sam, never throwing', async () => {
    const amyResult = { report: { findings: [{ file: 'backend/services/matchEngine.js' }, { file: 'backend/services/matchEngine.js' }, { file: 'backend/crawler-os/sourceRegistry.js' }] } }
    const fakeAnya = async () => ({ findings_found: 2, files_modified: 0, findings: [], modifications: [] })
    const fakeSam = async () => ({ run_id: 'sam-1', health_score: 90, applied_fixes: [{ ok: true, fix_id: 'lint.eslint-fix-file' }], findings: [] })
    const chain = await runAmyAnyaSamPipeline({ db: null, amyResult, options: { anyaApply: false, samApply: false }, runAnya: fakeAnya, runSam: fakeSam })
    expect(chain.anya.files_targeted.length).toBe(2)
    expect(chain.anya.reports.length).toBe(2)
    expect(chain.sam.run_id).toBe('sam-1')
    expect(chain.sam.applied_fixes.length).toBe(1)
  })
})

describe('amyReportStore', () => {
  it('persists and reads the latest report + history', async () => {
    const db = createDb()
    try {
      await saveAmyReport(db, { run_id: 'r1', completed_at: '2026-06-29T00:00:00Z', slider_floor: 75, metrics: { before: {}, after: {} }, approval_queue: [], amy: { summary: {} } })
      const latest = await readLatestAmyReport(db)
      expect(latest.run_id).toBe('r1')
      const history = await readAmyHistory(db)
      expect(history.length).toBe(1)
      expect(history[0].run_id).toBe('r1')
    } finally {
      db.close()
    }
  })
})

describe('Amy improvement loop (end-to-end, injected)', () => {
  it('measures, tunes (validated), runs chain, persists, and cleans only crawled', async () => {
    const db = createDb()
    // Every profile finds a real 12 match plus a generic-only 11 ACCEPT.
    // The cohort proves raising the live data-point floor from 8 to 12 cuts the
    // junk without losing direct-funding coverage.
    const fakeDiscovery = async ({ profileId, floor }) => {
      const t = db.prepare('SELECT primary_type FROM profiles WHERE id=?').get(profileId)
      return {
        run: {
          run_id: 'r', stored: 2,
          sources: [{ source_id: 'grants_gov', outcome: 'OK', fetched: 5, stored: 2 }],
          recommendations: [
            { title: 'Specific Grant', match_score: 12, decision: 'ACCEPT' },
            { title: 'Resource Directory', match_score: 11, decision: 'ACCEPT' },
          ],
          zero_result: null,
        },
        persisted: { opportunities: 2 },
        thesis: { applicant_types: [t?.primary_type || 'x'], needs: ['funding'], location: { state: 'TN' }, min_match_score: floor },
      }
    }
    const editorState = { value: DISCOVERY_MIN_SCORE_FLOOR }
    const fakeEditor = {
      read: async () => editorState.value,
      apply: async (to) => { const from = editorState.value; editorState.value = to; return { applied: true, from, to, backup_path: 'audit-reports/x.bak.js' } },
    }
    let pipelineCalled = false
    const fakePipeline = async () => { pipelineCalled = true; return { anya: { files_targeted: ['backend/services/matchEngine.js'], files_modified: 0, reports: [] }, sam: { run_id: 'sam-9', applied_fixes: [], health_score: 88 } } }

    try {
      const out = await runAmyTraining({
        db,
        targetCount: 16,
        dryRunDiscovery: true,
        improve: true,
        applyTuning: true,
        runDiscovery: fakeDiscovery,
        runPipeline: fakePipeline,
        thresholdEditor: fakeEditor,
        clock: () => new Date('2026-06-29T12:00:00Z'),
      })

      expect(out.combined.tuning.change).toBe(true)
      expect(out.combined.tuning.applied.applied).toBe(true)
      expect(editorState.value).toBe(12)
      expect(pipelineCalled).toBe(true)
      expect(out.combined.chain.sam.run_id).toBe('sam-9')
      expect(out.combined.metrics.before).toBeTruthy()
      expect(out.combined.metrics.best.floor).toBe(12)
      expect(out.crawled_profile_ids.length).toBe(16)
      expect(out.cleanup.deleted).toBe(16)
      expect(out.cleanup.require_crawled).toBe(true)
      const latest = await readLatestAmyReport(db)
      expect(latest.run_id).toBe(out.run_id)
      // Per-archetype measurement rode along with the run.
      expect(latest.archetype_metrics).toBeTruthy()
      expect(Object.keys(latest.archetype_metrics).length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('never deletes a profile that was not crawled', async () => {
    const db = createDb()
    try {
      const { profileId } = await createAmyProfile(db, generateScenarios({ runId: 'amy-x' })[0], { runId: 'amy-x', ttlHours: 48 })
      const skip = await cleanupAmyProfiles(db, { force: true, requireCrawled: true })
      expect(skip.deleted).toBe(0)
      expect(db.prepare('SELECT id FROM profiles WHERE id=?').get(profileId)).toBeTruthy()
      await markProfileCrawled(db, profileId, {})
      const del = await cleanupAmyProfiles(db, { force: true, requireCrawled: true })
      expect(del.deleted).toBe(1)
    } finally {
      db.close()
    }
  })

  it('never deletes a crawled profile before the teaching receipt exists for every required agent', async () => {
    const db = createDb()
    try {
      const { profileId } = await createAmyProfile(db, generateScenarios({ runId: 'amy-teach' })[0], { runId: 'amy-teach', ttlHours: 48 })
      await markProfileCrawled(db, profileId, {})

      const skipped = await cleanupAmyProfiles(db, { force: true, requireCrawled: true, requireTaught: true })
      expect(skipped.deleted).toBe(0)
      expect(skipped.skipped_ids.some((s) => s.id === profileId && s.reasons.includes('not_taught'))).toBe(true)

      await markProfilesTaught(db, [profileId], {
        runId: 'amy-teach',
        agents: REQUIRED_TEACHING_AGENTS,
        receipt: { run_id: 'amy-teach', findings_total: 1, approval_items: 1, handoff_generated: true },
      })
      const metaRow = db.prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?').get(profileId, METADATA_SECTION_KEY)
      const meta = JSON.parse(metaRow.data)
      expect(hasRequiredTeachingReceipt(meta)).toBe(true)

      const deleted = await cleanupAmyProfiles(db, { force: true, requireCrawled: true, requireTaught: true })
      expect(deleted.deleted).toBe(1)
      expect(db.prepare('SELECT id FROM profiles WHERE id=?').get(profileId)).toBeFalsy()
    } finally {
      db.close()
    }
  })

  it('reaps a never-crawled synthetic ONLY once it is far past its TTL (bounded escape hatch)', async () => {
    const db = createDb()
    try {
      // Created 100h ago, never crawled (its run crashed / discovery kept skipping).
      const oldNow = new Date(Date.now() - 100 * 60 * 60 * 1000)
      const { profileId: stale } = await createAmyProfile(db, generateScenarios({ runId: 'amy-stale' })[0], { runId: 'amy-stale', ttlHours: 48, now: oldNow })
      // Created 1h ago, never crawled — still young.
      const { profileId: fresh } = await createAmyProfile(db, generateScenarios({ runId: 'amy-fresh' })[0], { runId: 'amy-fresh', ttlHours: 48, now: new Date(Date.now() - 60 * 60 * 1000) })

      // Default (no neverCrawledMaxAgeMs): strict — never-crawled is never reaped.
      const strict = await cleanupAmyProfiles(db, { requireCrawled: true })
      expect(strict.deleted).toBe(0)

      // 96h cutoff: the 100h-old never-crawled one is reaped; the 1h-old is kept.
      const reap = await cleanupAmyProfiles(db, { requireCrawled: true, neverCrawledMaxAgeMs: 96 * 60 * 60 * 1000 })
      expect(reap.deleted).toBe(1)
      expect(reap.ids).toContain(stale)
      expect(db.prepare('SELECT id FROM profiles WHERE id=?').get(stale)).toBeFalsy()
      expect(db.prepare('SELECT id FROM profiles WHERE id=?').get(fresh)).toBeTruthy()
    } finally {
      db.close()
    }
  })

  it('respects the crawled grace window so an in-flight run is never reaped', async () => {
    const db = createDb()
    try {
      const { profileId } = await createAmyProfile(db, generateScenarios({ runId: 'amy-g' })[0], { runId: 'amy-g', ttlHours: 48 })
      // Crawled 2 minutes ago — its run could still be mid-flight.
      await markProfileCrawled(db, profileId, { now: new Date(Date.now() - 2 * 60 * 1000) })

      // 1h grace → too recent → skipped with the explicit reason.
      const skip = await cleanupAmyProfiles(db, { requireCrawled: true, minCrawledAgeMs: 60 * 60 * 1000 })
      expect(skip.deleted).toBe(0)
      expect(skip.skipped_ids.some((s) => s.reasons.includes('crawled_too_recently'))).toBe(true)
      expect(db.prepare('SELECT id FROM profiles WHERE id=?').get(profileId)).toBeTruthy()

      // No grace → old enough → reaped (expiry-independent; works even if
      // expires_at were missing/corrupted).
      const del = await cleanupAmyProfiles(db, { requireCrawled: true, minCrawledAgeMs: 0 })
      expect(del.deleted).toBe(1)
      expect(db.prepare('SELECT id FROM profiles WHERE id=?').get(profileId)).toBeFalsy()
    } finally {
      db.close()
    }
  })
})

// ── Expired-synthetic reaping (owner directive 2026-07-06: "make sure those
// profiles are getting deleted afterwards") ─────────────────────────────────

describe('Amy end-of-run expired sweep + crawled-signal rescue', () => {
  const HOUR = 60 * 60 * 1000

  /** Seed a leftover from a "prior run": created hoursAgo ago, crawled then, TTL expired. */
  async function seedExpiredLeftover(db, { hoursAgo = 30, ttlHours = 24, runId = 'amy-prior' } = {}) {
    const past = new Date(Date.now() - hoursAgo * HOUR)
    const { profileId } = await createAmyProfile(db, generateScenarios({ runId })[0], { runId, ttlHours, now: past })
    await markProfileCrawled(db, profileId, { now: past })
    return profileId
  }

  it('PROD REGRESSION: reaps an expired leftover from a PRIOR run even when THIS run crawled nothing', async () => {
    const db = createDb()
    try {
      const leftover = await seedExpiredLeftover(db)
      await markProfilesTaught(db, [leftover], { runId: 'amy-prior', agents: REQUIRED_TEACHING_AGENTS, receipt: { run_id: 'amy-prior' } })
      const events = []
      // Discovery that skips for every synthetic — the prod failure mode that
      // left crawledProfileIds EMPTY so the scoped cleanup deleted nothing.
      const skippedDiscovery = async ({ profileId }) => ({
        run: { skipped: true, reason: 'profile_deleted', run_id: 'r', profile_id: profileId, sources: [], recommendations: [] },
        persisted: { skipped: true },
        thesis: null,
      })

      const out = await runAmyTraining({
        db,
        categories: ['veteran', 'nonprofit'],
        perCategory: 1,
        dryRunDiscovery: true,
        runDiscovery: skippedDiscovery,
        recordActivity: (dbArg, event) => { events.push(event) },
        clock: () => new Date(),
      })

      // The scoped pass had nothing in scope…
      expect(out.crawled_profile_ids.length).toBe(0)
      expect(out.cleanup.deleted).toBe(0)
      // …but the unscoped expired-only pass reaped the prior run's leftover.
      expect(out.cleanup_expired.deleted).toBe(1)
      expect(out.cleanup_expired.ids).toContain(leftover)
      expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get(leftover)).toBeUndefined()

      // This run's own never-crawled, unexpired synthetics survive (TTL rule).
      const remaining = await listAmyProfiles(db)
      expect(remaining.length).toBe(2)
      expect(remaining.every((r) => r.id !== leftover)).toBe(true)

      // Agent Observability Rule: the sweep emitted the amy telemetry event.
      const sweepEvent = events.find((e) => e.event_type === 'amy.cleanup.expired_sweep')
      expect(sweepEvent).toBeTruthy()
      expect(sweepEvent.status).toBe('succeeded')
      expect(sweepEvent.metric_value).toBe(1)
      expect(sweepEvent.details_json.run_id).toBe(out.run_id)
    } finally {
      db.close()
    }
  })

  it('counts a profile as CRAWLED when the result said skipped but last_discovery_at advanced (belt and suspenders)', async () => {
    const db = createDb()
    db.exec('ALTER TABLE profiles ADD COLUMN last_discovery_at TEXT')
    try {
      // Discovery stamps the real stamp (persistRun behavior) but REPORTS skipped.
      const stampingSkippedDiscovery = async ({ profileId }) => {
        db.prepare('UPDATE profiles SET last_discovery_at = ? WHERE id = ?').run(new Date().toISOString(), profileId)
        return {
          run: { skipped: true, reason: 'post_persist_confusion', run_id: 'r', profile_id: profileId, sources: [], recommendations: [] },
          persisted: { skipped: true },
          thesis: null,
        }
      }
      const out = await runAmyTraining({
        db,
        categories: ['veteran'],
        perCategory: 1,
        dryRunDiscovery: true,
        runDiscovery: stampingSkippedDiscovery,
        recordActivity: () => {},
        clock: () => new Date(),
      })
      // The stamp advanced → genuinely crawled → scoped cleanup reaps it.
      expect(out.crawled_profile_ids.length).toBe(1)
      expect(out.cleanup.deleted).toBe(1)
      expect((await listAmyProfiles(db)).length).toBe(0)
    } finally {
      db.close()
    }
  })

  it('counts a profile as CRAWLED when discovery THREW after persisting (stamp advanced)', async () => {
    const db = createDb()
    db.exec('ALTER TABLE profiles ADD COLUMN last_discovery_at TEXT')
    try {
      const throwingAfterPersist = async ({ profileId }) => {
        db.prepare('UPDATE profiles SET last_discovery_at = ? WHERE id = ?').run(new Date().toISOString(), profileId)
        throw new Error('post-persist step exploded')
      }
      const out = await runAmyTraining({
        db,
        categories: ['veteran'],
        perCategory: 1,
        dryRunDiscovery: true,
        runDiscovery: throwingAfterPersist,
        recordActivity: () => {},
        clock: () => new Date(),
      })
      expect(out.summary.error).toBe(1) // the evaluation honestly recorded the throw
      expect(out.crawled_profile_ids.length).toBe(1)
      expect(out.cleanup.deleted).toBe(1)
      expect((await listAmyProfiles(db)).length).toBe(0)
    } finally {
      db.close()
    }
  })

  it('cleanupExpiredAmyProfiles: idempotent, never touches designated or expired-but-recently-crawled profiles', async () => {
    const db = createDb()
    try {
      const expired = await seedExpiredLeftover(db, { hoursAgo: 30, ttlHours: 24, runId: 'amy-a' })
      await markProfilesTaught(db, [expired], { runId: 'amy-a', agents: REQUIRED_TEACHING_AGENTS, receipt: { run_id: 'amy-a' } })

      // Expired, but crawled 1h ago — inside the 6h mid-flight grace.
      const recent = await seedExpiredLeftover(db, { hoursAgo: 30, ttlHours: 24, runId: 'amy-b' })
      await markProfileCrawled(db, recent, { now: new Date(Date.now() - 1 * HOUR) })
      await markProfilesTaught(db, [recent], { runId: 'amy-b', agents: REQUIRED_TEACHING_AGENTS, receipt: { run_id: 'amy-b' } })

      // A DESIGNATED profile id maliciously tagged as an expired Amy synthetic
      // must still be untouchable (guard 1 always wins).
      const designatedId = DESIGNATED_PROFILES[0].id
      expect(designatedId).toBeTruthy()
      const past = new Date(Date.now() - 30 * HOUR)
      db.prepare(
        `INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by, created_at, updated_at)
         VALUES (?, 'Designated', 'individual', 'active', '[]', 'agent:amy', ?, ?)`,
      ).run(designatedId, past.toISOString(), past.toISOString())
      const meta = buildAmyMetadata({ runId: 'amy-evil', scenarioId: 's', ttlHours: 24, now: past })
      meta.crawled_at = past.toISOString()
      meta.last_crawled_at = past.toISOString()
      meta.taught_at = past.toISOString()
      meta.last_taught_at = past.toISOString()
      meta.learning_agents = [...REQUIRED_TEACHING_AGENTS]
      meta.teaching = { taught_at: past.toISOString(), last_taught_at: past.toISOString(), agents: [...REQUIRED_TEACHING_AGENTS] }
      db.prepare(
        `INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)`,
      ).run(designatedId, METADATA_SECTION_KEY, JSON.stringify(meta))

      const first = await cleanupExpiredAmyProfiles(db)
      expect(first.deleted).toBe(1)
      expect(first.ids).toEqual([expired])
      expect(first.skipped_ids.some((s) => s.id === recent && s.reasons.includes('crawled_too_recently'))).toBe(true)
      expect(first.skipped_ids.some((s) => s.id === designatedId && s.reasons.includes('designated_profile'))).toBe(true)
      expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get(designatedId)).toBeTruthy()
      expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get(recent)).toBeTruthy()

      // Idempotent: nothing new to reap on an immediate second pass.
      const second = await cleanupExpiredAmyProfiles(db)
      expect(second.deleted).toBe(0)
    } finally {
      db.close()
    }
  })

  it('PROD LEAK b9ca2567: an EXPIRED synthetic re-crawled nightly cannot ride the 6h grace past the starvation bound', async () => {
    const db = createDb()
    try {
      // The exact prod shape (2026-08-04): created 100h ago (> the 96h bound),
      // TTL 48h → expired ~52h ago — but SOME discovery path re-crawled it 1h
      // ago, so the old rule skipped it `crawled_too_recently` on every sweep,
      // forever ("starved by perpetual re-discovery").
      const starved = await seedExpiredLeftover(db, { hoursAgo: 100, ttlHours: 48, runId: 'amy-starved' })
      await markProfileCrawled(db, starved, { now: new Date(Date.now() - 1 * HOUR) })
      await markProfilesTaught(db, [starved], { runId: 'amy-starved', agents: REQUIRED_TEACHING_AGENTS, receipt: { run_id: 'amy-starved' } })

      // Control: expired and ALSO crawled 1h ago, but only 30h old — well
      // inside the starvation bound, so the mid-flight grace must still hold.
      const graceHeld = await seedExpiredLeftover(db, { hoursAgo: 30, ttlHours: 24, runId: 'amy-grace' })
      await markProfileCrawled(db, graceHeld, { now: new Date(Date.now() - 1 * HOUR) })
      await markProfilesTaught(db, [graceHeld], { runId: 'amy-grace', agents: REQUIRED_TEACHING_AGENTS, receipt: { run_id: 'amy-grace' } })

      const res = await cleanupExpiredAmyProfiles(db)
      expect(res.ids).toContain(starved)
      expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get(starved)).toBeFalsy()
      // The younger expired row keeps its grace — the escalation is narrow.
      expect(res.skipped_ids.some((s) => s.id === graceHeld && s.reasons.includes('crawled_too_recently'))).toBe(true)
      expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get(graceHeld)).toBeTruthy()
    } finally {
      db.close()
    }
  })

  it('starvation escalation never reaches an UNEXPIRED row, whatever its age', async () => {
    const db = createDb()
    try {
      // 100h old but with a FUTURE expires_at (crafted directly — TTL hours are
      // clamped to 72h by buildAmyMetadata, so no created profile can be this
      // old and unexpired); crawled 1h ago. Both the expiry gate and the grace
      // must hold it — age alone can never reap.
      const past = new Date(Date.now() - 100 * HOUR)
      const profileId = 'amy-test-unexpired-old'
      db.prepare(
        `INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by, created_at, updated_at)
         VALUES (?, 'Unexpired Old Synthetic', 'individual', 'active', '[]', 'agent:amy', ?, ?)`,
      ).run(profileId, past.toISOString(), past.toISOString())
      const meta = buildAmyMetadata({ runId: 'amy-longttl', scenarioId: 's', ttlHours: 48, now: past })
      meta.expires_at = new Date(Date.now() + 24 * HOUR).toISOString() // future
      meta.crawled_at = new Date(Date.now() - 1 * HOUR).toISOString()
      meta.last_crawled_at = meta.crawled_at
      db.prepare(
        `INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)`,
      ).run(profileId, METADATA_SECTION_KEY, JSON.stringify(meta))

      const res = await cleanupExpiredAmyProfiles(db)
      expect(res.deleted).toBe(0)
      expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId)).toBeTruthy()
    } finally {
      db.close()
    }
  })

  it('cleanupExpiredAmyProfiles: never-crawled leftovers survive until the TTL escape window, then reap', async () => {
    const db = createDb()
    try {
      const past = new Date(Date.now() - 100 * HOUR) // > 96h default cutoff
      const { profileId: ancient } = await createAmyProfile(db, generateScenarios({ runId: 'amy-old' })[0], { runId: 'amy-old', ttlHours: 48, now: past })
      const { profileId: young } = await createAmyProfile(db, generateScenarios({ runId: 'amy-new' })[0], { runId: 'amy-new', ttlHours: 48, now: new Date(Date.now() - 10 * HOUR) })

      const res = await cleanupExpiredAmyProfiles(db)
      expect(res.deleted).toBe(1)
      expect(res.ids).toContain(ancient)
      expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get(young)).toBeTruthy()
    } finally {
      db.close()
    }
  })

  it('cleanupExpiredAmyProfiles: refuses an expired crawled profile until the teach receipt exists, then reaps it', async () => {
    const db = createDb()
    try {
      const past = new Date(Date.now() - 30 * HOUR)
      const { profileId } = await createAmyProfile(db, generateScenarios({ runId: 'amy-expired-teach' })[0], {
        runId: 'amy-expired-teach',
        ttlHours: 24,
        now: past,
      })
      await markProfileCrawled(db, profileId, { now: past })

      const skipped = await cleanupExpiredAmyProfiles(db)
      expect(skipped.deleted).toBe(0)
      expect(skipped.skipped_ids.some((s) => s.id === profileId && s.reasons.includes('not_taught'))).toBe(true)

      await markProfilesTaught(db, [profileId], {
        runId: 'amy-expired-teach',
        agents: REQUIRED_TEACHING_AGENTS,
        receipt: { run_id: 'amy-expired-teach', findings_total: 2, approval_items: 1, handoff_generated: true },
      })
      const reaped = await cleanupExpiredAmyProfiles(db)
      expect(reaped.deleted).toBe(1)
      expect(reaped.ids).toContain(profileId)
    } finally {
      db.close()
    }
  })

  it('runAmyTraining keeps crawled synthetics when the teach step cannot notify every required agent', async () => {
    const db = createDb()
    try {
      const out = await runAmyTraining({
        db,
        categories: CATEGORY_IDS.slice(0, 2),
        perCategory: 1,
        dryRunDiscovery: true,
        runDiscovery: makeFakeDiscovery(db),
        mesh: {
          consumeInbox: async () => [],
          readLessons: async () => [],
          recordLesson: async () => ({ id: 'lsn-failing', topic: 'coverage_gap', claim: 'lesson' }),
          postMessage: async (_db, args) => {
            if (args.to === 'robert') throw new Error('robert inbox unavailable')
            return { id: `msg-${args.to}`, to: args.to, kind: args.kind }
          },
          markConsumed: async () => true,
        },
        clock: () => new Date('2026-08-20T12:00:00Z'),
      })

      expect(out.crawled_profile_ids.length).toBeGreaterThan(0)
      expect(out.combined.agent_mesh.teaching_complete).toBe(false)
      expect(out.combined.agent_mesh.teaching_error).toContain('robert inbox unavailable')
      expect(out.cleanup.deleted).toBe(0)
      const survivors = await listAmyProfiles(db)
      expect(survivors.length).toBe(out.created_profile_ids.length)
      expect(survivors.every((row) => !hasRequiredTeachingReceipt(row.metadata))).toBe(true)
    } finally {
      db.close()
    }
  })
})

describe('scoring-weight editor + tuner', () => {
  it('normalizes weights to sum 1.0 within bounds', () => {
    const w = normalizeWeights({ W_NEED: 0.6, W_ELIGIBILITY: 0.6, W_GEO: 0.01, W_CATEGORY: 0.2 })
    const sum = w.W_NEED + w.W_ELIGIBILITY + w.W_GEO + w.W_CATEGORY
    expect(Math.round(sum * 100) / 100).toBe(1) // always sums to 1.0
    for (const k of Object.keys(w)) {
      expect(w[k]).toBeGreaterThan(0)
      expect(w[k]).toBeLessThanOrEqual(0.5) // no runaway weight
    }
  })

  it('reads/applies/reverts weights on an isolated file', async () => {
    const tmp = nodePath.join(os.tmpdir(), `amy-w-${Date.now()}.js`)
    await fsp.writeFile(tmp, 'export const W_NEED = 0.35\nexport const W_ELIGIBILITY = 0.25\nexport const W_GEO = 0.20\nexport const W_CATEGORY = 0.20\n', 'utf8')
    try {
      expect(await readCurrentWeights(tmp)).toEqual({ W_NEED: 0.35, W_ELIGIBILITY: 0.25, W_GEO: 0.2, W_CATEGORY: 0.2 })
      const applied = await applyWeights({ W_NEED: 0.45, W_ELIGIBILITY: 0.25, W_GEO: 0.15, W_CATEGORY: 0.15 }, { filePath: tmp })
      expect(applied.applied).toBe(true)
      const after = await readCurrentWeights(tmp)
      expect(Math.round((after.W_NEED + after.W_ELIGIBILITY + after.W_GEO + after.W_CATEGORY) * 100) / 100).toBe(1)
      await restoreFromBackup(applied.backup_path, tmp)
      expect(await readCurrentWeights(tmp)).toEqual({ W_NEED: 0.35, W_ELIGIBILITY: 0.25, W_GEO: 0.2, W_CATEGORY: 0.2 })
    } finally {
      await fsp.unlink(tmp).catch(() => {})
    }
  })

  it('decideWeightChange shifts toward fit on high weak-rate, precision on high FP', () => {
    const base = { W_NEED: 0.35, W_ELIGIBILITY: 0.25, W_GEO: 0.2, W_CATEGORY: 0.2 }
    const weak = decideWeightChange({ currentWeights: base, cohort: { profiles: 16, weak: 8, false_positive_rate: 0 } })
    expect(weak.change).toBe(true)
    expect(weak.to.W_NEED).toBeGreaterThan(base.W_NEED)
    const fp = decideWeightChange({ currentWeights: base, cohort: { profiles: 16, weak: 0, false_positive_rate: 0.4 } })
    expect(fp.change).toBe(true)
    expect(fp.to.W_ELIGIBILITY).toBeGreaterThan(base.W_ELIGIBILITY)
    const small = decideWeightChange({ currentWeights: base, cohort: { profiles: 3, weak: 3, false_positive_rate: 0 } })
    expect(small.change).toBe(false)
  })

  it('does not re-trial weights while a recent KEEP/REVERT is cooling down', () => {
    const base = { W_NEED: 0.35, W_ELIGIBILITY: 0.25, W_GEO: 0.2, W_CATEGORY: 0.2 }
    const now = Date.parse('2026-08-18T12:00:00.000Z')
    const lastWeek = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
    const cooled = decideWeightChange({
      currentWeights: base,
      cohort: { profiles: 50, weak: 29, false_positive_rate: 0 },
      opts: { lastTrial: { at: lastWeek, reverted: true }, now },
    })
    expect(cooled.change).toBe(false)
    expect(cooled.reason).toBe('recently_tried')

    const lastMonth = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString()
    const ready = decideWeightChange({
      currentWeights: base,
      cohort: { profiles: 50, weak: 29, false_positive_rate: 0 },
      opts: { lastTrial: { at: lastMonth, reverted: true }, now },
    })
    expect(ready.change).toBe(true)
    expect(ready.reason).not.toBe('recently_tried')
  })
})

describe('source-coverage overrides (additive, live)', () => {
  it('registry merges live additive overrides then resets', () => {
    const before = allSources().find((s) => s.source_id === 'grants_gov')
    expect(before.applicant_types).not.toContain('individual')
    setCoverageOverrides({ grants_gov: { add_applicant_types: ['individual'], add_need_categories: [] } })
    try {
      const after = allSources().find((s) => s.source_id === 'grants_gov')
      expect(after.applicant_types).toContain('individual')
      expect(after._amy_coverage_extended).toBe(true)
    } finally {
      setCoverageOverrides({}) // reset global
      expect(getCoverageOverrides()).toEqual({})
    }
  })

  it('proposeCoverageOverrides fills a known zero-result category gap', () => {
    const evals = [
      evalFix({ category: 'veteran', status: 'zero' }),
      evalFix({ category: 'veteran', status: 'zero' }),
    ]
    const cp = proposeCoverageOverrides(evals, { liveOverrides: {}, opts: { minZero: 2 } })
    expect(cp.change).toBe(true)
    expect(cp.additions[0].source_id).toBe('benefits_gov')
    expect(cp.next.benefits_gov.add_applicant_types).toContain('veteran')
  })
})

describe('Amy weight tuning with empirical validation', () => {
  function makeDb() {
    const db = createDb()
    return db
  }
  // SCORING SPLIT (owner directives 2026-07-06): the FINAL match score is
  // data-point coverage × eligibility/geo gates and never moves with a W_*
  // weight change — weights act only inside the legacy weighted-evidence blend
  // (topical_evidence). So the fake discovery keeps the final score pinned in
  // the REVIEW band (ACCEPT_SCORE - 1 on the data-point scale, weak cohort →
  // weight symptom fires) and moves ONLY the topical subscale once the weight
  // edit is "applied": weak topical (55) until then, strong (80, above
  // TOPICAL_EVIDENCE_STRONG_BAR=75 — that subscale did NOT change scale) when
  // it improves.
  function discoveryFactory(state, improves) {
    return async ({ profileId }) => {
      const topical = state.applied && improves ? 80 : 55
      return {
        run: { run_id: 'r', stored: 1, sources: [{ source_id: 'grants_gov', outcome: 'OK', fetched: 3, stored: 1 }], recommendations: [{ title: 'Specific Grant', match_score: ACCEPT_SCORE - 1, decision: 'REVIEW', topical_evidence: topical }], zero_result: null },
        persisted: { opportunities: 1 },
        thesis: { applicant_types: ['x'], needs: ['funding'], location: { state: 'TN' } },
      }
    }
  }
  const baseWeights = { W_NEED: 0.35, W_ELIGIBILITY: 0.25, W_GEO: 0.2, W_CATEGORY: 0.2 }

  it('KEEPS a weight change that improves cohort quality', async () => {
    const db = makeDb()
    const state = { applied: false }
    const weightEditor = {
      read: async () => baseWeights,
      apply: async (to) => { state.applied = true; return { applied: true, from: baseWeights, to, backup_path: 'b' } },
      restore: async () => { state.applied = false; return true },
    }
    try {
      const out = await runAmyTraining({
        db, targetCount: 16, dryRunDiscovery: true,
        improve: true, applyTuning: false, applyWeights: true,
        runDiscovery: discoveryFactory(state, true),
        runPipeline: async () => ({ anya: {}, sam: {} }),
        thresholdEditor: { read: async () => DISCOVERY_MIN_SCORE_FLOOR, apply: async () => ({ applied: false }) },
        weightEditor,
        clock: () => new Date('2026-06-29T12:00:00Z'),
      })
      expect(out.combined.weight_tuning.applied.applied).toBe(true)
      expect(out.combined.weight_tuning.validation.kept).toBe(true)
      expect(state.applied).toBe(true) // not reverted
    } finally { db.close() }
  })

  it('REVERTS a weight change that does not improve quality', async () => {
    const db = makeDb()
    const state = { applied: false }
    const weightEditor = {
      read: async () => baseWeights,
      apply: async (to) => { state.applied = true; return { applied: true, from: baseWeights, to, backup_path: 'b' } },
      restore: async () => { state.applied = false; return true },
    }
    try {
      const out = await runAmyTraining({
        db, targetCount: 16, dryRunDiscovery: true,
        improve: true, applyTuning: false, applyWeights: true,
        runDiscovery: discoveryFactory(state, false), // never improves
        runPipeline: async () => ({ anya: {}, sam: {} }),
        thresholdEditor: { read: async () => DISCOVERY_MIN_SCORE_FLOOR, apply: async () => ({ applied: false }) },
        weightEditor,
        clock: () => new Date('2026-06-29T12:00:00Z'),
      })
      expect(out.combined.weight_tuning.applied.applied).toBe(true)
      expect(out.combined.weight_tuning.validation.kept).toBe(false)
      expect(out.combined.weight_tuning.validation.reverted).toBe(true)
      expect(state.applied).toBe(false) // reverted
    } finally { db.close() }
  })

  it('does not apply a second weight trial the night after a revert', async () => {
    const db = makeDb()
    const state = { applied: false }
    let applyCount = 0
    const weightEditor = {
      read: async () => baseWeights,
      apply: async (to) => {
        applyCount += 1
        state.applied = true
        return { applied: true, from: baseWeights, to, backup_path: 'b' }
      },
      restore: async () => { state.applied = false; return true },
    }
    const runOpts = {
      db, targetCount: 16, dryRunDiscovery: true,
      improve: true, applyTuning: false, applyWeights: true,
      runDiscovery: discoveryFactory(state, false),
      runPipeline: async () => ({ anya: {}, sam: {} }),
      thresholdEditor: { read: async () => DISCOVERY_MIN_SCORE_FLOOR, apply: async () => ({ applied: false }) },
      weightEditor,
      clock: () => new Date('2026-08-18T12:00:00Z'),
    }
    try {
      const first = await runAmyTraining(runOpts)
      expect(first.combined.weight_tuning.validation.reverted).toBe(true)
      expect(applyCount).toBe(1)
      const second = await runAmyTraining(runOpts)
      expect(second.combined.weight_tuning.change).toBe(false)
      expect(second.combined.weight_tuning.reason).toBe('recently_tried')
      expect(applyCount).toBe(1)
    } finally { db.close() }
  })
})
