// Guards the 2026-07-20 fix: the 2026-06-23 Crawler OS cutover (commit
// 18d397d1) changed the crawler-run completion audit action from
// 'autonomous_crawlers_complete' (legacy fleet) to 'complete' (Crawler OS),
// but getAutonomousCrawlersStatus()'s query was never updated to match — it
// kept looking for the OLD full action string
// 'autonomous_crawlers.autonomous_crawlers_complete'. Since that day NOTHING
// has ever written that string again, so admin.anya.getStatus's
// crawlers.last_run silently froze on the legacy fleet's final run forever,
// even while the scheduler kept driving the Crawler OS successfully every
// day — a metrics-plumbing bug reading "nothing has run in weeks" for a
// system that was actually fine.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { getAutonomousCrawlersStatus } from '../services/anyaAutonomousFunctionRunner.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT, action TEXT, severity TEXT,
      user_id TEXT, profile_id TEXT, resource_type TEXT, resource_id TEXT,
      details TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE crawler_jobs (id TEXT PRIMARY KEY, status TEXT);
  `)
  raw.dialect = 'sqlite'
  return raw
}

describe('getAutonomousCrawlersStatus', () => {
  it('finds the CURRENT Crawler OS completion audit row (action="complete")', async () => {
    const db = makeDb()
    db.prepare(
      `INSERT INTO audit_logs (category, action, details, created_at)
       VALUES ('anya', 'autonomous_crawlers.complete', ?, '2026-07-19T03:00:00.000Z')`,
    ).run(JSON.stringify({ report: { engine: 'crawler-os', profiles_processed: 12, opportunities_stored: 40 } }))

    const status = await getAutonomousCrawlersStatus(db)
    // Before the fix this was always null — the query only matched the
    // retired legacy action string, so a healthy daily Crawler OS run was
    // invisible to this status panel.
    expect(status.last_run).toBeTruthy()
    expect(status.last_run.engine).toBe('crawler-os')
    expect(status.last_run.profiles_processed).toBe(12)
    expect(status.message).toBeUndefined()
  })

  it('still finds a LEGACY completion row (rollback / ANYA_AUTONOMOUS_LEGACY_FLEET=1 compatibility)', async () => {
    const db = makeDb()
    db.prepare(
      `INSERT INTO audit_logs (category, action, details, created_at)
       VALUES ('anya', 'autonomous_crawlers.autonomous_crawlers_complete', ?, '2026-06-23T20:51:45.229Z')`,
    ).run(JSON.stringify({ report: { profiles_processed: 15, jobs_created: 75 } }))

    const status = await getAutonomousCrawlersStatus(db)
    expect(status.last_run).toBeTruthy()
    expect(status.last_run.profiles_processed).toBe(15)
  })

  it('prefers whichever action actually ran MOST RECENTLY when both exist', async () => {
    const db = makeDb()
    db.prepare(
      `INSERT INTO audit_logs (category, action, details, created_at)
       VALUES ('anya', 'autonomous_crawlers.autonomous_crawlers_complete', ?, '2026-06-23T20:51:45.229Z')`,
    ).run(JSON.stringify({ report: { profiles_processed: 15 } }))
    db.prepare(
      `INSERT INTO audit_logs (category, action, details, created_at)
       VALUES ('anya', 'autonomous_crawlers.complete', ?, '2026-07-19T03:00:00.000Z')`,
    ).run(JSON.stringify({ report: { engine: 'crawler-os', profiles_processed: 12 } }))

    const status = await getAutonomousCrawlersStatus(db)
    expect(status.last_run.engine).toBe('crawler-os')
    expect(status.last_run.profiles_processed).toBe(12)
  })

  it('reports the honest "no operations run yet" message when neither action exists', async () => {
    const db = makeDb()
    const status = await getAutonomousCrawlersStatus(db)
    expect(status.last_run).toBeNull()
    expect(status.message).toBe('No autonomous crawler operations have been run yet')
  })
})
