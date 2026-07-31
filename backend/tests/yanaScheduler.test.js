/**
 * Unit tests for backend/services/yana/yanaScheduler.js + getYanaConfig.
 *
 * Proves Yana's Phase 9 background-execution contract:
 *   1. getYanaConfig is OFF by default and honors env overrides.
 *   2. startYanaScheduler refuses to start when disabled / no triggers.
 *   3. parseSchedule maps the supported cron specs.
 *   4. runYanaScheduledCycle runs the real funnel under the in-memory lock,
 *      persists a yana_lead_runs row, and honors allowLeads (observe vs push).
 *   5. stopYanaScheduler short-circuits a cycle.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import { getYanaConfig, _resetYanaSchemaCache } from '../services/yana/yanaLeadDiscovery.js'
import {
  parseSchedule,
  runYanaScheduledCycle,
  startYanaScheduler,
  stopYanaScheduler,
  __testing__,
} from '../services/yana/yanaScheduler.js'

function makeDb() { return new Database(':memory:') }

function richOrg(i) {
  return {
    id: String(i),
    name: `Org ${i}`,
    email: `contact${i}@example.org`,
    website: `https://org${i}.example.org`,
    mission: 'We provide measurable community programs and direct services to families.',
    focus_areas: JSON.stringify(['education', 'housing']),
    program_areas: JSON.stringify(['after-school']),
    applicant_type: 'nonprofit',
    ein: `12-345${String(i).padStart(4, '0')}`,
    city: 'Columbus',
    state: 'OH',
  }
}

const loaderFor = (orgs) => async () => orgs

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('YANA_')) delete process.env[key]
  }
  _resetYanaSchemaCache()
  __testing__._resetLock()
})

describe('getYanaConfig', () => {
  it('is OFF by default', () => {
    const cfg = getYanaConfig({})
    expect(cfg.enabled).toBe(false)
    expect(cfg.runOnStartup).toBe(false)
    expect(cfg.runOnSchedule).toBe(false)
    expect(cfg.allowLeads).toBe(true)
    expect(cfg.limit).toBe(200)
  })

  it('honors env overrides', () => {
    const cfg = getYanaConfig({
      YANA_ENABLED: 'true',
      YANA_RUN_ON_SCHEDULE: 'true',
      YANA_ALLOW_LEADS: 'false',
      YANA_DISCOVERY_LIMIT: '50',
      YANA_SCHEDULE: '0 3 * * *',
    })
    expect(cfg.enabled).toBe(true)
    expect(cfg.runOnSchedule).toBe(true)
    expect(cfg.allowLeads).toBe(false)
    expect(cfg.limit).toBe(50)
    expect(cfg.schedule).toBe('0 3 * * *')
  })
})

describe('parseSchedule', () => {
  it('maps hourly, daily, and falls back to hourly', () => {
    expect(parseSchedule('0 * * * *')).toBe(60 * 60 * 1000)
    expect(parseSchedule('0 6 * * *')).toBe(24 * 60 * 60 * 1000)
    expect(parseSchedule('garbage')).toBe(60 * 60 * 1000)
    expect(parseSchedule('')).toBe(60 * 60 * 1000)
  })
})

describe('startYanaScheduler gating', () => {
  it('does not start when disabled (default env)', () => {
    const res = startYanaScheduler({ db: makeDb() })
    expect(res).toEqual({ started: false, reason: 'yana_disabled' })
  })

  it('does not start when enabled but no triggers are set', () => {
    const prev = { ...process.env }
    process.env.YANA_ENABLED = 'true'
    delete process.env.YANA_RUN_ON_STARTUP
    delete process.env.YANA_RUN_ON_SCHEDULE
    try {
      const res = startYanaScheduler({ db: makeDb() })
      expect(res).toEqual({ started: false, reason: 'no_runtime_triggers_enabled' })
    } finally {
      process.env = prev
    }
  })
})

describe('runYanaScheduledCycle', () => {
  it('runs the funnel, persists a run, and pushes leads when allowLeads', async () => {
    const db = makeDb()
    const orgs = [richOrg(1), richOrg(2), richOrg(3)]
    const res = await runYanaScheduledCycle({
      db,
      logger: { info() {}, error() {} },
      cfg: { allowLeads: true, limit: 200 },
      deps: { loadOrganizations: loaderFor(orgs) },
    })
    expect(res.ok).toBe(true)
    expect(res.mode).toBe('qualify_and_push')
    expect(res.candidates_qualified).toBe(3)
    expect(res.leads_pushed_to_john).toBe(3)

    const runCount = db.prepare('SELECT COUNT(*) AS c FROM yana_lead_runs').get().c
    expect(runCount).toBe(1)
  })

  it('observes only (no push) when allowLeads is false', async () => {
    const db = makeDb()
    const res = await runYanaScheduledCycle({
      db,
      logger: { info() {}, error() {} },
      cfg: { allowLeads: false, limit: 200 },
      deps: { loadOrganizations: loaderFor([richOrg(1)]) },
    })
    expect(res.mode).toBe('observe')
    expect(res.leads_pushed_to_john).toBe(0)
  })

  it('short-circuits after stopYanaScheduler', async () => {
    stopYanaScheduler()
    const res = await runYanaScheduledCycle({ db: makeDb(), logger: { info() {}, error() {} } })
    expect(res).toEqual({ skipped: true, reason: 'stopped' })
  })
})
