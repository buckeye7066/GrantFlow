/**
 * Sam's deep per-agent observability checks + the see→act queue safe fix.
 *
 * The HTTP telemetry probes (agent.yana.health etc.) only prove the summary
 * endpoint answers 200. These INTERNAL checks read the agents' own tables so a
 * reachable-but-silently-failing agent surfaces as a finding, and the
 * queue.staleJobs finding nominates a registered safe fix that a
 * human-authorized repair-safe run actually APPLIES.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { getCheckById, findSafeFixById, SAFE_FIX_REGISTRY } from '../services/sam/samRegistry.js'
import { applySafeFix, deriveSafeFixesFromFindings } from '../services/sam/samSafeFixes.js'

const iso = (daysAgo = 0) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()

describe('agent.yana.yield', () => {
  const check = getCheckById('agent.yana.yield')

  it('is registered as a non-heavy internal check', () => {
    expect(check).toBeTruthy()
    expect(check.kind).toBe('internal')
    expect(check.heavy).toBeFalsy()
  })

  it('fails open when the table is absent or db is missing', async () => {
    expect((await check.run({})).ok).toBe(true)
    const db = new Database(':memory:')
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      expect(res.skipped).toBe(true)
    } finally { db.close() }
  })

  it('flags a frozen qualification pipeline (found >= 10, zero qualified, zero pushed)', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE yana_lead_candidates (
        id TEXT PRIMARY KEY, qualification_status TEXT, pushed_to_john INTEGER DEFAULT 0, created_at TEXT
      )`)
      const ins = db.prepare(`INSERT INTO yana_lead_candidates (id, qualification_status, pushed_to_john, created_at) VALUES (?, ?, ?, ?)`)
      for (let i = 0; i < 12; i++) ins.run(`l${i}`, 'pending', 0, iso(2))
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/frozen/i)
      expect(res.evidence.found).toBe(12)
    } finally { db.close() }
  })

  it('stays green when leads are being qualified/pushed', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE yana_lead_candidates (
        id TEXT PRIMARY KEY, qualification_status TEXT, pushed_to_john INTEGER DEFAULT 0, created_at TEXT
      )`)
      const ins = db.prepare(`INSERT INTO yana_lead_candidates (id, qualification_status, pushed_to_john, created_at) VALUES (?, ?, ?, ?)`)
      for (let i = 0; i < 12; i++) ins.run(`l${i}`, i % 3 === 0 ? 'qualified' : 'pending', i % 3 === 0 ? 1 : 0, iso(2))
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
    } finally { db.close() }
  })
})

describe('agent.john.draftHealth', () => {
  const check = getCheckById('agent.john.draftHealth')

  it('fails open before John has run', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE john_runs (id TEXT PRIMARY KEY, status TEXT, started_at TEXT)`)
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      expect(res.summary).toMatch(/not run yet/i)
    } finally { db.close() }
  })

  it('flags when every recent run failed', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE john_runs (id TEXT PRIMARY KEY, status TEXT, started_at TEXT)`)
      const ins = db.prepare(`INSERT INTO john_runs (id, status, started_at) VALUES (?, ?, ?)`)
      for (let i = 0; i < 4; i++) ins.run(`r${i}`, 'failed', iso(i))
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/all failed/i)
    } finally { db.close() }
  })

  it('stays green on mixed outcomes', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE john_runs (id TEXT PRIMARY KEY, status TEXT, started_at TEXT)`)
      const ins = db.prepare(`INSERT INTO john_runs (id, status, started_at) VALUES (?, ?, ?)`)
      ins.run('r1', 'completed', iso(1))
      ins.run('r2', 'failed', iso(2))
      ins.run('r3', 'completed', iso(3))
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
    } finally { db.close() }
  })
})

describe('agent.anya.toolFailures', () => {
  const check = getCheckById('agent.anya.toolFailures')

  function seededDb(total, failed) {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE anya_tool_usage (
      id TEXT PRIMARY KEY, created_at TEXT, tool_name TEXT, success INTEGER
    )`)
    const ins = db.prepare(`INSERT INTO anya_tool_usage (id, created_at, tool_name, success) VALUES (?, ?, ?, ?)`)
    for (let i = 0; i < total; i++) ins.run(`u${i}`, iso(0), i % 2 ? 'grants.explainMatch' : 'admin.db.query', i < failed ? 0 : 1)
    return db
  }

  it('needs a real sample before it will signal', async () => {
    const db = seededDb(5, 5)
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      expect(res.summary).toMatch(/no reliable failure signal/i)
    } finally { db.close() }
  })

  it('flags a high failure rate and names the top failing tools', async () => {
    const db = seededDb(20, 10)
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.evidence.failure_rate).toBeGreaterThan(0.3)
      expect(res.evidence.top_failing_tools.length).toBeGreaterThan(0)
    } finally { db.close() }
  })

  it('stays green on a healthy failure rate', async () => {
    const db = seededDb(20, 2)
    try {
      expect((await check.run({ db })).ok).toBe(true)
    } finally { db.close() }
  })
})

describe('queue.staleJobs + queue.recover-stale-jobs (see → act)', () => {
  const check = getCheckById('queue.staleJobs')

  function queueDb({ staleRunning = 0, staleQueued = 0, fresh = 0 } = {}) {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE crawler_jobs (
      id TEXT PRIMARY KEY, status TEXT, created_at TEXT, started_at TEXT, last_heartbeat_at TEXT, last_retry_at TEXT
    )`)
    const ins = db.prepare(`INSERT INTO crawler_jobs (id, status, created_at, started_at) VALUES (?, ?, ?, ?)`)
    let n = 0
    for (let i = 0; i < staleRunning; i++) ins.run(`sr${n++}`, 'running', iso(3), iso(2))
    for (let i = 0; i < staleQueued; i++) ins.run(`sq${n++}`, 'queued', iso(3), null)
    for (let i = 0; i < fresh; i++) ins.run(`f${n++}`, 'queued', iso(0), null)
    return db
  }

  it('fails open when the table is absent', async () => {
    const db = new Database(':memory:')
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      expect(res.skipped).toBe(true)
    } finally { db.close() }
  })

  it('flags stale jobs and nominates the registered safe fix', async () => {
    const db = queueDb({ staleRunning: 2, staleQueued: 1, fresh: 1 })
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.evidence.stale_running).toBe(2)
      expect(res.evidence.stale_queued).toBe(1)
      expect(res.evidence.safe_fix_id).toBe('queue.recover-stale-jobs')
      expect(findSafeFixById(res.evidence.safe_fix_id)).toBeTruthy()
    } finally { db.close() }
  })

  it('stays green on a clean queue', async () => {
    const db = queueDb({ fresh: 3 })
    try {
      expect((await check.run({ db })).ok).toBe(true)
    } finally { db.close() }
  })

  it('deriveSafeFixesFromFindings honours a nominated REGISTERED safe fix and ignores bogus ids', () => {
    const derived = deriveSafeFixesFromFindings([
      { evidence: { safe_fix_id: 'queue.recover-stale-jobs' } },
      { evidence: { safe_fix_id: 'rm.dash.rf' } }, // never registered — must be ignored
    ])
    expect(derived.fixIds).toContain('queue.recover-stale-jobs')
    expect(derived.fixIds).not.toContain('rm.dash.rf')
  })

  it('queue.recover-stale-jobs refuses without admin authorization or repair-safe mode', async () => {
    const res = await applySafeFix({ fixId: 'queue.recover-stale-jobs', context: { authorisedByAdmin: false, mode: 'repair-safe' } })
    expect(res.refused).toBe(true)
    const res2 = await applySafeFix({ fixId: 'queue.recover-stale-jobs', context: { authorisedByAdmin: true, mode: 'observe' } })
    expect(res2.refused).toBe(true)
  })

  it('applies the recovery (injected cleanups) and is idempotent', async () => {
    const db = queueDb({ staleRunning: 1, staleQueued: 2 })
    try {
      let calls = 0
      const mk = (recover) => async (handle) => {
        expect(handle).toBe(db)
        calls += 1
        return recover
      }
      const first = await applySafeFix({
        fixId: 'queue.recover-stale-jobs',
        context: { authorisedByAdmin: true, mode: 'repair-safe', db },
        params: { _cleanupStaleCrawlers: mk(1), _cleanupStaleQueuedJobs: mk(2) },
      })
      expect(first.ok).toBe(true)
      expect(first.applied).toBe(true)
      expect(first.evidence).toEqual({ recovered_running: 1, recovered_queued: 2 })
      expect(calls).toBe(2)

      // Second pass finds nothing — still ok, applied:false (idempotent).
      const second = await applySafeFix({
        fixId: 'queue.recover-stale-jobs',
        context: { authorisedByAdmin: true, mode: 'repair-safe', db },
        params: { _cleanupStaleCrawlers: async () => 0, _cleanupStaleQueuedJobs: async () => 0 },
      })
      expect(second.ok).toBe(true)
      expect(second.applied).toBe(false)
    } finally { db.close() }
  })

  it('refuses when no db handle is available', async () => {
    const res = await applySafeFix({
      fixId: 'queue.recover-stale-jobs',
      context: { authorisedByAdmin: true, mode: 'repair-safe' },
      params: { _cleanupStaleCrawlers: async () => 0, _cleanupStaleQueuedJobs: async () => 0 },
    })
    expect(res.refused).toBe(true)
    expect(res.message).toMatch(/database/i)
  })

  it('the safe-fix registry entry is risk_level safe (policy auto-applicable)', () => {
    const entry = SAFE_FIX_REGISTRY.find((f) => f.id === 'queue.recover-stale-jobs')
    expect(entry).toBeTruthy()
    expect(entry.risk_level).toBe('safe')
  })
})
