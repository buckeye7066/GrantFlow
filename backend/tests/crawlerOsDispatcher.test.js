import { it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
const { discover } = vi.hoisted(() => ({ discover: vi.fn() }))
vi.mock('../services/crawlerOsService.js', async (original) => ({ ...await original(), runProfileDiscoveryLive: discover }))
import { createCrawlerJob } from '../services/crawlerJobCreation.js'
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js'

it('the real dispatcher claims canonical discovery once and writes its durable completion receipt', async () => {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  try {
    db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'))
    db.prepare("INSERT INTO profiles (id, display_name, primary_type, status) VALUES ('fixture-profile', 'Fixture nonprofit', 'nonprofit', 'active')").run()
    discover.mockResolvedValue({ run: { sources: [{ source_id: 'fixture-source', outcome: 'empty' }] }, persisted: { opportunities: 2, matches: 3 } })
    const { jobId } = await createCrawlerJob(db, { type: 'crawler_os_discovery', profileId: 'fixture-profile', buildSnapshot: false })
    await Promise.all([dispatchCrawlerJob({ db, jobId }), dispatchCrawlerJob({ db, jobId })])
    const row = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    expect(row.error).toBeNull()
    expect(row.status).toBe('completed')
    expect(row.attempt_count).toBe(1)
    expect(discover).toHaveBeenCalledTimes(1)
    expect(JSON.parse(row.result_meta)).toMatchObject({ engine: 'crawler-os', stored: 2, matches: 3 })
  } finally { db.close() }
})
