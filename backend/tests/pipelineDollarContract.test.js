import Database from 'better-sqlite3'
import { describe, it, expect } from 'vitest'
import {
  PIPELINE_ACTIVE_STATUSES,
  WIDE_AWARD_RANGE_RATIO,
  pipelineValueSql,
  pipelineDollarSql,
  grantPipelineValue,
  grantPipelineDollarValue,
  defaultPipelineRequestedAmount,
} from '../config/pipelineValue.js'

function setupDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, status TEXT,
      amount_requested NUMERIC, amount_min NUMERIC, amount_max NUMERIC,
      eligibility_status TEXT, match_decision TEXT,
      funding_opportunity_id TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, opportunity_kind TEXT
    );
  `)
  return db
}

describe('pipeline dollar contract', () => {
  it('zeros ineligible and REJECT rows case-insensitively while counting direct grants', () => {
    const db = setupDb()
    db.prepare('INSERT INTO funding_opportunities (id, opportunity_kind) VALUES (?,?)').run('o1', 'direct')
    db.prepare('INSERT INTO grants (id, profile_id, status, amount_requested, funding_opportunity_id) VALUES (?,?,?,?,?)').run('g1', 'p1', 'submitted', 5000, 'o1')
    db.prepare('INSERT INTO grants (id, profile_id, status, amount_requested, eligibility_status, funding_opportunity_id) VALUES (?,?,?,?,?,?)').run('g2', 'p1', 'submitted', 5000, 'INELIGIBLE', 'o1')
    db.prepare('INSERT INTO grants (id, profile_id, status, amount_requested, match_decision, funding_opportunity_id) VALUES (?,?,?,?,?,?)').run('g3', 'p1', 'submitted', 5000, 'reject', 'o1')

    // audit:allow dynamic-sql -- pipelineDollarSql is a compile-time literal helper; no user input flows here.
    const totalSql = db.prepare(`SELECT SUM(${pipelineDollarSql('g', 'fo')}) AS t
                                   FROM grants g
                              LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
                                  WHERE g.status = 'submitted'`).get().t
    expect(totalSql).toBe(5000)

    const rows = db.prepare('SELECT g.*, fo.opportunity_kind FROM grants g LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id').all()
    expect(rows.reduce((sum, row) => sum + grantPipelineDollarValue(row), 0)).toBe(totalSql)
  })

  it('zeros every no-per-award kind while leaving unknown legacy kinds eligible', () => {
    const db = setupDb()
    const kinds = ['directory', 'referral', 'school_portal', 'past_award_intel', 'benefit']
    for (const [i, kind] of kinds.entries()) {
      const opportunityId = `kind-${i}`
      db.prepare('INSERT INTO funding_opportunities (id, opportunity_kind) VALUES (?,?)').run(opportunityId, kind)
      db.prepare('INSERT INTO grants (id, profile_id, status, amount_requested, funding_opportunity_id) VALUES (?,?,?,?,?)')
        .run(`grant-${i}`, 'p1', 'submitted', 2000, opportunityId)
    }

    db.prepare('INSERT INTO funding_opportunities (id, opportunity_kind) VALUES (?,?)').run('unknown', 'future_kind')
    db.prepare('INSERT INTO grants (id, profile_id, status, amount_max, amount_min, funding_opportunity_id) VALUES (?,?,?,?,?,?)')
      .run('unknown-grant', 'p1', 'submitted', 3000, 1000, 'unknown')

    // audit:allow dynamic-sql -- pipelineDollarSql is a compile-time literal helper; no user input flows here.
    const total = db.prepare(`SELECT SUM(${pipelineDollarSql('g', 'fo')}) AS t
                                FROM grants g
                           LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
                               WHERE g.status = 'submitted'`).get().t
    expect(total).toBe(3000)
  })

  it('repairs legacy wide-range ceilings at read time without discarding a distinct explicit ask', () => {
    const db = setupDb()
    db.prepare('INSERT INTO funding_opportunities (id, opportunity_kind) VALUES (?,?)').run('wide', 'direct')
    const insert = db.prepare(`
      INSERT INTO grants (
        id, profile_id, status, amount_requested, amount_min, amount_max, funding_opportunity_id
      ) VALUES (?, ?, 'submitted', ?, ?, ?, 'wide')
    `)
    insert.run('auto-ceiling', 'p1', 42_000_000, 1_000_000, 42_000_000)
    insert.run('explicit-ask', 'p1', 2_500_000, 1_000_000, 42_000_000)
    insert.run('ordinary-range', 'p1', 5_000, 1_000, 5_000)

    // audit:allow dynamic-sql -- pipelineDollarSql is a compile-time literal helper; no user input flows here.
    const rows = db.prepare(`SELECT g.*, fo.opportunity_kind,
                                    ${pipelineDollarSql('g', 'fo')} AS corrected_value
                               FROM grants g
                          LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
                              ORDER BY g.id`).all()
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]))

    expect(byId['auto-ceiling'].corrected_value).toBe(1_000_000)
    expect(byId['explicit-ask'].corrected_value).toBe(2_500_000)
    expect(byId['ordinary-range'].corrected_value).toBe(5_000)
    for (const row of rows) {
      expect(grantPipelineDollarValue(row)).toBe(row.corrected_value)
    }
  })

  it('uses one conservative writer default for both automatic and manual opportunity promotion', () => {
    // ordinary no ask -> ceiling
    expect(defaultPipelineRequestedAmount({ amount_min: 1_000, amount_max: 5_000 })).toBe(5_000)
    // wide no ask -> floor
    expect(defaultPipelineRequestedAmount({ amount_min: 1_000_000, amount_max: 42_000_000 })).toBe(1_000_000)
    // wide requested == ceiling -> floor
    expect(defaultPipelineRequestedAmount({
      amount_requested: 42_000_000,
      amount_min: 1_000_000,
      amount_max: 42_000_000,
    })).toBe(1_000_000)
    // wide distinct ask -> ask
    expect(defaultPipelineRequestedAmount({
      amount_requested: 2_500_000,
      amount_min: 1_000_000,
      amount_max: 42_000_000,
    })).toBe(2_500_000)
    // nulls -> null
    expect(defaultPipelineRequestedAmount({})).toBeNull()
    expect(WIDE_AWARD_RANGE_RATIO).toBe(10)
  })

  it('keeps the raw amount fallback separate from the user-facing contribution contract', () => {
    expect(grantPipelineValue({ amount_requested: 6500 })).toBe(6500)
    expect(grantPipelineValue({ amount_max: 5000 })).toBe(5000)
    expect(grantPipelineValue({ amount_min: 1000 })).toBe(1000)
    const a = { amount_requested: 6500 }
    const b = { amount_max: 5000 }
    const c = { amount_min: 1000 }
    expect(grantPipelineValue(a)).toBe(6500)
    expect(grantPipelineValue(b)).toBe(5000)
    expect(grantPipelineValue(c)).toBe(1000)
    expect(PIPELINE_ACTIVE_STATUSES).toContain('submitted')
    expect(typeof pipelineValueSql()).toBe('string')
    expect(typeof pipelineDollarSql('g', 'fo')).toBe('string')
  })
})
