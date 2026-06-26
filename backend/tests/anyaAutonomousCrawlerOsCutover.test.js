// Guards the 2026-06-23 cutover: the Anya autonomous crawler runner must drive
// the Crawler OS (runProfileDiscoveryLive) and NEVER enqueue the retired legacy
// fleet (local/scholarship/curated_benefits/comprehensive/profile_enrichment).
// The legacy fleet generated templated geo-stub junk + fat per-job snapshots
// that bloated crawler_jobs to 8.3GB and caused prod disk-full failures.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const runProfileDiscoveryLive = vi.fn()

vi.mock('../services/crawlerOsService.js', () => ({ runProfileDiscoveryLive }))
vi.mock('../services/auditService.js', () => ({
  logAuditEvent: vi.fn(),
  AUDIT_CATEGORIES: { ANYA: 'anya' },
  SEVERITY: { INFO: 'info' },
}))

const { runAutonomousCrawlers } = await import('../services/anyaAutonomousFunctionRunner.js')

function fakeDb(profiles) {
  return {
    prepare(sql) {
      return {
        all: () => (/from profiles/i.test(sql) ? profiles : [{ c: 0 }]),
        get: () => ({ c: 0 }),
        run: () => ({ changes: 0 }),
      }
    },
  }
}

const PROFILES = [
  { id: 'p1', display_name: 'Org One', status: 'active' },
  { id: 'p2', display_name: 'Person Two', status: 'active' },
]

describe('autonomous crawler OS cutover', () => {
  beforeEach(() => {
    runProfileDiscoveryLive.mockReset()
    runProfileDiscoveryLive.mockResolvedValue({
      run: { stored: 7, sources: [{ source_id: 'grants_gov' }] },
      persisted: { opportunities: 7, matches: 7 },
    })
  })

  it('drives the Crawler OS and enqueues ZERO legacy jobs', async () => {
    const db = fakeDb(PROFILES)
    const report = await runAutonomousCrawlers({}, { db, user: { id: 'test' } })

    expect(report.engine).toBe('crawler-os')
    expect(report.profiles_processed).toBe(2)
    expect(report.jobs_created).toBe(2)
    expect(runProfileDiscoveryLive).toHaveBeenCalledTimes(2)
    expect(report.opportunities_stored).toBe(14)
  })

  it('counts a skipped (deleted/archived) profile without failing the run', async () => {
    runProfileDiscoveryLive.mockResolvedValueOnce({ run: { skipped: true, reason: 'profile_deleted' }, persisted: {} })
    const db = fakeDb(PROFILES)
    const report = await runAutonomousCrawlers({}, { db, user: { id: 'test' } })
    expect(report.engine).toBe('crawler-os')
    expect(report.jobs_created).toBe(1) // one skipped, one completed
    expect(report.jobs.some((j) => j.status === 'skipped')).toBe(true)
  })
})
