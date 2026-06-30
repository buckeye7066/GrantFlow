/**
 * Tests for the wedge-reclaim path in continuousRunner.js
 *
 * The overlap guard treats ANY queued/running national job as a live run. A job
 * stranded by a redeploy (process killed before dispatch finished) therefore
 * wedges the crawler permanently — the canonical funding catalog ends up with 0
 * national_programs rows even though the crawler is ENABLED. reclaimWedgedNationalJob
 * detects a job older than NATIONAL_JOB_WEDGE_MS and reclaims it so a fresh run
 * can proceed.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

import { ageMsFrom, reclaimWedgedNationalJob } from '../services/nationalPrograms/continuousRunner.js'

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')
const MIN = 60000

function makeDb() {
  const db = new Database(':memory:')
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  return db
}

describe('ageMsFrom', () => {
  const now = Date.parse('2026-06-30T12:00:00Z')
  it('parses a zoneless SQLite UTC timestamp as UTC (not local)', () => {
    expect(ageMsFrom('2026-06-30 11:00:00', now)).toBe(60 * MIN)
  })
  it('parses an ISO timestamp with zone', () => {
    expect(ageMsFrom('2026-06-30T11:30:00Z', now)).toBe(30 * MIN)
  })
  it('returns null for empty/garbage input', () => {
    expect(ageMsFrom(null, now)).toBeNull()
    expect(ageMsFrom('not-a-date', now)).toBeNull()
  })
})

describe('reclaimWedgedNationalJob', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('signals skip (no reclaim) for a fresh in-flight job', async () => {
    const created = new Date(Date.now() - 2 * MIN).toISOString() // 2 min old
    db.prepare("INSERT INTO crawler_jobs (id, type, status, parameters, created_at) VALUES (?, 'national', 'running', '{\"mode\":\"programs\"}', ?)")
      .run('fresh-job', created.replace('T', ' ').replace(/\.\d+Z$/, ''))
    const existing = db.prepare("SELECT id, status, created_at FROM crawler_jobs WHERE id='fresh-job'").get()
    const res = await reclaimWedgedNationalJob(db, existing)
    expect(res.skip).toBe(true)
    expect(res.reclaimed).toBe(false)
    // Job untouched.
    expect(db.prepare("SELECT status FROM crawler_jobs WHERE id='fresh-job'").get().status).toBe('running')
  })

  it('reclaims a wedged (old running) job and allows the crawler to proceed', async () => {
    const created = new Date(Date.now() - 120 * MIN).toISOString() // 2h old → wedged
    db.prepare("INSERT INTO crawler_jobs (id, type, status, parameters, created_at) VALUES (?, 'national', 'running', '{\"mode\":\"programs\"}', ?)")
      .run('wedged-job', created.replace('T', ' ').replace(/\.\d+Z$/, ''))
    const existing = db.prepare("SELECT id, status, created_at FROM crawler_jobs WHERE id='wedged-job'").get()
    const res = await reclaimWedgedNationalJob(db, existing)
    expect(res.skip).toBe(false)
    expect(res.reclaimed).toBe(true)
    expect(db.prepare("SELECT status FROM crawler_jobs WHERE id='wedged-job'").get().status).toBe('failed')
  })

  it('also reclaims a wedged QUEUED job that never dispatched', async () => {
    const created = new Date(Date.now() - 120 * MIN).toISOString()
    db.prepare("INSERT INTO crawler_jobs (id, type, status, parameters, created_at) VALUES (?, 'national', 'queued', '{\"mode\":\"programs\"}', ?)")
      .run('queued-wedge', created.replace('T', ' ').replace(/\.\d+Z$/, ''))
    const existing = db.prepare("SELECT id, status, created_at FROM crawler_jobs WHERE id='queued-wedge'").get()
    const res = await reclaimWedgedNationalJob(db, existing)
    expect(res.reclaimed).toBe(true)
    expect(db.prepare("SELECT status FROM crawler_jobs WHERE id='queued-wedge'").get().status).toBe('failed')
  })

  it('no existing job → proceed (no skip)', async () => {
    const res = await reclaimWedgedNationalJob(db, null)
    expect(res).toEqual({ skip: false, reclaimed: false })
  })
})
