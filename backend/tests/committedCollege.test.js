/**
 * Unit tests for backend/services/college/committedCollege.js
 *
 * Covers the load-bearing committed-college logic: resolution, the
 * "commit archives the others" rule, undo, and the financial-aid workspace
 * aggregation (incl. unmet-need math and not-committed/empty handling).
 */

import { describe, it, expect } from 'vitest'
import {
  isCommittedStatus,
  resolveCommittedCollege,
  activeNonCommitted,
  commitToCollege,
  uncommitArchived,
  buildCollegeAidWorkspace,
  addAidEntry,
  updateAidEntry,
  removeAidEntry,
  aidIsSecured,
} from '../services/college/committedCollege.js'

const uni = (apps) => ({ applications: apps })
const app = (id, name, status, extra = {}) => ({ id, name, status, ...extra })

describe('isCommittedStatus', () => {
  it('recognizes committed-family statuses', () => {
    expect(isCommittedStatus('committed')).toBe(true)
    expect(isCommittedStatus('Enrolled')).toBe(true)
    expect(isCommittedStatus('accepted')).toBe(false)
    expect(isCommittedStatus('')).toBe(false)
  })
})

describe('resolveCommittedCollege', () => {
  it('returns null when none committed', () => {
    expect(resolveCommittedCollege(uni([app('1', 'A', 'accepted')]))).toBeNull()
  })
  it('picks the highest-ranked committed school', () => {
    const r = resolveCommittedCollege(uni([
      app('1', 'A', 'committed'),
      app('2', 'B', 'enrolled'), // higher rank
    ]))
    expect(r.id).toBe('2')
  })
})

describe('commitToCollege', () => {
  it('archives every other active college and commits the chosen one', () => {
    const section = uni([
      app('1', 'Alpha', 'accepted'),
      app('2', 'Beta', 'planning'),
      app('3', 'Gamma', 'rejected'), // terminal — untouched
    ])
    const r = commitToCollege(section, '1', { now: '2026-06-18T00:00:00Z' })
    expect(r.ok).toBe(true)
    const byId = Object.fromEntries(r.section.applications.map((a) => [a.id, a]))
    expect(byId['1'].status).toBe('committed')
    expect(byId['1'].committed_at).toBe('2026-06-18T00:00:00Z')
    expect(byId['2'].status).toBe('archived')
    expect(byId['2'].previous_status).toBe('planning')
    expect(byId['2'].archived_reason).toBe('committed_elsewhere')
    expect(byId['3'].status).toBe('rejected') // terminal untouched
    expect(r.archived).toEqual(['2'])
  })

  it('errors on unknown college id and leaves the section unchanged', () => {
    const section = uni([app('1', 'Alpha', 'accepted')])
    const r = commitToCollege(section, 'nope')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('college_not_found')
    expect(r.section).toBe(section)
  })

  it('is idempotent when re-committing the same college', () => {
    const section = uni([app('1', 'Alpha', 'accepted'), app('2', 'Beta', 'planning')])
    const once = commitToCollege(section, '1', { now: 't1' })
    const twice = commitToCollege(once.section, '1', { now: 't2' })
    const a1 = twice.section.applications.find((a) => a.id === '1')
    expect(a1.status).toBe('committed')
    expect(a1.committed_at).toBe('t1') // preserved, not overwritten
    expect(twice.section.applications.find((a) => a.id === '2').status).toBe('archived')
  })
})

describe('aid pipeline (add/update/remove)', () => {
  const committedUni = () => commitToCollege(
    uni([app('1', 'State U', 'accepted'), app('2', 'Other', 'planning')]), '1', { now: 't0' },
  ).section

  it('addAidEntry appends a normalized entry to the committed college', () => {
    const r = addAidEntry(committedUni(), { name: 'Provost', amount: '5000', status: 'awarded' }, { id: 'x1', now: 't1' })
    expect(r.ok).toBe(true)
    const c = resolveCommittedCollege(r.section)
    expect(c.financial_aid_pipeline).toHaveLength(1)
    expect(c.financial_aid_pipeline[0]).toMatchObject({ id: 'x1', name: 'Provost', amount: 5000, status: 'awarded' })
  })

  it('addAidEntry requires a committed college and a name', () => {
    const noCommit = uni([app('1', 'A', 'accepted')])
    expect(addAidEntry(noCommit, { name: 'X' }, { id: 'i' }).error).toBe('no_committed_college')
    expect(addAidEntry(committedUni(), { name: '   ' }, { id: 'i' }).error).toBe('name_required')
  })

  it('updateAidEntry patches an entry; removeAidEntry deletes it', () => {
    const added = addAidEntry(committedUni(), { name: 'Provost', amount: 5000, status: 'applied' }, { id: 'x1', now: 't1' })
    const upd = updateAidEntry(added.section, 'x1', { status: 'awarded', amount: 5500 }, { now: 't2' })
    expect(upd.ok).toBe(true)
    expect(resolveCommittedCollege(upd.section).financial_aid_pipeline[0]).toMatchObject({ status: 'awarded', amount: 5500 })
    expect(aidIsSecured(upd.entry)).toBe(true)

    const rem = removeAidEntry(upd.section, 'x1')
    expect(rem.ok).toBe(true)
    expect(resolveCommittedCollege(rem.section).financial_aid_pipeline).toHaveLength(0)
    expect(removeAidEntry(rem.section, 'x1').error).toBe('aid_entry_not_found')
  })
})

