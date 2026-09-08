import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import migrate from '../db/migrations/186_crawler_os_discovery_job.mjs'

const { dispatch, discover } = vi.hoisted(() => ({ dispatch: vi.fn(async () => {}), discover: vi.fn() }))
vi.mock('../services/crawlerDispatcher.js', () => ({ dispatchCrawlerJob: dispatch }))
vi.mock('../services/crawlerOsService.js', () => ({ runProfileDiscoveryLive: discover }))
vi.mock('../services/profileHelpers.js', () => ({ computeProfileDigest: async () => 'fixture-digest', buildProfileContext: vi.fn() }))
import { enqueueCrawlerOsDiscovery, processCrawlerOsDiscoveryJob } from '../services/crawlerOsDiscoveryJob.js'
import { CRAWLER_JOB_TYPES } from '../config/constants.js'

function database() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
  const ddl = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS crawler_jobs ('), schema.indexOf('CREATE INDEX IF NOT EXISTS idx_crawler_jobs_status'))
  db.exec("CREATE TABLE profiles (id TEXT PRIMARY KEY); CREATE TABLE organizations (id TEXT PRIMARY KEY); INSERT INTO profiles VALUES ('profile-a'), ('profile-b');")
  db.exec(ddl)
  db.exec('CREATE UNIQUE INDEX discovery_idempotency ON crawler_jobs(idempotency_key)')
  return db
}

describe('durable canonical discovery', () => {
  beforeEach(() => { dispatch.mockClear(); discover.mockReset() })

  it('persists before dispatch, joins concurrent clicks, and permits a fresh scan after completion', async () => {
    const db = database()
    try {
      dispatch.mockImplementation(async ({ jobId }) => {
        expect(db.prepare('SELECT type FROM crawler_jobs WHERE id = ?').get(jobId).type).toBe('crawler_os_discovery')
      })
      const [first, second] = await Promise.all([enqueueCrawlerOsDiscovery(db, 'profile-a'), enqueueCrawlerOsDiscovery(db, 'profile-a')])
      expect(first.job_ids).toEqual(second.job_ids)
      expect(first.jobs_enqueued + second.jobs_enqueued).toBe(1)
      expect(db.prepare('SELECT COUNT(*) AS count FROM crawler_jobs').get().count).toBe(1)
      db.prepare("UPDATE crawler_jobs SET status = 'completed'").run()
      const next = await enqueueCrawlerOsDiscovery(db, 'profile-a')
      expect(next.job_ids).not.toEqual(first.job_ids)
      const [joined, concurrentJoin] = await Promise.all([
        enqueueCrawlerOsDiscovery(db, 'profile-a'), enqueueCrawlerOsDiscovery(db, 'profile-a'),
      ])
      expect(joined.job_ids).toEqual(next.job_ids)
      expect(concurrentJoin.job_ids).toEqual(next.job_ids)
      expect(joined.jobs_enqueued + concurrentJoin.jobs_enqueued).toBe(0)
      expect(db.prepare("SELECT COUNT(*) AS count FROM crawler_jobs WHERE profile_id = 'profile-a'").get().count).toBe(2)
      const other = await enqueueCrawlerOsDiscovery(db, 'profile-b')
      expect(other.job_ids).not.toEqual(next.job_ids)
    } finally { db.close() }
  })

  it('passes the live profile and cancellation signal to the canonical engine and retains source failures', async () => {
    const signal = new AbortController().signal
    const sources = [{ source_id: 'example', outcome: 'SKIPPED', reason: 'time_budget_exhausted' }]
    discover.mockResolvedValue({ run: { stored: 2, sources }, persisted: { opportunities: 2, matches: 3 } })
    const result = await processCrawlerOsDiscoveryJob({ db: 'fixture-db', job: { profile_id: 'profile-a' }, signal, deadlineMs: 10000 })
    expect(discover).toHaveBeenCalledExactlyOnceWith({ db: 'fixture-db', profileId: 'profile-a', signal, deadlineMs: 5000 })
    expect(result.result_meta).toMatchObject({ sources, stored: 2, matches: 3, partial: true })
    discover.mockRejectedValue(new Error('persistence unavailable'))
    await expect(processCrawlerOsDiscoveryJob({ job: { profile_id: 'profile-a' } })).rejects.toThrow('persistence unavailable')
  })

  it('widens SQLite inside a migration transaction without losing historical rows, indexes or child records', async () => {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys = ON')
      db.exec("CREATE TABLE crawler_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('local'))); CREATE INDEX job_type ON crawler_jobs(type); CREATE TABLE child (job_id TEXT REFERENCES crawler_jobs(id) ON DELETE CASCADE); INSERT INTO crawler_jobs VALUES ('old', 'local'); INSERT INTO child VALUES ('old'); BEGIN")
      await migrate(db)
      await migrate(db)
      db.exec("INSERT INTO crawler_jobs VALUES ('new', 'crawler_os_discovery'); COMMIT")
      expect(db.prepare('SELECT * FROM child').all()).toEqual([{ job_id: 'old' }])
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'job_type'").get()).toBeTruthy()
      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally { db.close() }
  })

  it('keeps the PostgreSQL migration type list equal to the canonical runtime list', () => {
    const sql = readFileSync(new URL('../db/postgres/migrations/0190_crawler_os_discovery_job.sql', import.meta.url), 'utf8')
    const types = [...sql.matchAll(/'([a-z_0-9]+)'/g)].map((match) => match[1])
    expect(types.sort()).toEqual([...CRAWLER_JOB_TYPES].sort())
  })
})
