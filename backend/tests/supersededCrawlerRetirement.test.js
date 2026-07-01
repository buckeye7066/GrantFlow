/**
 * Retired-discovery-crawler cutover guards.
 *
 * Covers the two enforcement points added when the legacy per-type discovery
 * crawlers were retired in favour of the Crawler OS (Robert):
 *
 *   1. Job-creation choke point (createCrawlerJob) NEVER persists a retired type.
 *   2. Orphan-recovery hard caps (shouldAutoRetryOrphan + cleanupStaleCrawlers)
 *      NEVER resurrect a retired type, an over-budget job, or an aged-out job —
 *      the runaway that flooded the Automation Control Center with thousands of
 *      "worker presumed dead" failures.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getAppAndDb, resetDb } from './testServer.js'
import { createCrawlerJob } from '../services/crawlerJobCreation.js'
import { cleanupStaleCrawlers, shouldAutoRetryOrphan } from '../services/crawlerConcurrencyGuard.js'
import {
  isSupersededCrawlerType,
  keepActiveCrawlerTypes,
} from '../../shared/supersededCrawlerTypes.js'

function seedUser(db) {
  const id = 'u-sup-' + Math.random().toString(36).slice(2, 10)
  db.prepare(`
    INSERT INTO users (id, primary_email, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, `${id}@test.local`)
  return id
}

function seedProfile(db, userId) {
  const id = 'p-sup-' + Math.random().toString(36).slice(2, 10)
  db.prepare(`
    INSERT INTO profiles (id, user_id, display_name, primary_type, status, created_at, updated_at)
    VALUES (?, ?, 'Superseded Test', 'individual', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, userId)
  return id
}

describe('superseded crawler types — shared source of truth', () => {
  it('classifies retired discovery types and keeps real automations', () => {
    expect(isSupersededCrawlerType('comprehensive')).toBe(true)
    expect(isSupersededCrawlerType('local')).toBe(true)
    expect(isSupersededCrawlerType('scholarship')).toBe(true)
    expect(isSupersededCrawlerType('item_search')).toBe(true)

    expect(isSupersededCrawlerType('pipeline_automation')).toBe(false)
    expect(isSupersededCrawlerType('profile_enrichment')).toBe(false)
    expect(isSupersededCrawlerType('document_ingest')).toBe(false)
    expect(isSupersededCrawlerType('portal_check')).toBe(false)

    const active = keepActiveCrawlerTypes(['local', 'pipeline_automation', 'comprehensive', 'portal_check'])
    expect(active).toEqual(['pipeline_automation', 'portal_check'])
  })
})

describe('createCrawlerJob — never persists a retired discovery type', () => {
  let db
  beforeAll(async () => {
    ({ db } = await getAppAndDb())
  }, 60_000)
  beforeEach(() => resetDb(db))

  it('skips a superseded type without inserting a row', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId)

    const result = await createCrawlerJob(db, {
      type: 'comprehensive',
      profileId,
      parameters: { mode: 'geo' },
      buildSnapshot: false,
    })

    expect(result.created).toBe(false)
    expect(result.superseded).toBe(true)
    expect(result.jobId).toBeNull()

    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM crawler_jobs WHERE type = 'comprehensive'")
      .get()
    expect(Number(rows.c)).toBe(0)
  })

  it('still creates a real automation type', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId)

    const result = await createCrawlerJob(db, {
      type: 'profile_enrichment',
      profileId,
      parameters: {},
      buildSnapshot: false,
    })

    expect(result.created).toBe(true)
    expect(result.jobId).toBeTruthy()

    const row = db.prepare('SELECT type, status FROM crawler_jobs WHERE id = ?').get(result.jobId)
    expect(row.type).toBe('profile_enrichment')
    expect(row.status).toBe('queued')
  })
})

describe('orphan auto-retry hard caps', () => {
  const now = Date.now()
  const iso = (ms) => new Date(ms).toISOString()

  it('shouldAutoRetryOrphan enforces type / budget / age caps', () => {
    // Retired type → never.
    expect(shouldAutoRetryOrphan({ type: 'comprehensive', retry_count: 0, created_at: iso(now) }).retry).toBe(false)
    // Real type, fresh, under budget → yes.
    expect(shouldAutoRetryOrphan({ type: 'pipeline_automation', retry_count: 0, created_at: iso(now) }).retry).toBe(true)
    // Real type but budget exhausted → no.
    expect(shouldAutoRetryOrphan({ type: 'pipeline_automation', retry_count: 5, created_at: iso(now) }).retry).toBe(false)
    // Real type, under budget, but too old → no.
    expect(
      shouldAutoRetryOrphan({
        type: 'pipeline_automation',
        retry_count: 0,
        created_at: iso(now - 48 * 60 * 60 * 1000),
      }).retry,
    ).toBe(false)
  })
})

describe('cleanupStaleCrawlers — never resurrects a retired orphan', () => {
  let db
  beforeAll(async () => {
    ({ db } = await getAppAndDb())
  }, 60_000)
  beforeEach(() => resetDb(db))

  it('fails a stale superseded running job and does NOT requeue it', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId)

    const oldIso = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1h ago
    db.prepare(`
      INSERT INTO crawler_jobs (id, type, status, profile_id, parameters, started_at, last_heartbeat_at, retry_count, created_at)
      VALUES ('legacy-orphan-1', 'comprehensive', 'running', ?, '{}', ?, ?, 0, ?)
    `).run(profileId, oldIso, oldIso, oldIso)

    // Small stale threshold so the 1h-old job is considered orphaned.
    await cleanupStaleCrawlers(db, 60 * 1000)

    const original = db.prepare("SELECT status FROM crawler_jobs WHERE id = 'legacy-orphan-1'").get()
    expect(original.status).toBe('failed')

    // No requeued descendant may exist for a retired type.
    const requeued = db
      .prepare("SELECT COUNT(*) AS c FROM crawler_jobs WHERE type = 'comprehensive' AND status = 'queued'")
      .get()
    expect(Number(requeued.c)).toBe(0)
  })
})
