/**
 * Tests for the Amy flywheel daily cohort scoreboard + owner goal notification
 * + the morning-digest section (owner directive 2026-07-05: run the daily
 * synthetic cohort until a full day comes back all-clean, notify once, and
 * report Amy's autonomous edits + what she could not edit every morning).
 */

import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const {
  buildCohortUpdate,
  isCleanEvaluation,
  recordFlywheelCohort,
  getFlywheelCohort,
  KV_KEY,
} = await import('../services/amy/flywheelCohort.js')
const { summarizeAmyFlywheel, buildOwnerReport } = await import('../services/anya/anyaDailyOwnerReport.js')

const clean = (i) => ({ scenario_id: `s${i}`, label: `Clean ${i}`, category: 'student', status: 'ok', findings: [] })
const gappy = (i, type = 'hyperlocal_recall_miss') => ({
  scenario_id: `g${i}`, label: `Gappy ${i}`, category: 'veteran', status: 'ok',
  findings: [{ type, message: 'gap' }],
})
const errored = (i) => ({ scenario_id: `e${i}`, label: `Err ${i}`, category: 'nonprofit', status: 'error', findings: [{ type: 'crawler_exception' }] })

function freshDb() {
  return wrapSqlite(new Database(':memory:'))
}

describe('isCleanEvaluation', () => {
  it('clean = status ok AND zero findings', () => {
    expect(isCleanEvaluation(clean(1))).toBe(true)
    expect(isCleanEvaluation(gappy(1))).toBe(false)
    expect(isCleanEvaluation(errored(1))).toBe(false)
    expect(isCleanEvaluation({ status: 'zero', findings: [] })).toBe(false)
    expect(isCleanEvaluation({ status: 'skipped', findings: [] })).toBe(false)
    expect(isCleanEvaluation(null)).toBe(false)
  })
})

describe('buildCohortUpdate (pure fold)', () => {
  it('accumulates clean/issue counts and finding types within an ET day', () => {
    const r1 = buildCohortUpdate(null, {
      dayKey: '2026-07-06', target: 4, runId: 'run-a', at: 't1',
      evaluations: [clean(1), gappy(1), errored(1)],
    })
    expect(r1.day.evaluated).toBe(3)
    expect(r1.day.clean).toBe(1)
    expect(r1.day.issues).toBe(2)
    expect(r1.day.finding_types.hyperlocal_recall_miss).toBe(1)
    expect(r1.day.finding_types.crawler_exception).toBe(1)
    expect(r1.goal_reached_now).toBe(false)

    const r2 = buildCohortUpdate(r1.store, {
      dayKey: '2026-07-06', target: 4, runId: 'run-b', at: 't2',
      evaluations: [clean(2)],
    })
    expect(r2.day.evaluated).toBe(4)
    expect(r2.day.complete).toBe(true)
    expect(r2.day.all_clean).toBe(false)
    expect(r2.day.runs).toEqual(['run-a', 'run-b'])
    expect(r2.goal_reached_now).toBe(false)
  })

  it('goal fires only when the day is complete AND fully clean', () => {
    const partial = buildCohortUpdate(null, {
      dayKey: '2026-07-06', target: 3, runId: 'r1', evaluations: [clean(1), clean(2)],
    })
    expect(partial.goal_reached_now).toBe(false)
    const full = buildCohortUpdate(partial.store, {
      dayKey: '2026-07-06', target: 3, runId: 'r2', evaluations: [clean(3)],
    })
    expect(full.goal_reached_now).toBe(true)
    expect(full.day.all_clean).toBe(true)
  })

  it('retains only the most recent day buckets', () => {
    let store = null
    for (let d = 1; d <= 30; d += 1) {
      const key = `2026-06-${String(d).padStart(2, '0')}`
      store = buildCohortUpdate(store, { dayKey: key, target: 1, evaluations: [clean(d)] }).store
    }
    const keys = Object.keys(store.days)
    expect(keys.length).toBeLessThanOrEqual(21)
    expect(keys.includes('2026-06-30')).toBe(true)
    expect(keys.includes('2026-06-01')).toBe(false)
  })
})

describe('recordFlywheelCohort (store + one-shot goal notification)', () => {
  it('persists the scoreboard and sends the goal email exactly once', async () => {
    const db = freshDb()
    const sent = []
    const send = async (msg) => { sent.push(msg); return { ok: true, id: 'em1' } }
    const now = new Date('2026-07-06T15:00:00Z')

    const r1 = await recordFlywheelCohort(db, {
      evaluations: [clean(1), clean(2)], runId: 'run-1', now, target: 2, send,
    })
    expect(r1.ok).toBe(true)
    expect(r1.goal_reached).toBe(true)
    expect(r1.notified).toBe(true)
    expect(sent.length).toBe(1)
    expect(sent[0].subject).toMatch(/GOAL reached/i)

    // A later qualifying run must NOT re-send (durable flag).
    const r2 = await recordFlywheelCohort(db, {
      evaluations: [clean(3)], runId: 'run-2', now, target: 2, send,
    })
    expect(r2.goal_reached).toBe(true)
    expect(r2.notified).toBe(false)
    expect(sent.length).toBe(1)

    const store = await getFlywheelCohort(db)
    expect(store.goal_notified_at).toBeTruthy()
    expect(Object.keys(store.days).length).toBe(1)
  })

  it('does not notify while the cohort has issues or is incomplete', async () => {
    const db = freshDb()
    const sent = []
    const send = async (msg) => { sent.push(msg); return { ok: true } }
    const now = new Date('2026-07-06T15:00:00Z')
    await recordFlywheelCohort(db, { evaluations: [clean(1), gappy(1)], runId: 'r', now, target: 2, send })
    expect(sent.length).toBe(0)
    const db2 = freshDb()
    await recordFlywheelCohort(db2, { evaluations: [clean(1)], runId: 'r', now, target: 50, send })
    expect(sent.length).toBe(0)
  })

  it('a failed send leaves the flag unset so the next qualifying run retries', async () => {
    const db = freshDb()
    let calls = 0
    const send = async () => { calls += 1; return calls === 1 ? { ok: false, error: 'smtp down' } : { ok: true } }
    const now = new Date('2026-07-06T15:00:00Z')
    const r1 = await recordFlywheelCohort(db, { evaluations: [clean(1)], runId: 'r1', now, target: 1, send })
    expect(r1.notified).toBe(false)
    const r2 = await recordFlywheelCohort(db, { evaluations: [clean(2)], runId: 'r2', now, target: 1, send })
    expect(r2.notified).toBe(true)
    expect(calls).toBe(2)
  })
})

