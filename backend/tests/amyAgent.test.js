import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runAmyTraining } from '../services/amy/amyAgent.js'
import os from 'node:os'
import fsp from 'node:fs/promises'
import nodePath from 'node:path'
import { createAmyProfile, cleanupAmyProfiles, listAmyProfiles, markProfileCrawled } from '../services/amy/amyProfileStore.js'
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

      // Default cleanup removed all synthetic profiles.
      expect(out.cleanup.deleted).toBe(out.created_profile_ids.length)
      const remaining = await listAmyProfiles(db)
      expect(remaining.length).toBe(0)
    } finally {
      db.close()
    }
  })

  it('scheduler is ON by default (owner directive) and targets 100/day; opt out with AMY_ENABLED=false', () => {
    const prev = { ...process.env }
    try {
      // Default (no env): enabled, scheduled runner starts, 100/day.
      delete process.env.AMY_ENABLED
      delete process.env.AMY_RUN_ON_SCHEDULE
      delete process.env.AMY_RUN_ON_STARTUP
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
    decision: s >= 70 ? 'ACCEPT' : s >= 35 ? 'REVIEW' : 'REJECT',
    title: generics[i] ? 'Resource Directory' : 'Specific Grant',
    generic: Boolean(generics[i]),
  }))
  const false_positives = candidates.filter((c) => c.generic && (c.decision === 'ACCEPT' || c.score >= 70)).length
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
  it('proposes a bounded floor change when the cohort proves a better floor', () => {
    const evals = Array.from({ length: 16 }, () => evalFix({ scores: [55] }))
    const current = cohortMetricsAtFloor(evals, 75)
    const { best } = sweepFloors(evals)
    const decision = decideFloorChange({ currentFloor: 75, best, currentMetrics: current })
    expect(decision.change).toBe(true)
    expect(decision.to).toBeLessThan(75)
    expect(decision.to).toBeGreaterThanOrEqual(65) // bounded by maxDelta=10
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
      const applied = await applyMinScore(60, { filePath: tmp })
      expect(applied.applied).toBe(true)
      expect(applied.from).toBe(75)
      expect(applied.to).toBe(60)
      expect(await readCurrentMinScore(tmp)).toBe(60)
      expect(applied.backup_path).toBeTruthy()
      await restoreFromBackup(applied.backup_path, tmp)
      expect(await readCurrentMinScore(tmp)).toBe(75)
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
    const fakeDiscovery = async ({ profileId, floor }) => {
      const t = db.prepare('SELECT primary_type FROM profiles WHERE id=?').get(profileId)
      return {
        run: {
          run_id: 'r', stored: 1,
          sources: [{ source_id: 'grants_gov', outcome: 'OK', fetched: 5, stored: 1 }],
          recommendations: [{ title: 'Specific Grant', match_score: 55, decision: 'REVIEW' }],
          zero_result: null,
        },
        persisted: { opportunities: 1 },
        thesis: { applicant_types: [t?.primary_type || 'x'], needs: ['funding'], location: { state: 'TN' }, min_match_score: floor },
      }
    }
    const editorState = { value: 75 }
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
      expect(editorState.value).toBe(65)
      expect(pipelineCalled).toBe(true)
      expect(out.combined.chain.sam.run_id).toBe('sam-9')
      expect(out.combined.metrics.before).toBeTruthy()
      expect(out.combined.metrics.best.floor).toBeLessThan(75)
      expect(out.crawled_profile_ids.length).toBe(16)
      expect(out.cleanup.deleted).toBe(16)
      expect(out.cleanup.require_crawled).toBe(true)
      const latest = await readLatestAmyReport(db)
      expect(latest.run_id).toBe(out.run_id)
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
  // Discovery returns weak (55) until the weight edit is "applied", then strong (80).
  function discoveryFactory(state, improves) {
    return async ({ profileId }) => {
      const score = state.applied && improves ? 80 : 55
      return {
        run: { run_id: 'r', stored: 1, sources: [{ source_id: 'grants_gov', outcome: 'OK', fetched: 3, stored: 1 }], recommendations: [{ title: 'Specific Grant', match_score: score, decision: score >= 70 ? 'ACCEPT' : 'REVIEW' }], zero_result: null },
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
        thresholdEditor: { read: async () => 75, apply: async () => ({ applied: false }) },
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
        thresholdEditor: { read: async () => 75, apply: async () => ({ applied: false }) },
        weightEditor,
        clock: () => new Date('2026-06-29T12:00:00Z'),
      })
      expect(out.combined.weight_tuning.applied.applied).toBe(true)
      expect(out.combined.weight_tuning.validation.kept).toBe(false)
      expect(out.combined.weight_tuning.validation.reverted).toBe(true)
      expect(state.applied).toBe(false) // reverted
    } finally { db.close() }
  })
})
