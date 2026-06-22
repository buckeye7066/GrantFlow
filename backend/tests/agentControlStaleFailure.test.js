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
