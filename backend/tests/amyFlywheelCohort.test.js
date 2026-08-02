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

  it('re-folding the SAME runId is a no-op: counters unchanged, duplicate:true', () => {
    const r1 = buildCohortUpdate(null, {
      dayKey: '2026-07-06', target: 4, runId: 'run-a', at: 't1',
      evaluations: [clean(1), gappy(1)],
    })
    expect(r1.duplicate).toBe(false)

    const dup = buildCohortUpdate(r1.store, {
      dayKey: '2026-07-06', target: 4, runId: 'run-a', at: 't2',
      evaluations: [clean(1), gappy(1)],
    })
    expect(dup.duplicate).toBe(true)
    expect(dup.goal_reached_now).toBe(false)
    // Counters untouched — the old fold double-counted these.
    expect(dup.day.evaluated).toBe(2)
    expect(dup.day.clean).toBe(1)
    expect(dup.day.issues).toBe(1)
    expect(dup.day.finding_types).toEqual(r1.day.finding_types)
    expect(dup.day.issue_examples.length).toBe(r1.day.issue_examples.length)
    expect(dup.day.runs).toEqual(['run-a'])
    expect(dup.store).toEqual(r1.store)
  })

  it('a duplicate fold can never fabricate day.complete or fire the goal', () => {
    // target 2, one clean profile folded once: incomplete, no goal.
    const r1 = buildCohortUpdate(null, {
      dayKey: '2026-07-06', target: 2, runId: 'run-a', evaluations: [clean(1)],
    })
    expect(r1.goal_reached_now).toBe(false)
    // Old bug: re-folding run-a pushed evaluated to 2 → complete + all_clean →
    // goal_reached_now true → false one-shot owner GOAL notification.
    const dup = buildCohortUpdate(r1.store, {
      dayKey: '2026-07-06', target: 2, runId: 'run-a', evaluations: [clean(1)],
    })
    expect(dup.duplicate).toBe(true)
    expect(dup.day.evaluated).toBe(1)
    expect(dup.day.complete).toBe(false)
    expect(dup.goal_reached_now).toBe(false)
  })

  it('an issue example retains the finding EVIDENCE, not only type counts', () => {
    // The synthetic profiles and their match rows are reaped next run, so the
    // cohort store is the ONLY thing that outlives a failed day. Measured
    // 2026-08-02: the 2026-08-01 day's 13 issues retained only {category,
    // types} — not one missed school name or accepted ineligible title was
    // attributable post-hoc. The excerpt must survive, bounded.
    const r = buildCohortUpdate(null, {
      dayKey: '2026-07-07', target: 1, runId: 'run-e',
      evaluations: [{
        scenario_id: 'hs1', label: 'High School Student', category: 'high_school_student', status: 'ok',
        findings: [
          {
            type: 'institution_recall_miss',
            message: 'student committed to MTSU but 0 of 12 results reference the school',
            excerpt: 'schools=[Middle Tennessee State University] field=Computer Science',
          },
          { type: 'amount_recall_miss', message: 'no excerpt on this one' },
        ],
      }],
    })
    const ex = r.day.issue_examples[0]
    expect(ex.findings.length).toBe(2)
    expect(ex.findings[0].type).toBe('institution_recall_miss')
    expect(ex.findings[0].excerpt).toContain('Middle Tennessee State University')
    // excerpt falls back to message, and is BOUNDED
    expect(ex.findings[1].excerpt).toBe('no excerpt on this one')
    const long = buildCohortUpdate(null, {
      dayKey: '2026-07-07', target: 1,
      evaluations: [{
        scenario_id: 'x', label: 'X', category: 'veteran', status: 'ok',
        findings: [{ type: 'weak_match', excerpt: 'y'.repeat(5000) }],
      }],
    })
    expect(long.day.issue_examples[0].findings[0].excerpt.length).toBeLessThanOrEqual(240)
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

  it('recording the SAME runId twice leaves the store unchanged and never notifies', async () => {
    const db = freshDb()
    const sent = []
    const send = async (msg) => { sent.push(msg); return { ok: true } }
    const now = new Date('2026-07-06T15:00:00Z')

    const r1 = await recordFlywheelCohort(db, { evaluations: [clean(1)], runId: 'run-1', now, target: 2, send })
    expect(r1.ok).toBe(true)
    expect(r1.duplicate).toBe(false)

    // Old bug: this duplicate fold pushed evaluated to target → complete +
    // all_clean → one-shot GOAL email fired on inflated numbers.
    const r2 = await recordFlywheelCohort(db, { evaluations: [clean(1)], runId: 'run-1', now, target: 2, send })
    expect(r2.ok).toBe(true)
    expect(r2.duplicate).toBe(true)
    expect(r2.goal_reached).toBe(false)
    expect(r2.notified).toBe(false)
    expect(sent.length).toBe(0)

    const store = await getFlywheelCohort(db)
    const day = store.days['2026-07-06']
    expect(day.evaluated).toBe(1)
    expect(day.clean).toBe(1)
    expect(day.issues).toBe(0)
    expect(day.runs).toEqual(['run-1'])
    expect(store.goal_notified_at).toBe(null)
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
        {
          lever: 'relevance_precision',
          category: 'foster_youth',
          actionability: 'owner_api',
          requires_approval: true,
          apply_surface: 'POST /api/amy/relevance-vocabulary',
          nights_open: 12,
          first_seen_at: '2026-07-19T04:00:00Z',
          stale: true,
        },
        { lever: 'scoring_weights', actionability: 'auto', requires_approval: false, auto_applied: { kept: true } },
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

  // ── the write-only-queue fix (2026-08-01) ────────────────────────────────
  // Prod carried a non-empty queue for 20 consecutive runs and the report
  // rendered six identical ageless "Needs your approval" lines, so night 1 and
  // night 30 read the same. These assertions FAIL on the pre-fix summarizer.
  it('an owner ask carries its AGE and the surface that closes it', () => {
    const fw = summarizeAmyFlywheel(amy)
    const line = fw.couldNot.find((l) => l.includes('foster_youth'))
    expect(line).toMatch(/open 12 nights/)
    expect(line).toMatch(/since 2026-07-19/)
    expect(line).toMatch(/STALE/)
    expect(line).toMatch(/POST \/api\/amy\/relevance-vocabulary/)
  })

  it('a CODE-CHANGE lever is never rendered as "Needs your approval"', () => {
    const fw = summarizeAmyFlywheel({
      ...amy,
      report: {
        ...amy.report,
        approval_queue: [{
          lever: 'eligibility_gate',
          category: 'homeschool_family',
          actionability: 'code_change',
          requires_approval: false,
          human_gate_reason: 'The eligibility gate is code in the canonical match engine.',
          nights_open: 3,
        }],
      },
    })
    const text = fw.couldNot.join(' ')
    expect(text).toMatch(/Needs a CODE change \(no approval can close this\): eligibility_gate for homeschool_family/)
    expect(text).not.toMatch(/Needs your approval: eligibility_gate/)
  })

  it('a CLOSED ledger item is reported as an edit — the loop CAN converge', () => {
    const fw = summarizeAmyFlywheel({
      ...amy,
      report: {
        ...amy.report,
        approval_queue: [],
        approval_ledger: {
          closed: [{ id: 'scoring:tribal_org', lever: 'scoring_weights', category: 'tribal_org', resolution: 'stopped_reproducing', nights_open: 4 }],
          stale: [],
        },
      },
    })
    expect(fw.edits.join(' ')).toMatch(/1 approval item\(s\) CLOSED/)
    expect(fw.edits.join(' ')).toMatch(/scoring_weights\/tribal_org \(4n\)/)
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
