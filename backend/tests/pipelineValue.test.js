import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  PIPELINE_ACTIVE_STATUSES,
  WIDE_AWARD_RANGE_RATIO,
  defaultPipelineRequestedAmount,
  grantCountsTowardPipelineDollars,
  pipelineValueSql,
  grantPipelineValue,
  unvaluedCountSql,
} from '../config/pipelineValue.js'

describe('pipelineValue choke point', () => {
  it('defaults wide program envelopes to the floor at write time', () => {
    expect(defaultPipelineRequestedAmount({ amount_min: 1000, amount_max: 5000 })).toBe(5000)
    expect(defaultPipelineRequestedAmount({ amount_min: 1_000_000, amount_max: 42_000_000 })).toBe(1_000_000)
    expect(defaultPipelineRequestedAmount({
      amount_requested: 2_500_000,
      amount_min: 1_000_000,
      amount_max: 42_000_000,
    })).toBe(2_500_000)
    expect(defaultPipelineRequestedAmount({})).toBeNull()
    expect(WIDE_AWARD_RANGE_RATIO).toBe(10)
  })

  it('grantPipelineValue is conservative for wide ranges and ignores rejected/non-award rows', () => {
    expect(grantPipelineValue({ amount_requested: 6500 })).toBe(6500)
    expect(grantPipelineValue({ amount_requested: null, amount_max: 5000, amount_min: 1000 })).toBe(5000)
    expect(grantPipelineValue({ amount_requested: 0, amount_max: 0, amount_min: 1000 })).toBe(1000)

    // Legacy writer signature: a >10x range with requested copied exactly from
    // the ceiling. The honest estimate is the floor, not the program envelope.
    expect(grantPipelineValue({
      amount_requested: 42_000_000,
      amount_min: 1_000_000,
      amount_max: 42_000_000,
    })).toBe(1_000_000)

    // A distinct explicit ask remains authoritative.
    expect(grantPipelineValue({
      amount_requested: 2_500_000,
      amount_min: 1_000_000,
      amount_max: 42_000_000,
    })).toBe(2_500_000)

    expect(grantPipelineValue({ amount_requested: 9000, eligibility_status: 'ineligible' })).toBe(0)
    expect(grantPipelineValue({ amount_requested: 9000, match_decision: 'REJECT' })).toBe(0)
    expect(grantPipelineValue({ amount_requested: 9000, opportunity_kind: 'directory' })).toBe(0)
    expect(grantPipelineValue({ amount_requested: 9000, opportunity_kind: 'benefit' })).toBe(0)
    expect(grantPipelineValue({ amount_requested: 9000, opportunity_kind: 'unknown_legacy_kind' })).toBe(9000)
    expect(grantPipelineValue({ amount_requested: 'n/a' })).toBe(0)
    expect(grantPipelineValue({})).toBe(0)
    expect(grantPipelineValue(null)).toBe(0)
  })

  it('pipelineValueSql and JS reconcile across direct, non-dollar, rejected, and wide-range rows', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY,
        opportunity_kind TEXT,
        amount_min NUMERIC,
        amount_max NUMERIC
      );
      CREATE TABLE grants (
        id TEXT,
        funding_opportunity_id TEXT,
        eligibility_status TEXT,
        match_decision TEXT,
        amount_requested NUMERIC,
        amount_min NUMERIC,
        amount_max NUMERIC
      );
    `)

    const insertOpportunity = db.prepare('INSERT INTO funding_opportunities VALUES (?, ?, ?, ?)')
    insertOpportunity.run('direct', 'direct', 1000, 5000)
    insertOpportunity.run('directory', 'directory', null, 500_000)
    insertOpportunity.run('benefit', 'benefit', null, 12_000)
    insertOpportunity.run('wide', 'direct', 1_000_000, 42_000_000)
    insertOpportunity.run('unknown', 'new_future_kind', 2000, 8000)

    const insert = db.prepare('INSERT INTO grants VALUES (?, ?, ?, ?, ?, ?, ?)')
    const rows = [
      ['requested', 'direct', null, 'ACCEPT', 6500, null, null],
      ['ordinary-range', 'direct', null, 'ACCEPT', null, 1000, 5000],
      ['wide-auto-ceiling', 'wide', null, 'ACCEPT', 42_000_000, 1_000_000, 42_000_000],
      ['wide-explicit-ask', 'wide', null, 'ACCEPT', 2_500_000, 1_000_000, 42_000_000],
      ['ineligible', 'direct', 'ineligible', 'ACCEPT', 99_000, null, null],
      ['rejected', 'direct', null, 'REJECT', 88_000, null, null],
      ['directory', 'directory', null, 'ACCEPT', 500_000, null, null],
      ['benefit', 'benefit', null, 'ACCEPT', 12_000, null, null],
      ['unknown-kind', 'unknown', null, 'ACCEPT', 8000, null, null],
      ['legacy-unlinked', null, null, 'ACCEPT', 3000, null, null],
      ['unvalued-direct', 'direct', null, 'ACCEPT', null, null, null],
    ]
    for (const row of rows) insert.run(...row)

    // audit:allow dynamic-sql — pipelineValueSql returns a compile-time literal fragment (no user input)
    const sqlTotal = db.prepare(`SELECT SUM(${pipelineValueSql('grants')}) AS t FROM grants`).get().t
    const joinedRows = db.prepare(`
      SELECT g.*, fo.opportunity_kind
      FROM grants g
      LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
    `).all()
    const jsTotal = joinedRows.reduce((sum, grant) => sum + grantPipelineValue(grant), 0)

    const expected = 6500 + 5000 + 1_000_000 + 2_500_000 + 8000 + 3000
    expect(sqlTotal).toBe(expected)
    expect(jsTotal).toBe(sqlTotal)

    // Un-aliased variant used by routes/stats.js.
    // audit:allow dynamic-sql — same compile-time literal fragment, un-aliased variant
    const bare = db.prepare(`SELECT SUM(${pipelineValueSql('')}) AS t FROM grants`).get().t
    expect(bare).toBe(sqlTotal)

    // Useful non-dollar resources remain visible in the "no fixed amount"
    // count. Explicitly rejected/ineligible rows do not.
    // audit:allow dynamic-sql — compile-time pipeline fragments only
    const unvalued = db.prepare(`SELECT ${unvaluedCountSql('grants')} AS n FROM grants`).get().n
    expect(unvalued).toBe(3) // directory + benefit + direct source with no stated amount
  })

  it('classifies dollar eligibility without treating an unknown kind as exclusion evidence', () => {
    expect(grantCountsTowardPipelineDollars({ opportunity_kind: 'direct' })).toBe(true)
    expect(grantCountsTowardPipelineDollars({ opportunity_kind: 'school_portal' })).toBe(false)
    expect(grantCountsTowardPipelineDollars({ opportunity_kind: 'past_award_intel' })).toBe(false)
    expect(grantCountsTowardPipelineDollars({ opportunity_kind: 'future_new_kind' })).toBe(true)
    expect(grantCountsTowardPipelineDollars({})).toBe(true)
  })

  it('active statuses exclude terminal stages and stay frozen', () => {
    for (const terminal of ['awarded', 'declined', 'closed', 'deadline_passed', 'archived']) {
      expect(PIPELINE_ACTIVE_STATUSES).not.toContain(terminal)
    }
    expect(Object.isFrozen(PIPELINE_ACTIVE_STATUSES)).toBe(true)
    expect(PIPELINE_ACTIVE_STATUSES).toContain('discovered')
    expect(PIPELINE_ACTIVE_STATUSES).toContain('submitted')
  })
})
