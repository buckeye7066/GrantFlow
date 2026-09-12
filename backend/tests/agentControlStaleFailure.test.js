import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import {
  ensureSchema,
  _resetSchemaCache,
  getRunHighlights,
} from '../services/agentControl/agentControlStore.js'

// Pins item 3b: a long-stale failure (e.g. the 6/18 "Could not acquire lock")
// must not be presented as the CURRENT/standing failure on a clean later run.
// getRunHighlights now annotates last_failure with staleness so the UI mutes it.

function makeDb() {
  _resetSchemaCache()
  const db = new Database(':memory:')
  return db
}

function insertRun(db, { id, status, runType = 'full_cycle', completedAt, errorMessage = null }) {
  db.prepare(`
    INSERT INTO agent_control_runs (id, run_type, status, started_at, completed_at, error_message, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, runType, status, completedAt, completedAt, errorMessage, completedAt, completedAt)
}

describe('getRunHighlights — stale "Last failure"', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureSchema(db)
  })

  it('flags a failure older than the TTL as stale', async () => {
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString()
    insertRun(db, { id: 'old-fail', status: 'failed', completedAt: fourDaysAgo, errorMessage: "Could not acquire lock 'agent_control:agent:sam'" })

    const h = await getRunHighlights(db)
    expect(h.last_failure?.id).toBe('old-fail')
    expect(h.last_failure_is_stale).toBe(true)
    expect(h.last_failure_age_hours).toBeGreaterThanOrEqual(72)
  })

  it('flags the failure as stale + superseded when a later success exists (clean run)', async () => {
    const failAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString()
    const successAt = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1h ago, clean run
    insertRun(db, { id: 'old-fail', status: 'failed', completedAt: failAt, errorMessage: 'stale lock failure' })
    insertRun(db, { id: 'fresh-ok', status: 'completed', completedAt: successAt })

    const h = await getRunHighlights(db)
    expect(h.last_failure?.id).toBe('old-fail')
    expect(h.last_failure_superseded_by_success).toBe(true)
    expect(h.last_failure_is_stale).toBe(true)
    expect(h.last_success?.id).toBe('fresh-ok')
  })

  it('does NOT mark a recent failure with no later success as stale', async () => {
    const recentFail = new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30m ago
    insertRun(db, { id: 'recent-fail', status: 'failed', completedAt: recentFail, errorMessage: 'real failure now' })

    const h = await getRunHighlights(db)
    expect(h.last_failure?.id).toBe('recent-fail')
    expect(h.last_failure_is_stale).toBe(false)
    expect(h.last_failure_superseded_by_success).toBe(false)
  })

  it('no failures at all → null + non-stale defaults', async () => {
    insertRun(db, { id: 'ok-1', status: 'completed', completedAt: new Date().toISOString() })
    const h = await getRunHighlights(db)
    expect(h.last_failure).toBeNull()
    expect(h.last_failure_is_stale).toBe(false)
    expect(h.last_failure_age_hours).toBeNull()
  })
})

// Pins the standing-preflight-block fix: the UI must not decide "still
// standing" by comparing against `last_success` alone — a later run that
// failed, was cancelled, or stopped also supersedes an old block. Highlights
// exposes `last_terminal` (the single most recent run of ANY terminal status)
// so the frontend can do that comparison correctly.
describe('getRunHighlights — last_terminal (standing-block comparison)', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureSchema(db)
  })

  it('reports a lone blocked run as the last_terminal', async () => {
    const at = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    insertRun(db, { id: 'blocked-1', status: 'blocked', completedAt: at })

    const h = await getRunHighlights(db)
    expect(h.last_terminal?.id).toBe('blocked-1')
  })

  it('a later FAILURE (not a success) becomes last_terminal, superseding an older block', async () => {
    const blockedAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() // 6h ago
    const failedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1h ago
    insertRun(db, { id: 'blocked-1', status: 'blocked', completedAt: blockedAt })
    insertRun(db, { id: 'failed-1', status: 'failed', completedAt: failedAt, errorMessage: 'robert error' })

    const h = await getRunHighlights(db)
    expect(h.last_blocked?.id).toBe('blocked-1')
    expect(h.last_terminal?.id).toBe('failed-1')
  })

  it('a later CANCELLED/STOPPED run also becomes last_terminal', async () => {
    const blockedAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    const stoppedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    insertRun(db, { id: 'blocked-1', status: 'blocked', completedAt: blockedAt })
    insertRun(db, { id: 'stopped-1', status: 'stopped', completedAt: stoppedAt })

    const h = await getRunHighlights(db)
    expect(h.last_terminal?.id).toBe('stopped-1')
  })

  it('a later non-terminal (running) row is NOT last_terminal — the block is still latest terminal', async () => {
    const blockedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const runningAt = new Date().toISOString()
    insertRun(db, { id: 'blocked-1', status: 'blocked', completedAt: blockedAt })
    db.prepare(`
      INSERT INTO agent_control_runs (id, run_type, status, started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('running-1', 'full_cycle', 'running', runningAt, runningAt, runningAt)

    const h = await getRunHighlights(db)
    expect(h.last_terminal?.id).toBe('blocked-1')
  })

  it('no runs at all → last_terminal is null', async () => {
    const h = await getRunHighlights(db)
    expect(h.last_terminal).toBeNull()
  })
})
