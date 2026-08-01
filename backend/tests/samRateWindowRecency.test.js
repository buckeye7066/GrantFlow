/**
 * A RATE finding must be able to go green on its own.
 *
 * THE PROD DEFECT (2026-08-01). Anya's morning report read "44% of the last 200
 * tool calls failed / admin.db.query (87)". The underlying bug — a SQL guard
 * matching `update` inside `updated_at` — was already fixed (PR #1084), and the
 * 87 failures were ONE ~2-hour burst on 2026-07-30 (87 of that day's 138
 * calls). Measured read-only in prod: the two days SINCE were 18 calls / 0
 * failures and 18 calls / 0 failures. `agent.anya.toolFailures` read the last
 * 200 rows with NO time bound, so at ~18–30 calls/day those 87 needed roughly
 * six more days to age out — the owner would read the same red line every
 * morning for a defect that no longer existed. CLAUDE.md's own rule: "a finding
 * that can never go green is not a standard — it is noise, and an owner trained
 * to scroll past it is exactly how the REAL defect next door goes unread."
 *
 * Registry-wide, three checks had the fixed-count-no-recency shape:
 * `agent.anya.toolFailures`, `agent.john.draftHealth`, `crawler.coverageDegraded`.
 *
 * Every test here fails when its guard is removed (mutation-verified).
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { getCheckById, applyRecencyWindow, rowTimestampMs } from '../services/sam/samRegistry.js'

const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString()

function anyaDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE anya_tool_usage (
    id TEXT PRIMARY KEY, tool_name TEXT, success INTEGER, created_at TEXT
  )`)
  return db
}

function seedCalls(db, { count, failures, agoHours, prefix }) {
  const ins = db.prepare('INSERT INTO anya_tool_usage (id, tool_name, success, created_at) VALUES (?, ?, ?, ?)')
  for (let i = 0; i < count; i += 1) {
    ins.run(`${prefix}-${i}`, i < failures ? 'admin.db.query' : 'admin.profile.get', i < failures ? 0 : 1, hoursAgo(agoHours))
  }
}

describe('agent.anya.toolFailures is recency-bounded', () => {
  const check = getCheckById('agent.anya.toolFailures')

  it('is registered as a non-heavy internal check', () => {
    expect(check).toBeTruthy()
    expect(check.kind).toBe('internal')
    expect(check.heavy).toBeFalsy()
  })

  it('does NOT fire on a STALE burst that is already fixed (the exact prod shape)', async () => {
    const db = anyaDb()
    try {
      // 2026-07-30: 138 calls, 87 failed — 48h+ ago.
      seedCalls(db, { count: 87, failures: 87, agoHours: 50, prefix: 'burst' })
      seedCalls(db, { count: 51, failures: 0, agoHours: 50, prefix: 'burst-ok' })
      // The two clean days since: 18 calls each, 0 failures.
      seedCalls(db, { count: 18, failures: 0, agoHours: 30, prefix: 'd1' })
      seedCalls(db, { count: 18, failures: 0, agoHours: 3, prefix: 'd2' })
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      expect(res.evidence.failed).toBe(0)
      expect(res.evidence.total).toBe(18)
      // The stale rows are still IN the 200-row candidate set — proving the
      // recency window, not the LIMIT, is what excluded them.
      expect(res.evidence.candidates_scanned).toBeGreaterThan(res.evidence.total)
    } finally { db.close() }
  })

  it('DOES fire on a fresh burst inside the window', async () => {
    const db = anyaDb()
    try {
      seedCalls(db, { count: 20, failures: 0, agoHours: 20, prefix: 'ok' })
      seedCalls(db, { count: 30, failures: 30, agoHours: 1, prefix: 'now' })
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.evidence.failed).toBe(30)
      expect(res.evidence.top_failing_tools[0][0]).toBe('admin.db.query')
      expect(res.summary).toMatch(/last 24h/)
    } finally { db.close() }
  })

  it('never pages on a tiny denominator ("1 of 2 failed = 50%")', async () => {
    const db = anyaDb()
    try {
      seedCalls(db, { count: 1, failures: 1, agoHours: 1, prefix: 'a' })
      seedCalls(db, { count: 1, failures: 0, agoHours: 1, prefix: 'b' })
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      expect(res.summary).toMatch(/no reliable failure signal yet/)
      expect(res.evidence.min_sample).toBe(10)
    } finally { db.close() }
  })

  it('honors the env window override', async () => {
    const db = anyaDb()
    try {
      seedCalls(db, { count: 20, failures: 20, agoHours: 30, prefix: 'old' })
      seedCalls(db, { count: 20, failures: 0, agoHours: 1, prefix: 'new' })
      expect((await check.run({ db })).ok).toBe(true)
      process.env.ANYA_TOOL_FAILURE_WINDOW_HOURS = '72'
      try {
        const widened = await check.run({ db })
        expect(widened.ok).toBe(false)
        expect(widened.evidence.window_hours).toBe(72)
      } finally { delete process.env.ANYA_TOOL_FAILURE_WINDOW_HOURS }
    } finally { db.close() }
  })

  it('fails open when the table is absent', async () => {
    expect((await check.run({})).ok).toBe(true)
    const db = new Database(':memory:')
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      expect(res.skipped).toBe(true)
    } finally { db.close() }
  })
})

describe('agent.john.draftHealth is recency-bounded', () => {
  const check = getCheckById('agent.john.draftHealth')

  function johnDb(rows) {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE john_runs (id TEXT PRIMARY KEY, status TEXT, started_at TEXT)')
    const ins = db.prepare('INSERT INTO john_runs (id, status, started_at) VALUES (?, ?, ?)')
    rows.forEach((r, i) => ins.run(`r${i}`, r.status, hoursAgo(r.agoHours)))
    return db
  }

  it('DOES fire when every run inside the window failed', async () => {
    const db = johnDb([
      { status: 'failed', agoHours: 2 },
      { status: 'failed', agoHours: 26 },
      { status: 'failed', agoHours: 50 },
    ])
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/John's 3 runs in the last 168h ALL FAILED/)
    } finally { db.close() }
  })

  it('does NOT keep firing on failures that have aged out of the window', async () => {
    const db = johnDb([
      { status: 'failed', agoHours: 200 },
      { status: 'failed', agoHours: 224 },
      { status: 'failed', agoHours: 248 },
      { status: 'completed', agoHours: 2 },
    ])
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      // The aged-out failures are excluded from the SAMPLE, not merely
      // outvoted — without the window this reads 4 runs, 3 of them failed.
      expect(res.evidence.recent_statuses).toEqual(['completed'])
    } finally { db.close() }
  })

  it('reports an EMPTY window honestly instead of claiming health', async () => {
    const db = johnDb([{ status: 'failed', agoHours: 400 }])
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      expect(res.evidence.window_empty).toBe(true)
      expect(res.summary).toMatch(/cannot speak to it/)
      expect(res.summary).not.toMatch(/health ok/)
    } finally { db.close() }
  })
})

describe('crawler.coverageDegraded is recency-bounded', () => {
  const check = getCheckById('crawler.coverageDegraded')

  function crawlerDb(runs) {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE crawler_source_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, crawler_run_id TEXT, source_id TEXT,
      queried INTEGER, failed INTEGER, created_at TEXT
    )`)
    const ins = db.prepare(
      'INSERT INTO crawler_source_runs (crawler_run_id, source_id, queried, failed, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    for (const run of runs) {
      for (let i = 0; i < run.sources; i += 1) {
        ins.run(run.id, `s${i}`, 1, i < run.failures ? 1 : 0, hoursAgo(run.agoHours))
      }
    }
    return db
  }

  it('DOES fire on a fresh outage', async () => {
    const db = crawlerDb([{ id: 'run-now', sources: 30, failures: 25, agoHours: 1 }])
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.evidence.window_hours).toBe(24)
    } finally { db.close() }
  })

  it('reports NO SIGNAL rather than replaying a bad day after crawling stops', async () => {
    const db = crawlerDb([{ id: 'run-old', sources: 30, failures: 25, agoHours: 72 }])
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      expect(res.evidence.queried).toBe(0)
      expect(res.summary).toMatch(/no reliable signal yet/)
    } finally { db.close() }
  })
})

describe('the recency-window primitives', () => {
  it('reads a Postgres Date and a bare SQLite timestamp identically (UTC, not local)', () => {
    const utc = Date.UTC(2026, 7, 1, 13, 20, 48)
    expect(rowTimestampMs(new Date(utc))).toBe(utc)
    expect(rowTimestampMs('2026-08-01 13:20:48')).toBe(utc)
    expect(rowTimestampMs('2026-08-01T13:20:48.000Z')).toBe(utc)
    expect(rowTimestampMs('not a date')).toBeNull()
    expect(rowTimestampMs(null)).toBeNull()
  })

  it('degrades to count-only — and SAYS so — when no timestamp can be read', () => {
    const rows = [{ created_at: 'junk' }, { created_at: null }]
    const res = applyRecencyWindow(rows, 24)
    expect(res.windowed).toBe(false)
    expect(res.rows).toHaveLength(2)
  })

  it('keeps the newest rows and drops only the old ones', () => {
    const rows = [{ created_at: hoursAgo(1) }, { created_at: hoursAgo(50) }]
    const res = applyRecencyWindow(rows, 24)
    expect(res.windowed).toBe(true)
    expect(res.rows).toHaveLength(1)
  })
})
