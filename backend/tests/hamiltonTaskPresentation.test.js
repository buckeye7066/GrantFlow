/**
 * A task must arrive at the UI carrying a name a person can read, the reason
 * the system recorded for its outcome, and — for a submission — WHO submitted
 * it.
 *
 * All three were available and none were being sent. Measured on production
 * 2026-08-21: 594 of 931 tasks can resolve a title one join away; all 331
 * cancelled tasks carry a recorded reason in `last_agent_message`; and of the
 * 43 tasks reading `submitted`, 41 carry an event whose actor is `admin` with
 * the message "User marked this application submitted from the Application
 * Tracker" while only 17 `submitted` events anywhere are Hamilton's own.
 */
import { describe, it, expect } from 'vitest'
import {
  attachTaskPresentation,
  hostLabelFromUrl,
  resolveTaskIdentity,
  submissionActor,
  taskApplyUrl,
} from '../services/hamilton/hamiltonTaskPresentation.js'

/**
 * A minimal stand-in for the repo's db handle: `prepare(sql).all(...params)`.
 * Routing on the table name keeps the fixture readable.
 */
function fakeDb({ grants = [], opportunities = [], events = [] } = {}) {
  return {
    prepare(sql) {
      return {
        async all() {
          if (/FROM grants/i.test(sql)) return grants
          if (/FROM funding_opportunities/i.test(sql)) return opportunities
          if (/FROM application_task_events/i.test(sql)) return events
          return []
        },
      }
    },
  }
}

describe('task display identity', () => {
  it('prefers the grant title, then the opportunity title', () => {
    const maps = {
      titleMap: new Map([['grant:g1', 'Tennessee HOPE Aspire Award'], ['opp:o1', 'Something else']]),
      funderMap: new Map([['grant:g1', 'National Program']]),
      urlMap: new Map(),
    }
    const out = resolveTaskIdentity({ id: 't', grant_id: 'g1', opportunity_id: 'o1' }, maps)
    expect(out.display_title).toBe('Tennessee HOPE Aspire Award')
    expect(out.title_source).toBe('source_record')
    expect(out.funder_name).toBe('National Program')
  })

  it('falls back to the funder HOST, which is a real identifier', () => {
    const out = resolveTaskIdentity(
      { id: 't', application_url: 'https://www.studentaid.gov/understand-aid/types/grants/fseog' },
      {},
    )
    expect(out.display_title).toBe('studentaid.gov')
    expect(out.title_source).toBe('host')
  })

  it('never gives two nameless tasks the SAME label', () => {
    // This is the whole defect: 931 rows all reading "Untitled funding source".
    const a = resolveTaskIdentity({ id: 'aaaaaaaa-1111' }, {})
    const b = resolveTaskIdentity({ id: 'bbbbbbbb-2222' }, {})
    expect(a.display_title).not.toBe(b.display_title)
    expect(a.title_source).toBe('none')
  })

  it('never presents a search-results page as the place to apply', () => {
    expect(taskApplyUrl({ application_url: 'https://www.google.com/search?q=grants' })).toBeNull()
    expect(taskApplyUrl({ application_url: 'https://funder.org/apply' })).toBe('https://funder.org/apply')
  })

  it('reads a host the way a person recognises a funder', () => {
    expect(hostLabelFromUrl('https://www.questbridge.org/')).toBe('questbridge.org')
    expect(hostLabelFromUrl('ftp://x.org')).toBeNull()
    expect(hostLabelFromUrl('')).toBeNull()
  })
})

describe('who submitted it', () => {
  it('calls Hamilton\'s own agent-recorded submission Hamilton', () => {
    expect(submissionActor({ status: 'submitted' }, { actor_role: 'agent' })).toBe('hamilton')
  })

  it('calls a tracker click by a person the owner, not Hamilton', () => {
    expect(submissionActor({ status: 'submitted' }, { actor_role: 'admin' })).toBe('owner')
  })

  it('says "unrecorded" rather than guessing when no actor was stored', () => {
    expect(submissionActor({ status: 'submitted' }, null)).toBe('unrecorded')
    expect(submissionActor({ status: 'submitted' }, { actor_role: null })).toBe('unrecorded')
  })

  it('attributes nothing on a task that is not submitted', () => {
    expect(submissionActor({ status: 'cancelled' }, { actor_role: 'agent' })).toBeNull()
  })
})

describe('attachTaskPresentation', () => {
  it('resolves names, reasons and actors from the rows that hold them', async () => {
    const db = fakeDb({
      grants: [{ id: 'g1', title: 'QuestBridge National College Match', funder: 'National Program', application_url: 'https://www.questbridge.org/' }],
      opportunities: [{ id: 'o2', title: 'FSEOG', sponsor: 'Federal Student Aid', application_url: 'https://studentaid.gov/understand-aid/types/grants/fseog' }],
      events: [
        { task_id: 't-sub', event_type: 'submitted', actor_role: 'admin', message: 'User marked this application submitted from the Application Tracker.', created_at: '2026-08-03T05:29:00Z' },
        { task_id: 't-can', event_type: 'cancelled', actor_role: 'system', message: 'Closed by the junk audit', created_at: '2026-08-03T06:18:34Z' },
      ],
    })

    const out = await attachTaskPresentation(db, [
      {
        id: 't-sub',
        profile_id: 'p1',
        grant_id: 'g1',
        status: 'submitted',
        submitted_at: '2026-08-03T05:29:00Z',
        last_agent_message: null,
      },
      {
        id: 't-can',
        profile_id: 'p1',
        opportunity_id: 'o2',
        status: 'cancelled',
        last_agent_message: 'Cancelled by the 2026-08-03 eligibility/junk audit (dangling or profile-ineligible source).',
      },
    ])

    expect(out[0].display_title).toBe('QuestBridge National College Match')
    expect(out[0].submitted_by).toBe('owner')
    expect(out[0].terminal_actor_role).toBe('admin')

    expect(out[1].display_title).toBe('FSEOG')
    expect(out[1].funder_name).toBe('Federal Student Aid')
    // The reason was ALWAYS persisted. Surfacing it is the fix; inventing one
    // where none exists is forbidden.
    expect(out[1].outcome_reason).toMatch(/eligibility\/junk audit/)
    expect(out[1].submitted_by).toBeNull()
  })

  it('leaves outcome_reason null when nothing was recorded', async () => {
    const db = fakeDb({})
    const [row] = await attachTaskPresentation(db, [
      { id: 't', profile_id: 'p1', status: 'cancelled', last_agent_message: null },
    ])
    expect(row.outcome_reason).toBeNull()
  })

  it('survives a database that cannot answer, rather than losing the list', async () => {
    const brokenDb = {
      prepare() {
        return { async all() { throw new Error('no such column: g.source_url') } }
      },
    }
    const out = await attachTaskPresentation(brokenDb, [
      { id: 't', profile_id: 'p1', status: 'ready_to_start', application_url: 'https://funder.org/apply' },
    ])
    expect(out).toHaveLength(1)
    // It still finds a real identifier from the task's own row.
    expect(out[0].display_title).toBe('funder.org')
  })

  it('returns an empty list untouched', async () => {
    expect(await attachTaskPresentation(fakeDb({}), [])).toEqual([])
  })
})