describe('uncommitArchived', () => {
  it('restores an archived college to its previous status', () => {
    const committed = commitToCollege(uni([app('1', 'A', 'accepted'), app('2', 'B', 'applied')]), '1', { now: 't' })
    const restored = uncommitArchived(committed.section, '2')
    const a2 = restored.section.applications.find((a) => a.id === '2')
    expect(a2.status).toBe('applied')
    expect(a2.archived_reason).toBeUndefined()
  })
})

describe('buildCollegeAidWorkspace', () => {
  it('reports not-committed with a candidate count', () => {
    const ws = buildCollegeAidWorkspace({ sections: { university_applications: uni([app('1', 'A', 'accepted'), app('2', 'B', 'planning')]) } })
    expect(ws.committed).toBe(false)
    expect(ws.candidate_count).toBe(2)
  })

  it('aggregates COA, FAFSA, aid, matched funding, and unmet need', () => {
    const sections = {
      university_applications: uni([
        app('1', 'State U', 'committed', {
          city: 'Columbus', state: 'OH', website_url: 'https://stateu.edu',
          costs: { tuition: 12000, housing: 8000, books: 1000, other: 1000, total: 22000 },
          financial_aid_pipeline: [{ name: 'Pell', amount: 5000 }, { name: 'Merit', amount: 3000 }],
        }),
        app('2', 'Other', 'archived', { previous_status: 'accepted' }),
      ]),
      education: { fafsa_completed: true, pell_grant_eligible: true, efc_sai_band: '0-1000' },
    }
    const ws = buildCollegeAidWorkspace({
      sections,
      matchedFunding: [{ title: 'Local Scholarship', amount: 2000 }],
      hamiltonTasks: [{ id: 't1', status: 'in_progress' }, { id: 't2', status: 'blocked_login_required', blocker_type: 'login_required' }],
    })
    expect(ws.committed).toBe(true)
    expect(ws.college).toMatchObject({ id: '1', name: 'State U', state: 'OH' })
    expect(ws.cost_of_attendance.total).toBe(22000)
    expect(ws.aid.received_total).toBe(8000) // 5000 + 3000
    expect(ws.matched_funding).toMatchObject({ count: 1, total: 2000 })
    expect(ws.unmet_need).toBe(12000) // 22000 - 8000 - 2000
    expect(ws.fafsa.completed).toBe(true)
    expect(ws.hamilton).toMatchObject({ total: 2, in_progress: 1, blocked: 1 })
    expect(ws.hamilton.blockers[0]).toMatchObject({ task_id: 't2', blocker_type: 'login_required' })
    expect(ws.archived_colleges).toEqual([{ id: '2', name: 'Other', previous_status: 'accepted' }])
  })

  it('counts only secured aid toward received_total; tracks applied-for separately', () => {
    const sections = {
      university_applications: uni([
        app('1', 'State U', 'committed', {
          costs: { total: 30000 },
          financial_aid_pipeline: [
            { id: 'a', name: 'Merit', amount: 6000, status: 'awarded' },
            { id: 'b', name: 'Legacy (no status)', amount: 2000 }, // legacy → secured
            { id: 'c', name: 'Foundation', amount: 4000, status: 'applied' }, // pending
            { id: 'd', name: 'Lost one', amount: 1000, status: 'declined' }, // ignored
          ],
        }),
      ]),
      education: { fafsa_completed: true },
    }
    const ws = buildCollegeAidWorkspace({ sections })
    expect(ws.aid.received_total).toBe(8000) // 6000 awarded + 2000 legacy
    expect(ws.aid.applied_total).toBe(4000)
    expect(ws.aid.applied_count).toBe(1)
    expect(ws.aid.total_in_play).toBe(12000) // awarded + applied
    expect(ws.unmet_need).toBe(18000) // 30000 - 8000 - 4000 (both awarded AND applied count)
    expect(ws.aid.pipeline.find((p) => p.id === 'a').secured).toBe(true)
    expect(ws.aid.pipeline.find((p) => p.id === 'c').secured).toBe(false)
  })

  it('flags FAFSA as a missing document + deadline when not filed, and unmet_need null without COA', () => {
    const sections = {
      university_applications: uni([app('1', 'No Cost U', 'committed', {})]),
      education: { fafsa_completed: false },
    }
    const ws = buildCollegeAidWorkspace({ sections })
    expect(ws.unmet_need).toBeNull()
    expect(ws.missing_documents.some((d) => d.key === 'fafsa')).toBe(true)
    expect(ws.deadlines.some((d) => d.key === 'fafsa')).toBe(true)
  })
})