describe('summarizeAmyFlywheel + digest section', () => {
  const amy = {
    cohort: {
      day: '2026-07-06', target: 50, evaluated: 50, clean: 47, issues: 3, complete: true, all_clean: false,
      finding_types: { hyperlocal_recall_miss: 2, ineligible_match: 1 },
      runs: ['run-x'],
      issue_examples: [],
    },
    goal_notified_at: null,
    report: {
      tuning: { from: 75, to: 76, change: true, applied: { applied: true } },
      weight_tuning: { validation: { kept: true } },
      coverage_tuning: { validation: { kept: false }, applied: { applied: true } },
      archetype_learning: { update: { student_committed: {}, veteran_family: {} } },
      approval_queue: [
        { lever: 'source_keyword_coverage', category: 'foster_youth', reason: 'needs review' },
        { lever: 'scoring_weights', auto_applied: { kept: true } },
      ],
    },
  }

  it('reports edits applied, reverted trials, and could-not-edit items', () => {
    const fw = summarizeAmyFlywheel(amy)
    expect(fw.cohortLine).toMatch(/47\/50 synthetic profiles clean/)
    expect(fw.goal).toBe(false)
    expect(fw.edits.join(' ')).toMatch(/Score floor tuned 75 → 76/)
    expect(fw.edits.join(' ')).toMatch(/weights re-tuned.*KEPT/i)
    expect(fw.edits.join(' ')).toMatch(/coverage trial.*REVERTED/i)
    expect(fw.edits.join(' ')).toMatch(/lessons recorded for 2/)
    // auto_applied queue items are excluded; pending ones listed.
    expect(fw.couldNot.join(' ')).toMatch(/foster_youth/)
    expect(fw.couldNot.join(' ')).not.toMatch(/scoring_weights/)
    expect(fw.couldNot.join(' ')).toMatch(/hyperlocal_recall_miss ×2/)
  })

  it('flags the goal when a full day is all clean', () => {
    const fw = summarizeAmyFlywheel({
      cohort: { ...amy.cohort, clean: 50, issues: 0, all_clean: true, finding_types: {} },
      report: null,
    })
    expect(fw.goal).toBe(true)
  })

  it('buildOwnerReport embeds the flywheel section in text and html', () => {
    const { text, html } = buildOwnerReport({ findings: [], health_score: 100 }, { amy })
    expect(text).toMatch(/AMY CRAWLER FLYWHEEL/)
    expect(text).toMatch(/47\/50 synthetic profiles clean/)
    expect(text).toMatch(/Could NOT auto-edit/)
    expect(html).toMatch(/Amy crawler flywheel/)
    expect(html).toMatch(/Could not auto-edit/)
  })

  it('digest builds without the section when Amy has no data', () => {
    expect(summarizeAmyFlywheel(null)).toBe(null)
    const { text } = buildOwnerReport({ findings: [] }, { amy: null })
    expect(text).not.toMatch(/AMY CRAWLER FLYWHEEL/)
  })
})

describe('Sam check amy.flywheelCohort', () => {
  it('reds on issue profiles, greens on the goal, and tolerates an empty store', async () => {
    const { DIAGNOSTIC_CHECKS } = await import('../services/sam/samRegistry.js')
    const check = DIAGNOSTIC_CHECKS.find((c) => c.id === 'amy.flywheelCohort')
    expect(check).toBeTruthy()

    const db = freshDb()
    // empty store → ok
    let res = await check.run({ db })
    expect(res.ok).toBe(true)

    // issues → not ok, evidence carries examples
    await recordFlywheelCohort(db, {
      evaluations: [clean(1), gappy(1, 'ineligible_match')], runId: 'r1',
      now: new Date('2026-07-06T15:00:00Z'), target: 2, send: async () => ({ ok: true }),
    })
    res = await check.run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/1 of 2 synthetic profiles had issues/)
    expect(res.evidence.finding_types.ineligible_match).toBe(1)

    // clean complete day → ok with GOAL summary
    const db2 = freshDb()
    await recordFlywheelCohort(db2, {
      evaluations: [clean(1), clean(2)], runId: 'r2',
      now: new Date('2026-07-06T15:00:00Z'), target: 2, send: async () => ({ ok: true }),
    })
    res = await check.run({ db: db2 })
    expect(res.ok).toBe(true)
    expect(res.summary).toMatch(/GOAL/)
  })
})
