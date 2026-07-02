/**
 * Coverage-sweep observability (Agent Observability Rule — read AND failure side).
 *
 * Defects fixed:
 *   1. `coverage_audit_last_run` was WRITE-ONLY — getLastCoverageSweep had zero
 *      consumers. Sam now reads it via the `coverage.sweepHealth` registry
 *      check and Anya via the owner.coverage_audit_status tool.
 *   2. A sweep that died mid-run (restart during autoheal) or threw left NO
 *      trace at all. runProfileCoverageSweep now writes a status:'running'
 *      heartbeat BEFORE any work and a status:'failed' record on exception.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  runProfileCoverageSweep,
  getLastCoverageSweep,
  COVERAGE_SWEEP_KV_KEY,
} from '../services/coverageAudit/profileResultCoverageAudit.js'
import { getCheckById } from '../services/sam/samRegistry.js'
import { listToolMetadata } from '../services/anyaToolRegistry.js'

const OWNER = 'buckeye7066@gmail.com'

function createSweepDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, status TEXT DEFAULT 'active',
      deleted_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (
      profile_id TEXT, section_key TEXT, data TEXT, updated_by TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT, opportunity_id TEXT, match_score INTEGER,
      match_decision TEXT, matcher_version TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
      categories TEXT, opportunity_kind TEXT, deadline TEXT, deadline_at TEXT,
      deadline_type TEXT, is_active INTEGER
    );
  `)
  return db
}

/** Wrap a better-sqlite3 db so every system_kv INSERT/UPDATE arg list is captured in order. */
function withKvWriteCapture(db, writes) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql)
      const record = /system_kv/i.test(sql) && /INSERT|UPDATE/i.test(sql)
      return {
        run: (...args) => {
          if (record) writes.push({ sql, args })
          return stmt.run(...args)
        },
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
      }
    },
  }
}

describe('runProfileCoverageSweep observability records', () => {
  it('records a completed sweep (status + started_at + summary) readable via getLastCoverageSweep', async () => {
    const db = createSweepDb()
    try {
      const result = await runProfileCoverageSweep(db, { autoheal: false })
      expect(result.ok).toBe(true)
      expect(result.status).toBe('completed')
      expect(result.started_at).toBeTruthy()

      const last = await getLastCoverageSweep(db)
      expect(last).toBeTruthy()
      expect(last.status).toBe('completed')
      expect(last.started_at).toBe(result.started_at)
      expect(last.summary).toBeTruthy()
      expect(last.recorded_at).toBeTruthy()
    } finally { db.close() }
  })

  it('writes the running heartbeat BEFORE the audit and a failed record when the sweep throws', async () => {
    const db = new Database(':memory:') // no profiles table → the audit throws
    const writes = []
    const wrapped = withKvWriteCapture(db, writes)
    try {
      await expect(runProfileCoverageSweep(wrapped, { autoheal: false })).rejects.toThrow()

      // First KV VALUE write is the heartbeat (status:'running'), before any audit work.
      const valueWrites = writes.filter((w) => w.args.some((a) => typeof a === 'string' && a.includes('"status"')))
      const firstPayload = JSON.parse(valueWrites[0].args.find((a) => typeof a === 'string' && a.includes('"status"')))
      expect(firstPayload.status).toBe('running')
      expect(firstPayload.started_at).toBeTruthy()

      // Terminal record is status:'failed' with the error, same key.
      const last = await getLastCoverageSweep(wrapped)
      expect(last.status).toBe('failed')
      expect(last.error).toBeTruthy()
      expect(last.started_at).toBe(firstPayload.started_at)

      const row = db.prepare('SELECT key FROM system_kv WHERE key = ?').get(COVERAGE_SWEEP_KV_KEY)
      expect(row).toBeTruthy()
    } finally { db.close() }
  })
})

describe('sam check coverage.sweepHealth (the read side)', () => {
  const check = getCheckById('coverage.sweepHealth')

  function kvDb() {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    return db
  }
  const put = (db, payload, updatedAt = new Date().toISOString()) =>
    db.prepare('INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
      .run(COVERAGE_SWEEP_KV_KEY, JSON.stringify(payload), updatedAt)
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString()

  it('is registered as a non-heavy internal check', () => {
    expect(check).toBeTruthy()
    expect(check.kind).toBe('internal')
    expect(check.heavy).toBeFalsy()
  })

  it('fails open when db / system_kv is unavailable', async () => {
    expect((await check.run({})).ok).toBe(true)
    const db = new Database(':memory:')
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      expect(res.skipped).toBe(true)
    } finally { db.close() }
  })

  it('flags an ABSENT record (the never-recorded prod defect)', async () => {
    const db = kvDb()
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/never recorded/i)
    } finally { db.close() }
  })

  it('flags a FAILED last sweep with its error', async () => {
    const db = kvDb()
    try {
      put(db, { ok: false, status: 'failed', error: 'pool exhausted', started_at: hoursAgo(1), recorded_at: hoursAgo(1) })
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/failed/i)
      expect(res.summary).toMatch(/pool exhausted/)
    } finally { db.close() }
  })

  it('flags a heartbeat stuck in status=running past the grace window (restart mid-autoheal)', async () => {
    const db = kvDb()
    try {
      put(db, { ok: null, status: 'running', started_at: hoursAgo(5), recorded_at: hoursAgo(5) }, hoursAgo(5))
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/never completed/i)
    } finally { db.close() }
  })

  it('flags a stale completed sweep (>36h)', async () => {
    const db = kvDb()
    try {
      put(db, { ok: true, status: 'completed', started_at: hoursAgo(40), recorded_at: hoursAgo(40), summary: { scanned: 5, with_gap: 1 } }, hoursAgo(40))
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/36h/)
    } finally { db.close() }
  })

  it('reports gap counts and stays green for a fresh completed sweep', async () => {
    const db = kvDb()
    try {
      put(db, {
        ok: true, status: 'completed', started_at: hoursAgo(2), recorded_at: hoursAgo(2),
        summary: { scanned: 12, with_gap: 3, needs_rediscovery: 2, surfacing_regressions: 0 },
        healed_count: 2,
      }, hoursAgo(2))
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      expect(res.summary).toMatch(/with_gap=3/)
      expect(res.summary).toMatch(/needs_rediscovery=2/)
      expect(res.evidence.gap_counts.healed).toBe(2)
    } finally { db.close() }
  })

  it('tolerates a legacy record without a status field (pre-heartbeat sweeps)', async () => {
    const db = kvDb()
    try {
      put(db, { ok: true, recorded_at: hoursAgo(1), summary: { scanned: 4, with_gap: 0 } }, hoursAgo(1))
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
    } finally { db.close() }
  })
})

describe('anya owner tool owner.coverage_audit_status', () => {
  it('is advertised to the owner and hidden from non-owner admins', () => {
    const ownerTools = listToolMetadata({ isAdmin: true, email: OWNER }).map((t) => t.name)
    const adminTools = listToolMetadata({ isAdmin: true, email: 'other-admin@example.com' }).map((t) => t.name)
    expect(ownerTools).toContain('owner.coverage_audit_status')
    expect(adminTools).not.toContain('owner.coverage_audit_status')
  })
})
