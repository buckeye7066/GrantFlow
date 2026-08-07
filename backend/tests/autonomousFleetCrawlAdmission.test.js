// Guards the 2026-08-06 runaway-crawler incident.
//
// A FLEET crawl (runAutonomousCrawlers with no profileIds) runs a full live
// discovery per ACTIVE PROFILE, sequentially, uncapped. Three separate triggers
// call it that way — server boot (ANYA_RUN_ON_STARTUP), EVERY admin login
// (ANYA_RUN_ON_ADMIN_LOGIN, backend/routes/auth.js), and the daily schedule —
// and the only thing standing between them was one in-memory boolean inside
// runOnAdminLogin that dies with the process and does not cover startup at all.
//
// Production on 2026-08-06 showed the result: 86 distinct profiles across 142
// crawler-os runs in 3h09m (crawler_source_runs), i.e. the whole 88-profile
// fleet crawled ~1.6x over with many profiles hit 3x — three overlapping
// sweeps. To the owner that is "I'm not touching anything and it keeps running
// the programs".
//
// These tests pin the admission control:
//   1. a second fleet sweep is REFUSED while one holds the lease,
//   2. a fleet sweep is REFUSED inside the cooldown window,
//   3. an explicitly SCOPED (owner-initiated) crawl is NEVER gated — the
//      recall-preservation half of the contract,
//   4. force:true still lets a human override.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const runProfileDiscoveryLive = vi.fn()

vi.mock('../services/crawlerOsService.js', () => ({ runProfileDiscoveryLive }))
vi.mock('../services/auditService.js', () => ({
  logAuditEvent: vi.fn(),
  AUDIT_CATEGORIES: { ANYA: 'anya' },
  SEVERITY: { INFO: 'info' },
}))

// In-memory stand-in for the durable agent_control_locks / agent_settings store.
const lockState = { held: null, settings: new Map() }

vi.mock('../services/agentControl/agentControlStore.js', () => ({
  acquireLock: vi.fn(async (_db, { lockName, controlRunId }) => {
    if (lockState.held && lockState.held.expiresAtMs > Date.now()) {
      return { acquired: false, reason: 'held', heldBy: lockState.held.controlRunId }
    }
    const ownerToken = `tok-${Math.random().toString(36).slice(2)}`
    lockState.held = { lockName, controlRunId, ownerToken, expiresAtMs: Date.now() + 60_000 }
    return { acquired: true, ownerToken, lockName }
  }),
  releaseLock: vi.fn(async (_db, { ownerToken }) => {
    if (lockState.held && lockState.held.ownerToken === ownerToken) lockState.held = null
    return 1
  }),
  getAgentSetting: vi.fn(async (_db, key) => lockState.settings.get(key) ?? null),
  setAgentSetting: vi.fn(async (_db, key, value) => { lockState.settings.set(key, value) }),
}))

const { runAutonomousCrawlers } = await import('../services/anyaAutonomousFunctionRunner.js')

const PROFILES = [
  { id: 'p1', display_name: 'Org One', status: 'active' },
  { id: 'p2', display_name: 'Person Two', status: 'active' },
]

function fakeDb() {
  return {
    prepare(sql) {
      return {
        all: () => (/from profiles/i.test(sql) ? PROFILES : []),
        get: () => ({ c: 0 }),
        run: () => ({ changes: 0 }),
      }
    },
  }
}

const ctx = () => ({ db: fakeDb(), user: { id: 'test-admin' } })

