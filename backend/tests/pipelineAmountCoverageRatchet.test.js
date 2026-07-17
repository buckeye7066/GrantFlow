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
    CREATE TABLE grants (id INTEGER PRIMARY KEY, status TEXT, amount_requested REAL, amount_min REAL, amount_max REAL,
                         amount_status TEXT, funding_opportunity_id INTEGER);
    CREATE TABLE funding_opportunities (id INTEGER PRIMARY KEY, is_active INTEGER DEFAULT 1, amount_min REAL, amount_max REAL,
                                        amount_status TEXT, amount_text TEXT, opportunity_kind TEXT,
                                        amount_enrich_attempted_at TEXT);
  `)
})

/**
 * Seed N active grants, `withValue` of which carry a dollar value.
 *
 * Every unvalued grant gets a LINKED catalog row that has been READ and honestly
 * denied (`none_published`) unless the caller says otherwise. That is the
 * realistic default — prod 2026-07-17: of 257 unvalued active rows, 186 were
 * already read-and-exhausted and only ONE had never been tried — and it keeps
 * these ratchet tests testing the RATCHET rather than tripping the answer census.
 */
function seedGrants(total, withValue, { unansweredFo = 0 } = {}) {
  const insFo = db.prepare(
    'INSERT INTO funding_opportunities (is_active, amount_status, amount_enrich_attempted_at) VALUES (1, ?, ?)',
  )
  const ins = db.prepare(
    'INSERT INTO grants (status, amount_requested, funding_opportunity_id) VALUES (?, ?, ?)',
  )
  let unanswered = unansweredFo
  for (let i = 0; i < total; i++) {
    const valued = i < withValue
    let foId = null
    if (!valued) {
      // An unanswered row = burned with no recorded answer (the "unreadable" bucket).
      const answered = unanswered-- <= 0
      foId = insFo.run(answered ? 'none_published' : 'not_listed', '2026-07-16T00:00:00Z').lastInsertRowid
    } else {
      foId = insFo.run('known', '2026-07-16T00:00:00Z').lastInsertRowid
    }
    ins.run('discovered', valued ? 5000 : null, foId)
  }
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

  it('is GREEN when coverage is low and steady but every row has an ANSWER', async () => {
    // THE FALSE ALARM THIS REPLACES. The old check failed whenever raw coverage
    // sat under 60%, so it fired every single night — 21%, 15%, 18%, forever.
    // That bar measured THE WORLD (what share of funders publish a per-award
    // figure at all), not us: the honest measured ceiling is ~21%, and prod on
    // 2026-07-17 had remaining=2 / exhausted=132 — the backlog was DRAINED and
    // the sweep had done its job. A finding that cannot ever go green is not a
    // standard, it is noise, and an owner trained to scroll past it is exactly
    // how the REAL defect next door (a re-crawl wiping amounts) goes unread.
    //
    // 15% coverage where every unvalued row was read and honestly denied is not
    // a crawler defect. It is the answer.
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 15, with_value: 15, total: 100 }])
    seedGrants(100, 15)
    const res = await check().run({ db })
    expect(res.ok).toBe(true)
    expect(res.summary).toMatch(/All 100 active pipeline grants have an amount answer/)
    expect(res.summary).toMatch(/85 read → funder publishes none/)
  })

  it('FAILS when rows have no answer, and names why', async () => {
    // The bar that replaces it, and the one the system can actually hold: an
    // unvalued row must carry a reason. 10 rows burned with no recorded answer
    // are rows we cannot explain — that IS actionable (they need an adapter).
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 15, with_value: 15, total: 100 }])
    seedGrants(100, 15, { unansweredFo: 10 })
    const res = await check().run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/10 active pipeline grant\(s\) have NO amount answer/)
    expect(res.summary).toMatch(/needs an API adapter/)
    expect(res.evidence).toMatchObject({ unanswered_unreadable: 10, answered_none_published: 75 })
  })

  it('counts a grant with NO catalog row as unanswered — the sweep cannot reach it', async () => {
    // enforceAmountEnrichment JOINs grants→funding_opportunities, so a grant with
    // no link is structurally invisible to it (82 of 312 active rows in prod).
    // Those must not read as "answered" just because nothing can look at them.
    seedGrants(30, 30)
    db.prepare('INSERT INTO grants (status, amount_requested, funding_opportunity_id) VALUES (?, NULL, NULL)')
      .run('discovered')
    const res = await check().run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/no catalog row/)
    expect(res.evidence).toMatchObject({ unanswered_no_catalog_row: 1 })
  })

  it('does NOT count a DIRECTORY locator as a miss — it carries no award BY DESIGN', async () => {
    // A locator is a pointer to more sources, never an award (crawler-os
    // contract.js). Amy's false_positive detector already excludes them for the
    // same reason; this check was the surface that still counted them.
    seedGrants(30, 30)
    const foId = db.prepare(
      "INSERT INTO funding_opportunities (is_active, opportunity_kind, amount_status) VALUES (1, 'DIRECTORY', 'not_listed')",
    ).run().lastInsertRowid
    db.prepare('INSERT INTO grants (status, amount_requested, funding_opportunity_id) VALUES (?, NULL, ?)')
      .run('discovered', foId)
    const res = await check().run({ db })
    expect(res.ok).toBe(true)
    expect(res.evidence).toMatchObject({ no_amount_by_design: 1 })
  })

  it('A WIPED row still counts as a MISS — the wipe must never hide in an exclusion', async () => {
    // THE TRAP THIS DESIGN EXISTS TO AVOID, and the reason the denial must be a
    // POSITIVE recorded fact rather than "we tried and have nothing now".
    //
    // #950: a re-crawl nulled amounts the grants.gov adapter had just acquired,
    // and `amount_enrich_attempted_at` SURVIVED the wipe. Had this check excluded
    // rows on "attempted but still blank", every wiped row would have quietly
    // LEFT the denominator, coverage would have read ~100%, and the metric would
    // have gone blind to the exact defect it was built to catch.
    //
    // A wiped row keeps its honest status ('known') — it is NOT `none_published`,
    // because no read ever denied it — so it stays a miss and the ratchet fires.
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 90, with_value: 90, total: 100 }])
    seedGrants(100, 90)
    // The wipe: 50 valued rows lose their amounts, keeping the burn mark + status.
    db.prepare(
      `UPDATE grants SET amount_requested = NULL WHERE id IN (SELECT id FROM grants WHERE amount_requested > 0 LIMIT 50)`,
    ).run()
    const res = await check().run({ db })
    expect(res.ok, 'a wipe must FAIL the check').toBe(false)
    expect(res.summary).toMatch(/DROPPED/)
    // And they are NOT laundered into an "answered" bucket.
    expect(res.evidence.answered_none_published ?? 0).toBe(10)
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
