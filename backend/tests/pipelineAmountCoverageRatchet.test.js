/**
 * pipelineAmountCoverageRatchet.test.js
 *
 * THE DEFECT: `pipeline.amountCoverage` only ever compared coverage to an
 * ABSOLUTE bar (`pct < 60`), so it printed the identical "LOW" line at 21%, at
 * 15% and at 18%. On 2026-07-16 a re-crawl bug wiped award amounts for hours and
 * drove coverage 21% → 15% — Sam said exactly what it says every other day, and
 * the owner had no way to tell "climbing back" from "actively being destroyed".
 *
 * A level tells you where you are. Only a TREND tells you which way you are
 * going — and this subsystem's characteristic failure is work being silently
 * undone. The web-parity benchmark next door already ratchets on regression
 * ("the system may only get better"); coverage never did.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  getCheckById,
  detectCoverageRegression,
  AMOUNT_COVERAGE_KV_KEY,
  AMOUNT_COVERAGE_REGRESSION_POINTS,
} from '../services/sam/samRegistry.js'

const check = () => getCheckById('pipeline.amountCoverage')

let db
beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE grants (id INTEGER PRIMARY KEY, status TEXT, amount_requested REAL, amount_min REAL, amount_max REAL);
    CREATE TABLE funding_opportunities (id INTEGER PRIMARY KEY, is_active INTEGER DEFAULT 1, amount_min REAL, amount_max REAL);
  `)
})

/** Seed N active grants, `withValue` of which carry a dollar value. */
function seedGrants(total, withValue) {
  const ins = db.prepare('INSERT INTO grants (status, amount_requested) VALUES (?, ?)')
  for (let i = 0; i < total; i++) ins.run('discovered', i < withValue ? 5000 : null)
  db.prepare('INSERT INTO funding_opportunities (is_active, amount_max) VALUES (1, 5000)').run()
}

const seedHistory = (runs) =>
  db.prepare('INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
    .run(AMOUNT_COVERAGE_KV_KEY, JSON.stringify({ updated_at: 'x', runs }), 'x')

describe('detectCoverageRegression', () => {
  it('flags a material drop', () => {
    expect(detectCoverageRegression(21, 15)).toMatchObject({ previous_pct: 21, current_pct: 15, delta: -6 })
  })
  it('ignores noise below the threshold', () => {
    expect(detectCoverageRegression(21, 19)).toBeNull()
  })
  it('never flags an improvement', () => {
    expect(detectCoverageRegression(15, 21)).toBeNull()
  })
  it('cannot flag on a first run (no previous reading to compare)', () => {
    expect(detectCoverageRegression(NaN, 15)).toBeNull()
    expect(detectCoverageRegression(undefined, 15)).toBeNull()
  })
})

describe('pipeline.amountCoverage ratchet', () => {
  it('reports the real 21% → 15% DROP that went unreported', async () => {
    // THE REGRESSION. Both readings are below the 60% bar, so the old check
    // returned the same "LOW" summary for each and the collapse was invisible.
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 21, with_value: 21, total: 100 }])
    seedGrants(100, 15)
    const res = await check().run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/DROPPED 6 points \(21% → 15%\)/)
    expect(res.evidence).toMatchObject({ previous_pct: 21, current_pct: 15, delta: -6 })
    // The fix must name the query that actually finds the culprit.
    expect(res.recommended_fix).toMatch(/record_origin/)
  })

  it('reports a DROP even when the level is HEALTHY (above the bar)', async () => {
    // 90% → 80% is still "fine" by the absolute bar, but something removed
    // amounts — which is a bug, not a backlog.
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 90, with_value: 90, total: 100 }])
    seedGrants(100, 80)
    const res = await check().run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/DROPPED 10 points/)
  })

  it('a DROP outranks LOW — going backwards is the more urgent fact', async () => {
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 21, with_value: 21, total: 100 }])
    seedGrants(100, 15)
    const res = await check().run({ db })
    expect(res.summary).toMatch(/DROPPED/)
    expect(res.summary).not.toMatch(/^Pipeline-\$ coverage LOW/)
  })

  it('still reports LOW (not a drop) when coverage is merely low and steady', async () => {
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 15, with_value: 15, total: 100 }])
    seedGrants(100, 15)
    const res = await check().run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/^Pipeline-\$ coverage LOW/)
  })

  it('goes GREEN while RECOVERING, so a climb is never mistaken for a fault', async () => {
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 62, with_value: 62, total: 100 }])
    seedGrants(100, 70)
    const res = await check().run({ db })
    expect(res.ok).toBe(true)
    expect(res.summary).toMatch(/was 62%/) // the trend is shown either way
  })

  it('records every reading so the NEXT run has something to compare against', async () => {
    seedGrants(100, 40)
    await check().run({ db })
    const runs = JSON.parse(db.prepare('SELECT value FROM system_kv WHERE key = ?').get(AMOUNT_COVERAGE_KV_KEY).value).runs
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ pct: 40, with_value: 40, total: 100 })
  })

  it('a first run cannot regress (no history) but still seeds the ratchet', async () => {
    seedGrants(100, 15)
    const res = await check().run({ db })
    expect(res.summary).toMatch(/^Pipeline-\$ coverage LOW/) // low, but not a "DROP"
    expect(res.summary).not.toMatch(/DROPPED/)
    const runs = JSON.parse(db.prepare('SELECT value FROM system_kv WHERE key = ?').get(AMOUNT_COVERAGE_KV_KEY).value).runs
    expect(runs).toHaveLength(1)
  })

  it('stays quiet below the noise threshold (churn must not cry wolf)', async () => {
    // The pipeline denominator moves on its own as Amy's synthetics rotate; a
    // couple of points of wobble is not a defect and must not page the owner.
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 64, with_value: 64, total: 100 }])
    seedGrants(100, 64 - (AMOUNT_COVERAGE_REGRESSION_POINTS - 1))
    const res = await check().run({ db })
    expect(res.ok).toBe(true)
  })

  it('does not fail the check when the ratchet store is unreadable', async () => {
    db.prepare('INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
      .run(AMOUNT_COVERAGE_KV_KEY, 'not json{{', 'x')
    seedGrants(100, 70)
    const res = await check().run({ db })
    expect(res.ok).toBe(true) // a broken ratchet must never break the reading
  })
})
