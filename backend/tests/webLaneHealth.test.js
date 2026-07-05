/**
 * webLaneHealth.test.js
 *
 * The open-web lane is best-effort by design: a dead search backend (Brave 402,
 * SearXNG upstream engines suspended) or an exhausted LLM key silently degrades
 * it to a no-op — in July 2026 that silence let the lane stay dead for 3+ days
 * while every live crawl logged a hyperlocal gap (the consequence, not the
 * cause). These tests lock down the observability that ends that failure mode:
 * the rolling telemetry store, the "all recent runs got zero search pages"
 * deadness judgment, and Sam's crawler.webLaneHealth check.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  buildWebLaneHealthUpdate,
  summarizeRecentWebLane,
  getWebLaneHealth,
  recordWebLaneRun,
  RECENT_CAP,
  MIN_RUNS_TO_JUDGE,
} from '../services/coverageAudit/webLaneHealth.js'
import { getCheckById } from '../services/sam/samRegistry.js'

const liveRun = (over = {}) => ({
  at: '2026-07-05T00:00:00Z', profile_id: 'p', ok: true,
  queries: 6, pages: 9, fetched: 9, extracted: 4, stored: 2, ...over,
})

describe('webLaneHealth — pure fold + summary', () => {
  it('folds runs, counts zero-page runs, caps the recent buffer', () => {
    let store = null
    store = buildWebLaneHealthUpdate(store, liveRun())
    store = buildWebLaneHealthUpdate(store, liveRun({ pages: 0, stored: 0 }))
    expect(store.totals.runs).toBe(2)
    expect(store.totals.zero_page_runs).toBe(1)
    expect(store.totals.stored_total).toBe(2)
    expect(store.recent[0].pages).toBe(0) // newest first

    for (let i = 0; i < RECENT_CAP + 10; i++) store = buildWebLaneHealthUpdate(store, liveRun())
    expect(store.recent).toHaveLength(RECENT_CAP)
  })

  it('judges the lane DEAD only when enough recent runs ALL got zero pages', () => {
    let dead = null
    for (let i = 0; i < MIN_RUNS_TO_JUDGE; i++) {
      dead = buildWebLaneHealthUpdate(dead, liveRun({ pages: 0, stored: 0, error: 'search backend down' }))
    }
    const deadSummary = summarizeRecentWebLane(dead)
    expect(deadSummary.dead).toBe(true)
    expect(deadSummary.reasons).toContain('search backend down')

    // One healthy run in the window → not dead.
    const mixed = buildWebLaneHealthUpdate(dead, liveRun({ pages: 5 }))
    expect(summarizeRecentWebLane(mixed).dead).toBe(false)

    // Too few runs to judge → not dead (cold-start safety).
    let cold = null
    for (let i = 0; i < MIN_RUNS_TO_JUDGE - 1; i++) {
      cold = buildWebLaneHealthUpdate(cold, liveRun({ pages: 0 }))
    }
    expect(summarizeRecentWebLane(cold).dead).toBe(false)
  })
})

describe('webLaneHealth — DB round-trip + Sam check', () => {
  function makeDb() {
    const raw = new Database(':memory:')
    return raw
  }

  it('recordWebLaneRun persists to system_kv and getWebLaneHealth reads it back', async () => {
    const db = makeDb()
    const res = await recordWebLaneRun(db, {
      profileId: 'p1',
      telemetry: { ok: true, queries: ['a', 'b'], pages: 3, fetched: 3, extracted: 1, stored: 1 },
    })
    expect(res.ok).toBe(true)
    const store = await getWebLaneHealth(db)
    expect(store.totals.runs).toBe(1)
    expect(store.recent[0]).toMatchObject({ profile_id: 'p1', queries: 2, pages: 3, stored: 1 })
    db.close()
  })

  it('Sam crawler.webLaneHealth reds out when the lane is dead and names the reason', async () => {
    const check = getCheckById('crawler.webLaneHealth')
    expect(check).toBeTruthy()
    const db = makeDb()

    // No telemetry yet → green (cold start).
    let res = await check.run({ db })
    expect(res.ok).toBe(true)

    // A run of zero-page crawls → dead lane finding.
    for (let i = 0; i < 6; i++) {
      await recordWebLaneRun(db, {
        profileId: `p${i}`,
        telemetry: { ok: false, queries: ['q1', 'q2'], pages: 0, fetched: 0, extracted: 0, stored: 0, error: 'Brave 402 / SearXNG engines suspended' },
      })
    }
    res = await check.run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('ZERO search pages')
    expect(res.summary).toContain('Brave 402')

    // Lane recovers → green again (the finding must not latch).
    for (let i = 0; i < 8; i++) {
      await recordWebLaneRun(db, {
        profileId: `r${i}`,
        telemetry: { ok: true, queries: ['q'], pages: 4, fetched: 4, extracted: 2, stored: 1 },
      })
    }
    res = await check.run({ db })
    expect(res.ok).toBe(true)
    db.close()
  })
})
