import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import { trustedOriginClause } from '../utils/recordOrigins.js'

function createCatalog(db) {
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      record_origin TEXT,
      is_active INTEGER,
      is_hidden INTEGER,
      opportunity_kind TEXT,
      result_kind TEXT,
      opportunity_type TEXT,
      type TEXT,
      link_status TEXT,
      last_verified_at TEXT
    )
  `)
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

describe('trustedOriginClause lifecycle guard', () => {
  it('filters hidden, inactive, untrusted, unverified, and stale direct rows through the shared read contract', () => {
    const db = new Database(':memory:')
    createCatalog(db)
    const insert = db.prepare(`
      INSERT INTO funding_opportunities
        (id, record_origin, is_active, is_hidden, opportunity_kind, result_kind,
         opportunity_type, type, link_status, last_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    insert.run('current-direct', 'live_crawl', 1, 0, 'DIRECT', null, 'grant', 'OPPORTUNITY', 'ok', isoDaysAgo(1))
    insert.run('stale-direct', 'live_crawl', 1, 0, 'DIRECT', null, 'grant', 'OPPORTUNITY', 'ok', isoDaysAgo(31))
    insert.run('unverified-direct', 'live_crawl', 1, 0, 'DIRECT', null, 'grant', 'OPPORTUNITY', 'unverified', null)
    insert.run('pointer-no-proof', 'live_crawl', 1, 0, null, 'directory', 'directory', 'DIRECTORY', 'unverified', null)
    insert.run('hidden-pointer', 'live_crawl', 1, 1, null, 'directory', 'directory', 'DIRECTORY', 'unverified', null)
    insert.run('inactive-pointer', 'live_crawl', 0, 0, null, 'directory', 'directory', 'DIRECTORY', 'unverified', null)
    insert.run('synthetic-pointer', 'synthetic', 1, 0, null, 'directory', 'directory', 'DIRECTORY', 'unverified', null)
    insert.run('manual-pointer', 'manual', 1, 0, null, 'directory', 'directory', 'DIRECTORY', 'unverified', null)

    const clause = trustedOriginClause()
    expect(clause).toContain('COALESCE(is_hidden, FALSE) = FALSE')
    expect(clause).toContain("LOWER(TRIM(COALESCE(link_status, ''))) IN ('ok','redirect','verified')")
    expect(clause).toContain('last_verified_at IS NOT NULL')
    expect(clause).toContain("record_origin NOT IN ('synthetic','manual')")

    const ids = db.prepare(`
      SELECT id
        FROM funding_opportunities
       WHERE ${clause}
       ORDER BY id
    `).all().map((row) => row.id)

    expect(ids).toEqual(['current-direct', 'pointer-no-proof'])
    db.close()
  })

  it('applies the same lifecycle, proof, and trust rules through a table alias', () => {
    const db = new Database(':memory:')
    createCatalog(db)
    const insert = db.prepare(`
      INSERT INTO funding_opportunities
        (id, record_origin, is_active, is_hidden, opportunity_kind, result_kind,
         opportunity_type, type, link_status, last_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run('ok', 'funding_api', 1, 0, 'DIRECT', null, 'grant', 'OPPORTUNITY', 'verified', isoDaysAgo(2))
    insert.run('stale', 'funding_api', 1, 0, 'DIRECT', null, 'grant', 'OPPORTUNITY', 'verified', isoDaysAgo(31))
    insert.run('directory', 'funding_api', 1, 0, null, 'directory', 'directory', 'DIRECTORY', null, null)
    insert.run('quarantined', 'funding_api', 1, 1, null, 'directory', 'directory', 'DIRECTORY', null, null)

    const clause = trustedOriginClause('fo')
    expect(clause).toContain('COALESCE(fo.is_hidden, FALSE) = FALSE')
    expect(clause).toContain("LOWER(TRIM(COALESCE(fo.link_status, ''))) IN ('ok','redirect','verified')")
    expect(clause).toContain('fo.last_verified_at IS NOT NULL')
    expect(clause).toContain("fo.record_origin NOT IN ('synthetic','manual')")

    const ids = db.prepare(`
      SELECT fo.id
        FROM funding_opportunities fo
       WHERE ${clause}
       ORDER BY fo.id
    `).all().map((row) => row.id)

    expect(ids).toEqual(['directory', 'ok'])
    db.close()
  })

  it('rejects caller-controlled aliases', () => {
    expect(() => trustedOriginClause('fo; DROP TABLE funding_opportunities')).toThrow(/invalid alias/)
  })
})
