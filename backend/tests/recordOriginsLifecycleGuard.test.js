import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import { trustedOriginClause } from '../utils/recordOrigins.js'

// Deliberately minimal: the shared read guard may only depend on the lifecycle
// flags and record_origin. Readers with reduced fixtures (and legacy rows) must
// keep working, and the fragment must never need a wall clock.
function createCatalog(db) {
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      record_origin TEXT,
      is_active INTEGER,
      is_hidden INTEGER,
      opportunity_kind TEXT,
      link_status TEXT,
      last_verified_at TEXT
    )
  `)
  return db.prepare(`
    INSERT INTO funding_opportunities
      (id, record_origin, is_active, is_hidden, opportunity_kind, link_status, last_verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

describe('trustedOriginClause lifecycle guard', () => {
  it('filters hidden, inactive, and untrusted rows through the shared read contract', () => {
    const db = new Database(':memory:')
    const insert = createCatalog(db)

    insert.run('visible-direct', 'live_crawl', 1, 0, 'DIRECT', 'ok', isoDaysAgo(1))
    // The writer guard / verifier hide unproven and stale direct rows; the
    // reader honours that decision through is_hidden, not by re-deriving it.
    insert.run('writer-quarantined-unverified', 'live_crawl', 1, 1, 'DIRECT', 'unverified', null)
    insert.run('writer-quarantined-stale', 'live_crawl', 1, 1, 'DIRECT', 'unverified', isoDaysAgo(31))
    insert.run('writer-quarantined-unknown-kind', 'live_crawl', 1, 1, 'future_direct_spelling', 'broken', null)
    insert.run('inactive-direct', 'live_crawl', 0, 0, 'DIRECT', 'ok', isoDaysAgo(1))
    // Missing flags stay visible for legacy rows (matchSurfacing contract).
    insert.run('legacy-null-flags', 'live_crawl', null, null, 'DIRECT', 'ok', isoDaysAgo(1))
    insert.run('pointer-no-proof', 'live_crawl', 1, 0, 'directory', 'unverified', null)
    insert.run('hidden-pointer', 'live_crawl', 1, 1, 'directory', 'unverified', null)
    insert.run('synthetic-direct', 'synthetic', 1, 0, 'DIRECT', 'ok', isoDaysAgo(1))
    insert.run('manual-pointer', 'manual', 1, 0, 'directory', null, null)

    const safeClause = trustedOriginClause()
    expect(safeClause).toContain('COALESCE(is_active, TRUE) = TRUE')
    expect(safeClause).toContain('COALESCE(is_hidden, FALSE) = FALSE')
    expect(safeClause).toContain("record_origin NOT IN ('synthetic','manual')")

    const ids = db.prepare(`
      SELECT id
        FROM funding_opportunities
       WHERE ${safeClause}
       ORDER BY id
    `).all().map((row) => row.id)

    expect(ids).toEqual(['legacy-null-flags', 'pointer-no-proof', 'visible-direct'])
    db.close()
  })

  it('applies the same lifecycle and trust rules through a table alias', () => {
    const db = new Database(':memory:')
    const insert = createCatalog(db)
    insert.run('ok', 'funding_api', 1, 0, 'DIRECT', 'verified', isoDaysAgo(2))
    insert.run('quarantined-direct', 'funding_api', 1, 1, 'DIRECT', 'unverified', isoDaysAgo(31))
    insert.run('directory', 'funding_api', 1, 0, 'directory', null, null)
    insert.run('quarantined-directory', 'funding_api', 1, 1, 'directory', null, null)
    insert.run('killed', 'funding_api', 0, 0, 'DIRECT', 'ok', isoDaysAgo(1))

    const safeClause = trustedOriginClause('fo')
    expect(safeClause).toContain('COALESCE(fo.is_active, TRUE) = TRUE')
    expect(safeClause).toContain('COALESCE(fo.is_hidden, FALSE) = FALSE')
    expect(safeClause).toContain("fo.record_origin NOT IN ('synthetic','manual')")

    const ids = db.prepare(`
      SELECT fo.id
        FROM funding_opportunities fo
       WHERE ${safeClause}
       ORDER BY fo.id
    `).all().map((row) => row.id)

    expect(ids).toEqual(['directory', 'ok'])
    db.close()
  })

  it('never embeds a wall clock, so cached copies of the fragment stay correct', () => {
    // anyaToolRegistry (and any prepared-statement cache) builds this fragment
    // once and reuses it. A Date.now() literal inside the SQL would freeze at
    // build time and silently hide every row verified after that moment.
    const first = trustedOriginClause('fo')
    const second = trustedOriginClause('fo')
    expect(second).toBe(first)
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    expect(first).not.toContain('last_verified_at')
    expect(first).not.toContain('link_status')
  })

  it('rejects caller-controlled aliases', () => {
    expect(() => trustedOriginClause('fo; DROP TABLE funding_opportunities')).toThrow(/invalid alias/)
  })
})
