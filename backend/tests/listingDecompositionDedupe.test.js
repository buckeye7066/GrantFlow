/**
 * A DEDUPE HIT IS AN ADMISSION, NOT A DEAD END (prod 2026-09-06, a real
 * student profile). The canonical inserter answers `skipped:true` WITH the existing
 * row's id when an enumerated award is already in the catalog under another
 * source ("url_duplicate:web_search/null"). decomposeListing treated that as
 * `not_admitted` and never matched or applied for the award — 9 of 12 awards
 * on her HOPE/TELS and Buchanan listings ended that way. The existing row must
 * be carried forward: matched and (on ACCEPT) applied; and if THIS profile
 * already holds a task for it, that is said instead of minting a second one.
 */
import { describe, it, expect } from 'vitest'
import { decomposeListing } from '../services/hamilton/listingDecomposition.js'
import { describeDecomposition } from '../services/hamilton/hamiltonAutomationOrchestrator.js'

const profile = { id: 'profile-1', basic_information: { first_name: 'A' } }
const listing = { url: 'https://www.mtsu.edu/financial-aid/tels/', title: 'TELS', text: 'awards', links: [] }
const enumOf = (items) => async () => ({ items, rejected: [], notFound: [] })

const dedupeInsert = async () => ({ id: 'existing-hope', inserted: false, skipped: true, reason: 'url_duplicate:web_search/null' })

function fakeDb({ row = null, task = null } = {}) {
  return {
    prepare: (sql) => ({
      get: async () => (/FROM funding_opportunities/i.test(sql) ? row : task),
    }),
  }
}

const item = { title: 'HOPE Lottery Scholarship', applyUrl: 'https://www.collegefortn.org/tennessee-hope-scholarship/', sponsor: 'TSAC', amount: 2250 }

describe('decomposeListing — a dedupe hit carries the EXISTING row forward', () => {
  it('matches the stored row and applies on ACCEPT with the existing id', async () => {
    const applied = []
    const matched = []
    const out = await decomposeListing(
      { db: fakeDb({ row: { id: 'existing-hope', title: 'HOPE Scholarship', description: 'Full stored text', state: 'TN' } }), profile, listing },
      {
        enumerate: enumOf([item]),
        insert: dedupeInsert,
        match: (_p, opp) => { matched.push(opp); return { decision: 'ACCEPT', score: 90 } },
        applyItem: async (_i, { opportunityId }) => { applied.push(opportunityId); return { status: 'submitted' } },
      },
    )
    expect(out.admitted).toBe(1)
    expect(out.items[0]).toMatchObject({ outcome: 'applied', opportunity_id: 'existing-hope', existing_row: true, dedupe_reason: 'url_duplicate:web_search/null' })
    expect(applied).toEqual(['existing-hope'])
    // The STORED row's facts are what the engine judged (richer than the snippet),
    // with the snippet's own facts only filling blanks.
    expect(matched[0].description).toBe('Full stored text')
    expect(matched[0].state).toBe('TN')
    expect(matched[0].application_url).toBe('https://www.collegefortn.org/tennessee-hope-scholarship/')
  })

  it('never mints a second task: an existing task for this profile is reported, not re-applied', async () => {
    const applied = []
    const out = await decomposeListing(
      { db: fakeDb({ row: { id: 'existing-hope', title: 'HOPE Scholarship' }, task: { id: 'task-9', status: 'completed' } }), profile, listing },
      { enumerate: enumOf([item]), insert: dedupeInsert, match: () => ({ decision: 'ACCEPT', score: 90 }), applyItem: async (_i, { opportunityId }) => { applied.push(opportunityId) } },
    )
    expect(out.admitted).toBe(0)
    expect(applied).toEqual([])
    expect(out.items[0]).toMatchObject({ outcome: 'already_in_pipeline', opportunity_id: 'existing-hope', existing_task_id: 'task-9', existing_task_status: 'completed' })
    const summary = describeDecomposition(out, 0)
    expect(summary).toMatch(/already in the profile's pipeline/)
    expect(summary).toMatch(/HOPE Lottery Scholarship \(completed\)/)
  })

  it('a REJECT on the existing row is still not_accepted (the engine stays the sole authority)', async () => {
    const out = await decomposeListing(
      { db: fakeDb({ row: { id: 'existing-hope', title: 'HOPE Scholarship' } }), profile, listing },
      { enumerate: enumOf([item]), insert: dedupeInsert, match: () => ({ decision: 'REJECT', score: 0 }), applyItem: async () => { throw new Error('must not apply') } },
    )
    expect(out.items[0]).toMatchObject({ outcome: 'not_accepted', decision: 'REJECT', existing_row: true })
  })

  it('a real rejection (no id) is still not_admitted; a test double with no db is matched on the snippet', async () => {
    const rejected = await decomposeListing(
      { db: {}, profile, listing },
      { enumerate: enumOf([item]), insert: async () => ({ id: null, skipped: true, reason: 'reality:dead_url' }), match: () => ({ decision: 'ACCEPT', score: 90 }) },
    )
    expect(rejected.items[0]).toMatchObject({ outcome: 'not_admitted', detail: 'reality:dead_url' })

    const noDb = await decomposeListing(
      { db: {}, profile, listing },
      { enumerate: enumOf([item]), insert: dedupeInsert, match: () => ({ decision: 'ACCEPT', score: 90 }) },
    )
    expect(noDb.items[0]).toMatchObject({ outcome: 'accepted_apply_deferred', opportunity_id: 'existing-hope', existing_row: true })
  })
})
