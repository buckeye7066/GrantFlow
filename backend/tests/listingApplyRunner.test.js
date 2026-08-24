import { describe, it, expect } from 'vitest'
import { makeListingApplyItem } from '../services/hamilton/listingApplyRunner.js'
import { decomposeListing } from '../services/hamilton/listingDecomposition.js'

const profile = { id: 'p1', basic_information: { first_name: 'A' } }
const listing = { url: 'https://bold.org/scholarships/category/housing', title: 'Housing', text: 't', links: [] }
const fakeInsert = () => { let n = 0; return async (_d, _r) => { n += 1; return { id: `opp-${n}`, inserted: true } } }
const enumOf = (items) => async () => ({ items, rejected: [], notFound: [] })

describe('makeListingApplyItem — consent forwarding, bound, evidence pass-through', () => {
  it('requires a runChildApply function', () => {
    expect(() => makeListingApplyItem({ allowAutoSubmit: true })).toThrow(/runChildApply/)
  })

  it('refuses when parent consent is not granted (never widens consent)', async () => {
    let called = 0
    const applyItem = makeListingApplyItem({ allowAutoSubmit: false, runChildApply: async () => { called += 1; return { status: 'submitted' } } })
    const r = await applyItem({ title: 'X', applyMarker: 'm0' }, { opportunityId: 'opp-1' })
    expect(called).toBe(0)
    expect(r).toMatchObject({ status: 'blocked', blocker_kind: 'apply_unauthorized' })
  })

  it('forwards consent VERBATIM and passes the child engine result through unchanged', async () => {
    const seen = []
    const applyItem = makeListingApplyItem({
      allowAutoSubmit: true,
      runChildApply: async (ctx) => { seen.push(ctx); return { status: 'submitted', confirmation_evidence: 'portal_reference' } },
    })
    const r = await applyItem({ title: 'Housing', applyMarker: 'm0' }, { opportunityId: 'opp-9' })
    expect(seen[0]).toMatchObject({ opportunityId: 'opp-9', allowAutoSubmit: true })
    expect(r).toMatchObject({ status: 'submitted', confirmation_evidence: 'portal_reference' })
  })

  it('bounds fan-out and never fabricates a submitted status on a child error', async () => {
    const applyItem = makeListingApplyItem({
      allowAutoSubmit: true, maxApplies: 1,
      runChildApply: async () => { throw new Error('browser died') },
    })
    const r1 = await applyItem({ title: 'A' }, { opportunityId: 'opp-1' })
    expect(r1).toMatchObject({ status: 'failed', blocker_kind: 'apply_error' })
    const r2 = await applyItem({ title: 'B' }, { opportunityId: 'opp-2' })
    expect(r2).toMatchObject({ blocker_kind: 'apply_fanout_capped' })
  })
})

describe('decomposeListing wired WITH the applyItem runner (gap 2)', () => {
  it('an ACCEPT with an in-SPA applyMarker (no applyUrl) now re-enters the apply flow', async () => {
    const applied = []
    const out = await decomposeListing(
      { db: {}, profile, listing },
      {
        enumerate: enumOf([{ title: 'Housing Security Scholarship', applyUrl: null, applyMarker: 'hamilton-apply-0' }]),
        insert: fakeInsert(),
        match: () => ({ decision: 'ACCEPT', score: 0.9 }),
        applyItem: makeListingApplyItem({
          allowAutoSubmit: true,
          runChildApply: async (ctx) => { applied.push(ctx.item.applyMarker); return { status: 'submitted', confirmation_evidence: 'portal_reference' } },
        }),
      },
    )
    // Before the fix this award (no applyUrl) was `accepted_no_apply_link`; now
    // its in-SPA marker is a real apply surface and it is applied.
    expect(applied).toEqual(['hamilton-apply-0'])
    expect(out.applies_attempted).toBe(1)
    expect(out.items[0].outcome).toBe('applied')
    expect(out.items[0].apply_marker).toBe('hamilton-apply-0')
  })
})