describe('fleet-crawl admission control', () => {
  beforeEach(() => {
    lockState.held = null
    lockState.settings.clear()
    delete process.env.ANYA_FLEET_CRAWL_MIN_INTERVAL_MS
    runProfileDiscoveryLive.mockReset()
    runProfileDiscoveryLive.mockResolvedValue({
      run: { stored: 3 },
      persisted: { opportunities: 3, matches: 3 },
    })
  })

  afterEach(() => {
    delete process.env.ANYA_FLEET_CRAWL_MIN_INTERVAL_MS
  })

  it('refuses a SECOND concurrent fleet sweep instead of crawling the fleet twice', async () => {
    // Disable the cooldown so this test isolates the overlap guard alone.
    process.env.ANYA_FLEET_CRAWL_MIN_INTERVAL_MS = '0'

    let releaseFirst
    const firstProfileStarted = new Promise((resolve) => {
      runProfileDiscoveryLive.mockImplementationOnce(async () => {
        resolve()
        await new Promise((r) => { releaseFirst = r })
        return { run: { stored: 1 }, persisted: { opportunities: 1, matches: 1 } }
      })
    })

    const first = runAutonomousCrawlers({}, ctx())
    await firstProfileStarted

    // A concurrent trigger (admin login / boot) arrives mid-sweep.
    const second = await runAutonomousCrawlers({}, ctx())
    expect(second.skipped).toBe(true)
    expect(second.skipped_reason).toBe('fleet_crawl_in_progress')
    expect(second.profiles_processed).toBe(0)

    releaseFirst()
    const firstReport = await first
    expect(firstReport.skipped).toBeUndefined()
    expect(firstReport.profiles_processed).toBe(PROFILES.length)

    // Exactly ONE sweep of the fleet happened, not two.
    expect(runProfileDiscoveryLive).toHaveBeenCalledTimes(PROFILES.length)
  })

  it('refuses a fleet sweep inside the cooldown window', async () => {
    process.env.ANYA_FLEET_CRAWL_MIN_INTERVAL_MS = String(6 * 60 * 60 * 1000)

    const first = await runAutonomousCrawlers({}, ctx())
    expect(first.skipped).toBeUndefined()
    expect(runProfileDiscoveryLive).toHaveBeenCalledTimes(PROFILES.length)

    runProfileDiscoveryLive.mockClear()
    const second = await runAutonomousCrawlers({}, ctx())
    expect(second.skipped).toBe(true)
    expect(second.skipped_reason).toBe('fleet_crawl_cooldown')
    expect(runProfileDiscoveryLive).not.toHaveBeenCalled()
  })

  it('NEVER gates an explicitly scoped (owner-initiated) crawl — recall is not starved', async () => {
    process.env.ANYA_FLEET_CRAWL_MIN_INTERVAL_MS = String(6 * 60 * 60 * 1000)

    // Burn the cooldown with a fleet sweep first.
    await runAutonomousCrawlers({}, ctx())
    runProfileDiscoveryLive.mockClear()

    const scoped = await runAutonomousCrawlers({ profileIds: ['p1'] }, ctx())
    expect(scoped.skipped).toBeUndefined()
    expect(runProfileDiscoveryLive).toHaveBeenCalled()

    // And a second scoped crawl right after is still allowed.
    runProfileDiscoveryLive.mockClear()
    const scopedAgain = await runAutonomousCrawlers({ profileIds: ['p2'] }, ctx())
    expect(scopedAgain.skipped).toBeUndefined()
    expect(runProfileDiscoveryLive).toHaveBeenCalled()
  })

  it('lets force:true override the cooldown for a deliberate human re-run', async () => {
    process.env.ANYA_FLEET_CRAWL_MIN_INTERVAL_MS = String(6 * 60 * 60 * 1000)

    await runAutonomousCrawlers({}, ctx())
    runProfileDiscoveryLive.mockClear()

    const forced = await runAutonomousCrawlers({ force: true }, ctx())
    expect(forced.skipped).toBeUndefined()
    expect(runProfileDiscoveryLive).toHaveBeenCalledTimes(PROFILES.length)
  })

  it('releases the lease so the NEXT sweep can run once the cooldown has passed', async () => {
    process.env.ANYA_FLEET_CRAWL_MIN_INTERVAL_MS = '0'

    await runAutonomousCrawlers({}, ctx())
    expect(lockState.held).toBeNull()

    runProfileDiscoveryLive.mockClear()
    const second = await runAutonomousCrawlers({}, ctx())
    expect(second.skipped).toBeUndefined()
    expect(runProfileDiscoveryLive).toHaveBeenCalledTimes(PROFILES.length)
  })
})
