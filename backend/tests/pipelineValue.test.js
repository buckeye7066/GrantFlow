import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  PIPELINE_ACTIVE_STATUSES,
  pipelineValueSql,
  grantPipelineValue,
} from '../config/pipelineValue.js'

describe('pipelineValue choke point', () => {
  it('grantPipelineValue falls back requested → max → min → 0 and ignores 0/garbage', () => {
    expect(grantPipelineValue({ amount_requested: 6500 })).toBe(6500)
    expect(grantPipelineValue({ amount_requested: null, amount_max: 5000, amount_min: 1000 })).toBe(5000)
    expect(grantPipelineValue({ amount_requested: 0, amount_max: 0, amount_min: 1000 })).toBe(1000)
    expect(grantPipelineValue({ amount_requested: 'n/a' })).toBe(0)
    expect(grantPipelineValue({})).toBe(0)
    expect(grantPipelineValue(null)).toBe(0)
  })

  it('pipelineValueSql matches grantPipelineValue semantics when run against SQL', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE grants (id TEXT, amount_requested NUMERIC, amount_min NUMERIC, amount_max NUMERIC)')
    const insert = db.prepare('INSERT INTO grants VALUES (?, ?, ?, ?)')
    const rows = [
      ['a', 6500, null, null],   // requested wins
      ['b', null, 1000, 5000],   // ceiling
      ['c', 0, 1000, 0],         // 0 is "unknown", floor wins
      ['d', null, null, null],   // honest zero
    ]
    for (const r of rows) insert.run(...r)

    // audit:allow dynamic-sql — pipelineValueSql returns a compile-time literal fragment (no user input)
    const sqlTotal = db.prepare(`SELECT SUM(${pipelineValueSql('grants')}) AS t FROM grants`).get().t
    const jsTotal = db.prepare('SELECT * FROM grants').all().reduce((s, g) => s + grantPipelineValue(g), 0)
    expect(sqlTotal).toBe(6500 + 5000 + 1000)
    expect(jsTotal).toBe(sqlTotal)

    // Un-aliased variant used by routes/stats.js.
    // audit:allow dynamic-sql — same compile-time literal fragment, un-aliased variant
    const bare = db.prepare(`SELECT SUM(${pipelineValueSql('')}) AS t FROM grants`).get().t
    expect(bare).toBe(sqlTotal)
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
