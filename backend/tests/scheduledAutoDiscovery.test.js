/**
 * Daily scheduled auto-discovery — per-profile guard and batch runner.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getAppAndDb, resetDb } from './testServer.js'
import { computeProfileDigest } from '../services/profileHelpers.js'
import {
  shouldRunProfileDailyDiscovery,
  runScheduledAutoDiscovery,
  resetScheduledAutoDiscoveryStateForTests,
} from '../services/scheduledAutoDiscovery.js'
import { randomUUID } from 'crypto'

function seedUser(db) {
  const id = 'u-sched-' + Math.random().toString(36).slice(2, 10)
  db.prepare(`
    INSERT INTO users (id, primary_email, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, `${id}@test.local`)
  return id
}

function seedProfile(db, userId, { status = 'active' } = {}) {
  const id = 'p-sched-' + Math.random().toString(36).slice(2, 10)
  db.prepare(`
    INSERT INTO profiles (id, user_id, display_name, primary_type, status, created_at, updated_at)
    VALUES (?, ?, 'Scheduled Discovery Profile', 'individual', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, userId, status)
  return id
}

function insertDiscoveryJob(db, profileId, { requestedBy = 'auto-discovery', digest = 'abc123', createdAt = null } = {}) {
  const id = randomUUID()
  const params = JSON.stringify({ _profile_digest: digest })
  if (createdAt) {
    db.prepare(`
      INSERT INTO crawler_jobs (id, type, status, profile_id, parameters, requested_by, created_at)
      VALUES (?, 'local', 'completed', ?, ?, ?, ?)
    `).run(id, profileId, params, requestedBy, createdAt)
  } else {
    db.prepare(`
      INSERT INTO crawler_jobs (id, type, status, profile_id, parameters, requested_by)
      VALUES (?, 'local', 'completed', ?, ?, ?)
    `).run(id, profileId, params, requestedBy)
  }
  return id
}

describe('scheduledAutoDiscovery', () => {
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    db = loaded.db
  }, 60_000)

  beforeEach(() => {
    resetDb(db)
    resetScheduledAutoDiscoveryStateForTests()
  })

  it('runs when profile has never been discovered', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId)

    const decision = await shouldRunProfileDailyDiscovery(db, profileId)
    expect(decision.run).toBe(true)
    expect(decision.reason).toBe('never_ran')
  })

  it('skips when already discovered today with unchanged profile', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId)
    const digest = await computeProfileDigest(db, profileId)

    insertDiscoveryJob(db, profileId, { digest, requestedBy: 'scheduled-auto-discovery' })

    const decision = await shouldRunProfileDailyDiscovery(db, profileId)
    expect(decision.run).toBe(false)
    expect(decision.reason).toBe('already_ran_today')
  })

  it('re-runs when profile digest changed since last discovery today', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId)

    insertDiscoveryJob(db, profileId, { digest: 'stale-digest-value' })

    const decision = await shouldRunProfileDailyDiscovery(db, profileId)
    expect(decision.run).toBe(true)
    expect(decision.reason).toBe('profile_changed')
  })

  it('runs when last discovery was before today', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId)
    const digest = await computeProfileDigest(db, profileId)

    insertDiscoveryJob(db, profileId, {
      digest,
      createdAt: '2020-01-01 12:00:00',
    })

    const decision = await shouldRunProfileDailyDiscovery(db, profileId)
    expect(decision.run).toBe(true)
    expect(decision.reason).toBe('daily')
  })

  it('queues jobs for active profiles when forced enabled', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId)
    const discoveryRuns = []

    const report = await runScheduledAutoDiscovery(db, {
      forceEnabled: true,
      runDiscovery: async (runDb, runProfileId, runOptions) => {
        discoveryRuns.push({ db: runDb, profileId: runProfileId, options: runOptions })
        return { engine: 'crawler-os', synchronous: true, opportunities: 4, stored: 4, matches: 2, sources: 1 }
      },
    })
    expect(report.profiles_queued).toBe(1)
    expect(discoveryRuns).toHaveLength(1)
    expect(discoveryRuns[0].db).toBe(db)
    expect(discoveryRuns[0].profileId).toBe(profileId)
    expect(discoveryRuns[0].options.requestedBy).toBe('scheduled-auto-discovery')
    expect(discoveryRuns[0].options.trigger).toBe('scheduled_daily')

    const count = db
      .prepare(
        `
          SELECT COUNT(*) AS n
          FROM crawler_jobs
          WHERE profile_id = ?
            AND requested_by = 'scheduled-auto-discovery'
        `,
      )
      .get(profileId)

    expect(Number(count?.n ?? 0)).toBeGreaterThan(0)

    const marker = db.prepare(
      `SELECT status, result_count, result_meta
         FROM crawler_jobs
        WHERE profile_id = ? AND requested_by = 'scheduled-auto-discovery'
        ORDER BY created_at DESC LIMIT 1`,
    ).get(profileId)
    expect(marker.status).toBe('completed')
    expect(Number(marker.result_count)).toBe(4)
    expect(JSON.parse(marker.result_meta)).toMatchObject({
      completed: true,
      engine: 'crawler-os',
      trigger: 'scheduled_daily',
      opportunities: 4,
      matches: 2,
      sources: 1,
    })
  })

  it('records failed attempts as terminal telemetry and allows retry', async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId)

    const report = await runScheduledAutoDiscovery(db, {
      forceEnabled: true,
      runDiscovery: async () => {
        throw new Error('simulated discovery failure')
      },
    })

    expect(report.profiles_failed).toBe(1)
    expect(report.errors).toHaveLength(1)
    const marker = db.prepare(
      `SELECT status, result_count, result_meta, error
         FROM crawler_jobs
        WHERE profile_id = ? AND requested_by = 'scheduled-auto-discovery'
        ORDER BY created_at DESC LIMIT 1`,
    ).get(profileId)
    expect(marker.status).toBe('failed')
    expect(Number(marker.result_count)).toBe(0)
    expect(marker.error).toContain('simulated discovery failure')
    expect(JSON.parse(marker.result_meta)).toMatchObject({ completed: false, trigger: 'scheduled_daily' })

    const decision = await shouldRunProfileDailyDiscovery(db, profileId)
    expect(decision).toMatchObject({ run: true, reason: 'previous_failed' })
  })

  it('skips inactive profiles in batch run', async () => {
    const userId = seedUser(db)
    seedProfile(db, userId, { status: 'archived' })

    const report = await runScheduledAutoDiscovery(db, { forceEnabled: true })
    expect(report.profiles_total).toBe(0)
    expect(report.profiles_queued).toBe(0)
  })
})
