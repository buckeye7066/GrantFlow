/**
 * Funder-aware funding-lifecycle calendar events (owner rule 2026-08-23).
 * Every date is real or computed from a funder-stated rule; unknown cornerstones
 * are OMITTED, never invented.
 */
import { describe, it, expect } from 'vitest'
import { deriveLifecycleEvents, deriveLifecycleEventsForPipeline } from '../services/calendar/pipelineLifecycleEvents.js'

const byType = (evs) => Object.fromEntries(evs.map((e) => [e.type, e]))

describe('deriveLifecycleEvents', () => {
  it('a not-yet-submitted row shows only its upcoming application deadline', () => {
    const evs = deriveLifecycleEvents(
      { id: 'o1', title: 'The Coolidge Scholarship', sponsor: 'Coolidge Foundation', deadline: '2027-01-15', pipeline_status: 'discovered' },
      { today: '2026-12-01' },
    )
    const t = byType(evs)
    expect(t.apply_deadline.deadline).toBe('2027-01-15')
    expect(t.apply_deadline.title).toMatch(/Apply by: The Coolidge Scholarship/)
    expect(t.submitted).toBeUndefined()
    expect(t.expected_decision).toBeUndefined() // no funder decision date + not submitted
  })

  it('a past application deadline is not shown; rolling has no deadline event', () => {
    expect(deriveLifecycleEvents({ id: 'o', title: 'X', deadline: '2026-01-01' }, { today: '2026-12-01' })
      .some((e) => e.type === 'apply_deadline')).toBe(false)
    expect(deriveLifecycleEvents({ id: 'o', title: 'X', deadline: '2027-01-01', deadline_type: 'rolling' })
      .some((e) => e.type === 'apply_deadline')).toBe(false)
  })

  it('a SUBMITTED row shows the submission date and drops the (now-historical) apply deadline', () => {
    const evs = deriveLifecycleEvents({
      id: 'o2', title: 'U.S. Bank Scholarship', sponsor: 'U.S. Bank',
      deadline: '2026-08-25', submitted_date: '2026-08-23', pipeline_status: 'submitted',
    })
    const t = byType(evs)
    expect(t.submitted.deadline).toBe('2026-08-23')
    expect(t.submitted.title).toMatch(/Submitted: U.S. Bank Scholarship/)
    expect(t.apply_deadline).toBeUndefined()
  })

  it('a captured funder decision date is authoritative; an award date drops the expected-decision', () => {
    const withStated = deriveLifecycleEvents({ id: 'o', title: 'X', submitted_date: '2026-08-23', expected_decision_date: '2027-04-15' })
    expect(byType(withStated).expected_decision.deadline).toBe('2027-04-15')
    expect(byType(withStated).expected_decision.estimated).toBe(false)

    const awarded = deriveLifecycleEvents({ id: 'o', title: 'X', submitted_date: '2026-08-23', expected_decision_date: '2027-04-15', award_date: '2027-04-10' })
    expect(byType(awarded).expected_decision).toBeUndefined() // decided — the award date takes over
    expect(byType(awarded).awarded.deadline).toBe('2027-04-10')
  })

  it('with no funder decision date, an estimate is derived from a stated review length and LABELED estimated', () => {
    const evs = deriveLifecycleEvents({ id: 'o', title: 'X', submitted_date: '2026-08-23', decision_review_days: 90 })
    const ed = byType(evs).expected_decision
    expect(ed.deadline).toBe('2026-11-21') // 2026-08-23 + 90 days
    expect(ed.estimated).toBe(true)
    expect(ed.label).toMatch(/estimated/i)
  })

  it('with NO decision date and NO review length, the expected-decision cornerstone is OMITTED (never invented)', () => {
    const evs = deriveLifecycleEvents({ id: 'o', title: 'X', submitted_date: '2026-08-23' })
    expect(evs.some((e) => e.type === 'expected_decision')).toBe(false)
  })

  it('grant period start/end appear for a funded award', () => {
    const evs = deriveLifecycleEvents({ id: 'o', title: 'X', award_date: '2027-04-10', start_date: '2027-06-01', end_date: '2028-05-31' })
    const t = byType(evs)
    expect(t.grant_start.deadline).toBe('2027-06-01')
    expect(t.grant_end.deadline).toBe('2028-05-31')
  })

  it('a funder-required follow-up computes its due date from a real anchor (award + offset)', () => {
    const evs = deriveLifecycleEvents({
      id: 'o', title: 'STEM Innovation Grant', award_date: '2027-04-10',
      reporting_requirements: [{ label: '25% of the award spent', offset_days: 90, anchor: 'award_date' }],
    })
    const rep = evs.find((e) => e.type === 'reporting')
    expect(rep.deadline).toBe('2027-07-09') // 2027-04-10 + 90
    expect(rep.title).toMatch(/Report due — 25% of the award spent/)
  })

  it('an absolute due_date wins; a reporting rule with no resolvable date is SKIPPED (never guessed)', () => {
    const evs = deriveLifecycleEvents({
      id: 'o', title: 'X', // no award_date, no submitted_date
      reporting_requirements: [
        { label: 'Final report', due_date: '2028-01-31' },
        { label: 'Interim report', offset_days: 90, anchor: 'award_date' }, // no award_date → skip
      ],
    })
    const reps = evs.filter((e) => e.type === 'reporting')
    expect(reps).toHaveLength(1)
    expect(reps[0].deadline).toBe('2028-01-31')
  })

  it('reporting requirements accept a JSON string (as the crawler stores them)', () => {
    const evs = deriveLifecycleEvents({
      id: 'o', title: 'X', submitted_date: '2026-08-23',
      reporting_requirements: JSON.stringify([{ label: 'Progress report', offset_days: 180 }]),
    })
    expect(evs.find((e) => e.type === 'reporting').deadline).toBe('2027-02-19') // submitted + 180
  })

  it('the pipeline aggregator flattens + sorts by date', () => {
    const rows = [
      { id: 'a', title: 'A', deadline: '2027-03-01' },
      { id: 'b', title: 'B', submitted_date: '2026-08-23' },
    ]
    const evs = deriveLifecycleEventsForPipeline(rows, { today: '2026-08-01' })
    expect(evs.map((e) => e.deadline)).toEqual(['2026-08-23', '2027-03-01'])
  })
})
