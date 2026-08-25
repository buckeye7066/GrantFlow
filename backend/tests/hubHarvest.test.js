import { describe, it, expect } from 'vitest'
import {
  harvestHub,
  enumerateHubAwards,
  isReportableSubmission,
  hubMatchedListUrl,
} from '../services/hamilton/hubHarvest.js'

// A profile with a declared need so the need gate has something to test against.
const profile = { id: 'p-robert', basic_information: { first_name: 'Robert' }, needs: ['education'] }

// A minimal fake Playwright page. goto/waitForLoadState/click are inert; the
// applyRunner is injected in the harvest tests so no real browser is needed.
function fakePage({ gotoThrows = false } = {}) {
  const clicks = []
  return {
    goto: async () => { if (gotoThrows) throw new Error('nav fail') },
    waitForLoadState: async () => {},
    click: async (sel) => { clicks.push(sel) },
    url: () => 'https://bold.org/dashboard/scholarships',
    _clicks: clicks,
  }
}

// Injectable enumerator returning the real bold.org card shapes the prior probe
// captured: an Apply BUTTON (no <a href>) yields applyUrl:null + an applyMarker.
function enumOf(awards) {
  return async () => ({ awards, applyControls: awards.map((a) => ({ marker: a.applyMarker, title: a.title, text: 'Apply' })) })
}
const fakeInsert = () => {
  let n = 0
  return async (_db, rec) => { n += 1; return rec.__reject ? { id: null, skipped: true, reason: 'reality:dead' } : { id: `opp-${n}`, inserted: true } }
}
const matchBy = (byTitle) => (_p, opp) => ({ decision: byTitle[opp.title] || 'REVIEW', score: 80 })
const needBy = (failTitles = []) => (opp) => ({ pass: !failTitles.includes(opp.title), detail: failTitles.includes(opp.title) ? 'uncovered' : 'matched' })

const AWARDS = [
  { title: 'Housing Security Scholarship', applyUrl: null, applyMarker: 'hamilton-apply-0', amount: 2000, sponsor: null },
  { title: 'First-Generation Fellowship', applyUrl: null, applyMarker: 'hamilton-apply-1', amount: 5000, sponsor: null },
  { title: 'Ineligible Award', applyUrl: null, applyMarker: 'hamilton-apply-2', amount: 1000, sponsor: null },
]

describe('isReportableSubmission — no evidence NEVER reads as submitted', () => {
  it('true only for status submitted WITH captured evidence', () => {
    expect(isReportableSubmission({ status: 'submitted', confirmation_evidence: 'portal_reference' })).toBe(true)
    expect(isReportableSubmission({ status: 'submitted', confirmation: { reference: 'CONF-9' } })).toBe(true)
    expect(isReportableSubmission({ status: 'submitted', confirmation: { received_acknowledgement: true } })).toBe(true)
  })
  it('false for a submit click with no captured evidence, and for any blocker', () => {
    expect(isReportableSubmission({ status: 'submitted' })).toBe(false)
    expect(isReportableSubmission({ status: 'submitted', confirmation: {} })).toBe(false)
    expect(isReportableSubmission({ status: 'blocked', blocker_kind: 'spa_apply_form_ready' })).toBe(false)
    expect(isReportableSubmission(null)).toBe(false)
  })
})

