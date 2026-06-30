/**
 * Tests for reopenStaleMaintenance() in maintenanceMode.js
 *
 * The nightly sweep enters a DOWN maintenance window and is supposed to reopen
 * when green. If Sam crashes mid-sweep (criticals unknown) or the process dies
 * before endMaintenance(), the window is stranded DOWN and every non-admin user
 * is locked out. reopenStaleMaintenance() is the self-healing net:
 *   - automated windows reopen once past estimated_end + STALE_BUFFER_MIN
 *   - ANY window reopens once past estimated_end + STALE_HARD_MAX_MIN
 *   - a still-within-estimate window is left alone
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

import {
  enterMaintenanceNow,
  scheduleMaintenance,
  reopenStaleMaintenance,
  getMaintenanceStatus,
} from '../services/maintenance/maintenanceMode.js'

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  return db
}

const MIN = 60000

describe('reopenStaleMaintenance', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('no-ops when no window is active', async () => {
    const res = await reopenStaleMaintenance(db)
    expect(res).toEqual({ reopened: false })
  })

  it('reopens a stranded automated (nightly_sweep) window past the soft buffer', async () => {
    const started = new Date(Date.now() - 120 * MIN) // 2h ago
    await enterMaintenanceNow(db, { reason: 'nightly_sweep', estimatedMinutes: 20, by: 'sam_nightly', now: started })
    // Still DOWN before the heal.
    expect((await getMaintenanceStatus(db)).phase).toBe('down')

    const res = await reopenStaleMaintenance(db)
    expect(res.reopened).toBe(true)
    expect(res.reason).toBe('automated_window_overdue')
    expect((await getMaintenanceStatus(db)).active).toBe(false)
  })

  it('leaves an automated window alone while still within its estimate + buffer', async () => {
    // estimated_end = now + 20m; buffer 30m → not overdue yet.
    await enterMaintenanceNow(db, { reason: 'nightly_sweep', estimatedMinutes: 20, by: 'sam_nightly' })
    const res = await reopenStaleMaintenance(db)
    expect(res.reopened).toBe(false)
    expect((await getMaintenanceStatus(db)).phase).toBe('down')
  })

  it('does NOT reopen a human deploy window on the soft buffer, but does past the hard max', async () => {
    // Human-scheduled deploy window that started 90m ago, est 15m → overdue ~75m.
    const started = new Date(Date.now() - 90 * MIN)
    await scheduleMaintenance(db, { graceMinutes: 0, estimatedMinutes: 15, reason: 'deploy', by: 'admin', now: started })
    const soft = await reopenStaleMaintenance(db)
    expect(soft.reopened).toBe(false) // automated-only soft path must not touch a human window

    // Now simulate it being open way past the hard max (default 6h).
    const longAgo = new Date(Date.now() - 8 * 60 * MIN)
    await scheduleMaintenance(db, { graceMinutes: 0, estimatedMinutes: 15, reason: 'deploy', by: 'admin', now: longAgo })
    const hard = await reopenStaleMaintenance(db)
    expect(hard.reopened).toBe(true)
    expect(hard.reason).toBe('past_hard_max')
    expect((await getMaintenanceStatus(db)).active).toBe(false)
  })
})
