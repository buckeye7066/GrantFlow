/**
 * overlayLiveAmountKnowledge — the flywheel's deduped-row honesty fix.
 *
 * Every discovery run starts from a blank memory store, so a recommendation
 * carries only what THIS crawl extracted — while the live catalog row it lands
 * on (by canonical identity) may already hold the amount the nightly sweeps
 * learned, or a directory/benefit kind classification. Amy's amount-recall
 * evaluator then counted a miss on an amount GrantFlow already knows and
 * displays (amount_recall_miss ×31, prod cohort 2026-07-24), and the
 * DIRECTORY/BENEFIT exclusion could not fire on deduped rows whose fresh
 * extraction carried no kind.
 *
 * Contract under test: FILL-GAPS ONLY (a live answer fills silence, never
 * overwrites an extracted fact), with the one tug-of-war exception — a live
 * 'directory'/'benefit' classification outranks a generic machine stamp,
 * mirroring fundingOpportunityConflictExpr's never-downgrade rule.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { overlayLiveAmountKnowledge } from '../services/crawlerOsService.js'
import { evaluateDiscovery } from '../services/amy/amyReport.js'

function makeDb(rows = []) {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, amount_min REAL, amount_max REAL,
      amount_status TEXT, opportunity_kind TEXT
    );
  `)
  const ins = raw.prepare(
    'INSERT INTO funding_opportunities (id, amount_min, amount_max, amount_status, opportunity_kind) VALUES (?, ?, ?, ?, ?)',
  )
  for (const r of rows) ins.run(r.id, r.amount_min ?? null, r.amount_max ?? null, r.amount_status ?? null, r.opportunity_kind ?? null)
  raw.dialect = 'sqlite'
  return raw
}

const rec = (extra = {}) => ({
  opportunity_id: 'os-1', title: 'Program', sponsor: 'Agency', kind: null,
  amount_min: null, amount_max: null, amount_status: null,
  match_score: 40, decision: 'REVIEW', ...extra,
})

describe('overlayLiveAmountKnowledge', () => {
  it('fills a silent rec with the live row amount, following the os→live id remap', async () => {
    const db = makeDb([{ id: 'live-1', amount_max: 5000, amount_status: 'known' }])
    const recs = [rec()]
    const out = await overlayLiveAmountKnowledge(db, recs, new Map([['os-1', 'live-1']]))
    expect(recs[0].amount_max).toBe(5000)
    expect(recs[0].amount_status).toBe('known')
    expect(out).toEqual({ checked: 1, enriched: 1 })
  })

  it('NEVER overwrites an amount this crawl extracted (fill-gaps only)', async () => {
    const db = makeDb([{ id: 'os-1', amount_min: 111, amount_max: 999 }])
    const recs = [rec({ amount_min: 1000, amount_max: 2500 })]
    await overlayLiveAmountKnowledge(db, recs, new Map())
    expect(recs[0].amount_min).toBe(1000)
    expect(recs[0].amount_max).toBe(2500)
  })

  it('a real live status replaces only SILENCE; live silence replaces nothing', async () => {
    const db = makeDb([
      { id: 'a', amount_status: 'none_published' },
      { id: 'b', amount_status: 'not_listed' },
    ])
    const recs = [
      rec({ opportunity_id: 'a', amount_status: 'not_listed' }),
      rec({ opportunity_id: 'b', amount_status: 'varies' }),
    ]
    await overlayLiveAmountKnowledge(db, recs, new Map())
    expect(recs[0].amount_status).toBe('none_published') // silence filled by a read denial
    expect(recs[1].amount_status).toBe('varies') // live silence never clobbers an extracted fact
  })

  it("a live 'benefit'/'directory' classification outranks a generic stamp; a generic live kind fills only null", async () => {
    const db = makeDb([
      { id: 'a', opportunity_kind: 'benefit' },
      { id: 'b', opportunity_kind: 'DIRECT_GRANT' },
      { id: 'c', opportunity_kind: 'DIRECT_GRANT' },
    ])
    const recs = [
      rec({ opportunity_id: 'a', kind: 'PROGRAM' }), // tug-of-war: curated benefit wins
      rec({ opportunity_id: 'b', kind: 'SCHOLARSHIP' }), // generic live kind never overwrites
      rec({ opportunity_id: 'c', kind: null }), // generic live kind fills a null
    ]
    await overlayLiveAmountKnowledge(db, recs, new Map())
    expect(recs[0].kind).toBe('benefit')
    expect(recs[1].kind).toBe('SCHOLARSHIP')
    expect(recs[2].kind).toBe('DIRECT_GRANT')
  })

  it('a rec with no live row, and a failing db, both leave the rec exactly as extracted', async () => {
    const db = makeDb([])
    const recs = [rec()]
    const out = await overlayLiveAmountKnowledge(db, recs, new Map())
    expect(out.enriched).toBe(0)
    expect(recs[0].amount_max).toBeNull()

    const broken = { prepare: () => { throw new Error('boom') } }
    const recs2 = [rec()]
    const out2 = await overlayLiveAmountKnowledge(broken, recs2, new Map())
    expect(out2.enriched).toBe(0)
    expect(recs2[0].amount_max).toBeNull()
  })
})

describe('the flywheel false-miss class the overlay closes (amount_recall_miss ×31, 2026-07-24)', () => {
  const scenario = { scenario_id: 'sb-v1', category: 'business', label: 'Small Business', expected: { state: 'TN' } }
  const evaluate = (recommendations) =>
    evaluateDiscovery(scenario, 'p-amt', {
      run: { run_id: 'r', stored: recommendations.length, sources: [], recommendations },
      persisted: { opportunities: recommendations.length },
      thesis: { applicant_types: ['business'], needs: ['equipment'], location: { state: 'TN' } },
    })
  const fired = (ev) => ev.findings.some((f) => f.type === 'amount_recall_miss')
  const silentRecs = () =>
    Array.from({ length: 5 }, (_, i) => rec({ opportunity_id: `os-${i}`, title: `Program ${i}`, kind: 'PROGRAM', amount_status: 'not_listed' }))

  it('WITHOUT the overlay, a cohort deduped onto amount-carrying live rows still fires (the defect)', () => {
    expect(fired(evaluate(silentRecs())), 'baseline: the false miss the overlay exists to close').toBe(true)
  })

  it('WITH the overlay, an amount the live catalog already knows stops the false miss', async () => {
    const db = makeDb([{ id: 'live-3', amount_max: 25000, amount_status: 'known' }])
    const recs = silentRecs()
    await overlayLiveAmountKnowledge(db, recs, new Map([['os-3', 'live-3']]))
    expect(fired(evaluate(recs)), 'a known amount is not a recall miss').toBe(false)
  })

  it('WITH the overlay, live benefit/none_published classifications drain the measurable set', async () => {
    // 3 recs deduped onto rows classified 'benefit', 2 onto rows the sweep READ
    // and recorded an evidenced denial for → nothing measurable remains.
    const db = makeDb([
      { id: 'live-0', opportunity_kind: 'benefit' },
      { id: 'live-1', opportunity_kind: 'benefit' },
      { id: 'live-2', opportunity_kind: 'benefit' },
      { id: 'live-3', amount_status: 'none_published' },
      { id: 'live-4', amount_status: 'none_published' },
    ])
    const recs = silentRecs()
    await overlayLiveAmountKnowledge(db, recs, new Map(recs.map((r, i) => [r.opportunity_id, `live-${i}`])))
    expect(fired(evaluate(recs))).toBe(false)
  })

  it('the finding KEEPS ITS TEETH: live rows that know nothing leave a real miss firing', async () => {
    const db = makeDb(silentRecs().map((r, i) => ({ id: `live-${i}`, amount_status: 'not_listed' })))
    const recs = silentRecs()
    await overlayLiveAmountKnowledge(db, recs, new Map(recs.map((r, i) => [r.opportunity_id, `live-${i}`])))
    expect(fired(evaluate(recs)), 'the overlay must never manufacture cleanliness').toBe(true)
  })
})