describe('hubMatchedListUrl', () => {
  it('resolves the configured hub list URLs and null for unknown hubs', () => {
    expect(hubMatchedListUrl('bold.org')).toMatch(/^https:\/\/bold\.org\//)
    expect(hubMatchedListUrl('scholarshipowl.com')).toMatch(/^https:\/\/scholarshipowl\.com\//)
    expect(hubMatchedListUrl('example.com')).toBeNull()
  })
})

describe('enumerateHubAwards — post-processing of the in-page card scrape', () => {
  it('keeps cards with real titles and builds per-award apply controls', async () => {
    // Simulate the in-page evaluate result for the real bold.org matched list.
    const page = { evaluate: async () => ([
      { title: 'Housing Security Scholarship', applyUrl: null, applyMarker: 'hamilton-apply-0', amount: 2000 },
      { title: 'tiny', applyUrl: null, applyMarker: 'hamilton-apply-1', amount: null }, // too short → dropped
      { title: 'First-Generation Fellowship', applyUrl: null, applyMarker: 'hamilton-apply-2', amount: 5000 },
    ]) }
    const { awards, applyControls } = await enumerateHubAwards(page, { maxAwards: 25 })
    expect(awards.map((a) => a.title)).toEqual(['Housing Security Scholarship', 'First-Generation Fellowship'])
    expect(awards[0].applyMarker).toBe('hamilton-apply-0')
    expect(applyControls).toHaveLength(2)
    expect(applyControls[0]).toMatchObject({ marker: 'hamilton-apply-0', title: 'Housing Security Scholarship' })
  })
  it('never throws when the page scrape fails', async () => {
    const page = { evaluate: async () => { throw new Error('detached frame') } }
    const r = await enumerateHubAwards(page, {})
    expect(r.awards).toEqual([])
  })
})

describe('harvestHub — enumerate → admit → 4-gate → apply', () => {
  it('an ACCEPT that covers a need AND is authorized reaches the apply path and reports submitted WITH evidence', async () => {
    const applied = []
    const out = await harvestHub(
      { db: {}, profile, hubKey: 'bold.org', page: fakePage(), allowAutoSubmit: true },
      {
        enumerate: enumOf(AWARDS),
        insert: fakeInsert(),
        match: matchBy({ 'Housing Security Scholarship': 'ACCEPT', 'First-Generation Fellowship': 'ACCEPT', 'Ineligible Award': 'REJECT' }),
        needCoverage: needBy(['First-Generation Fellowship']), // ACCEPT but need-fail
        applyRunner: async (_p, ctx) => { applied.push(ctx.item.title); return { status: 'submitted', confirmation_evidence: 'portal_reference' } },
      },
    )
    expect(out.enumerated).toBe(3)
    expect(out.admitted).toBe(3)
    // Only the ACCEPT + need-covered award reached apply.
    expect(applied).toEqual(['Housing Security Scholarship'])
    expect(out.applies_attempted).toBe(1)
    expect(out.submitted).toBe(1)
    const housing = out.items.find((i) => i.title === 'Housing Security Scholarship')
    expect(housing.outcome).toBe('submitted')
    // A REJECT never reaches the apply path.
    expect(out.items.find((i) => i.title === 'Ineligible Award').outcome).toBe('not_accepted')
    // An ACCEPT that fails the declared-need gate never reaches the apply path.
    expect(out.items.find((i) => i.title === 'First-Generation Fellowship').outcome).toBe('need_not_covered')
  })

  it('CONSENT IS NEVER WIDENED: without allow_auto_submit an ACCEPT is admitted+accepted but NEVER applied', async () => {
    const applied = []
    const out = await harvestHub(
      { db: {}, profile, hubKey: 'bold.org', page: fakePage(), allowAutoSubmit: false },
      {
        enumerate: enumOf([AWARDS[0]]),
        insert: fakeInsert(),
        match: matchBy({ 'Housing Security Scholarship': 'ACCEPT' }),
        needCoverage: needBy([]),
        applyRunner: async (_p, ctx) => { applied.push(ctx.item.title); return { status: 'submitted', confirmation_evidence: 'x' } },
      },
    )
    expect(applied).toEqual([]) // apply driver NEVER invoked
    expect(out.applies_attempted).toBe(0)
    expect(out.submitted).toBe(0)
    expect(out.items[0].outcome).toBe('accepted_apply_unauthorized')
  })

  it('a submit click WITHOUT captured evidence is submit_unconfirmed, NEVER submitted', async () => {
    const out = await harvestHub(
      { db: {}, profile, hubKey: 'bold.org', page: fakePage(), allowAutoSubmit: true },
      {
        enumerate: enumOf([AWARDS[0]]),
        insert: fakeInsert(),
        match: matchBy({ 'Housing Security Scholarship': 'ACCEPT' }),
        needCoverage: needBy([]),
        applyRunner: async () => ({ status: 'submitted' }), // status but NO evidence
      },
    )
    expect(out.submitted).toBe(0)
    expect(out.items[0].outcome).toBe('submit_unconfirmed')
  })

  it('bounds the apply fan-out with maxApplies', async () => {
    const applied = []
    const out = await harvestHub(
      { db: {}, profile, hubKey: 'bold.org', page: fakePage(), allowAutoSubmit: true, maxApplies: 1 },
      {
        enumerate: enumOf([AWARDS[0], AWARDS[1]]),
        insert: fakeInsert(),
        match: matchBy({ 'Housing Security Scholarship': 'ACCEPT', 'First-Generation Fellowship': 'ACCEPT' }),
        needCoverage: needBy([]),
        applyRunner: async (_p, ctx) => { applied.push(ctx.item.title); return { status: 'blocked', blocker_kind: 'spa_apply_form_ready' } },
      },
    )
    expect(out.applies_attempted).toBe(1)
    expect(applied).toHaveLength(1)
    expect(out.items.some((i) => i.outcome === 'apply_fanout_capped')).toBe(true)
  })

  it('reports honestly when the hub or session is missing (never throws)', async () => {
    const noHub = await harvestHub({ db: {}, profile, hubKey: 'nope.com', page: fakePage() })
    expect(noHub.notFound[0]).toMatch(/unknown scholarship hub/)
    const noPage = await harvestHub({ db: {}, profile, hubKey: 'bold.org', page: null })
    expect(noPage.notFound[0]).toMatch(/no authenticated browser page/)
  })
})
