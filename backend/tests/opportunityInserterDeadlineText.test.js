/**
 * Prod 2026-09-06: listing decomposition handed the inserter a funder's own
 * words — "April 1 each year" (afte.org), "Rolling / Open" and "Rolling"
 * (grantable.co) — as `deadline`, and Postgres refused the row
 * (`invalid input syntax for type date: "April 1 each year"`), so a genuinely
 * matching forensic-science scholarship ended `insert_error` and was never
 * matched. SQLite (the test dialect) accepts any text in a DATE column, which
 * is why no test had ever seen it. The parser below is the single choke point;
 * its deadline_type vocabulary is the column's CHECK list ('fixed' | 'rolling'
 * | 'ongoing' | 'unknown') and recurrence rides the lifecycle-contract column.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeDeadlineLike, upsertFundingOpportunity } from '../services/opportunityInserter.js'
import { buildOpportunityRecord } from '../services/hamilton/listingDecomposition.js'

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')
const NOW = new Date('2026-09-06T12:00:00Z')
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DEADLINE_TYPE_VOCAB = new Set(['fixed', 'rolling', 'ongoing', 'unknown'])

describe('normalizeDeadlineLike — a DATE column only ever receives a date', () => {
  it.each([
    ['April 1 each year', { deadline: '2027-04-01', deadline_type: 'fixed', recurrence: 'annual' }],
    ['Rolling / Open', { deadline: null, deadline_type: 'rolling', recurrence: null }],
    ['Rolling', { deadline: null, deadline_type: 'rolling', recurrence: null }],
    ['open until filled', { deadline: null, deadline_type: 'rolling', recurrence: null }],
    ['Applications accepted annually', { deadline: null, deadline_type: 'unknown', recurrence: 'annual' }],
    ['Deadline TBD', { deadline: null, deadline_type: null, recurrence: null }],
    ['', { deadline: null, deadline_type: null, recurrence: null }],
  ])('%s → %j', (input, expected) => {
    expect(normalizeDeadlineLike(input, { now: NOW })).toEqual(expected)
  })

  it('keeps real dates, in every shape a funder writes them', () => {
    expect(normalizeDeadlineLike('2026-09-18')).toEqual({ deadline: '2026-09-18', deadline_type: 'fixed', recurrence: null })
    expect(normalizeDeadlineLike('2026-09-18T04:00:00.000Z')).toEqual({ deadline: '2026-09-18T04:00:00.000Z', deadline_type: 'fixed', recurrence: null })
    expect(normalizeDeadlineLike('4/1/2026')).toEqual({ deadline: '2026-04-01', deadline_type: 'fixed', recurrence: null })
    expect(normalizeDeadlineLike('March 15, 2027')).toEqual({ deadline: '2027-03-15', deadline_type: 'fixed', recurrence: null })
    expect(normalizeDeadlineLike('1 April 2026')).toEqual({ deadline: '2026-04-01', deadline_type: 'fixed', recurrence: null })
    expect(normalizeDeadlineLike('Sept 30th, 2026')).toEqual({ deadline: '2026-09-30', deadline_type: 'fixed', recurrence: null })
  })

  it('a month-day with no year is the NEXT occurrence, never a past date', () => {
    expect(normalizeDeadlineLike('April 1', { now: new Date('2026-03-01T00:00:00Z') })).toEqual({ deadline: '2026-04-01', deadline_type: 'fixed', recurrence: 'annual' })
    expect(normalizeDeadlineLike('April 1', { now: new Date('2026-04-01T00:00:00Z') })).toEqual({ deadline: '2026-04-01', deadline_type: 'fixed', recurrence: 'annual' })
    expect(normalizeDeadlineLike('April 1', { now: new Date('2026-04-02T00:00:00Z') })).toEqual({ deadline: '2027-04-01', deadline_type: 'fixed', recurrence: 'annual' })
  })

  it('null / Date pass through', () => {
    expect(normalizeDeadlineLike(null)).toEqual({ deadline: null, deadline_type: null, recurrence: null })
    const d = new Date('2026-05-05T00:00:00Z')
    expect(normalizeDeadlineLike(d)).toEqual({ deadline: d, deadline_type: 'fixed', recurrence: null })
  })

  it('never emits a deadline_type outside the column CHECK vocabulary', () => {
    for (const v of ['April 1 each year', 'Rolling', 'annually', 'each spring', '2026-01-01', 'TBD', 'ongoing basis']) {
      const t = normalizeDeadlineLike(v, { now: NOW }).deadline_type
      expect(t === null || DEADLINE_TYPE_VOCAB.has(t), `${v} → ${t}`).toBe(true)
    }
  })
})

describe('upsertFundingOpportunity stores what the DATE column accepts', () => {
  it('the AFTE listing item lands with an ISO deadline, deadline_type fixed and recurrence annual', async () => {
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    const rec = buildOpportunityRecord({
      title: 'AFTE Scholarship',
      amount: 1500,
      sponsor: 'Association of Firearm and Tool Mark Examiners',
      deadline: 'April 1 each year',
      applyUrl: 'https://afte.org/about-afte/scholarship-program/',
      evidence: 'The AFTE Scholarship supports students pursuing forensic science and firearm and toolmark examination. Deadline April 1 each year.',
    }, { listingUrl: 'https://www.afte.org/scholarship' })
    const res = await upsertFundingOpportunity(db, rec, { verifyUrl: false, allowDirectories: true })
    expect(res.skipped, `record was gated: ${res.reason}`).toBeFalsy()
    const row = db.prepare('SELECT deadline, deadline_type, recurrence FROM funding_opportunities WHERE id = ?').get(res.id)
    expect(row.deadline).toMatch(ISO_DATE)
    expect(row.deadline_type).toBe('fixed')
    expect(row.recurrence).toBe('annual')
    db.close()
  })

  it('a rolling deadline lands as NULL with deadline_type rolling; a caller\'s own deadline_type wins', async () => {
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    const rec = buildOpportunityRecord({
      title: 'Technology Grants',
      amount: 5000,
      sponsor: 'Grantable',
      deadline: 'Rolling / Open',
      applyUrl: 'https://grantable.co/grants/technology-grants-1cfe4678fe3c',
      evidence: 'Technology Grants for organizations. Rolling / Open.',
    }, { listingUrl: 'https://grantable.co/grants/tennessee' })
    const res = await upsertFundingOpportunity(db, rec, { verifyUrl: false, allowDirectories: true })
    expect(res.skipped, `record was gated: ${res.reason}`).toBeFalsy()
    const row = db.prepare('SELECT deadline, deadline_type FROM funding_opportunities WHERE id = ?').get(res.id)
    expect(row.deadline).toBeNull()
    expect(row.deadline_type).toBe('rolling')

    const res2 = await upsertFundingOpportunity(db, { ...rec, title: 'Other Grants', application_url: 'https://grantable.co/grants/other-grants-9', source_url: 'https://grantable.co/grants/other-grants-9', final_url: 'https://grantable.co/grants/other-grants-9', deadline_type: 'fixed' }, { verifyUrl: false, allowDirectories: true })
    expect(res2.skipped, `record was gated: ${res2.reason}`).toBeFalsy()
    expect(db.prepare('SELECT deadline_type FROM funding_opportunities WHERE id = ?').get(res2.id).deadline_type).toBe('fixed')
    db.close()
  })
})
