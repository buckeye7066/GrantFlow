/**
 * The Amy→crawler archetype-learning flywheel:
 *
 *   Amy synthetic run → per-archetype gap lessons (system_kv) → the next LIVE
 *   crawl's thesis (attachLearnedGaps) → buildWebQueries targets the gap.
 *
 * Plus the per-run, per-archetype metrics history that makes the evolution
 * verifiable, and the safety bounds (whitelisted classes only; additive-only
 * consumption; coverage overrides change planner output but never remove).
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { classifyThesisArchetype, ARCHETYPES } from '../crawler-os/archetypes.js'
import {
  SAFE_LEARNED_CLASSES,
  METRICS_HISTORY_MAX,
  buildArchetypeMetrics,
  buildArchetypeLearningUpdate,
  saveArchetypeLearning,
  getArchetypeLearning,
  learnedClassesForThesis,
  appendArchetypeMetrics,
  readArchetypeMetrics,
} from '../services/amy/archetypeLearning.js'
import { proposeCoverageOverrides } from '../services/amy/crawlerTuner.js'
import { buildWebQueries } from '../crawler-os/webQueries.js'
import { plan } from '../crawler-os/planner.js'
import { setCoverageOverrides } from '../crawler-os/coverageOverrides.js'
import { attachLearnedGaps } from '../services/crawlerOsService.js'
import { runAmyTraining } from '../services/amy/amyAgent.js'
import { CATEGORY_IDS, CATEGORY_CATALOG } from '../services/amy/syntheticProfileCatalog.js'

function createDb() {
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

describe('classifyThesisArchetype', () => {
  it('classifies the funding-lane-defining signal first', () => {
    expect(classifyThesisArchetype({ applicant_types: ['student', 'individual'], is_student: true })).toBe('student')
    expect(classifyThesisArchetype({ applicant_types: ['veteran', 'individual'] })).toBe('veteran')
    expect(classifyThesisArchetype({ applicant_types: ['military_spouse', 'family', 'individual'] })).toBe('military_family')
    expect(classifyThesisArchetype({ applicant_types: ['individual'], needs: ['aging', 'senior'] })).toBe('senior')
    expect(classifyThesisArchetype({ applicant_types: ['individual'], keywords: ['assistive technology', 'disability'] })).toBe('disability')
    expect(classifyThesisArchetype({ applicant_types: ['family', 'individual'], needs: ['caregiving'], keywords: ['respite care'] })).toBe('caregiver')
    expect(classifyThesisArchetype({ applicant_types: ['individual'], keywords: ['paramedic certification', 'ems'] })).toBe('first_responder')
    expect(classifyThesisArchetype({ applicant_types: ['vfd', 'government'] })).toBe('first_responder')
    expect(classifyThesisArchetype({ applicant_types: ['nonprofit'] })).toBe('nonprofit')
    expect(classifyThesisArchetype({ applicant_types: ['church'] })).toBe('nonprofit')
    expect(classifyThesisArchetype({ applicant_types: ['business'] })).toBe('business')
    expect(classifyThesisArchetype({ applicant_types: ['farm'] })).toBe('farm')
    expect(classifyThesisArchetype({ applicant_types: ['tribal', 'government'] })).toBe('tribal')
    expect(classifyThesisArchetype({ applicant_types: ['government'] })).toBe('government')
    expect(classifyThesisArchetype({ applicant_types: ['family', 'individual'] })).toBe('family')
    expect(classifyThesisArchetype({})).toBe('individual')
    for (const t of ['student', 'veteran', 'nonprofit']) expect(ARCHETYPES).toContain(t)
  })

  it('an org thesis never reads as a person even with person-ish needs text', () => {
    expect(classifyThesisArchetype({ applicant_types: ['nonprofit'], needs: ['caregiving', 'senior'] })).toBe('nonprofit')
  })
})

describe('buildArchetypeLearningUpdate (pure)', () => {
  const zeroEval = (archetype, status = 'zero') => ({ archetype, status, findings: [] })
  const missEval = (archetype, type) => ({ archetype, status: 'ok', findings: [{ type }] })

  it('learns low_results only with enough evidence (>= minEvidence AND >= 50% of cohort)', () => {
    // 2 of 4 student profiles zero → 50% with evidence 2 → learns.
    const update = buildArchetypeLearningUpdate(
      [zeroEval('student'), zeroEval('student'), { archetype: 'student', status: 'ok', findings: [] }, { archetype: 'student', status: 'ok', findings: [] }],
      { runId: 'r1', at: 't1' },
    )
    expect(update.student.classes).toEqual(['low_results'])
    expect(update.student.run_id).toBe('r1')
    expect(update.student.evidence.zero).toBe(2)

    // 1 of 4 zero → below both gates → nothing learned.
    const none = buildArchetypeLearningUpdate(
      [zeroEval('veteran'), { archetype: 'veteran', status: 'ok', findings: [] }, { archetype: 'veteran', status: 'ok', findings: [] }, { archetype: 'veteran', status: 'ok', findings: [] }],
      { runId: 'r1' },
    )
    expect(none.veteran).toBeUndefined()
  })

  it('learns institution/hyperlocal gaps from recall-miss findings with an audit trail', () => {
    const update = buildArchetypeLearningUpdate(
      [
        missEval('student', 'institution_recall_miss'),
        missEval('student', 'institution_recall_miss'),
        missEval('senior', 'hyperlocal_recall_miss'),
        missEval('senior', 'hyperlocal_recall_miss'),
      ],
      { runId: 'r2', at: 't2' },
    )
    expect(update.student.classes).toEqual(['institution_gap'])
    expect(update.student.caused_by).toContain('institution_recall_miss')
    expect(update.senior.classes).toEqual(['hyperlocal_gap'])
    expect(update.senior.at).toBe('t2')
  })

  it('SAFETY: only whitelisted, additive query-steering classes are ever emitted', () => {
    const update = buildArchetypeLearningUpdate(
      [zeroEval('student'), zeroEval('student')],
      { runId: 'r3' },
    )
    for (const entry of Object.values(update)) {
      for (const c of entry.classes) expect(SAFE_LEARNED_CLASSES).toContain(c)
    }
  })
})

describe('buildArchetypeMetrics (per-run measurement)', () => {
  it('aggregates qualified + ineligible-accept counts per archetype', () => {
    const metrics = buildArchetypeMetrics([
      { archetype: 'student', status: 'ok', accepted: 3, ineligible_accepts: 0, false_positives: 1, findings: [] },
      { archetype: 'student', status: 'zero', accepted: 0, ineligible_accepts: 0, false_positives: 0, findings: [] },
      { archetype: 'senior', status: 'ok', accepted: 2, ineligible_accepts: 2, false_positives: 0, findings: [] },
    ])
    expect(metrics.student.profiles).toBe(2)
    expect(metrics.student.qualified).toBe(3)
    expect(metrics.student.zero).toBe(1)
    expect(metrics.student.covered_rate).toBe(0.5)
    expect(metrics.senior.ineligible_accepts).toBe(2)
    expect(metrics.senior.covered_rate).toBe(1)
  })
})

describe('archetype learning persistence (system_kv)', () => {
  it('saves, reads, replaces, and clears healed archetypes', async () => {
    const db = createDb()
    try {
      await saveArchetypeLearning(db, { student: { classes: ['low_results'], evidence: { zero: 2 } } }, { runId: 'r1', at: 't1', cohortArchetypes: ['student'] })
      let store = await getArchetypeLearning(db)
      expect(store.archetypes.student.classes).toEqual(['low_results'])
      expect(store.updated_run_id).toBe('r1')

      // Next run: student healthy (in cohort, no update) → cleared; veteran learned.
      await saveArchetypeLearning(db, { veteran: { classes: ['hyperlocal_gap'] } }, { runId: 'r2', at: 't2', cohortArchetypes: ['student', 'veteran'] })
      store = await getArchetypeLearning(db)
      expect(store.archetypes.student).toBeUndefined()
      expect(store.archetypes.veteran.classes).toEqual(['hyperlocal_gap'])

      // An archetype NOT in the cohort is retained (no evidence either way).
      await saveArchetypeLearning(db, {}, { runId: 'r3', at: 't3', cohortArchetypes: ['student'] })
      store = await getArchetypeLearning(db)
      expect(store.archetypes.veteran.classes).toEqual(['hyperlocal_gap'])
    } finally {
      db.close()
    }
  })

  it('SAFETY: non-whitelisted classes are stripped on save and on read-out', async () => {
    const db = createDb()
    try {
      await saveArchetypeLearning(
        db,
        { student: { classes: ['low_results', 'disable_eligibility_gate', 'surfacing_regression'] } },
        { runId: 'r1', at: 't1' },
      )
      const store = await getArchetypeLearning(db)
      expect(store.archetypes.student.classes).toEqual(['low_results'])
      const learned = learnedClassesForThesis(store, { applicant_types: ['student'], is_student: true })
      expect(learned.classes).toEqual(['low_results'])
    } finally {
      db.close()
    }
  })

  it('metrics history persists per run and stays capped', async () => {
    const db = createDb()
    try {
      for (let i = 0; i < METRICS_HISTORY_MAX + 2; i++) {
        await appendArchetypeMetrics(db, { runId: `r${i}`, at: `t${i}`, metrics: { student: { profiles: 1, qualified: i } } })
      }
      const hist = await readArchetypeMetrics(db)
      expect(hist.runs.length).toBe(METRICS_HISTORY_MAX)
      // Newest first.
      expect(hist.runs[0].run_id).toBe(`r${METRICS_HISTORY_MAX + 1}`)
      expect(hist.runs[0].archetypes.student.qualified).toBe(METRICS_HISTORY_MAX + 1)
    } finally {
      db.close()
    }
  })
})

describe('consumption: learned gaps steer the next crawl', () => {
  it('attachLearnedGaps merges archetype lessons into a real profile thesis', async () => {
    const db = createDb()
    try {
      await saveArchetypeLearning(db, { student: { classes: ['low_results', 'hyperlocal_gap'] } }, { runId: 'r1', at: 't1' })
      const thesis = {
        applicant_types: ['student', 'individual'],
        is_student: true,
        needs: ['scholarship'],
        location: { state: 'TN', city: 'Nashville', county: 'Davidson County' },
      }
      await attachLearnedGaps(db, 'profile-xyz', thesis)
      expect(thesis.learned_gaps).toBeTruthy()
      expect(thesis.learned_gaps.classes).toContain('low_results')
      expect(thesis.learned_gaps.classes).toContain('hyperlocal_gap')
      expect(thesis.learned_gaps.sources).toContain('amy_archetype:student')
      expect(thesis.learned_gaps.archetype).toBe('student')
    } finally {
      db.close()
    }
  })

  it('a thesis of a DIFFERENT archetype is not steered by the student lesson', async () => {
    const db = createDb()
    try {
      await saveArchetypeLearning(db, { student: { classes: ['low_results'] } }, { runId: 'r1', at: 't1' })
      const thesis = { applicant_types: ['nonprofit'], needs: ['programs'], location: { state: 'TN' } }
      await attachLearnedGaps(db, 'profile-org', thesis)
      expect(thesis.learned_gaps).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('the learned classes CHANGE buildWebQueries output (queries added, none removed)', () => {
    const thesis = {
      applicant_types: ['individual'],
      needs: ['medical'],
      location: { state: 'TN', city: 'Cleveland', county: 'Bradley County' },
    }
    const before = buildWebQueries(thesis, { year: 2026, max: 24 })
    const after = buildWebQueries(
      { ...thesis, learned_gaps: { classes: ['hyperlocal_gap', 'low_results'], missing_schools: [] } },
      { year: 2026, max: 24 },
    )
    // Additive: every baseline query survives; targeted queries are added.
    for (const q of before) expect(after).toContain(q)
    expect(after.length).toBeGreaterThan(before.length)
    expect(after.some((q) => /local assistance programs Bradley County/i.test(q))).toBe(true)
  })

  it('an applied coverage override changes the PLANNER output for the next crawl', () => {
    const thesis = { applicant_types: ['zz_amy_test_type'], needs: ['funding'], location: { state: 'TN' } }
    const before = plan(thesis)
    expect(before.selected_source_ids).not.toContain('grants_gov')
    setCoverageOverrides({ grants_gov: { add_applicant_types: ['zz_amy_test_type'], add_need_categories: [] } })
    try {
      const after = plan(thesis)
      expect(after.selected_source_ids).toContain('grants_gov')
      // Additive-only: nothing previously selected was dropped.
      for (const id of before.selected_source_ids) expect(after.selected_source_ids).toContain(id)
    } finally {
      setCoverageOverrides({})
    }
  })
})

describe('new archetype coverage lanes (crawlerTuner)', () => {
  it('the expanded catalog spans the real profile taxonomy', () => {
    for (const cat of ['senior_citizen', 'family_caregiver', 'first_responder', 'adult_learner', 'volunteer_fire_department']) {
      expect(CATEGORY_IDS).toContain(cat)
      expect(CATEGORY_CATALOG[cat].build({ rng: () => 0.5, location: { state: 'TN', city: 'Nashville', county: 'Davidson', zip: '37203' }, index: 0 })).toBeTruthy()
    }
  })

  it('a proven senior zero-result gap proposes widening a real aging source', () => {
    const evals = [
      { scenario_id: 'senior_citizen-v1', category: 'senior_citizen', status: 'zero', candidates: [], findings: [] },
      { scenario_id: 'senior_citizen-v2', category: 'senior_citizen', status: 'zero', candidates: [], findings: [] },
    ]
    const cp = proposeCoverageOverrides(evals, { liveOverrides: {}, opts: { minZero: 2 } })
    expect(cp.change).toBe(true)
    expect(cp.additions[0].source_id).toBe('area_agency_on_aging')
    expect(cp.next.area_agency_on_aging.add_need_categories).toContain('aging')
  })
})

describe('end-to-end: an Amy run teaches the next student crawl', () => {
  it('zero-result student cohort → learning store → student thesis steered', async () => {
    const db = createDb()
    // Discovery always comes back EMPTY for these students.
    const fakeDiscovery = async ({ floor }) => ({
      run: {
        run_id: 'r', stored: 0, sources: [],
        recommendations: [],
        zero_result: { zero_result_reason: 'no_sources_matched', missing_profile_fields: [] },
      },
      persisted: { opportunities: 0 },
      thesis: { applicant_types: ['student', 'individual'], is_student: true, needs: ['scholarship'], location: { state: 'TN' }, min_match_score: floor },
    })
    try {
      const out = await runAmyTraining({
        db,
        categories: ['high_school_student', 'college_student'],
        perCategory: 2,
        dryRunDiscovery: true,
        improve: true,
        applyLearning: true,
        applyTuning: false,
        applyWeights: false,
        applyCoverage: false,
        runDiscovery: fakeDiscovery,
        runPipeline: async () => ({ anya: {}, sam: {} }),
        clock: () => new Date('2026-07-01T12:00:00Z'),
      })

      // The run recorded the lesson with its audit trail…
      expect(out.combined.archetype_learning.applied).toBe(true)
      expect(out.combined.archetype_learning.update.student.classes).toContain('low_results')
      expect(out.combined.archetype_learning.update.student.run_id).toBe(out.run_id)
      // …persisted the per-archetype measurement…
      const hist = await readArchetypeMetrics(db)
      expect(hist.runs[0].run_id).toBe(out.run_id)
      expect(hist.runs[0].archetypes.student.zero).toBe(4)
      // …and the NEXT student crawl's thesis is steered by it.
      const nextThesis = { applicant_types: ['student'], is_student: true, needs: ['scholarship'], location: { state: 'TN' } }
      await attachLearnedGaps(db, 'real-student-profile', nextThesis)
      expect(nextThesis.learned_gaps.classes).toContain('low_results')
      expect(nextThesis.learned_gaps.sources).toContain('amy_archetype:student')
    } finally {
      db.close()
    }
  })
})
