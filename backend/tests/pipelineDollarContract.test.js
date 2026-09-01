import Database from 'better-sqlite3'
import { describe, it, expect } from 'vitest'
import {
  PIPELINE_ACTIVE_STATUSES,
  pipelineValueSql,
  pipelineDollarSql,
  grantPipelineValue,
  grantPipelineDollarValue,
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
  it('zeros ineligible and REJECT rows; counts direct grants', () => {
    const db = setupDb()
    db.prepare('INSERT INTO funding_opportunities (id, opportunity_kind) VALUES (?,?)').run('o1', 'direct')
    db.prepare('INSERT INTO grants (id, profile_id, status, amount_requested, funding_opportunity_id) VALUES (?,?,?,?,?)').run('g1', 'p1', 'submitted', 5000, 'o1')
    db.prepare('INSERT INTO grants (id, profile_id, status, amount_requested, eligibility_status, funding_opportunity_id) VALUES (?,?,?,?,?,?)').run('g2', 'p1', 'submitted', 5000, 'ineligible', 'o1')
    db.prepare('INSERT INTO grants (id, profile_id, status, amount_requested, match_decision, funding_opportunity_id) VALUES (?,?,?,?,?,?)').run('g3', 'p1', 'submitted', 5000, 'REJECT', 'o1')

    const totalSql = db.prepare(`SELECT SUM(${pipelineDollarSql('g','fo')}) AS t
                                   FROM grants g LEFT JOIN funding_opportunities fo ON fo.id=g.funding_opportunity_id
                                  WHERE g.status IN (${PIPELINE_ACTIVE_STATUSES.map(()=>'\'submitted\'').join(', ')})`).get().t
    expect(totalSql).toBe(5000)

    // JS twins
    const rows = db.prepare('SELECT g.*, fo.opportunity_kind FROM grants g LEFT JOIN funding_opportunities fo ON fo.id=g.funding_opportunity_id').all()
    const js = rows.reduce((s, r) => s + grantPipelineDollarValue(r), 0)
    expect(js).toBe(5000)
  })

  it('zeros pointer/benefit kinds, leaves unknown legacy kinds eligible', () => {
    const db = setupDb()
    const kinds = ['directory','referral','school_portal','past_award_intel','benefit']
    for (const [i, k] of kinds.entries()) {
      const oid = `ok${i}`, gid = `gk${i}`
      db.prepare('INSERT INTO funding_opportunities (id, opportunity_kind) VALUES (?,?)').run(oid, k)
      db.prepare('INSERT INTO grants (id, profile_id, status, amount_requested, funding_opportunity_id) VALUES (?,?,?,?,?)').run(gid, 'p1', 'submitted', 2000, oid)
    }
    // legacy/unknown kind → counts
    db.prepare('INSERT INTO funding_opportunities (id, opportunity_kind) VALUES (?,?)').run('oz', null)
    db.prepare('INSERT INTO grants (id, profile_id, status, amount_max, amount_min, funding_opportunity_id) VALUES (?,?,?,?,?,?)').run('gz', 'p1', 'submitted', 3000, 1000, 'oz')

    const total = db.prepare(`SELECT SUM(${pipelineDollarSql('g','fo')}) AS t
                                FROM grants g LEFT JOIN funding_opportunities fo ON fo.id=g.funding_opportunity_id
                               WHERE g.status='submitted'`).get().t
    expect(total).toBe(3000) // only the unknown/legacy row contributes (max fallback)
  })

  it('grantPipelineValue fallback holds (requested → max → min), wide-range noted by constant', () => {
    const a = { amount_requested: 6500 }
    const b = { amount_max: 5000 }
    const c = { amount_min: 1000 }
    expect(grantPipelineValue(a)).toBe(6500)
    expect(grantPipelineValue(b)).toBe(5000)
    expect(grantPipelineValue(c)).toBe(1000)
    // Wide-range behavior is enforced at WRITE/BACKFILL; this file pins contract pieces exist
    expect(PIPELINE_ACTIVE_STATUSES).toContain('submitted')
    // And SQL fragments compile
    expect(typeof pipelineValueSql()).toBe('string')
    expect(typeof pipelineDollarSql('g','fo')).toBe('string')
  })
})

