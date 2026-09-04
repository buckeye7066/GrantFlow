import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import { trustedOriginClause } from '../utils/recordOrigins.js'

const TRUSTED_ORIGIN_SQL = `(COALESCE(is_active, TRUE) = TRUE AND COALESCE(is_hidden, FALSE) = FALSE) AND (record_origin IS NULL OR record_origin NOT IN ('synthetic','manual'))`
const TRUSTED_ORIGIN_ALIAS_SQL = `(COALESCE(fo.is_active, TRUE) = TRUE AND COALESCE(fo.is_hidden, FALSE) = FALSE) AND (fo.record_origin IS NULL OR fo.record_origin NOT IN ('synthetic','manual'))`

describe('trustedOriginClause lifecycle guard', () => {
  it('filters hidden, inactive, and untrusted rows through the shared read contract', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY,
        record_origin TEXT,
        is_active INTEGER,
        is_hidden INTEGER
      )
    `)
    const insert = db.prepare(
      'INSERT INTO funding_opportunities (id, record_origin, is_active, is_hidden) VALUES (?, ?, ?, ?)',
    )
    insert.run('visible', 'live_crawl', 1, 0)
    insert.run('hidden', 'live_crawl', 1, 1)
    insert.run('inactive', 'live_crawl', 0, 0)
    insert.run('synthetic', 'synthetic', 1, 0)
    insert.run('manual', 'manual', 1, 0)
    insert.run('legacy-visible', null, null, null)

    expect(trustedOriginClause()).toBe(`(${TRUSTED_ORIGIN_SQL})`)
    const ids = db.prepare(`
      SELECT id
        FROM funding_opportunities
       WHERE (COALESCE(is_active, TRUE) = TRUE AND COALESCE(is_hidden, FALSE) = FALSE)
         AND (record_origin IS NULL OR record_origin NOT IN ('synthetic','manual'))
       ORDER BY id
    `).all().map((row) => row.id)

    expect(ids).toEqual(['legacy-visible', 'visible'])
    db.close()
  })

  it('applies the same lifecycle and trust rules through a table alias', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY,
        record_origin TEXT,
        is_active INTEGER,
        is_hidden INTEGER
      );
      INSERT INTO funding_opportunities VALUES
        ('ok', 'funding_api', 1, 0),
        ('quarantined', 'funding_api', 1, 1);
    `)

    expect(trustedOriginClause('fo')).toBe(`(${TRUSTED_ORIGIN_ALIAS_SQL})`)
    const ids = db.prepare(`
      SELECT fo.id
        FROM funding_opportunities fo
       WHERE (COALESCE(fo.is_active, TRUE) = TRUE AND COALESCE(fo.is_hidden, FALSE) = FALSE)
         AND (fo.record_origin IS NULL OR fo.record_origin NOT IN ('synthetic','manual'))
       ORDER BY fo.id
    `).all().map((row) => row.id)

    expect(ids).toEqual(['ok'])
    db.close()
  })

  it('rejects caller-controlled aliases', () => {
    expect(() => trustedOriginClause('fo; DROP TABLE funding_opportunities')).toThrow(/invalid alias/)
  })
})
